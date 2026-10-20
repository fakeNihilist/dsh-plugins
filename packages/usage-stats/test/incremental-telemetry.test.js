/**
 * Regression tests for the checkpoint's telemetry block.
 *
 * The checkpoint may only carry state that can be recomputed from the logs: the
 * folded aggregate plus each session's cursor, route, and fingerprint. The warning
 * counters are per-PROCESS derivations of the corpus as this process found it, so
 * they must not be restored — `planPass`/`backfill` re-derive all of them, and a
 * restored counter would be added to instead of replaced. That bug made every
 * restart grow `sessionsScanned` by the corpus size and `sessionsFailed` /
 * `failureReasons[].count` by the unreadable sessions, so the panel claimed more
 * broken sessions the longer the host had been restarted.
 *
 * A "start" here is a fresh import of `index.js` through a cache-busting URL, which
 * gives the module-scope ledger a genuinely empty state. That is the same situation
 * `test/incremental-start.test.js` reaches through a child process; it is done
 * in-process because the sandbox forbids child-process pipes.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import test, { after } from 'node:test';

// Redirects the Host half's checkpoint into a throwaway directory. Imported for its
// side effect and before any fresh `index.js` module is loaded below.
import './support/isolated-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = pathToFileURL(join(HERE, '..', 'index.js')).href;

const SCRATCH = mkdtempSync(join(tmpdir(), 'usage-stats-telemetry-'));
const HOME_DIR = join(SCRATCH, 'home');
// Saved and restored so this file leaves the process environment as it found it:
// the suite can also run with --experimental-test-isolation=none, where every test
// file shares one process environment.
const PREVIOUS_HOME = process.env.USERPROFILE;
const PREVIOUS_HOME_ALIAS = process.env.HOME;
process.env.USERPROFILE = HOME_DIR;
process.env.HOME = HOME_DIR;
after(() => {
  if (PREVIOUS_HOME === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = PREVIOUS_HOME;
  if (PREVIOUS_HOME_ALIAS === undefined) delete process.env.HOME;
  else process.env.HOME = PREVIOUS_HOME_ALIAS;
  rmSync(SCRATCH, { recursive: true, force: true });
});

const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset();
const pad = (value) => (value < 10 ? `0${value}` : String(value));
const TODAY = (() => {
  const now = new Date(Date.now() + TZ_OFFSET_MINUTES * 60_000);
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
})();
/** Noon local today, so a settlement cannot land on a neighbouring day. */
const NOON = (() => {
  const parts = TODAY.split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2], 12) - TZ_OFFSET_MINUTES * 60_000;
})();

function routeEvent(seq) {
  return {
    type: 'request/header',
    seq,
    time: NOON,
    data: { header: { config: { provider: 'prov-a', model: 'model-a' } }, reason: 'initial' },
  };
}

function settlement(seq, tokens) {
  return {
    type: 'assistant/message',
    seq,
    time: NOON,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [] },
      stream: [],
      usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  };
}

// Write the readable session's artifact, so the store scan produces a fingerprint
// and a later start really skips its read: the counters must stay the same either
// way, and skipping is the path where a restored counter would accumulate.
const READ_DIR = join(HOME_DIR, '.dsh', 'sessions', '--w--', 'session-read');
mkdirSync(READ_DIR, { recursive: true });
writeFileSync(join(READ_DIR, 'session.v4.jsonl.zstd'), zstdCompressSync([
  JSON.stringify({ type: 'session', id: 'session-read', cwd: '/--w--', isSeeded: false }),
  JSON.stringify(routeEvent(0)),
  JSON.stringify(settlement(1, 100)),
].join('\n') + '\n'));

/** One plugin "start" against a fixed two-session corpus, one of them unreadable. */
let run = 0;
async function start() {
  run += 1;
  let route = null;
  const ctx = {
    effect: (fn) => {
      fn();
    },
    on: () => () => true,
    connection: {
      fetch: {
        register: (entry) => {
          route = entry.fetch;
          return () => true;
        },
      },
    },
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'session-read', cwd: '/--w--' } },
        { header: { id: 'session-broken', cwd: '/--w--' } },
      ],
      readSession: async (id) => {
        if (id === 'session-broken') throw new Error('archive is not migratable');
        return {
          session: { cwd: '/--w--', isSeeded: false },
          events: [routeEvent(0), settlement(1, 100)],
          inheritedEventCount: 0,
        };
      },
    },
  };
  const { DATA_PATH, apply } = await import(`${INDEX}?telemetry=${run}`);
  apply(ctx);
  const response = await route(new Request(`http://localhost${DATA_PATH}?days=371`));
  assert.equal(response.status, 200);
  return response.json();
}

test('warning counters are re-derived per start, not restored from the checkpoint', async () => {
  const cold = await start();
  assert.equal(cold.warnings.sessionsScanned, 1, 'the pass counts the readable session once');
  assert.equal(cold.warnings.sessionsFailed, 1, 'and reports the one unreadable session');
  assert.equal(cold.warnings.failureReasons.length, 1, 'with its cause listed once');
  assert.equal(cold.warnings.failureReasons[0].count, 1, 'and counted once');

  // The bug: each restart restored these counters and then re-derived on top of
  // them, so a second start reported scanned=2 while folding the same corpus.
  for (const label of ['second', 'third']) {
    const restarted = await start();
    assert.deepEqual(restarted.warnings, cold.warnings, `the ${label} start reports the same warnings`);
    assert.deepEqual(restarted.totals, cold.totals, `the ${label} start reports the same totals`);
  }

  // The on-disk shape is the durable contract: counters that describe this process
  // must not be in the file at all, otherwise a future reader can restore them again.
  const stateFile = join(process.env.DSH_USAGE_STATS_STATE, 'ledger.json');
  const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal('telemetry' in stored, false, 'the checkpoint stores no per-process telemetry');
});
