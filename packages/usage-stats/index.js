/**
 * Host half of the usage-statistics plugin.
 *
 * Folds provider-reported token usage out of the durable session corpus and
 * serves it to the plugin's own browser half over one authenticated Fetch route.
 *
 * Why an HTTP route instead of a Remote namespace: the Client's `ctx.remote.*`
 * namespaces are a build-time fixed set assembled by `dsh-api-remotes/client`,
 * which an installed bundle cannot extend. An exact Fetch route on the shared
 * `/api` channel is the documented seam for exactly this case, and
 * `dsh-session-log-export` is the reference consumer.
 *
 * Nothing here is model-visible: the plugin registers no tool and contributes no
 * prompt, so it cannot affect the model request or its KV cache.
 *
 * @module dsh-plugin-usage-stats
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import {
  buildPayload,
  emptyAggregate,
  enumerateDays,
  foldSessionIntoAggregate,
  localDayKey,
  routeOf,
  shiftDay,
} from './usage-fold.js';
import {
  artifactFingerprints,
  checkpointPath,
  CHECKPOINT_VERSION,
  FOLD_VERSION,
  fingerprintMatches,
  readCheckpoint,
  routeEventOf,
  writeCheckpoint,
} from './checkpoint.js';

/** Cordis plugin name. */
export const name = 'usage-stats';

/**
 * Services this plugin needs. `sessionQuery` reads the whole historical corpus;
 * `connection` owns the `/api` channel the browser half fetches from.
 */
export const inject = ['connection', 'sessionQuery'];

/** Exact Fetch route path, absolute below the `/api` channel. */
export const DATA_PATH = '/api/usage-statistics.data';

/**
 * Default heatmap window: a full year plus the current partial month.
 *
 * This is the *heatmap's* span. The per-model views get their own window from
 * `buildPayload` (the corpus's own span inside this one), so a young corpus is not
 * padded out to a year of empty columns there.
 */
const DEFAULT_WINDOW_DAYS = 371;

/** Sessions folded per backfill batch, balancing latency against I/O churn. */
const BACKFILL_BATCH_SIZE = 8;

/** Bounded number of distinct failure causes retained for the field diagnostic. */
const FAILURE_REASON_LIMIT = 20;

/** Live-fold errors echoed to the Host console before going quiet. */
const LIVE_FOLD_ERROR_LIMIT = 3;

/**
 * How long live settlements may go uncheckpointed.
 *
 * A settlement changes a handful of counters, so writing the checkpoint on every
 * one would replace a read problem with a write problem. The debounce is safe to
 * lose: an unwritten checkpoint simply means the next start re-reads the sessions
 * whose logs moved, which is exactly what it would have done anyway.
 */
const SAVE_DEBOUNCE_MS = 2_000;

/**
 * Module-level ledger of one server process.
 *
 * Kept per process rather than per fiber so an HMR re-activation does not lose
 * the folded corpus; the aggregate is derived purely from durable logs, so a
 * process restart simply rebuilds it.
 */
const ledger = {
  aggregate: emptyAggregate(),
  revision: 0,
  /**
   * Highest session seq already folded, per session id.
   *
   * Absence means this session has contributed nothing yet: either the corpus pass
   * still owns it, or no enumeration has run to decide who does, or it is simply
   * new and the live feed has not adopted it.
   */
  sessionCursor: new Map(),
  /** Last known route per session, so an incremental fold keeps model attribution. */
  sessionRoute: new Map(),
  /**
   * Sessions the persistence service can never read, mapped to a short reason.
   *
   * Without this set the backfill re-attempts them on every request: a handful of
   * unreadable legacy artifacts made the failure counter climb on each poll
   * forever rather than describing a fixed number of problems.
   */
  unreadable: new Map(),
  /**
   * Session ids the corpus pass listed, so the two contributors can partition the
   * corpus between them instead of racing over it.
   *
   * A listed session's history belongs to the pass — it reads the whole log, so a
   * live event for it must stay out of the aggregate until the cursor the pass
   * leaves behind takes over. A session the pass never listed has no other
   * contributor at all, and that is every conversation started while the server is
   * up: nothing else can ever count it.
   */
  corpus: new Set(),
  /**
   * Artifact fingerprint per session id, as of the moment the checkpoint captured
   * that session's tokens.
   *
   * This is what lets a start skip a session entirely: if the log's size and mtime
   * still match, nothing has been appended since it was folded, so re-reading it
   * cannot change a single number. Reading a log is 99% of a cold pass, so this one
   * comparison is where the whole optimisation lives.
   */
  fingerprints: new Map(),
  /**
   * The artifact scan the current pass planned against, so a folded session can be
   * stamped without walking the store again per session.
   */
  artifacts: new Map(),
  /**
   * Session ids the loaded checkpoint already accounts for.
   *
   * Held until the first listing can confirm every one of them still exists: a
   * folded aggregate cannot have one session subtracted from it, so a corpus that
   * shrank is a reason to throw the checkpoint away rather than keep its tokens.
   */
  checkpointSessions: new Set(),
  /** Set while the checkpoint on disk is behind the in-memory aggregate. */
  dirty: false,
  saveTimer: null,
  /** Set once the corpus has been enumerated, so backfill is a one-time job. */
  seeded: false,
  seeding: false,
  backfill: null,
  /** Live-fold errors, kept separate from session read failures. */
  liveFoldErrors: 0,
  /**
   * `corpusFailures` is 0 or 1, never a retry count, and it tracks the CURRENT
   * state rather than the process's history: it is set when an enumeration attempt
   * throws and cleared by the next one that succeeds, because a pass that succeeds
   * has listed and folded everything the failed one could not.
   */
  telemetry: { sessionsScanned: 0, sessionsFailed: 0, recovered: 0, corpusFailures: 0, failureReasons: [] },
  tzOffsetMinutes: 0,
};

