/**
 * Point the Host half's checkpoint at a throwaway directory.
 *
 * Every host-side test file imports this for its side effect, BEFORE any `apply()`
 * runs. Without it a test run writes into the real
 * `<home>/.dsh/storages/usage-stats` — and, far worse, the next real start then
 * adopts a checkpoint built from fixtures, so a developer's panel would show numbers
 * no log ever produced.
 *
 * It lives in one module rather than a line per file because the failure mode is
 * silent and remote: nothing in the offending test fails, and the damage appears in
 * somebody else's panel days later. Adding a host-side test file means adding this
 * import.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'usage-stats-test-'));
process.env.DSH_USAGE_STATS_STATE = dir;
process.on('exit', () => {
  rmSync(dir, { recursive: true, force: true });
});
