/**
 * Host-contract test: the real `@deepseek-ai/dsh-tools` schema validator must
 * accept every parameter and output schema this plugin registers. Run from an
 * installed profile link so the Host package resolves.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'

test('every compiled tool schema is accepted by the Host validator', async () => {
  const tools = []
  const effects = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    systemPrompt: { section() {}, getSectionOrder: () => 10 },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (factory) => effects.push(factory),
  }
  apply(ctx, { enabled: true, channel: 'chrome' })
  assert.equal(tools.length, 10)

  for (const tool of tools) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters), `${tool.name} parameters`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), `${tool.name} output`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} render`)
  }

  const dispose = effects[0]()
  await dispose()
})
