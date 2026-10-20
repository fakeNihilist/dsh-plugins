/**
 * Loader for the shipped browser bundle.
 *
 * The client half is a `window.__ModuleLoader__.load({ id, factory })` script, not an
 * ES module: the Platform Seed hands it React from the browser's module table. Node
 * cannot import it, so the tests evaluate the exact shipped file and then call its
 * factory the way the real loader does.
 *
 * Evaluation deliberately uses `new Function` in the host realm rather than a `vm`
 * context. A cross-realm `Array` and `Object` fail `deepStrictEqual` on prototype
 * identity, which would turn every structural assertion into a realm check; the
 * artifact under test is identical either way.
 *
 * Testing the artifact rather than a copy is the point: a bundle that registers under
 * the wrong id, forgets a dictionary, or targets the wrong slot fails here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(HERE, '..', 'client.js');

/** Minimal `document` good enough for the stylesheet effect, listeners, and portals. */
export function createDocument() {
  const listeners = new Map();
  const head = {
    children: [],
    appendChild(node) {
      head.children.push(node);
      return node;
    },
  };
  const body = {
    children: [],
    appendChild(node) {
      body.children.push(node);
      return node;
    },
  };
  const document = {
    head,
    body,
    activeElement: null,
    /**
     * Answer the one selector the bundle queries — the stylesheet's own tag — so the
     * "inject once per page" rule is exercised rather than assumed.
     */
    querySelector(selector) {
      const match = /^style\[data-plugin-css=(?:"([^"]*)"|'([^']*)'|([^\]]*))\]$/.exec(
        String(selector).trim(),
      );
      if (match === null) return null;
      const wanted = match[1] ?? match[2] ?? match[3];
      return (
        head.children.find(
          (node) => node.tagName === 'STYLE' && node.dataset.pluginCss === wanted,
        ) ?? null
      );
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), dataset: {}, textContent: '' };
    },
    addEventListener(type, handler) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(handler);
      listeners.set(type, bucket);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    /** @returns the handlers currently registered for one event type. */
    listenersFor(type) {
      return [...(listeners.get(type) ?? [])];
    },
  };
  return document;
}

/** Event stub: the reveal path only needs `type` to round-trip. */
export class StubEvent {
  constructor(type) {
    this.type = type;
  }
}

/** React stub. The bundle only calls `createElement` unless a component renders. */
function createReact() {
  const refused = (hook) => () => {
    throw new Error(`the test stub does not render; React.${hook} was called`);
  };
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: refused('useState'),
    useRef: refused('useRef'),
    useCallback: refused('useCallback'),
    useEffect: refused('useEffect'),
    useLayoutEffect: refused('useLayoutEffect'),
  };
}

/**
 * UI-primitives stub using the export names the current client ships.
 *
 * The 0.2 line names icons by size class (`IconSearchOutlineRegular`); earlier builds used
 * pixel suffixes (`IconSearchOutline16`). Stubbing the current spelling keeps the tests on
 * the path the running client takes, and `component-render.test.js` covers the older
 * spelling and the icon-less case through its own module table.
 */
function createPrimitives() {
  const icon = (name) =>
    function Icon() {
      return { type: name };
    };
  return {
    IconSearchOutlineRegular: icon('IconSearchOutlineRegular'),
    IconChevronUpOutlineRegular: icon('IconChevronUpOutlineRegular'),
    IconChevronDownOutlineRegular: icon('IconChevronDownOutlineRegular'),
    IconCloseOutlineRegular: icon('IconCloseOutlineRegular'),
  };
}

/**
 * Evaluate the shipped bundle and materialize its factory.
 * @param overrides - optional `document`, extra `modules`, and extra globals.
 * @returns `{ id, exports, document }`.
 */
export function loadBundle(overrides = {}) {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  const document = overrides.document ?? createDocument();
  let registration = null;

  // A host window is either supplied whole (the jsdom integration tests, so the bundle
  // reaches the same window its DOM lives in) or synthesized here.
  const window = overrides.windowObject ?? { innerWidth: 1440, ...overrides.window };
  window.__ModuleLoader__ = {
    load(entry) {
      registration = entry;
    },
  };

  const modules = {
    react: createReact(),
    'react-dom': { createPortal: (node) => node },
    '@deepseek-ai/dsh-client-ui-primitives': createPrimitives(),
    ...overrides.modules,
  };

  // Every free identifier the bundle may read is threaded in as a parameter, so the file
  // runs unchanged while the test controls exactly what the browser provides. The
  // highlight API is deliberately absent: the bundle reaches it through `globalThis`.
  const evaluate = new Function(
    'window',
    'document',
    'Event',
    'setTimeout',
    'clearTimeout',
    'console',
    'MutationObserver',
    'requestAnimationFrame',
    source,
  );
  evaluate(
    window,
    document,
    overrides.Event ?? StubEvent,
    setTimeout,
    clearTimeout,
    console,
    overrides.MutationObserver ?? globalThis.MutationObserver,
    overrides.requestAnimationFrame ?? globalThis.requestAnimationFrame,
  );

  if (registration === null) {
    throw new Error('the bundle never registered with window.__ModuleLoader__');
  }
  const exported = registration.factory((spec) => {
    if (!(spec in modules)) {
      throw new Error(`the bundle required an unexpected module: "${spec}"`);
    }
    return modules[spec];
  });

  return { id: registration.id, exports: exported, document, window };
}
