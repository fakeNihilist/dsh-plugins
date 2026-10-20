import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'

test('loads as a Cordis plugin with injected tools and systemPrompt', async () => {
  const tools = []
  const sections = []
  const ctx = new Context()
  ctx.provide('tools', { register: (tool) => tools.push(tool) })
  ctx.provide('systemPrompt', {
    section: (section) => sections.push(section),
    getSectionOrder: () => 10,
  })

  const fiber = await ctx.plugin(plugin, { channel: 'chrome', idleCloseMs: 600_000 })
  assert.equal(tools.length, 10)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:browser')
  assert.equal(typeof tools[0].execute, 'function')

  await fiber.dispose()
  if (typeof ctx.dispose === 'function') await ctx.dispose()
})
