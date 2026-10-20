/**
 * Regression tests for painting and clearing the highlight layers.
 *
 * These exist because of a bug the DOM-flow tests caught: the module's stylesheet
 * constant was named `CSS`, which shadowed the platform's `CSS` global inside the
 * bundle. `highlightsSupported()` therefore always answered "unsupported", every match
 * was counted and none was ever painted, and nothing threw. A test that only asserted
 * the match counter could not see it, so these assert the registry itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBundle } from './load-bundle.js';

const { exports } = loadBundle();
const core = exports.__internals;

/** Install a fake highlight API on `globalThis`, run `body`, then restore it. */
function withHighlightApi(body) {
  const registry = new Map();
  const previous = { CSS: globalThis.CSS, Highlight: globalThis.Highlight };
  globalThis.CSS = {
    highlights: {
      set: (name, value) => registry.set(name, value),
      get: (name) => registry.get(name),
      delete: (name) => registry.delete(name),
    },
  };
  globalThis.Highlight = class Highlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
    add(range) {
      this.ranges.push(range);
    }
  };
  try {
    body(registry);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

/** Install no highlight API at all, so the degradation path is exercised. */
function withoutHighlightApi(body) {
  const previous = { CSS: globalThis.CSS, Highlight: globalThis.Highlight };
  delete globalThis.CSS;
  delete globalThis.Highlight;
  try {
    body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value !== undefined) globalThis[key] = value;
    }
  }
}

/**
 * A stand-in for a `Range`: the painting layer only stores and counts them, so identity
 * is all these tests need.
 */
const fakeRange = (id) => ({ id });

test('the stylesheet constant does not shadow the platform CSS global', () => {
  // The exact bug: a lexical `CSS` binding made every highlight call answer
  // "unsupported" while the match counter still worked.
  assert.equal(typeof core.STYLES, 'string');
  assert.match(core.STYLES, /::highlight\(dsh-chat-search\)/);
  assert.equal('CSS' in core, false, 'the module must not export a CSS binding');
});

test('the stylesheet references its theme tokens without whitespace', () => {
  // `var(-- token)` is not a token reference: the custom property name starts after the
  // dashes, so a stray space silently drops the declaration and the styling falls back.
  assert.equal(
    /var\(--\s/.test(core.STYLES),
    false,
    'every var() must name its custom property immediately',
  );
  for (const token of [
    '--dsw-alias-label-primary',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l2',
    '--dsw-alias-state-warn-primary',
  ]) {
    assert.ok(core.STYLES.includes(`var(${token}`), `the stylesheet must reference ${token}`);
  }
});

test('painting writes both layers into the document registry', () => {
  withHighlightApi((registry) => {
    const ranges = [fakeRange('a'), fakeRange('b'), fakeRange('c')];
    core.paintHighlights(ranges, 1);

    const all = registry.get(core.HIGHLIGHT_ALL);
    assert.ok(all !== undefined, 'the all-matches layer must be registered');
    assert.deepEqual(all.ranges.map((range) => range.id), ['a', 'b', 'c']);

    const active = registry.get(core.HIGHLIGHT_ACTIVE);
    assert.ok(active !== undefined, 'the active-match layer must be registered');
    assert.deepEqual(active.ranges.map((range) => range.id), ['b']);
  });
});

test('an empty active index clears only the active layer', () => {
  withHighlightApi((registry) => {
    core.paintHighlights([fakeRange('a')], 0);
    assert.equal(registry.has(core.HIGHLIGHT_ACTIVE), true);
    core.paintHighlights([fakeRange('a')], -1);
    assert.equal(registry.has(core.HIGHLIGHT_ACTIVE), false);
    assert.equal(registry.has(core.HIGHLIGHT_ALL), true);
  });
});

test('clearing removes both layers and leaves the transcript untouched', () => {
  withHighlightApi((registry) => {
    core.paintHighlights([fakeRange('a'), fakeRange('b')], 0);
    assert.equal(registry.size, 2);
    core.clearHighlights();
    assert.equal(registry.size, 0);
  });
});

test('an empty range list still publishes an empty all-matches layer', () => {
  withHighlightApi((registry) => {
    core.paintHighlights([], -1);
    assert.deepEqual(registry.get(core.HIGHLIGHT_ALL).ranges, []);
    assert.equal(registry.has(core.HIGHLIGHT_ACTIVE), false);
  });
});

test('without the highlight API every call is a quiet no-op', () => {
  withoutHighlightApi(() => {
    // Counting and scrolling continue to work; only painting is unavailable.
    assert.doesNotThrow(() => core.paintHighlights([fakeRange('a')], 0));
    assert.doesNotThrow(() => core.clearHighlights());
  });
});
