/**
 * Regression tests for the Host half's live settlement feed.
 *
 * The corpus pass and the live feed must partition sessions between them exactly
 * once. The bug these pin down: the feed refused every session the pass had not
 * already folded, and the pass only ever ran once per process — so every
 * conversation started while the server was up contributed nothing at all, and
 * "today" showed only what the pass had found on disk at its first request.
 *
 * The Host half keeps its ledger in module scope, so these cases run in one
 * process and in order: the first request seeds the corpus, and every later case
 * asserts the DELTA its own events produced rather than an absolute total.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// Redirects the Host half's checkpoint into a throwaway directory. Imported for its
// side effect and before anything activates the plugin.
import './support/isolated-state.js';
import { DATA_PATH, apply } from '../index.js';
import { localDayKey, totalOf } from '../usage-fold.js';

const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset();
const TODAY = localDayKey(Date.now(), TZ_OFFSET_MINUTES);

/** Noon local of a day key, so a settlement cannot land on a neighbouring day. */
function noonLocal(day) {
  const parts = day.split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2], 12) - TZ_OFFSET_MINUTES * 60_000;
}

const NOON = noonLocal(TODAY);

/** One `assistant/message` carrying a settlement. */
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
      usage: {
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };
}

/** One `request/header` naming the route for the settlements that follow. */
function header(seq, provider, model) {
  return {
    type: 'request/header',
    seq,
    time: NOON,
    data: { header: { config: { provider, model } }, reason: 'initial' },
  };
}

/**
 * Activate the plugin over a stub context and corpus.
 * @param {{header: object, events: object[], unreadable?: boolean}[]} sessions - the corpus.
 * @returns {{emit: Function, get: Function}} the live feed and the route.
 */
