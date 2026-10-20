/**
 * Tests for the checkpoint module.
 *
 * The checkpoint is a cache in front of the plugin's only numbers, so the tests
 * here are about the two ways a cache can lie: accepting something it should not
 * (a stale or foreign file served as current) and rejecting something it should
 * keep. A false rejection only costs a slower start, so the reader is deliberately
 * strict, and these cases pin that strictness down.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import {
  artifactFingerprints,
  CHECKPOINT_VERSION,
  checkpointDir,
  checkpointPath,
  FOLD_VERSION,
  fingerprintMatches,
  readCheckpoint,
  routeEventOf,
  writeCheckpoint,
} from '../checkpoint.js';
import { routeOf } from '../usage-fold.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'usage-stats-checkpoint-'));
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** A checkpoint body good enough to be accepted. */
function validPayload() {
  return {
    version: CHECKPOINT_VERSION,
    foldVersion: FOLD_VERSION,
    tzOffsetMinutes: 480,
    savedAt: Date.now(),
    aggregate: {
      byDay: {},
      byDayWorkspace: {},
      byDayRoute: {},
      byWorkspace: {},
      byWorkspaceRoute: {},
      byWorkspaceRouteDay: {},
      byRoute: {},
      totals: { calls: 0 },
      minDay: null,
      malformedUsageEvents: 0,
    },
    sessions: { 'session-a': { cursor: 7, route: { provider: 'p', model: 'm' }, size: 10, mtimeMs: 20 } },
    telemetry: { sessionsScanned: 1, sessionsFailed: 0, recovered: 0, failureReasons: [] },
  };
}

/** A fresh file path inside the scratch directory. */
function scratchFile(name) {
  return join(SCRATCH, name);
}

test('a written checkpoint reads back, and dies on any disagreement', () => {
  const file = scratchFile('round-trip.json');
  assert.equal(writeCheckpoint(file, validPayload()), true, 'the write reports success');

  const read = readCheckpoint(file, { tzOffsetMinutes: 480 });
  assert.notEqual(read, null, 'a matching file is accepted');
  assert.equal(read.version, CHECKPOINT_VERSION);
  assert.deepEqual(read.sessions['session-a'].route, { provider: 'p', model: 'm' });

  // Day buckets were cut with the writing process's offset: adopting them under a
  // different one would silently move every day boundary.
  assert.equal(readCheckpoint(file, { tzOffsetMinutes: 0 }), null, 'a different timezone is refused');

  for (const [field, value] of [['version', 99], ['foldVersion', FOLD_VERSION + 1]]) {
    const mutated = { ...validPayload(), [field]: value };
    writeCheckpoint(file, mutated);
    assert.equal(
      readCheckpoint(file, { tzOffsetMinutes: 480 }),
      null,
      `a different ${field} is refused`,
    );
  }
});

test('an unusable checkpoint reads as absent rather than throwing', () => {
  const missing = scratchFile('never-written.json');
  assert.equal(readCheckpoint(missing, { tzOffsetMinutes: 480 }), null, 'a missing file is not an error');

  const truncated = scratchFile('truncated.json');
  // What a crash mid-write would leave behind if the write were not atomic.
  writeFileSync(truncated, '{"version":1,"aggregate":{"byDay":');
  assert.equal(readCheckpoint(truncated, { tzOffsetMinutes: 480 }), null, 'a truncated file is refused');

  const wrongShape = scratchFile('wrong-shape.json');
  writeFileSync(wrongShape, JSON.stringify({ version: CHECKPOINT_VERSION, foldVersion: FOLD_VERSION, tzOffsetMinutes: 480, aggregate: {}, sessions: {} }));
  assert.equal(readCheckpoint(wrongShape, { tzOffsetMinutes: 480 }), null, 'an aggregate missing its tables is refused');

  const notJson = scratchFile('not-json.json');
  writeFileSync(notJson, 'this is not json at all');
  assert.equal(readCheckpoint(notJson, { tzOffsetMinutes: 480 }), null, 'arbitrary bytes are refused');
});

