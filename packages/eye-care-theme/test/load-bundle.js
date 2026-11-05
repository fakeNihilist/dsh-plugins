/**
 * Loader for the shipped browser bundle.
 *
 * The client half is a `window.__ModuleLoader__.load({ id, factory })` script, not an
 * ES module: the browser's module table hands it the Platform Seed. Node cannot
 * import it, so the tests evaluate the exact shipped file and then call its factory
 * the way the real loader does. A bundle that registers under the wrong id, claims
 * the wrong services, or hands the theme service an unusable token map fails here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(HERE, '..', 'client.js');

/**
 * Evaluate the shipped bundle and materialize its factory.
 *
 * @param {object} [overrides] - optional extra browser globals (none are needed today).
 * @returns {{ id: string, exports: object, window: object }}
 */
export function loadBundle(overrides = {}) {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  let registration = null;

  const window = { ...overrides.window };
  window.__ModuleLoader__ = {
    load(entry) {
      registration = entry;
    },
  };

  // The free identifiers the bundle reads are threaded in as parameters, so the file
  // runs unchanged while the test decides exactly what the browser provides.
  const evaluate = new Function('window', 'console', source);
  evaluate(window, overrides.console ?? console);

  if (registration === null) {
    throw new Error('the bundle never registered with window.__ModuleLoader__');
  }
  const exported = registration.factory((spec) => {
    throw new Error(`the bundle required an unexpected module: "${spec}"`);
  });

  return { id: registration.id, exports: exported, window };
}
