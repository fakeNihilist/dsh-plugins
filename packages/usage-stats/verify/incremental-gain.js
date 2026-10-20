/**
 * Verifier: how much a resumed start actually saves, measured on the real corpus.
 *
 * A cold pass reads every session log; a resumed one reads only what moved since the
 * last checkpoint. This runs BOTH against `~/.dsh/sessions` and prints the
 * comparison, so the optimisation is a number anyone can reproduce rather than a
 * claim — and so a regression that quietly stopped skipping shows up as reads that
 * went back up.
 *
 * The two starts must be separate PROCESSES: the Host half keeps its ledger in module
 * scope, so a second `apply()` in one process would find the first pass's aggregate
 * still in memory and never do the work being measured. This script re-invokes itself
 * as the child.
 *
 * The checkpoint directory is a throwaway: the real host's checkpoint is neither
 * consumed (which would hide the cold cost) nor overwritten.
 *
 * Run: node verify/incremental-gain.js
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const SELF = fileURLToPath(import.meta.url);
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

function collectLogs(root) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...collectLogs(full));
    else if (entry.name.endsWith('.jsonl.zstd')) found.push(full);
  }
  return found;
}

//#region child: one plugin start against the real store

if (process.argv.includes('--child')) {
  const { homedir } = await import('node:os');
  process.env.DSH_USAGE_STATS_STATE = process.env.BENCH_STATE;
  const { DATA_PATH, apply, inheritedCut } = await import('../index.js');

  const root = join(homedir(), '.dsh', 'sessions');
  const byId = new Map();
  for (const file of collectLogs(root)) {
    const id = file.slice(root.length + 1).split(/[\\/]/)[1];
    const stat = statSync(file);
    const previous = byId.get(id);
    if (previous === undefined || stat.mtimeMs > previous.mtimeMs) byId.set(id, { file, mtimeMs: stat.mtimeMs });
  }

  let readCalls = 0;
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
      listSessions: async () => [...byId.keys()].map((id) => ({ header: { id, cwd: null } })),
      readSession: async (id) => {
        const entry = byId.get(id);
        if (entry === undefined) throw new Error(`no session ${id}`);
        readCalls += 1;
        const text = decompressAllFrames(readFileSync(entry.file));
        const events = [];
        let cwd = null;
        let isSeeded = false;
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
            cwd = parsed.cwd ?? null;
            isSeeded = parsed.isSeeded === true;
            continue;
          }
          events.push(parsed);
        }
        return { session: { cwd, isSeeded }, events, inheritedEventCount: inheritedCut(events, 0, isSeeded) };
      },
    },
  };

  apply(ctx);
  const started = Number(process.hrtime.bigint()) / 1e6;
  const response = await route(new Request(`http://localhost${DATA_PATH}?days=371`));
  const payload = await response.json();
  const elapsed = Number(process.hrtime.bigint()) / 1e6 - started;
  const totals = payload.totals;
  console.log(JSON.stringify({
    sessions: byId.size,
    readCalls,
    elapsedMs: Math.round(elapsed),
    tokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    calls: totals.calls,
    unknown: (payload.routes ?? []).filter((row) => row.provider === 'unknown' || row.model === 'unknown').length,
  }));
  process.exit(0);
}

//#endregion

const stateDir = mkdtempSync(join(tmpdir(), 'usage-stats-gain-'));
const runChild = () => {
  const result = spawnSync(process.execPath, [SELF, '--child'], {
    encoding: 'utf8',
    env: { ...process.env, BENCH_STATE: stateDir, DSH_USAGE_STATS_STATE: stateDir },
  });
  if (result.status !== 0) {
    console.log(result.stderr || result.stdout);
    process.exit(1);
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
};

const cold = runChild();
const warm = runChild();
rmSync(stateDir, { recursive: true, force: true });

const line = (label, run) =>
  `  ${label.padEnd(8)} reads ${String(run.readCalls).padStart(4)}/${run.sessions}  ${String(run.elapsedMs).padStart(6)} ms  calls=${run.calls}  tokens=${run.tokens}`;

console.log('one plugin start against the real session store');
console.log(line('cold', cold));
console.log(line('resumed', warm));
console.log('');
console.log(`skipped        : ${cold.readCalls - warm.readCalls} of ${cold.readCalls} logs`);
if (cold.elapsedMs > 0) {
  console.log(`faster by      : ${(cold.elapsedMs / Math.max(1, warm.elapsedMs)).toFixed(1)}x`);
}

let failed = false;
const check = (ok, message) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failed = true;
};

console.log('');
console.log('invariants:');
check(warm.readCalls < cold.readCalls, 'a resumed start reads fewer logs than a cold one');
check(cold.tokens === warm.tokens, 'both starts report the same token total');
check(cold.calls === warm.calls, 'both starts report the same settlement count');
check(cold.unknown === 0 && warm.unknown === 0, 'no settlement fell through to the unknown route');
process.exitCode = failed ? 1 : 0;
