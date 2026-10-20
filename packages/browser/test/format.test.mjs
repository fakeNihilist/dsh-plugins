import test from 'node:test'
import assert from 'node:assert/strict'
import { formatAction, formatDialog, formatDownloads, formatTabs, formatView } from '../src/format.js'
import { truncateSnapshot, UNTRUSTED_PAGE_NOTICE } from '../src/snapshot.js'

test('snapshot truncation keeps a line boundary and names the escape hatch', () => {
  const text = `${'line\n'.repeat(100)}end`
  const truncated = truncateSnapshot(text, 50)
  assert.match(truncated, /\[truncated:/)
  assert.match(truncated, /browser_snapshot/)
  assert.ok(truncated.length < text.length)
})

test('the untrusted-page notice is stable', () => {
  assert.match(UNTRUSTED_PAGE_NOTICE, /untrusted/i)
})

test('tab and dialog formatting is model-readable', () => {
  const tabs = formatTabs([
    { tabId: 'tab-1', url: 'https://a.test/', title: 'A', active: true, lifecycle: 'active' },
    { tabId: 'tab-2', url: 'https://b.test/', title: 'B', active: false, lifecycle: 'deliverable' },
  ], 'tab-1')
  assert.match(tabs, /tab-1 \(active\): https:\/\/a\.test\/ — A/)
  assert.match(tabs, /tab-2 \(deliverable\): https:\/\/b\.test\/ — B/)
  assert.equal(formatTabs([]), 'No browser tabs are open.')

  assert.match(formatDialog(null), /No JavaScript dialog/)
  assert.match(formatDialog({ type: 'confirm', message: 'Sure?' }), /confirm: Sure\?/)
})

test('action and downloads formatting includes recovery facts', () => {
  const action = formatAction({ action: 'click', target: 'role=button name="Go"', url: 'https://a.test/', title: 'A' })
  assert.match(action, /Done: click role=button name="Go"/)
  assert.match(action, /URL: https:\/\/a\.test\//)

  const downloads = formatDownloads([
    { id: 'dl-1', state: 'saved', bytes: 12, path: '/tmp/a.txt' },
    { id: 'dl-2', state: 'failed', error: 'nope' },
  ])
  assert.match(downloads, /dl-1: saved 12 bytes/)
  assert.match(downloads, /dl-2: failed \(nope\)/)

  assert.match(formatView({ visible: false, changed: false, restored: 0 }), /already hidden/)
  assert.match(formatView({ visible: true, changed: true, restored: 2 }), /separate Chrome window; reopened 2 tab/)
})
