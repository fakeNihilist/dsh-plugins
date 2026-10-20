/**
 * End-to-end smoke test for the browser engine: launch Chromium, navigate a
 * local fixture, snapshot, click, fill, select, check, screenshot, dialog,
 * download, frames, truncation, evaluate, and video recording.
 */
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performAction } from '../src/actions.js'
import { capture } from '../src/capture.js'
import { BrowserManager, validateViewport } from '../src/engine.js'
import { buildSnapshotText } from '../src/snapshot.js'
import { record } from '../src/recording.js'

const progressFile = new URL('./smoke-progress.log', import.meta.url)
writeFileSync(progressFile, '')
function note(...args) {
  const line = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
  process.stdout.write(`${line}\n`)
  appendFileSync(progressFile, `${line}\n`)
}

const fixtures = new URL('./fixtures/', import.meta.url)
const root = join(tmpdir(), `dsh-browser-smoke-${Date.now()}`)
await fs.mkdir(root, { recursive: true })

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/cross.html') {
    const port = server.address().port
    response.writeHead(200, { 'content-type': mime['.html'] })
    response.end(`<!doctype html><html><body><h1>Cross outer</h1><iframe src="http://localhost:${port}/frame-child.html"></iframe></body></html>`)
    return
  }
  if (url.pathname === '/file.txt') {
    const body = await fs.readFile(new URL('./fixtures/file.txt', import.meta.url))
    response.writeHead(200, { 'content-type': mime['.txt'], 'content-disposition': 'attachment; filename="sample.txt"' })
    response.end(body)
    return
  }
  const name = url.pathname.replace(/^\//, '') || 'basic.html'
  try {
    const body = await fs.readFile(new URL(name, fixtures))
    response.writeHead(200, { 'content-type': mime[name.slice(name.lastIndexOf('.'))] ?? 'text/plain' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
note('fixture server', base)

const config = {
  headed: false,
  channel: 'chrome',
  viewport: { width: 1280, height: 800 },
  navigationTimeoutMs: 20_000,
  actionTimeoutMs: 5_000,
  snapshotMaxChars: 60_000,
  idleCloseMs: 600_000,
  browserIdleCloseMs: 600_000,
  maxDownloadBytes: 10 * 1024 * 1024,
  outputDir: '.dsh-browser-smoke',
  persistCookies: false,
  allowEvaluate: true,
  recording: { enabled: true },
  launchArgs: [],
}
validateViewport(config.viewport.width, config.viewport.height)

const manager = new BrowserManager(config, console)
let session
try {
  session = await manager.getSession('smoke', root)
  const basic = await session.openTab({ url: `${base}/basic.html` })
  const basicTab = session.resolveTab(basic.tabId)
  note('opened', basic.url, basic.title)

  const snapshot = await buildSnapshotText({ ...basicTab, active: true }, { maxChars: 60_000 })
  assert.match(snapshot.text, /heading "Browser fixture"/)
  assert.match(snapshot.text, /button "Increment counter"/)
  assert.match(snapshot.text, /button "Shadow action"/)
  assert.match(snapshot.text, /textbox "Name"/)
  note('snapshot ok', snapshot.text.length, 'chars')

  await performAction(basicTab, { action: 'click', target: { by: 'role', role: 'button', name: 'Increment counter' } }, config)
  assert.equal(await basicTab.page.locator('#count').innerText(), '1')

  await performAction(basicTab, { action: 'fill', target: { by: 'label', label: 'Name' }, text: 'Ada' }, config)
  assert.equal(await basicTab.page.locator('#name').inputValue(), 'Ada')

  await performAction(basicTab, { action: 'select', target: { by: 'label', label: 'Color' }, option: 'green' }, config)
  assert.equal(await basicTab.page.locator('#color').inputValue(), 'green')

  await performAction(basicTab, { action: 'check', target: { by: 'label', label: 'Agree' } }, config)
  assert.equal(await basicTab.page.locator('#agree').isChecked(), true)

  const evaluated = await performAction(basicTab, { action: 'evaluate', expression: 'document.title' }, config)
  assert.equal(evaluated.value, 'Browser fixture')

  const linkTab = await session.openTab({ url: `${base}/basic.html`, newTab: true })
  const linkRecord = session.resolveTab(linkTab.tabId)
  await performAction(linkRecord, {
    action: 'click',
    target: { by: 'css', selector: '#next' },
    waitForNavigation: true,
  }, config)
  assert.match(linkRecord.page.url(), /frames\.html$/)
  note('navigation click ok', linkRecord.page.url())

  const shot = await capture(session, basicTab, { kind: 'page', fullPage: true, path: 'shots/basic.png' }, config)
  assert.ok(shot.bytes > 0)
  assert.equal(shot.path.endsWith('basic.png'), true)
  note('screenshot ok', shot.path, shot.bytes)

  const dialogTab = await session.openTab({ url: `${base}/dialog.html`, newTab: true })
  const dialogRecord = session.resolveTab(dialogTab.tabId)
  note('dialog: clicking #alert')
  await performAction(dialogRecord, { action: 'click', target: { by: 'css', selector: '#alert' } }, config)
  note('dialog: click returned')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const pending = session.getDialog(dialogTab.tabId)
  note('dialog: pending', pending ? pending.type() : 'none')
  assert.ok(pending, 'alert dialog should be pending')
  const dialogSnapshot = await buildSnapshotText(dialogRecord, { maxChars: 60_000 })
  assert.match(dialogSnapshot.text, /Dialog: alert/)
  note('dialog: snapshot reports pending dialog')
  note('dialog: accepting')
  await pending.accept()
  note('dialog: accepted')
  session.clearDialog(dialogTab.tabId)
  note('dialog ok', pending.type())

  const downloadTab = await session.openTab({ url: `${base}/download.html`, newTab: true })
  const downloadRecord = session.resolveTab(downloadTab.tabId)
  await performAction(downloadRecord, { action: 'click', target: { by: 'css', selector: '#download' } }, config)
  await new Promise((resolve) => setTimeout(resolve, 800))
  const downloads = await session.listDownloads(downloadTab.tabId)
  assert.ok(downloads.length >= 1, 'download should be tracked')
  assert.equal(downloads[0].state, 'saved')
  const downloadStat = await fs.stat(downloads[0].path)
  assert.ok(downloadStat.size > 0)
  note('download ok', downloads[0].path)

  const framesTab = await session.openTab({ url: `${base}/frames.html`, newTab: true })
  const framesRecord = session.resolveTab(framesTab.tabId)
  const framesSnapshot = await buildSnapshotText(framesRecord, { maxChars: 60_000 })
  assert.match(framesSnapshot.text, /Inner heading/)
  assert.match(framesSnapshot.text, /Inner button/)
  note('frames ok', framesSnapshot.text.length)

  const crossTab = await session.openTab({ url: `${base}/cross.html`, newTab: true })
  const crossRecord = session.resolveTab(crossTab.tabId)
  const crossSnapshot = await buildSnapshotText(crossRecord, { maxChars: 60_000 })
  assert.match(crossSnapshot.text, /Cross outer/)
  assert.match(crossSnapshot.text, /Inner heading/)
  note('cross-origin frame ok', crossSnapshot.text.length)

  const bigTab = await session.openTab({ url: `${base}/big.html`, newTab: true })
  const bigRecord = session.resolveTab(bigTab.tabId)
  const bigSnapshot = await buildSnapshotText(bigRecord, { maxChars: 2000 })
  assert.match(bigSnapshot.text, /truncated:/)
  note('truncation ok', bigSnapshot.text.length)

  const recording = await record(session, basicTab, {
    durationMs: 1_000,
    width: 640,
    height: 480,
    outputPath: 'recordings/smoke.webm',
  }, config, manager)
  assert.ok(recording.bytes > 0)
  assert.equal(recording.path.endsWith('smoke.webm'), true)
  note('recording ok', recording.path, recording.bytes)

  const scripted = await record(session, basicTab, {
    actions: [
      { type: 'click', selector: '#increment' },
      { type: 'wait', durationMs: 200 },
    ],
    width: 640,
    height: 480,
    outputPath: 'recordings/scripted.webm',
  }, config, manager)
  assert.ok(scripted.bytes > 0)
  assert.equal(scripted.actions, 2)
  note('scripted recording ok', scripted.path, scripted.bytes)

  const tabs = await session.listTabs()
  assert.ok(tabs.length >= 5)
  note('tabs ok', tabs.map((tab) => tab.tabId).join(','))
} finally {
  await session?.dispose().catch(() => {})
  await manager.dispose().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}
note('SMOKE OK')
