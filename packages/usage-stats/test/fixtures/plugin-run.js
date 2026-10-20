/**
 * One plugin "start" against a fake session store, for the incremental-start test.
 *
 * Runs in its own PROCESS because the Host half keeps its ledger in module scope:
 * an in-process second `apply()` would find the previous run's aggregate still in
 * memory and could not tell a resumed start from a continued one. A child process
 * gets a genuinely empty ledger, which is what "the app was restarted" means.
 *
 * Reads its store from `$USERPROFILE/.dsh/sessions` and its checkpoint from
 * `$DSH_USAGE_STATS_STATE`, both pointed at a scratch directory by the test, and
 * prints one JSON line: the payload's totals plus how many logs it actually read.
 *
 * Usage: node test/fixtures/plugin-run.js
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { DATA_PATH, apply } from '../../index.js';

const ZSTD_MAGIC = 0xfd2fb528;

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

const root = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'sessions');

/** Every `<slug>/<id>/session.v<N>.jsonl.zstd` in the fake store. */
function artifacts() {
  const found = [];
  for (const slug of readdirSync(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    for (const session of readdirSync(join(root, slug.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = join(root, slug.name, session.name);
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.jsonl.zstd')) {
          found.push({ id: session.name, cwd: `/${slug.name}`, file: join(dir, file) });
        }
      }
    }
  }
  return found;
}

const entries = artifacts();
/** How many logs the pass actually read — the number this whole design is about. */
let readCalls = 0;
/** The live settlement feed, so a case can settle a session after the pass. */
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
      register: (registration) => {
        route = registration.fetch;
        return () => true;
      },
    },
  },
  sessionQuery: {
    listSessions: async () => entries.map((entry) => ({ header: { id: entry.id, cwd: entry.cwd } })),
    readSession: async (id) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry === undefined) throw new Error(`no session ${id}`);
      readCalls += 1;
      const text = decompressAllFrames(readFileSync(entry.file));
      const events = [];
      let cwd = entry.cwd;
      let isSeeded = false;
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        const parsed = JSON.parse(line);
        if (parsed.type === 'session') {
          cwd = parsed.cwd ?? cwd;
          isSeeded = parsed.isSeeded === true;
          continue;
        }
        events.push(parsed);
      }
      return {
        session: { cwd, isSeeded },
        events,
        inheritedEventCount: 0,
      };
    },
  },
};

apply(ctx);
const totalOf = (buckets) =>
  buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
const unknownOf = (payload) =>
  (payload.routes ?? [])
    .filter((row) => row.provider === 'unknown' || row.model === 'unknown')
    .reduce((sum, row) => sum + totalOf(row), 0);

const request = async () => {
  const response = await route(new Request(`http://localhost${DATA_PATH}?days=371`));
  return response.json();
};

const payload = await request();
const report = {
  readCalls,
  sessions: entries.length,
  totals: payload.totals,
  today: payload.today,
  unknown: unknownOf(payload),
  workspaces: (payload.workspaces ?? []).map((row) => row.key).sort(),
  days: (payload.days ?? []).filter((row) => row.calls > 0).map((row) => row.day).sort(),
};

// Optional second phase: settle one session through the live feed AFTER the pass,
// the way a resumed conversation does. Route attribution here has only one possible
// source — the route the checkpoint carried across the restart — so a checkpoint
// that dropped it shows up as an `unknown` row rather than as a missing number.
const liveSession = process.env.LIVE_SESSION;
if (liveSession !== undefined) {
  live(
    { id: liveSession, header: { cwd: '/live' } },
    {
      type: 'assistant/message',
      seq: Number(process.env.LIVE_SEQ ?? '9999'),
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [] },
        stream: [],
        usage: {
          inputTokens: Number(process.env.LIVE_TOKENS ?? '0'),
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    },
  );
  const after = await request();
  report.after = {
    totals: after.totals,
    unknown: unknownOf(after),
    readCalls,
  };
}

console.log(JSON.stringify(report));
