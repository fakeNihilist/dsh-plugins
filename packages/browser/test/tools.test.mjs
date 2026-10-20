/**
 * Tool-layer integration: invoke the registered definitions exactly as the
 * agent loop would, including argument validation and output rendering.
 *
 * Progress is written to tools-progress.log because node:test buffers stdout
 * until the test settles; the log makes a hang diagnosable.
 */
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { apply } from '../index.js'

const progressFile = new URL('./tools-progress.log', import.meta.url)
writeFileSync(progressFile, '')
function note(...args) {
  const line = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
  appendFileSync(progressFile, `${line}\n`)
  process.stderr.write(`${line}\n`)
}

const fixtures = new URL('./fixtures/', import.meta.url)

function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const name = url.pathname.replace(/^\//, '') || 'basic.html'
    try {
      const body = await fs.readFile(new URL(name, fixtures))
      response.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

test('registered tools execute through validation and render model text', async () => {
  note('start')
  const root = join(tmpdir(), `dsh-browser-tools-${Date.now()}`)
  await fs.mkdir(root, { recursive: true })
  const { server, base } = await startServer()
  note('server', base)

  const tools = new Map()
  const effects = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section() {}, getSectionOrder: () => 10 },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (factory) => effects.push(factory),
  }
  apply(ctx, {
    channel: 'chrome',
    outputDir: '.dsh-browser',
    timeoutMs: 60_000,
    navigationTimeoutMs: 20_000,
    actionTimeoutMs: 5_000,
    idleCloseMs: 600_000,
    browserIdleCloseMs: 600_000,
    recording: { enabled: true },
  })
  note('applied', tools.size, effects.length)

  const exec = {
    agent: { id: 'tool-test', session: { header: { cwd: root } } },
    signal: new AbortController().signal,
  }
  const invoke = async (name, args) => {
    const tool = tools.get(name)
    assert.ok(tool, `${name} is registered`)
    return await tool.execute(args, exec)
  }

  try {
    note('open')
    const opened = await invoke('browser_open', { url: `${base}/basic.html` })
    note('opened', opened.tabId, opened.title)
    assert.equal(typeof opened.tabId, 'string')
    assert.match(opened.url, /basic\.html$/)
    assert.equal(opened.title, 'Browser fixture')
    assert.match(tools.get('browser_open').output.render({}, opened)[0].text, /Opened tab-1/)

    note('snapshot')
    const snapshot = await invoke('browser_snapshot', { tabId: opened.tabId, maxChars: 20_000 })
    note('snapshot done', snapshot.text.length)
    assert.match(snapshot.text, /heading "Browser fixture"/)
    assert.match(snapshot.text, /button "Increment counter"/)

    note('act click')
    const clicked = await invoke('browser_act', {
      tabId: opened.tabId,
      action: 'click',
      target: { by: 'role', role: 'button', name: 'Increment counter' },
    })
    note('act done', clicked.action)
    assert.equal(clicked.action, 'click')
    assert.match(tools.get('browser_act').output.render({}, clicked)[0].text, /Done: click/)

    note('wait action')
    const waited = await invoke('browser_act', {
      tabId: opened.tabId,
      action: 'wait',
      waitFor: 'timeout',
      durationMs: 20,
    })
    assert.equal(Object.hasOwn(waited, 'target'), false)
    note('wait done')

    note('read')
    const read = await invoke('browser_read', {
      tabId: opened.tabId,
      target: { by: 'css', selector: '#count' },
      what: 'text',
    })
    note('read done', read.text)
    assert.equal(read.text, '1')

    note('fill + value read')
    await invoke('browser_act', {
      tabId: opened.tabId,
      action: 'fill',
      target: { by: 'label', label: 'Name' },
      text: 'Ada',
    })
    const value = await invoke('browser_read', {
      tabId: opened.tabId,
      target: { by: 'label', label: 'Name' },
      what: 'value',
    })
    assert.equal(value.text, 'Ada')

    note('evaluate')
    const evaluated = await invoke('browser_act', {
      tabId: opened.tabId,
      action: 'evaluate',
      expression: 'document.title',
    })
    assert.equal(evaluated.value, 'Browser fixture')

    note('tabs')
    const tabs = await invoke('browser_tabs', { action: 'list' })
    note('tabs done', tabs.tabs.length)
    assert.equal(tabs.tabs.length, 1)
    assert.equal(tabs.activeTabId, opened.tabId)
    assert.match(tools.get('browser_tabs').output.render({}, tabs)[0].text, /tab-1 \(active\)/)

    note('finalize')
    const finalized = await invoke('browser_tabs', {
      action: 'finalize',
      keep: [{ tabId: opened.tabId, status: 'deliverable' }],
    })
    assert.equal(finalized.tabs[0].lifecycle, 'deliverable')

    note('capture')
    const shot = await invoke('browser_capture', {
      tabId: opened.tabId,
      kind: 'page',
      path: 'shots/tools.png',
    })
    note('capture done', shot.path, shot.bytes)
    assert.ok(shot.bytes > 0)
    assert.equal(shot.path.endsWith('tools.png'), true)
    assert.match(tools.get('browser_capture').output.render({}, shot)[0].text, /Screenshot saved to:/)

    note('element capture')
    const elementShot = await invoke('browser_capture', {
      tabId: opened.tabId,
      kind: 'element',
      target: { by: 'css', selector: '#increment' },
      path: 'shots/button.png',
    })
    assert.ok(elementShot.bytes > 0)

    note('record')
    const recording = await invoke('browser_record', {
      tabId: opened.tabId,
      durationMs: 600,
      width: 640,
      height: 480,
      outputPath: 'recordings/tool.webm',
    })
    note('record done', recording.path, recording.bytes)
    assert.ok(recording.bytes > 0)
    assert.match(tools.get('browser_record').output.render({}, recording)[0].text, /Recording saved to:/)

    note('dialog')
    const dialog = await invoke('browser_dialog', { tabId: opened.tabId, action: 'list' })
    note('dialog done')
    assert.match(dialog.text, /No JavaScript dialog/)

    note('downloads')
    const downloads = await invoke('browser_download', { tabId: opened.tabId, action: 'list' })
    note('downloads done')
    assert.match(downloads.text, /No downloads/)

    note('view no-op')
    const view = await invoke('browser_view', { visible: false })
    assert.equal(view.changed, false)
    assert.match(tools.get('browser_view').output.render({}, view)[0].text, /already hidden/)

    note('validation')
    await assert.rejects(invoke('browser_open', {}), /url|required/i)
    await assert.rejects(invoke('browser_snapshot', { tabId: 'tab-999' }), /tab_not_found/)
    note('validation done')
  } finally {
    note('dispose')
    const dispose = effects[0]?.()
    if (dispose) await dispose()
    note('disposed')
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    note('cleanup done')
  }
})