/** Local timezone offset in minutes **east of UTC**, captured once per process. */
function localOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

//#region checkpoint

/**
 * Adopt a checkpoint written by an earlier process, if one can be trusted.
 *
 * Everything the checkpoint carries is derived state, so this never has to be
 * careful about what it loses: a rejected file means the pass folds the corpus from
 * the logs, which is what every start did before the checkpoint existed.
 *
 * The timezone is already in `ledger` by the time this runs, because day buckets
 * are cut with it and a checkpoint folded under a different offset would keep
 * yesterday's boundaries.
 */
function loadCheckpoint() {
  const stored = readCheckpoint(checkpointPath(), { tzOffsetMinutes: ledger.tzOffsetMinutes });
  if (stored === null) return;
  ledger.aggregate = stored.aggregate;
  for (const [id, entry] of Object.entries(stored.sessions)) {
    if (!isSessionEntry(entry)) continue;
    if (typeof entry.cursor === 'number' && Number.isFinite(entry.cursor)) {
      ledger.sessionCursor.set(id, entry.cursor);
    }
    const route = routeEventOf(entry.route);
    if (route !== null) ledger.sessionRoute.set(id, route);
    if (isFingerprint(entry)) ledger.fingerprints.set(id, { size: entry.size, mtimeMs: entry.mtimeMs });
    ledger.checkpointSessions.add(id);
  }
  // Telemetry is deliberately NOT restored. Its counters describe the corpus as
  // THIS process found it — sessions scanned, sessions unreadable, failure causes —
  // and `planPass`/`backfill` re-derive every one of them. Restoring them would add
  // this process's count on top of the previous process's, so the panel's "N
  // sessions unreadable" would grow with every restart.
}

/** Whether one checkpoint session entry has the shape this version wrote. */
function isSessionEntry(entry) {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry);
}

/** Whether an entry carries a usable artifact fingerprint. */
function isFingerprint(entry) {
  return typeof entry.size === 'number' && Number.isFinite(entry.size)
    && typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs);
}

/**
 * Throw the checkpoint away and go back to folding everything.
 *
 * Used when the corpus no longer matches what was folded: a session that has been
 * deleted cannot be subtracted from a folded aggregate, and rebuilding is both
 * cheap and exactly what the pass does anyway.
 */
function discardCheckpoint() {
  ledger.aggregate = emptyAggregate();
  ledger.sessionCursor.clear();
  ledger.sessionRoute.clear();
  ledger.fingerprints.clear();
  ledger.checkpointSessions.clear();
  ledger.telemetry = { sessionsScanned: 0, sessionsFailed: 0, recovered: 0, corpusFailures: 0, failureReasons: [] };
  ledger.dirty = true;
}

