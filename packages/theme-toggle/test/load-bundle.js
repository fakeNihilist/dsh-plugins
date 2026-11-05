/**
 * Loader for the shipped browser bundle.
 *
 * The client half is a `window.__ModuleLoader__.load({ id, factory })` script,
 * not an ES module: the browser's module table provides React. Node cannot
 * import it, so the tests evaluate the exact shipped file, hand the factory a
 * minimal React stub, and then call it the way the real loader does.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(HERE, '..', 'client.js');

/** React stub: the toggle only calls createElement until it renders. */
function createReact() {
  const refused = (hook) => () => {
    throw new Error(`the test stub does not render; React.${hook} was called`);
  };
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: refused('useState'),
    useEffect: refused('useEffect'),
    useCallback: refused('useCallback'),
  };
}

/**
 * Evaluate the shipped bundle and materialize its factory.
 *
 * @param {object} [overrides] - optional extra modules keyed by specifier.
 * @returns {{ id: string, exports: object }}
 */
export function loadBundle(overrides = {}) {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  let registration = null;

  const window = {};
  window.__ModuleLoader__ = {
    load(entry) {
      registration = entry;
    },
  };

  // The free identifiers the bundle reads are threaded in as parameters, so the
  // file runs unchanged while the test decides exactly what the browser provides.
  const evaluate = new Function('window', 'console', source);
  evaluate(window, overrides.console ?? console);

  if (registration === null) {
    throw new Error('the bundle never registered with window.__ModuleLoader__');
  }
  const modules = { react: createReact(), ...overrides.modules };
  const exported = registration.factory((spec) => {
    if (!(spec in modules)) {
      throw new Error(`the bundle required an unexpected module: "${spec}"`);
    }
    return modules[spec];
  });

  return { id: registration.id, exports: exported };
}
