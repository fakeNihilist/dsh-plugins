import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, normalizeToolError, resolveConfig } from '../index.js'
import { BrowserPolicyError } from '../src/policy.js'

/** Minimal Cordis context for registration tests. */
function fakeContext() {
  const tools = []
  const sections = []
  const effects = []
  return {
    tools,
    sections,
    effects,
    toolsRegistry: { register: (tool) => tools.push(tool) },
    ctx: {
      tools: { register: (tool) => tools.push(tool) },
      systemPrompt: {
        section: (section) => sections.push(section),
        getSectionOrder: () => 10,
      },
      logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      effect: (factory) => effects.push(factory),
    },
  }
}

test('registers the planned tool surface and prompt section', async () => {
  const fake = fakeContext()
  apply(fake.ctx, { enabled: true, channel: 'chrome' })
  const names = fake.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'browser_act',
    'browser_capture',
    'browser_dialog',
    'browser_download',
    'browser_open',
    'browser_read',
    'browser_record',
    'browser_snapshot',
    'browser_tabs',
    'browser_view',
  ])
  assert.equal(fake.sections.length, 1)
  assert.equal(fake.sections[0].name, 'tool:browser')
  assert.equal(fake.effects.length, 1)
  const dispose = fake.effects[0]()
  await dispose()
})

test('disabled config registers nothing', () => {
  const fake = fakeContext()
  apply(fake.ctx, { enabled: false })
  assert.equal(fake.tools.length, 0)
  assert.equal(fake.sections.length, 0)
  assert.equal(fake.effects.length, 0)
})

test('resolveConfig merges nested defaults and validates limits', () => {
  const config = resolveConfig({ viewport: { width: 1024 }, recording: { enabled: false } })
  assert.equal(config.viewport.width, 1024)
  assert.equal(config.viewport.height, 800)
  assert.equal(config.recording.enabled, false)
  assert.throws(() => resolveConfig({ viewport: { width: 100 } }), /viewport\.width/)
  assert.throws(() => resolveConfig({ allowPrivateNetwork: 'sometimes' }), /allowPrivateNetwork/)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /timeoutMs/)
})

test('normalizeToolError preserves stable codes and adds recovery hints', () => {
  const policy = normalizeToolError(new BrowserPolicyError('invalid_url', 'bad url'))
  assert.match(policy.message, /^invalid_url: bad url$/)

  const timeout = normalizeToolError(Object.assign(new Error('locator timed out'), { name: 'TimeoutError' }))
  assert.match(timeout.message, /^timeout:/)
  assert.match(timeout.message, /browser_snapshot/)

  const strict = normalizeToolError(new Error("strict mode violation: locator resolved to 3 elements"))
  assert.match(strict.message, /^ambiguous_target:/)
})

test('every tool declares a schema and an execute function', () => {
  const fake = fakeContext()
  apply(fake.ctx, { enabled: true, channel: 'chrome' })
  for (const tool of fake.tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} execute`)
    assert.equal(typeof tool.parameters, 'object', `${tool.name} parameters`)
    assert.equal(typeof tool.output?.schema, 'object', `${tool.name} output schema`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} output render`)
  }
})
