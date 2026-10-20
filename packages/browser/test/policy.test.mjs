import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAllowedUrl,
  classifyHost,
  isWithin,
  normalizeBrowserUrl,
  resolveArtifactPath,
  sanitizeFilename,
} from '../src/policy.js'

test('bare hosts upgrade to the right protocol', () => {
  assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com/')
  assert.equal(normalizeBrowserUrl('localhost:3000'), 'http://localhost:3000/')
  assert.equal(normalizeBrowserUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x')
  assert.equal(normalizeBrowserUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(normalizeBrowserUrl('about:blank'), 'about:blank')
})

test('unsafe protocols and credentials are refused', () => {
  assert.throws(() => normalizeBrowserUrl('javascript:alert(1)'), /not allowed/)
  assert.throws(() => normalizeBrowserUrl('data:text/html,hi'), /not allowed/)
  assert.throws(() => normalizeBrowserUrl('file:///etc/passwd'), /file: URLs are disabled/)
  assert.throws(() => normalizeBrowserUrl('https://user:pass@example.com'), /credentials/)
  assert.throws(() => normalizeBrowserUrl('about:config'), /about:blank/)
})

test('file URLs can be enabled explicitly', () => {
  assert.equal(normalizeBrowserUrl('file:///tmp/a.html', { allowFileUrls: true }), 'file:///tmp/a.html')
})

test('address classification covers loopback, private, link-local and metadata', () => {
  assert.equal(classifyHost('127.0.0.1'), 'loopback')
  assert.equal(classifyHost('::1'), 'loopback')
  assert.equal(classifyHost('10.1.2.3'), 'private')
  assert.equal(classifyHost('172.20.1.1'), 'private')
  assert.equal(classifyHost('192.168.1.1'), 'private')
  assert.equal(classifyHost('169.254.1.1'), 'link-local')
  assert.equal(classifyHost('169.254.169.254'), 'metadata')
  assert.equal(classifyHost('metadata.google.internal'), 'metadata')
  assert.equal(classifyHost('example.com'), 'public')
  assert.equal(classifyHost('0.0.0.0'), 'blocked')
})

test('network policy allows loopback but refuses private and metadata', async () => {
  await assert.doesNotReject(assertAllowedUrl('http://127.0.0.1:3000/', { allowPrivateNetwork: 'loopback' }))
  await assert.doesNotReject(assertAllowedUrl('http://localhost:8080/', { allowPrivateNetwork: 'loopback' }))
  await assert.rejects(assertAllowedUrl('http://10.0.0.5/', { allowPrivateNetwork: 'loopback' }), /policy_denied|private/)
  await assert.rejects(assertAllowedUrl('http://169.254.169.254/', { allowPrivateNetwork: 'all' }), /policy_denied|metadata/)
  await assert.rejects(assertAllowedUrl('http://127.0.0.1/', { allowPrivateNetwork: 'none' }), /policy_denied|loopback/)
  await assert.doesNotReject(assertAllowedUrl('http://10.0.0.5/', { allowPrivateNetwork: 'all' }))
})

test('filenames are sanitized and path traversal is removed', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFilename('a:b*c?.txt'), 'a-b-c-.txt')
  assert.equal(sanitizeFilename('CON'), '_CON')
  assert.equal(sanitizeFilename(''), 'download')
  assert.ok(sanitizeFilename('x'.repeat(300)).length <= 120)
})

test('artifact paths stay inside their root', () => {
  const root = 'D:/work/session'
  assert.equal(isWithin(root, 'D:/work/session/shots/a.png'), true)
  assert.equal(isWithin(root, 'D:/work/session-other/a.png'), false)
  assert.equal(isWithin(root, 'D:/work/a.png'), false)
  const destination = resolveArtifactPath(root, '.dsh-browser/shots', 'a.png')
  assert.match(destination.replace(/\\/g, '/'), /\/session\/\.dsh-browser\/shots\/a\.png$/)
})