test('a write leaves no partial file behind', () => {
  const file = scratchFile('atomic.json');
  assert.equal(writeCheckpoint(file, validPayload()), true);
  const first = readFileSync(file, 'utf8');
  assert.equal(writeCheckpoint(file, { ...validPayload(), savedAt: first.length }), true);
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')), 'the file is complete JSON after a rewrite');

  // The temp file the rename consumes must not survive as clutter beside it.
  assert.throws(() => readFileSync(`${file}.tmp`, 'utf8'), 'no temp file is left behind');
});

test('the state directory can be redirected', () => {
  const previous = process.env.DSH_USAGE_STATS_STATE;
  process.env.DSH_USAGE_STATS_STATE = join(SCRATCH, 'custom-state');
  try {
    assert.equal(checkpointDir(), join(SCRATCH, 'custom-state'));
    assert.equal(checkpointPath(), join(SCRATCH, 'custom-state', 'ledger.json'));
  } finally {
    if (previous === undefined) delete process.env.DSH_USAGE_STATS_STATE;
    else process.env.DSH_USAGE_STATS_STATE = previous;
  }
});

test('a fingerprint matches only when both size and time agree', () => {
  const stored = { size: 10, mtimeMs: 20 };
  assert.equal(fingerprintMatches(stored, { size: 10, mtimeMs: 20 }), true);
  // Either signal alone can repeat: a rewrite can land on the same length, and a
  // coarse timestamp can stamp two writes alike.
  assert.equal(fingerprintMatches(stored, { size: 10, mtimeMs: 21 }), false, 'a newer mtime is a change');
  assert.equal(fingerprintMatches(stored, { size: 11, mtimeMs: 20 }), false, 'a longer log is a change');
  assert.equal(fingerprintMatches(stored, undefined), false, 'a missing artifact is never fresh');
  assert.equal(fingerprintMatches(undefined, { size: 10, mtimeMs: 20 }), false, 'an unstamped session is never fresh');
});

test('artifact fingerprints track each session and ignore everything else', () => {
  const root = join(SCRATCH, 'store');
  const older = join(root, '--w--', 'session-old', 'session.v3.jsonl.zstd');
  const newest = join(root, '--w--', 'session-old', 'session.v4.jsonl.zstd');
  const other = join(root, '--w--', 'session-two', 'session.v4.jsonl.zstd');
  for (const file of [older, newest, other]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, zstdCompressSync('{}'));
  }
  // Decoys: a non-log file, and a directory that looks like one.
  writeFileSync(join(root, '--w--', 'session-old', 'notes.txt'), 'ignore me');
  mkdirSync(join(root, '--w--', 'session-old', 'nested'), { recursive: true });

  const fingerprints = artifactFingerprints(root);
  assert.equal(fingerprints.size, 2, 'one entry per session, not per artifact');
  const newestSize = readFileSync(newest).length;
  // `older` and `newest` are written in that order, so the newest generation wins.
  assert.equal(fingerprints.get('session-old').size, newestSize, 'the newest generation represents the session');
  assert.ok(fingerprints.has('session-two'));

  // A layout this does not recognize yields nothing, which reads as "everything
  // changed" — a full pass, never a skipped one.
  assert.equal(artifactFingerprints(join(SCRATCH, 'no-such-store')).size, 0);
});

test('a stored route rebuilds into an event the fold reads identically', () => {
  const route = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const event = routeEventOf(route);
  assert.deepEqual(routeOf(event.data), route, 'the rebuilt event names the same route');

  // The point of rebuilding rather than persisting: a real `request/header` carries
  // the whole tool table, which is what makes these logs tens of megabytes.
  assert.ok(JSON.stringify(event).length < 200, 'the rebuilt event stays tiny');
  assert.equal(routeEventOf(null), null);
  assert.equal(routeEventOf(undefined), null);
  assert.equal(routeEventOf({}), null, 'a route naming neither field is not a route');
});
