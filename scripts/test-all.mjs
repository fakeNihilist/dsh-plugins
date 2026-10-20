#!/usr/bin/env node
// Run the test suite of every package in the monorepo, one package at a time.
//
// Each package keeps its own `npm test` script; this runner simply invokes the
// Node.js test runner directly so it works without installing anything at the
// repository root.
//
// Usage:
//   node scripts/test-all.mjs
//   NODE_TEST_FLAGS="--experimental-test-isolation=none" node scripts/test-all.mjs
//
// The NODE_TEST_FLAGS escape hatch is useful in sandboxes that forbid the
// child-process pipes the default per-file test isolation needs.

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const packages = ['browser', 'chat-search', 'notification', 'usage-stats'];
const testFilePattern = /\.test\.(?:js|mjs)$/;

function collectTestFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTestFiles(full));
    else if (entry.isFile() && testFilePattern.test(entry.name)) out.push(full);
  }
  return out.sort();
}

const extraFlags = (process.env.NODE_TEST_FLAGS ?? '').trim().split(/\s+/).filter(Boolean);
const failures = [];

for (const name of packages) {
  const cwd = join(repoRoot, 'packages', name);
  const files = collectTestFiles(join(cwd, 'test'));
  if (files.length === 0) {
    console.log(`\n=== ${name}: no test files, skipped ===`);
    continue;
  }

  const shown = files.map((file) => relative(cwd, file).replaceAll('\\', '/'));
  console.log(`\n=== ${name}: ${shown.length} test file(s) ===`);

  // One process per file: several packages rely on per-file module isolation
  // (module-level caches), and `NODE_TEST_FLAGS=--experimental-test-isolation=none`
  // then still keeps files apart.
  let packageFailed = 0;
  for (const file of shown) {
    console.log(`\n--- ${name}: ${file} ---`);
    const result = spawnSync(
      process.execPath,
      ['--test', ...extraFlags, file],
      { cwd, stdio: 'inherit' },
    );
    if (result.status !== 0) {
      packageFailed += 1;
      failures.push({ name, file, status: result.status, signal: result.signal });
    }
  }
  console.log(`\n=== ${name}: ${packageFailed === 0 ? 'passed' : `${packageFailed} failed file(s)`} ===`);
}

console.log('\n=== summary ===');
if (failures.length === 0) {
  console.log('all packages passed');
} else {
  for (const failure of failures) {
    console.log(
      `FAILED ${failure.name} / ${failure.file}` +
      ` (exit ${failure.status}${failure.signal ? `, signal ${failure.signal}` : ''})`,
    );
  }
}
process.exit(failures.length === 0 ? 0 : 1);