/** Snapshot the ledger into the checkpoint's on-disk shape. */
function checkpointPayload() {
  /** @type {Record<string, {cursor: number, route: object|null, size?: number, mtimeMs?: number}>} */
  const sessions = {};
  for (const [id, cursor] of ledger.sessionCursor) {
    const stored = ledger.fingerprints.get(id);
    const route = routeOf(ledger.sessionRoute.get(id)?.data) ?? null;
    sessions[id] = {
      cursor,
      route,
      ...(stored === undefined ? {} : { size: stored.size, mtimeMs: stored.mtimeMs }),
    };
  }
  return {
    version: CHECKPOINT_VERSION,
    foldVersion: FOLD_VERSION,
    tzOffsetMinutes: ledger.tzOffsetMinutes,
    savedAt: Date.now(),
    aggregate: ledger.aggregate,
    sessions,
    // No telemetry: those counters are per-process derivations, re-derived by the
    // next start, not durable facts about the corpus.
  };
}

/** Write the checkpoint now, if anything has moved since the last write. */
function flushCheckpoint() {
  if (ledger.saveTimer !== null) {
    clearTimeout(ledger.saveTimer);
    ledger.saveTimer = null;
  }
  if (!ledger.dirty) return;
  ledger.dirty = false;
  // A write failure is not surfaced: the cache is an optimisation, and a read-only
  // state directory must not turn into a broken panel.
  writeCheckpoint(checkpointPath(), checkpointPayload());
}

/** Mark the checkpoint stale and write it once the churn settles. */
function scheduleCheckpoint() {
  ledger.dirty = true;
  if (ledger.saveTimer !== null) return;
  ledger.saveTimer = setTimeout(() => {
    ledger.saveTimer = null;
    flushCheckpoint();
  }, SAVE_DEBOUNCE_MS);
  // A pending debounce must not hold the host process open on shutdown.
  if (typeof ledger.saveTimer.unref === 'function') ledger.saveTimer.unref();
}

//#endregion

/**
 * The first day a payload's window should cover.
 *
 * The requested span is the heatmap's year; it is a floor rather than a cap, so an
 * older corpus widens the window back to its own start instead of being truncated.
 * That matters because the per-model views read the same series: a model that ran
 * eighteen months ago has to stay listable, and it can only be reached if the
 * window still contains its days.
 *
 * The widened span is probed against the payload builder's own window limit rather
 * than restating it, so the two can never drift apart. That bound guards against a
 * single malformed timestamp (a year-0001 event, say): an over-long span would not
 * merely shorten the window, it would empty the whole payload.
 * @param {string|undefined} earliest - first day present in the aggregate, if any.
 * @param {string} requestedStart - `today - (days - 1)`, the requested span's start.
 * @param {string} today - the current local day.
 * @returns {string} the day the window should start on.
 */
export function windowStartFor(earliest, requestedStart, today) {
  if (typeof earliest !== 'string' || earliest.length === 0) return requestedStart;
  // Only ever widen: a future-dated event (clock skew) must not pull the start
  // forward past the requested span, or the heatmap would lose its recent days.
  if (earliest >= requestedStart) return requestedStart;
  // An unusable (absurdly long) span keeps the requested window rather than
  // handing `buildPayload` a range it would refuse to enumerate.
  return enumerateDays(earliest, today).length > 0 ? earliest : requestedStart;
}

/** Today's local calendar date. */
function todayKey() {
  const now = Date.now();
  return localDayKey(now, ledger.tzOffsetMinutes) ?? '1970-01-01';
}

/**
 * Exact count of fork-inherited leading events for one session log.
 *
 * Getting this wrong double-counts a fork parent's tokens, so it is computed rather
 * than assumed. The session-owned tagged marker sits exactly at the cut and is the
 * only reliable evidence: the SDK reconstructs the cut from that marker itself, and
 * the current physical header format never serializes `inheritedEventCount` at all
 * (only the legacy v0 artifacts carried such a field). A seeded log is also rejected
 * upstream if it lacks the tagged marker, so the marker is expected to be present.
 *
 * The `reported` fallback is therefore a defensive branch rather than a live path: it
 * exists so an unforeseen snapshot shape yields a plausible cut instead of silently
 * folding the whole inherited prefix. Note it is used as a COUNT, while the SDK's own
 * value is the marker's SEQ — the two differ by one on a log where both are present,
 * which is harmless because the extra skipped event is the marker itself and carries
 * no usage.
 *
 * Note that an UNTAGGED `session/end-seed` marker is a lifecycle boundary that
 * most ordinary sessions carry, so it must never be treated as a cut.
 *
 * @param {readonly unknown[]} events - the complete raw log.
 * @param {number} reported - `inheritedEventCount` from the session snapshot.
 * @param {boolean} isSeeded - whether the session header declares fork lineage.
 * @returns {number} the number of leading events to skip.
 */
