/**
 * Tests for the incremental start.
 *
 * A cold pass reads every session log, and measurement on a real store puts 99% of
 * its ~2 s in that read. The checkpoint lets a start skip the logs that have not
 * moved since they were folded. That is a cache in front of the only numbers the
 * plugin has, so the tests here are about the two ways it could lie:
 *
 *  - skipping a log that DID change, which would lose its tokens for good, and
 *  - re-folding a log that did not, which is merely slow.
 *
 * Each case runs the plugin in a CHILD PROCESS against a scratch store, because the
 * Host half keeps its ledger in module scope: an in-process rerun could not tell a
 * resumed start from a continued one.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import test, { after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'plugin-run.js');

const SCRATCH = mkdtempSync(join(tmpdir(), 'usage-stats-resume-'));
const HOME_DIR = join(SCRATCH, 'home');
const STATE_DIR = join(SCRATCH, 'state');
after(() => {
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

/** One `assistant/message` carrying `tokens` input tokens. */
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

/**
 * One `request/header` naming the session's route.
 *
 * Present in every fixture session on purpose: `request/header` is a change record,
 * so a session that keeps running never writes another one. Route attribution after
 * a restart therefore depends entirely on the checkpoint carrying it forward, which
 * is the failure that once put a phantom `unknown` model in the ring.
 */
function routeEvent(seq, slug) {
  return {
    type: 'request/header',
    seq,
    time: NOON,
    data: { header: { config: { provider: `prov-${slug}`, model: `model-${slug}` } }, reason: 'initial' },
  };
}

/**
 * Write one session's log as a multi-frame zstd artifact, the shape the real store
 * uses.
 * @param {string} slug - workspace directory name.
 * @param {string} id - session id.
 * @param {object[]} events - the log's events.
 */
function writeSession(slug, id, events) {
  const dir = join(HOME_DIR, '.dsh', 'sessions', slug, id);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', id, cwd: `/${slug}`, isSeeded: false }),
    JSON.stringify(routeEvent(0, slug)),
    ...events.map((event) => JSON.stringify(event)),
  ];
  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, zstdCompressSync(`${lines.join('\n')}\n`));
  return file;
}

/**
 * Append one more FRAME to a session log, which is how the store grows one.
 *
 * Plain text appended to a zstd artifact is not part of any frame and a reader
 * walking frames never sees it, so appending raw JSON here would test a write the
 * real store never performs.
 * @param {string} file - the artifact.
 * @param {object} event - the event to append.
 */
function appendFrame(file, event) {
  appendFileSync(file, zstdCompressSync(`${JSON.stringify(event)}\n`));
}

/**
 * Run one plugin start in a child process.
 * @param {Record<string, string>} [extraEnv] - further environment for the child.
 * @returns {{readCalls: number, sessions: number, totals: object, today: object, unknown: number, workspaces: string[], days: string[], after?: object}}
 */
function start(extraEnv = {}) {
  const output = execFileSync(process.execPath, [FIXTURE], {
    encoding: 'utf8',
    env: {
      ...process.env,
      USERPROFILE: HOME_DIR,
      HOME: HOME_DIR,
      DSH_USAGE_STATS_STATE: STATE_DIR,
      ...extraEnv,
    },
  });
  return JSON.parse(output.trim().split('\n').at(-1));
}

// Three sessions, each with two settlements, plus a third settlement on the newest.
// Distinct token counts make a lost or double-counted log visible in the total.
const A = writeSession('--w-one--', 'session-a', [settlement(1, 100), settlement(2, 200)]);
writeSession('--w-one--', 'session-b', [settlement(1, 300), settlement(2, 400)]);
writeSession('--w-two--', 'session-c', [settlement(1, 500), settlement(2, 600)]);

test('a first start reads the whole corpus and a second start reads nothing', () => {
  const cold = start();
  assert.equal(cold.sessions, 3, 'the store holds three sessions');
  assert.equal(cold.readCalls, 3, 'a cold pass reads every log');
  assert.equal(cold.totals.calls, 6);
  assert.equal(cold.unknown, 0, 'every session names a route');

  const warm = start();
  assert.equal(warm.readCalls, 0, 'an unchanged corpus is not read again');
  assert.equal(warm.totals.calls, cold.totals.calls, 'and the numbers are identical');
  assert.deepEqual(warm.totals, cold.totals);
  assert.deepEqual(warm.today, cold.today);
  assert.deepEqual(warm.days, cold.days, 'the same days carry usage');
  assert.deepEqual(warm.workspaces, cold.workspaces, 'and the same workspaces are listed');
});

test('only the session that changed is read again, and its new tokens appear', () => {
  const before = start();
  assert.equal(before.readCalls, 0, 'still nothing to read');

  // Append one settlement to ONE session. This is what a resumed conversation does,
  // and it is the case that must never be skipped: the log grew, so the checkpoint's
  // fingerprint no longer describes it.
  appendFrame(A, settlement(3, 700));

  const after = start();
  assert.equal(after.readCalls, 1, 'only the log that moved is read');
  assert.equal(after.totals.calls, before.totals.calls + 1, 'exactly one settlement was added');
  assert.equal(after.totals.inputTokens, before.totals.inputTokens + 700);
  assert.equal(after.unknown, 0, 'the route survived the resume');
});

test('a resumed session is not double counted', () => {
  const first = start();
  const second = start();
  assert.equal(second.totals.calls, first.totals.calls, 'the resumed log is folded once');
  assert.equal(second.readCalls, 0);
});

test('a settlement arriving after a restart keeps the route the checkpoint restored', () => {
  const before = start();
  assert.equal(before.readCalls, 0, 'the corpus is unchanged, so nothing is read');
  assert.equal(before.unknown, 0, 'and nothing is filed under the fallback route');

  // The session's only `request/header` is inside its log, which this start did NOT
  // read. The route can therefore only come from the checkpoint. Without it the feed
  // has nothing to attribute the settlement to and files it as `unknown` — the
  // phantom model that once appeared in the ring.
  const after = start({ LIVE_SESSION: 'session-a', LIVE_TOKENS: '900', LIVE_SEQ: '9999' });
  assert.notEqual(after.after, undefined, 'the live settlement was folded');
  assert.equal(after.after.totals.calls, before.totals.calls + 1, 'it was counted exactly once');
  assert.equal(after.after.totals.inputTokens, before.totals.inputTokens + 900);
  assert.equal(after.after.unknown, 0, 'and it kept its model across the restart');
});

test('a session that disappears rebuilds instead of keeping its tokens', () => {
  const before = start();
  rmSync(join(HOME_DIR, '.dsh', 'sessions', '--w-two--', 'session-c'), { recursive: true, force: true });

  const after = start();
  assert.equal(after.sessions, 2, 'the store now holds two sessions');
  assert.equal(after.totals.calls, before.totals.calls - 2, 'the removed session is gone from the totals');
  assert.equal(after.totals.inputTokens, before.totals.inputTokens - 1100);
});

test('the checkpoint is a cache: deleting it costs a re-read, not a wrong number', () => {
  const before = start();
  rmSync(STATE_DIR, { recursive: true, force: true });

  const rebuilt = start();
  assert.equal(rebuilt.readCalls, 2, 'every remaining log is read again');
  assert.deepEqual(rebuilt.totals, before.totals, 'and the numbers come out the same');
});