function harness(sessions) {
  let live = null;
  let route = null;
  const ctx = {
    effect: (fn) => {
      fn();
    },
    on: (name, fn) => {
      if (name === 'session/event') live = fn;
      return () => true;
    },
    connection: {
      fetch: {
        register: (entry) => {
          route = entry.fetch;
          return () => true;
        },
      },
    },
    sessionQuery: {
      listSessions: async () => sessions.map((entry) => ({ header: entry.header })),
      readSession: async (id) => {
        const entry = sessions.find((candidate) => candidate.header.id === id);
        if (entry === undefined) throw new Error(`no such session: ${id}`);
        if (entry.unreadable === true) throw new Error('archive is not migratable');
        return {
          session: { cwd: entry.cwd ?? '/work', isSeeded: entry.isSeeded === true },
          events: entry.events,
          inheritedEventCount: entry.inheritedEventCount ?? 0,
        };
      },
    },
  };
  apply(ctx);
  return {
    emit: (session, event) => live(session, event),
    get: async () => {
      const response = await route(new Request(`http://localhost${DATA_PATH}?days=371`));
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

const EARLY_LIVE = { id: 'early-session', header: { cwd: '/work' } };
const FRESH_LIVE = { id: 'fresh-session', header: { cwd: '/work' } };
const BROKEN_LIVE = { id: 'broken-session', header: { cwd: '/work' } };

/** Tokens the payload filed under the `unknown` fallback route. */
function unknownTotal(payload) {
  return (payload.routes ?? [])
    .filter((row) => row.provider === 'unknown' || row.model === 'unknown')
    .reduce((sum, row) => sum + totalOf(row), 0);
}

/** Tokens the payload attributed to one provider. */
function routeTotal(payload, provider) {
  return (payload.routes ?? [])
    .filter((row) => row.provider === provider)
    .reduce((sum, row) => sum + totalOf(row), 0);
}

/** A readable session that already existed when the corpus pass ran. */
const EARLY = {
  header: { id: 'early-session', cwd: '/work' },
  events: [header(1, 'prov-a', 'model-a'), settlement(2, 100)],
};

/** A session the pass lists but can never read, with no legacy archive behind it. */
const BROKEN = { header: { id: 'broken-session', cwd: '/work' }, events: [], unreadable: true };

test('the corpus pass folds a listed session and reports an unreadable one', async () => {
  const host = harness([EARLY, BROKEN]);

  // The session is on disk but nothing has enumerated the corpus yet. If the feed
  // claimed this settlement it would also create the cursor that makes the pass
  // skip the session — stranding the log's own settlement behind it forever.
  host.emit(EARLY_LIVE, settlement(99, 999));

  const payload = await host.get();
  assert.equal(payload.today.calls, 1, 'counts the log settlement, not the live one');
  assert.equal(totalOf(payload.today), 100, 'the live settlement must not be folded yet');
  assert.equal(payload.warnings.sessionsScanned, 1);
  assert.equal(payload.warnings.sessionsFailed, 1, 'the unreadable log is reported, not counted');
});

test('a session the corpus pass never listed is adopted by the live feed', async () => {
  const host = harness([EARLY]);
  const before = await host.get();

  // Every conversation started while the server is up looks exactly like this: a
  // session id no enumeration will ever list.
  host.emit(FRESH_LIVE, header(1, 'prov-b', 'model-b'));
  host.emit(FRESH_LIVE, settlement(2, 500));
  host.emit(FRESH_LIVE, settlement(3, 700));

  const after = await host.get();
  assert.equal(after.today.calls - before.today.calls, 2, 'both live settlements are folded');
  assert.equal(totalOf(after.today) - totalOf(before.today), 1200);
  const fresh = after.routes.find((row) => row.provider === 'prov-b');
  assert.ok(fresh !== undefined, 'the live session keeps its live route attribution');
  assert.equal(fresh.model, 'model-b');
  assert.equal(totalOf(fresh), 1200);
});

test('a listed session still folds only events beyond the pass cursor', async () => {
  const host = harness([EARLY]);
  const before = await host.get();

  // The pass folded `EARLY` through seq 2, so a replay at or below it is already
  // counted while a later settlement is new.
  host.emit(EARLY_LIVE, settlement(2, 5000));
  host.emit(EARLY_LIVE, settlement(4, 250));

  const after = await host.get();
  assert.equal(after.today.calls - before.today.calls, 1, 'the replayed settlement is not counted twice');
  assert.equal(totalOf(after.today) - totalOf(before.today), 250);
});

test('a settlement a folded session produces after the pass keeps its model', async () => {
  // The field shape behind the phantom `unknown` model in the ring: `request/header`
  // is a CHANGE record, not a per-request one, so a session that keeps running on
  // the same route appends no new one. The pass folds that session's history and its
  // header becomes history too — leaving the feed with nothing to attribute the
  // session's next settlement to, which it filed as `unknown` with real tokens under
  // it. The pass has to leave the route it ended on behind for the feed.
  const host = harness([EARLY]);
  const before = await host.get();

  host.emit(EARLY_LIVE, settlement(5, 400));

  const after = await host.get();
  assert.equal(unknownTotal(after) - unknownTotal(before), 0, 'nothing is filed under a phantom route');
  const named = routeTotal(after, 'prov-a') - routeTotal(before, 'prov-a');
  assert.equal(named, 400, 'the settlement joined the route the log last named');
  const row = after.routes.find((candidate) => candidate.provider === 'prov-a');
  assert.equal(row.model, 'model-a', 'and it kept that route\'s model');
});

test('a session the pass could not read hands its live settlements to the feed', async () => {
  // BROKEN is LISTED here, which is what makes this the release path rather than the
  // generic "never listed" one: the pass claims a listed session's history, so it has
  // to hand the session back when it turns out to be unreadable, or the feed would
  // refuse a settlement that no other contributor can count.
  const host = harness([EARLY, BROKEN]);
  const before = await host.get();
  assert.equal(before.warnings.sessionsFailed, 1, 'the listed session is reported unreadable');

  // Nothing else will ever count this session: the pass gave up on its history and
  // will not list it again, so the feed has to take its settlements from here.
  host.emit(BROKEN_LIVE, settlement(9, 320));

  const after = await host.get();
  assert.equal(after.today.calls - before.today.calls, 1, 'the released session is adopted by the feed');
  assert.equal(totalOf(after.today) - totalOf(before.today), 320);
  // This log names no route at all, so `unknown` is the honest answer here rather
  // than a bug: the fallback exists for exactly this, and must not be removed.
  assert.equal(unknownTotal(after) - unknownTotal(before), 320, 'a route-less session reports unknown');
  // And it is not re-counted on every later poll.
  const settled = await host.get();
  assert.equal(settled.today.calls, after.today.calls, 'the adoption does not repeat');
});