export function inheritedCut(events, reported, isSeeded) {
  if (isSeeded !== true) return 0;
  let tagged = -1;
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue;
    if (raw.type !== 'session/end-seed') continue;
    if (raw.data !== undefined && raw.data !== null && raw.data.inherited === true) tagged = raw.seq;
  }
  if (typeof tagged === 'number' && tagged >= 0) return tagged + 1;
  return typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : 0;
}

/**
 * Fold one session's log, advancing its cursor.
 *
 * Sessions are re-read on the first backfill pass and never re-folded
 * event-by-event afterwards, so `cursor` carries the resume point. Route
 * attribution is seeded from `sessionRoute` because a pre-cut
 * `request/header` is the only thing naming the model for the next settlement.
 *
 * It also leaves the session's route behind for the live feed, which is the only
 * way a settlement that arrives after the pass keeps its model: by then the header
 * that named it is history the feed never saw.
 *
 * @param {{ id: string, cwd?: string | null, isSeeded?: boolean }} session - identity, workspace, fork lineage.
 * @param {readonly unknown[]} events - its complete raw log.
 * @param {number} reportedInherited - the snapshot's `inheritedEventCount`.
 */
function foldSession(session, events, reportedInherited) {
  const cut = inheritedCut(events, reportedInherited, session.isSeeded);
  const lastIndexed = ledger.sessionCursor.get(session.id);
  if (lastIndexed !== undefined) {
    const tail = [];
    let lastHeader = null;
    for (const raw of events) {
      if (typeof raw !== 'object' || raw === null) continue;
      const seq = raw.seq;
      if (typeof seq === 'number' && seq <= lastIndexed) {
        // Remember a pre-cursor route event so new settlements keep their model.
        if (raw.type === 'request/header' || raw.type === 'request/context') lastHeader = raw;
        continue;
      }
      if (lastHeader !== null) {
        tail.push(lastHeader);
        lastHeader = null;
      }
      tail.push(raw);
    }
    if (tail.length === 0) return;
    foldSessionIntoAggregate(
      ledger.aggregate,
      { events: tail, inheritedEventCount: 0, sessionId: session.id, cwd: session.cwd ?? null },
      { tzOffsetMinutes: ledger.tzOffsetMinutes },
    );
  } else {
    foldSessionIntoAggregate(
      ledger.aggregate,
      { events, inheritedEventCount: cut, sessionId: session.id, cwd: session.cwd ?? null },
      { tzOffsetMinutes: ledger.tzOffsetMinutes },
    );
  }

  let highest = lastIndexed ?? -1;
  // The route that governs this session's NEXT settlement. Tracked with the same
  // precedence the fold itself uses — the newest header wins, and a context only
  // counts until the next header replaces it — so the two can never disagree.
  let lastHeader = null;
  let lastContext = null;
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue;
    const seq = raw.seq;
    if (typeof seq === 'number' && seq > highest) highest = seq;
    if (raw.type === 'request/header') {
      if (routeOf(raw.data) !== null) {
        lastHeader = raw;
        lastContext = null;
      }
      continue;
    }
    if (raw.type === 'request/context' && lastContext === null && routeOf(raw.data) !== null) {
      lastContext = raw;
    }
  }
  ledger.sessionCursor.set(session.id, highest);

  // Seed the live feed's route cache for this session.
  //
  // `request/header` is a change record, not a per-request one: the corpus logs a
  // few hundred of them against thousands of settlements. So a session that keeps
  // running on the same route appends nothing new, and once the pass has folded its
  // history there is no route event left for the feed to read. Without this seed
  // every settlement a folded session produced after the pass was filed under
  // `unknown`, which is what put a phantom model in the ring.
  //
  // Seeding only, never overwriting: a route the feed saw live is at least as new
  // as anything this re-read can still be missing from the log.
  const lastRoute = lastHeader ?? lastContext;
  if (lastRoute !== null && !ledger.sessionRoute.has(session.id)) {
    ledger.sessionRoute.set(session.id, lastRoute);
  }
}

/**
 * Condense one read failure into a short, countable reason.
 *
 * The service's own message names absolute paths and internal error identities,
 * which is far too noisy for a panel line. Only the distinguishing clause is
 * kept, and each distinct reason is counted rather than repeated per attempt.
 * @param {unknown} error - the thrown value.
 * @returns {string} a single-line reason.
 */
