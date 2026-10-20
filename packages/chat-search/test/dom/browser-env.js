/**
 * Browser environment for the DOM integration suite.
 *
 * Must be imported before `react-dom`: React decides at module load whether it can use
 * DOM events at all, and which `input` strategy to pick. Imported afterwards, it reads
 * an undefined `window`, concludes the platform has no `input` event, and installs its
 * legacy `attachEvent` polyfill — which throws the moment a field is focused.
 *
 * One jsdom window is shared by every test on purpose. React's platform detection is
 * module-level, so a per-test window could not be swapped in after the fact; each test
 * instead builds an isolated detached subtree and disposes it.
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});

export const window = dom.window;
export const document = window.document;

/** jsdom performs no layout, so every element would measure zero. */
Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
window.Element.prototype.getBoundingClientRect = () => ({
  x: 1372, y: 40, top: 40, right: 1400, bottom: 68, left: 1372, width: 28, height: 28,
});

/** Requests the plugin made to scroll a match into view, newest last. */
export const scrollCalls = [];
window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
  scrollCalls.push({ element: this, options });
};

/** A CSS Custom Highlight API stand-in that records what the plugin paints. */
const registry = new Map();
class Highlight {
  constructor(...ranges) {
    this.ranges = ranges;
  }
  add(range) {
    this.ranges.push(range);
  }
}
Object.defineProperty(window, 'CSS', {
  configurable: true,
  value: {
    highlights: {
      set: (name, value) => registry.set(name, value),
      delete: (name) => registry.delete(name),
      has: (name) => registry.has(name),
      get: (name) => registry.get(name),
      clear: () => registry.clear(),
      get size() {
        return registry.size;
      },
    },
  },
});
Object.defineProperty(window, 'Highlight', { configurable: true, value: Highlight });

export const highlights = { registry };

globalThis.window = window;
globalThis.document = document;
globalThis.CSS = window.CSS;
globalThis.Highlight = window.Highlight;
globalThis.MutationObserver = window.MutationObserver;
globalThis.Element = window.Element;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A Cordis-shaped context that records the registrations `apply` performs. */
export function createContext() {
  const record = { effects: [], locales: [], slotInjections: [], slots: [] };
  const ctx = {
    effect(factory) {
      record.effects.push(factory());
      return () => {};
    },
    locale: {
      register(ns, dicts) {
        record.locales.push({ ns, dicts });
        return () => {};
      },
    },
    slots: {
      inject(key, callback) {
        record.slotInjections.push(key);
        record.slots.push(callback());
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
  return { ctx, record };
}
