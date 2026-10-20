/**
 * Durable checkpoint for the folded corpus.
 *
 * Everything here is DERIVED state. Every field can be recomputed from the session
 * logs, so the checkpoint is a cache and nothing more: losing it or discarding it
 * costs time, never correctness. That is what makes the blunt invalidation rules
 * below affordable — when anything looks off, throwing the whole file away is
 * always a safe answer.
 *
 * Why a checkpoint at all. A cold pass reads every session log in the corpus.
 * Measured on a real store (72 sessions, 51 MiB of zstd frames, 48 778 events) the
 * pass costs about 2 s, of which 99% is zstd decompress plus JSON parse; folding
 * the parsed events is 12 ms and stat-ing every artifact is 6 ms. So folding less
 * would save nothing — the win is entirely in NOT READING a log that has not
 * changed since the last checkpoint.
 *
 * Why a plain file rather than `ctx.storage.domain`. The domain layer is a
 * dependency this plugin does not ship (it advertises none), and the checkpoint is
 * a private cache with no schema anyone else reads. `<home>/.dsh/storages/<name>/`
 * is where the app keeps exactly this kind of plugin-owned state — the same place
 * `cost-meter` keeps its ledger — and `DSH_USAGE_STATS_STATE` overrides it.
 *
 * @module dsh-plugin-usage-stats/checkpoint
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** On-disk layout of the checkpoint file itself. Bumped when the shape changes. */
export const CHECKPOINT_VERSION = 1;

/**
 * Version of the FOLD that produced a checkpoint's aggregate.
 *
 * Bump this whenever a change alters what a cold fold would produce — a new
 * bucket, a different cut rule, a changed attribution — so a checkpoint written by
 * the older code is discarded instead of being served as if it were current. It is
 * deliberately separate from {@link CHECKPOINT_VERSION}: the file shape and the
 * meaning of its numbers change for unrelated reasons.
 */
export const FOLD_VERSION = 2;

/** File name inside the state directory. */
const CHECKPOINT_FILE = 'ledger.json';

/** Environment override for the state directory, used by the tests and by anyone staging a corpus. */
const STATE_DIR_ENV = 'DSH_USAGE_STATS_STATE';

/**
 * Where this plugin keeps its state.
 * @returns {string} the state directory (not created here).
 */
export function checkpointDir() {
  const override = process.env[STATE_DIR_ENV];
  if (typeof override === 'string' && override.length > 0) return override;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, '.dsh', 'storages', 'usage-stats');
}

/** Full path of the checkpoint file. */
export function checkpointPath() {
  return join(checkpointDir(), CHECKPOINT_FILE);
}

/** Whether a value is a plain object usable as a record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and validate a checkpoint.
 *
 * Returns null for anything unusable — absent file, truncated write, a shape from
 * another version, a different timezone, an aggregate missing its tables. The
 * caller rebuilds from the logs, which is always correct, so a strict reader is
 * cheaper than a forgiving one.
 *
 * @param {string} file - the checkpoint path.
 * @param {{ tzOffsetMinutes: number }} expectations - values the file must agree with.
 * @returns {object|null} the checkpoint, or null when it cannot be trusted.
 */
export function readCheckpoint(file, expectations) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== CHECKPOINT_VERSION) return null;
  if (parsed.foldVersion !== FOLD_VERSION) return null;
  // Day buckets were cut with the offset in force when they were folded. A host
  // that changed timezone would silently keep yesterday's day boundaries.
  if (parsed.tzOffsetMinutes !== expectations.tzOffsetMinutes) return null;
  const aggregate = parsed.aggregate;
  if (!isRecord(aggregate)) return null;
  if (!isRecord(aggregate.byDay) || !isRecord(aggregate.byRoute) || !isRecord(aggregate.byWorkspace)) return null;
  if (!isRecord(aggregate.byDayWorkspace) || !isRecord(aggregate.byWorkspaceRoute)) return null;
  if (!isRecord(aggregate.byWorkspaceRouteDay) || !isRecord(aggregate.byDayRoute)) return null;
  if (!isRecord(aggregate.totals)) return null;
  if (!isRecord(parsed.sessions)) return null;
  return parsed;
}

/**
 * Write a checkpoint atomically, creating its directory.
 *
 * The write is a temp file plus a rename because a half-written cache is worse than
 * none: a truncated aggregate would be read back as a corpus that never had the
 * tokens it lost. A failure here is reported, never thrown — the panel does not
 * depend on the cache, and a read-only state directory must not break it.
 *
 * @param {string} file - the checkpoint path.
 * @param {object} payload - the checkpoint body.
 * @returns {boolean} whether the write succeeded.
 */
export function writeCheckpoint(file, payload) {
  const temporary = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return false;
  }
  try {
    writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/** The session id a store artifact belongs to: `<root>/<workspace>/<id>/<file>`. */
function sessionIdOfPath(root, file) {
  const parts = file.slice(root.length + 1).split(/[\\/]/);
  return parts.length >= 3 && parts[1].length > 0 ? parts[1] : null;
}

/**
 * Stat every session artifact, keeping each session's newest.
 *
 * A session can hold several format generations side by side and the newest one is
 * the live log, so the newest mtime wins — the same rule the rest of the plugin
 * applies when it picks a generation.
 *
 * This reads the store's directory layout directly, which the legacy-recovery path
 * already does. A layout this function does not recognize yields an EMPTY map,
 * which makes every session look changed and degrades to a full pass: the cost of
 * being wrong here is a slow start, never a wrong number.
 *
 * @param {string} root - the sessions root.
 * @returns {Map<string, {size: number, mtimeMs: number}>} fingerprint per session id.
 */
export function artifactFingerprints(root) {
  const fingerprints = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl.zstd')) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const id = sessionIdOfPath(root, full);
      if (id === null) continue;
      const previous = fingerprints.get(id);
      if (previous === undefined || stat.mtimeMs > previous.mtimeMs) {
        fingerprints.set(id, { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  return fingerprints;
}

/**
 * Whether a stored fingerprint still describes the artifact on disk.
 *
 * Size AND mtime, because either alone can repeat: a rewrite can land on the same
 * length, and a filesystem with coarse timestamps can stamp two writes alike.
 * @param {{size: number, mtimeMs: number}|undefined} stored - the checkpoint's record.
 * @param {{size: number, mtimeMs: number}|undefined} current - the artifact now.
 * @returns {boolean} true only when both are present and equal.
 */
export function fingerprintMatches(stored, current) {
  if (stored === undefined || current === undefined) return false;
  return stored.size === current.size && stored.mtimeMs === current.mtimeMs;
}

/**
 * A minimal event that names one already-extracted route.
 *
 * The live feed folds a route by handing it to the fold layer as a route-carrying
 * event. Persisting the event it actually saw would mean writing a whole
 * `request/header` — including the full tool table, which is what makes these logs
 * tens of megabytes — into a cache that only ever needs two strings out of it. The
 * checkpoint stores the extracted pair and rebuilds this shape, which `routeOf`
 * reads exactly like the original.
 *
 * @param {{provider: string, model: string}|null|undefined} route - the extracted route.
 * @returns {object|null} the route event, or null when there is no route.
 */
export function routeEventOf(route) {
  if (route === null || route === undefined) return null;
  if (typeof route.provider !== 'string' && typeof route.model !== 'string') return null;
  return {
    type: 'request/header',
    seq: -1,
    data: { header: { config: { provider: route.provider, model: route.model } } },
  };
}