export function reasonOf(error) {
  const raw = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  // The message reads `<inner cause>; source v0 artifact remains unchanged (raw log: <path>)`.
  const head = raw.split(' (raw log:')[0].split('; source ')[0];
  const cleaned = head.replace(/\s+/g, ' ').trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}\u2026` : cleaned;
}

/**
 * Mark one session permanently unreadable and record why, ONCE.
 *
 * Counting happens here rather than per attempt, so the reported tally describes
 * how many sessions are broken instead of how many times they were retried.
 * @param {string} sessionId - the session that cannot be read.
 * @param {unknown} error - the thrown value.
 */
function markUnreadable(sessionId, error) {
  const reason = reasonOf(error);
  // The pass has given up on this log, so it is no longer the pass's to own: its
  // live settlements have no other contributor and must be free to be folded.
  ledger.corpus.delete(sessionId);
  if (ledger.unreadable.has(sessionId)) return;
  ledger.unreadable.set(sessionId, reason);
  ledger.telemetry.sessionsFailed += 1;
  const existing = ledger.telemetry.failureReasons.find((entry) => entry.reason === reason);
  if (existing !== undefined) {
    existing.count += 1;
    return;
  }
  if (ledger.telemetry.failureReasons.length >= FAILURE_REASON_LIMIT) return;
  ledger.telemetry.failureReasons.push({
    key: reason,
    reason,
    count: 1,
    example: sessionId,
  });
}

//#region legacy (v0) artifact recovery

/**
 * Sessions whose log the persistence service refuses to migrate are still plain
 * zstd-compressed JSONL on disk. Those archives hold real provider usage, so
 * they are read directly instead of being dropped.
 *
 * This bypasses the session-format contract deliberately and reads ONLY the two
 * event types the fold needs; every other event is ignored. A session with a
 * readable vN generation never reaches this path, so a migrated session is never
 * counted twice.
 */

/** Read the 4-byte little-endian magic of a zstd frame. */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Decompress every zstd frame in one buffer.
 * @param {Buffer} input - multi-frame zstd bytes.
 * @returns {string} the decoded text.
 */
function decompressAllFrames(input) {
  const parts = [];
  let offset = 0;
  while (offset + 4 <= input.length && input.readUInt32LE(offset) === ZSTD_MAGIC) {
    let decoded;
    try {
      decoded = zstdDecompressSync(input.subarray(offset));
    } catch {
      break;
    }
    if (decoded === undefined || decoded.length === 0) break;
    parts.push(decoded.toString('utf8'));
    let next = -1;
    for (let index = offset + 4; index + 4 <= input.length; index += 1) {
      if (input.readUInt32LE(index) === ZSTD_MAGIC) {
        next = index;
        break;
      }
    }
    if (next === -1) break;
    offset = next;
  }
  return parts.join('');
}

/**
 * Location of the legacy generation of one session, when it exists.
 *
 * The versioned generation lives beside it as `session.v<N>.jsonl.zstd`; a
 * session that already has one is skipped, because the service reads it and
 * counting the archive too would double its tokens.
 * @param {string} sessionId - the session id.
 * @returns {string|null} the legacy log path, or null when there is nothing to recover.
 */
function legacyLogPath(sessionId) {
  // The store's own layout is `<root>/<workspace-slug>/<session id>/`; only the
  // session id is known here, so the located package supplies the root.
  const root = sessionsRoot();
  if (root === null) return null;
  try {
    const workspaceDirs = readdirSync(root, { withFileTypes: true });
    for (const entry of workspaceDirs) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name, sessionId);
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      if (!files.includes('session.jsonl.zstd')) return null;
      if (files.some((name) => name.startsWith('session.v') && name.endsWith('.jsonl.zstd'))) return null;
      return join(dir, 'session.jsonl.zstd');
    }
  } catch {
    return null;
  }
  return null;
}

/** Resolve `~/.dsh/sessions` without importing an unguarded Node global. */
function sessionsRoot() {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (typeof home !== 'string' || home.length === 0) return null;
  return join(home, '.dsh', 'sessions');
}

/**
 * Read one legacy session's usable events and its workspace.
 * @param {string} sessionId - the session id.
 * @returns {{ events: unknown[], cwd: string|null }|null}
 */
function readLegacySession(sessionId) {
  const path = legacyLogPath(sessionId);
  if (path === null) return null;
  let text;
  try {
    text = decompressAllFrames(readFileSync(path));
  } catch {
    return null;
  }
  const events = [];
  let cwd = null;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    if (parsed.type === 'session') {
      if (typeof parsed.cwd === 'string') cwd = parsed.cwd;
      continue;
    }
    events.push(parsed);
  }
  return events.length === 0 ? null : { events, cwd };
}

//#endregion

/**
 * Decide, for every listed session, whether its log has to be read at all.
 *
 * A session the checkpoint already folded, whose artifact still carries the same
 * size and mtime, cannot produce a different number: nothing has been appended since
 * it was folded. Reading is 99% of a pass, so this comparison is the entire
 * optimisation — a restart re-reads what changed since last time and nothing else.
 *
 * The whole decision runs in ONE synchronous block, which is load-bearing. Live
 * `session/event` callbacks run on this same thread and cannot interleave with it,
 * so there is no instant at which a session is neither claimed by the pass nor
 * released to the feed: a claimed session has its live events held back until the
 * fold catches up, and a released one needs them immediately.
 *
 * @param {object[]} records - the corpus listing.
 * @returns {object[]} the records whose logs must actually be read.
 */
function planPass(records) {
  const root = sessionsRoot();
  // A store layout this cannot read yields an empty scan, which makes every session
  // look changed. That degrades to a full pass, never to a wrong number.
  const artifacts = root === null ? new Map() : artifactFingerprints(root);
  ledger.artifacts = artifacts;

  const listed = new Set();
  for (const record of records) listed.add(String(record.header.id));

  // A folded aggregate cannot give one session's contribution back, so a corpus
  // that lost a session is rebuilt rather than patched.
  for (const id of ledger.checkpointSessions) {
    if (listed.has(id)) continue;
    discardCheckpoint();
    break;
  }
  ledger.checkpointSessions.clear();

  const pending = [];
  for (const record of records) {
    const id = String(record.header.id);
    if (ledger.unreadable.has(id)) continue;
    ledger.corpus.add(id);
    if (ledger.sessionCursor.has(id) && fingerprintMatches(ledger.fingerprints.get(id), artifacts.get(id))) {
      // Already folded and untouched since. Hand it straight back to the live feed,
      // which owns it from the cursor the checkpoint restored.
      ledger.corpus.delete(id);
      ledger.telemetry.sessionsScanned += 1;
      continue;
    }
    pending.push(record);
  }
  return pending;
}

/**
 * Record the fingerprint the fold just accounted for.
 *
 * The value comes from the scan `planPass` took rather than a fresh stat: a stat
 * taken after the read could describe content the fold never saw, and calling that
 * "already folded" would lose it for good. Storing the older value can only cause
 * one extra re-read, which is the harmless direction.
 * @param {string} id - the session id.
 */
function rememberFingerprint(id) {
  const observed = ledger.artifacts.get(id);
  if (observed !== undefined) ledger.fingerprints.set(id, observed);
}

/**
 * One pass over the stored corpus. Concurrent callers share the in-flight pass,
 * and the pass itself runs ONCE per process: after it settles nothing lists or
 * re-reads unreadable sessions again.
 *
 * A session whose log has not been touched since the checkpoint folded it is
 * accounted for WITHOUT being read — see {@link planPass}. Reading is the whole
 * cost of a pass, so this is what turns a restart from "fold the entire corpus" into
 * "fold whatever changed since last time".
 *
 * @param {object} sessionQuery - the `ctx.sessionQuery` service.
 * @returns {Promise<void>} after every listable session has been accounted for.
 */
async function backfill(sessionQuery) {
  if (ledger.seeded) return undefined;
  if (ledger.backfill !== null) return ledger.backfill;
  ledger.backfill = (async () => {
    ledger.seeding = true;
    try {
      const records = await sessionQuery.listSessions();
      const pending = planPass(records);
      for (let offset = 0; offset < pending.length; offset += BACKFILL_BATCH_SIZE) {
        const batch = pending.slice(offset, offset + BACKFILL_BATCH_SIZE);
        /* eslint-disable no-await-in-loop -- bounded batching keeps I/O pressure predictable. */
        await Promise.all(batch.map(async (record) => {
          const id = String(record.header.id);
          try {
            const snapshot = await sessionQuery.readSession(record.header.id);
            foldSession(
              {
                id,
                cwd: snapshot.session.cwd ?? record.header.cwd ?? null,
                isSeeded: snapshot.session.isSeeded === true || record.header.isSeeded === true,
              },
              snapshot.events,
              snapshot.inheritedEventCount,
            );
            ledger.telemetry.sessionsScanned += 1;
            // Record the fingerprint AFTER reading, so it describes a state the fold
            // has definitely seen. A write that lands in between only makes the next
            // start re-read one session, which is the harmless direction.
            rememberFingerprint(id);
          } catch (error) {
            // The service cannot migrate this log; recover its usage directly
            // rather than letting real tokens disappear from the totals.
            const legacy = readLegacySession(id);
            if (legacy !== null) {
              // `foldSession` already advanced this session's cursor to the archive's
              // highest seq; re-setting it here would only restate that value.
              foldSession(
                { id, cwd: legacy.cwd ?? record.header.cwd ?? null, isSeeded: false },
                legacy.events,
                0,
              );
              ledger.telemetry.recovered += 1;
              // Still marked unreadable — the service cannot open this log, so a later
              // pass must not retry it — but the usage is now counted, which is what
              // keeps the tokens from vanishing.
              ledger.unreadable.set(id, reasonOf(error));
              rememberFingerprint(id);
              return;
            }
            markUnreadable(id, error);
          }
        }));
        /* eslint-enable no-await-in-loop */
        ledger.revision += 1;
      }
      ledger.seeded = true;
      // First capture of a corpus the pass just folded, or the refresh after an
      // incremental one. Written only here and on the live debounce, so a failed
      // enumeration (which throws before this line) never stores a corpus that
      // looks complete.
      ledger.dirty = true;
      flushCheckpoint();
    } finally {
      ledger.seeding = false;
      ledger.backfill = null;
    }
  })();
  return ledger.backfill;
}

/**
 * Fold one live session event into the aggregate.
 *
 * The corpus pass and this feed must partition the sessions between them exactly
 * once, or a settlement is either lost or counted twice:
 *
 *  - a session the pass LISTED belongs to the pass, which reads its whole log; a
 *    live event for it stays out of the aggregate until the cursor the pass leaves
 *    behind takes over. Folding it here as well would double its tokens.
 *  - a session the pass never listed has no other contributor at all. That is
 *    every conversation started after the pass enumerated the corpus, which is
 *    every conversation started while the server is up; refusing those left
 *    "today" showing only what the last restart had already found on disk.
 *
 * Before the pass has enumerated anything the two cases are indistinguishable — an
 * unseen id may be a brand-new session or an older one that a user has just
 * resumed ahead of the pass — and the pass will fold both in full, so nothing is
 * claimed yet.
 */
function onSessionEvent(session, event) {
  const id = String(session.id);

  // A route event names the model for the settlements that follow it, including
  // the very first one of a session this feed is about to adopt, so it is cached
  // whether or not the session is already known. It carries no tokens.
  if (event.type === 'request/header' || event.type === 'request/context') {
    ledger.sessionRoute.set(id, event);
    return;
  }
  if (event.type !== 'assistant/message') return;

  const seq = typeof event.seq === 'number' ? event.seq : 0;
  let lastIndexed = ledger.sessionCursor.get(id);
  if (lastIndexed === undefined) {
    // Listed by the pass: its history is the pass's to fold.
    if (ledger.corpus.has(id)) return;
    // Nothing has enumerated the corpus yet, so this id may be an older session
    // the pass is about to fold in full — claiming it here would strand its
    // history behind a cursor the pass then declines to fill.
    if (!ledger.seeding && !ledger.seeded) return;
    // A session no enumeration ever listed: this feed owns it from this event on.
    lastIndexed = -1;
  }
  if (seq <= lastIndexed) return;

  const route = ledger.sessionRoute.get(id);
  const cwd = session.header !== undefined && typeof session.header.cwd === 'string' ? session.header.cwd : null;
  foldSessionIntoAggregate(
    ledger.aggregate,
    {
      events: route === undefined ? [event] : [route, event],
      inheritedEventCount: 0,
      sessionId: id,
      cwd,
    },
    { tzOffsetMinutes: ledger.tzOffsetMinutes },
  );
  ledger.sessionCursor.set(id, seq);
  ledger.revision += 1;
  // The cursor moved, so the checkpoint on disk now describes a shorter log than the
  // aggregate holds. Written on a debounce rather than per settlement.
  scheduleCheckpoint();
}

/** JSON response helper. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The panel polls; a cached body would freeze the numbers.
      'cache-control': 'no-store',
    },
  });
}

/**
 * Build the route handler bound to one plugin context.
 *
 * The panel has no filter controls, so the route always serves the whole
 * corpus: every workspace, and a window wide enough for a year of heatmap.
 * @param {object} ctx - the Host plugin context.
 * @returns {(request: Request) => Promise<Response>} the Fetch handler.
 */
function createHandler(ctx) {
  return async function handle(request) {
    const sessionQuery = ctx.sessionQuery;
    if (sessionQuery === undefined) {
      return json({ error: 'session query service is unavailable' }, 503);
    }

    const url = new URL(request.url);
    const daysParam = url.searchParams.get('days');
    let window = DEFAULT_WINDOW_DAYS;
    if (daysParam !== null) {
      const parsed = Number(daysParam);
      if (!Number.isInteger(parsed) || parsed < 7 || parsed > 1100) {
        return json({ error: 'days must be an integer between 7 and 1100' }, 400);
      }
      window = parsed;
    }

    try {
      await backfill(sessionQuery);
      // A pass that completed makes the corpus complete, so an earlier poll's failure
      // no longer describes this payload. Both halves of the report go away: the flag,
      // and the reason entry, which is transient in a way a session read failure is
      // not — those sessions stay unreadable, this enumeration does not stay broken.
      ledger.telemetry.corpusFailures = 0;
      const reasons = ledger.telemetry.failureReasons;
      const healed = reasons.findIndex((entry) => entry.example === '(corpus)');
      if (healed !== -1) reasons.splice(healed, 1);
    } catch (error) {
      // A failure to enumerate the corpus at all is reported once and does not stop
      // the route from serving whatever was folded. Retrying on the NEXT request is
      // deliberate: `backfill` clears its in-flight promise even when it throws, so a
      // transient failure heals itself without a restart.
      //
      // The flag exists because this failure is otherwise invisible in exactly the
      // case that matters most. While it lasts `seeded` stays false, so the live feed
      // refuses every session it cannot yet classify (see `onSessionEvent`), and the
      // route serves a payload whose counters all read zero — a wrong answer with no
      // sign that anything went wrong.
      ledger.telemetry.corpusFailures = 1;
      const reason = reasonOf(error);
      // Compared against corpus entries only: a session read failure carrying the same
      // message must not suppress this one, since they describe different problems.
      if (!ledger.telemetry.failureReasons.some((entry) => entry.example === '(corpus)' && entry.reason === reason)) {
        ledger.telemetry.failureReasons.push({ key: reason, reason, count: 1, example: '(corpus)' });
      }
    }

    const today = todayKey();
    const earliest = Object.keys(ledger.aggregate.byDay).sort()[0];
    // The requested span is a floor, not a cap: the aggregate may hold older days,
    // and an early model must stay listable. `buildPayload` then narrows the
    // per-model views to the corpus inside this heatmap window.
    const requested = shiftDay(today, -(window - 1));
    const from = windowStartFor(earliest, requested, today);
    return json(buildPayload(ledger.aggregate, {
      revision: ledger.revision,
      seeding: ledger.seeding,
      tzOffsetMinutes: ledger.tzOffsetMinutes,
      from,
      to: today,
      today,
      telemetry: ledger.telemetry,
    }));
  };
}
/**
 * Activate the plugin: capture the timezone, subscribe to live settlements, and
 * claim the Fetch route.
 * @param {object} ctx - the Host plugin context.
 */
export function apply(ctx) {
  ledger.tzOffsetMinutes = localOffsetMinutes();
  // Adopted before anything can fold, because the live feed consults the cursors and
  // routes it restores: a settlement that arrives before the first request would
  // otherwise be attributed from nothing.
  loadCheckpoint();

  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      try {
        onSessionEvent(session, event);
      } catch (error) {
        // A live fold failure must never disturb the agent loop, and it is NOT a
        // session read failure — folding already-logged data is a different
        // concern from reading a stored session, so the counters stay separate.
        ledger.liveFoldErrors += 1;
        if (ledger.liveFoldErrors <= LIVE_FOLD_ERROR_LIMIT) {
          console.error('[usage-stats] live fold failed:', reasonOf(error));
        }
      }
    }),
    'usage-stats: live settlement feed',
  );

  ctx.effect(
    () => () => {
      // Folded settlements must not be lost to a deactivation that outlives the
      // debounce; the pass also writes on its own way out.
      flushCheckpoint();
    },
    'usage-stats: checkpoint writer',
  );

  const connection = Reflect.get(ctx, 'connection');
  if (connection === undefined || connection === null) return;
  const fetchRegistry = connection.fetch;
  if (fetchRegistry === undefined || fetchRegistry === null) return;

  const handler = createHandler(ctx);
  ctx.effect(
    () => fetchRegistry.register({
      path: DATA_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: handler,
    }),
    `usage-stats: GET ${DATA_PATH}`,
  );
}
