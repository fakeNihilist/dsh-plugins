/**
 * Loader for the shipped browser bundle.
 *
 * The client half is a `window.__ModuleLoader__.load({ id, factory })` script, not
 * an ES module: the Platform Seed hands the browser module table to it. Node cannot
 * import it, so the tests evaluate the exact shipped file and then call its factory
 * the way the real loader does.
 *
 * Evaluation deliberately uses `new Function` in the host realm rather than a `vm`
 * context. A cross-realm `Array` and `Object` fail `deepStrictEqual` on prototype
 * identity, and the artifact under test is identical either way.
 *
 * Testing the artifact rather than a copy is the point: a bundle that registers
 * under the wrong id, forgets a service, or drops a dictionary fails here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(HERE, "..", "client.js");

/**
 * Evaluate the shipped bundle against a browser window stub.
 * @param windowObject - window stub the bundle will close over; mutated with `__ModuleLoader__`.
 * @returns `{ id, exports, window }`.
 */
export function loadBundle(windowObject = {}) {
  const source = readFileSync(BUNDLE_PATH, "utf8");
  const window = windowObject;
  let registration = null;
  window.__ModuleLoader__ = {
    load(entry) {
      registration = entry;
    },
  };

  const evaluate = new Function("window", source);
  evaluate(window);

  if (registration === null) {
    throw new Error("the bundle never registered with window.__ModuleLoader__");
  }
  const exported = registration.factory(() => {
    throw new Error("the bundle required a module the test did not provide");
  });

  return { id: registration.id, exports: exported, window };
}
