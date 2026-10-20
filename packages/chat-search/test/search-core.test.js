/**
 * Pure-logic tests for the find engine.
 *
 * These cover the parts of the browser bundle that do not need a live document: query
 * compilation, the transcript walk, hit identity, and the shortcut's target choice.
 * The walk is exercised against a tiny tree built here, which is why the bundle walks
 * `firstChild`/`nextSibling` instead of using `TreeWalker` — the same code path runs
 * in the browser and in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBundle } from './load-bundle.js';

const { exports } = loadBundle();
const core = exports.__internals;

//#region tree builders

/** @returns a text node of the shape the walk reads. */
function text(data) {
  return { nodeType: 3, data, parentNode: null, firstChild: null, nextSibling: null };
}

/**
 * @param tagName - element name; the walk only compares it against `SKIP_TAGS`.
 * @param options - `children`, `dataset` (→ `el.dataset`), and `attrs` (→ `hasAttribute`).
 */
function element(tagName, options = {}) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    dataset: { ...(options.dataset ?? {}) },
    attrs: new Set(options.attrs ?? []),
    firstChild: null,
    nextSibling: null,
    parentNode: null,
    hasAttribute(name) {
      return node.attrs.has(name);
    },
  };
  let previous = null;
  for (const child of options.children ?? []) {
    child.parentNode = node;
    if (previous === null) node.firstChild = child;
    else previous.nextSibling = child;
    previous = child;
  }
  return node;
}

/** A transcript column holding rows, each tagged with its Chat anchor key. */
function transcript(rows) {
  return element('div', {
    dataset: { chatFlow: '' },
    children: rows.map((row) =>
      element('div', {
        dataset: { chatAnchorKey: row.key },
        children: row.children,
      }),
    ),
  });
}

/** Compact view of the walk's output, so assertions read as the transcript does. */
function summarize(hits) {
  return hits.map((hit) => ({ key: hit.key, ordinal: hit.ordinal, text: hit.node.data.slice(hit.start, hit.end) }));
}

//#endregion

//#region query compilation

test('the bundle ships the namespace and limits the find bar relies on', () => {
  assert.equal(core.NS, 'chatSearch');
  assert.equal(core.FLOW_ATTR, 'data-chat-flow');
  assert.equal(core.ROW_ATTR, 'data-chat-anchor-key');
  assert.equal(core.MAX_MATCHES, 2000);
  assert.equal(core.MAX_PATTERN_LENGTH, 512);
});

test('a literal query matches without regard to case by default', () => {
  assert.deepEqual(core.findInText('Hello HELLO hello', 'hello', {}), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 },
  ]);
});

test('match case is honored when asked for', () => {
  assert.deepEqual(core.findInText('Hello hello', 'hello', { caseSensitive: true }), [
    { start: 6, end: 11 },
  ]);
});

test('literal matches never overlap', () => {
  // "aaa" searched for "aa" is one match, not two: the scan resumes past the hit.
  assert.deepEqual(core.findInText('aaa', 'aa', {}), [{ start: 0, end: 2 }]);
});

test('an empty query matches nothing', () => {
  assert.deepEqual(core.findInText('anything', '', {}), []);
});

test('a pattern longer than the ceiling is ignored rather than compiled', () => {
  const long = 'a'.repeat(core.MAX_PATTERN_LENGTH + 1);
  assert.deepEqual(core.findInText(long, long, {}), []);
  assert.equal(core.compileQuery(long, {}).ok, true);
});

test('the match ceiling stops a pathological query', () => {
  const text = 'a'.repeat(core.MAX_MATCHES + 500);
  assert.equal(core.findInText(text, 'a', {}).length, core.MAX_MATCHES);
});

test('case folding that changes length falls back to an exact scan', () => {
  // 'İ'.toLowerCase() is two code units, so folded offsets would drift and every span
  // after the fold would point at the wrong characters. The engine refuses to fold
  // rather than return a plausible-looking wrong answer, which costs recall here.
  const text = '\u0130stanbul';
  assert.deepEqual(core.findInText(text, 'istanbul', {}), []);
  assert.deepEqual(core.findInText(text, '\u0130STANBUL', {}), []);
  // The exact paths are unaffected, and folding still applies when lengths agree.
  assert.deepEqual(core.findInText(text, '\u0130stanbul', { caseSensitive: true }), [
    { start: 0, end: 8 },
  ]);
  assert.deepEqual(core.findInText(text, '\u0130stanbul', {}), [{ start: 0, end: 8 }]);
  assert.deepEqual(core.findInText('Stra\u00dfe', 'STRASSE', {}), []);
  assert.deepEqual(core.findInText('Stra\u00dfe', 'stra\u00dfe', {}), [{ start: 0, end: 6 }]);
});

test('a regular expression is compiled once and reused', () => {
  const compiled = core.compileQuery('\\d+', { regex: true });
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.match('a1 bb22'), [{ start: 1, end: 2 }, { start: 5, end: 7 }]);
  // `lastIndex` is reset per call, or the second search would start mid-string.
  assert.deepEqual(compiled.match('a1 bb22'), [{ start: 1, end: 2 }, { start: 5, end: 7 }]);
});

test('a regular expression respects match case', () => {
  assert.deepEqual(core.findInText('aXb x', 'X', { regex: true, caseSensitive: true }), [
    { start: 1, end: 2 },
  ]);
  assert.deepEqual(core.findInText('aXb x', 'X', { regex: true }), [
    { start: 1, end: 2 },
    { start: 4, end: 5 },
  ]);
});

test('a regular expression supports character classes and groups', () => {
  // Without match case, `[a-z]` also folds onto the uppercase X at index 1.
  assert.deepEqual(core.findInText('aXb ax', '[a-z]x', { regex: true }), [
    { start: 0, end: 2 },
    { start: 4, end: 6 },
  ]);
  assert.deepEqual(core.findInText('aXb ax', '[a-z]x', { regex: true, caseSensitive: true }), [
    { start: 4, end: 6 },
  ]);
  assert.deepEqual(core.findInText('id=42 id=7', 'id=(\\d+)', { regex: true }), [
    { start: 0, end: 5 },
    { start: 6, end: 10 },
  ]);
});

test('a zero-width pattern terminates instead of looping forever', () => {
  assert.deepEqual(core.findInText('bbb', 'a*', { regex: true }), []);
  assert.deepEqual(core.findInText('aab', 'a*', { regex: true }), [{ start: 0, end: 2 }]);
  assert.deepEqual(core.findInText('xyz', '(?=y)', { regex: true }), []);
});

test('an unusable pattern is reported, not thrown', () => {
  const compiled = core.compileQuery('(', { regex: true });
  assert.equal(compiled.ok, false);
  assert.deepEqual(compiled.match('anything'), []);
  assert.deepEqual(core.findInText('anything', '(', { regex: true }), []);
});

test('escapeRegExp makes a literal safe to embed', () => {
  const literal = 'a.b*c(d)[e]{f}|g^h$i\\j';
  const pattern = new RegExp(core.escapeRegExp(literal));
  assert.equal(pattern.test(literal), true);
  assert.equal(pattern.test('aXbXcXdXeXfXgXhXiXj'), false);
});

//#endregion

//#region transcript walk

test('the walk reports hits in document order with their row and ordinal', () => {
  const root = transcript([
    { key: 'row-a', children: [text('alpha beta')] },
    { key: 'row-b', children: [element('p', { children: [text('beta again')] })] },
    { key: 'row-c', children: [text('nothing here')] },
  ]);
  const found = core.collectMatches(root, 'beta', {});
  assert.equal(found.ok, true);
  assert.deepEqual(summarize(found.hits), [
    { key: 'row-a', ordinal: 0, text: 'beta' },
    { key: 'row-b', ordinal: 0, text: 'beta' },
  ]);
});

test('the walk counts ordinals per row, so identity survives a re-index', () => {
  const root = transcript([
    { key: 'row-a', children: [text('x x x')] },
    { key: 'row-b', children: [text('x')] },
  ]);
  const found = core.collectMatches(root, 'x', {});
  assert.deepEqual(summarize(found.hits), [
    { key: 'row-a', ordinal: 0, text: 'x' },
    { key: 'row-a', ordinal: 1, text: 'x' },
    { key: 'row-a', ordinal: 2, text: 'x' },
    { key: 'row-b', ordinal: 0, text: 'x' },
  ]);
  assert.deepEqual(
    found.hits.map((hit) => core.identityOf(hit)),
    ['row-a\u00000', 'row-a\u00001', 'row-a\u00002', 'row-b\u00000'],
  );
});

test('a hit outside any row has no anchor key', () => {
  const root = element('div', { children: [text('loose text')] });
  const found = core.collectMatches(root, 'loose', {});
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].key, null);
  assert.equal(core.identityOf(found.hits[0]), '\u00000');
});

test('non-prose elements are pruned, not just skipped over', () => {
  const root = element('div', {
    children: [
      element('script', { children: [text('needle in script')] }),
      element('style', { children: [text('needle in style')] }),
      text('needle in prose'),
    ],
  });
  const found = core.collectMatches(root, 'needle', {});
  assert.deepEqual(summarize(found.hits), [{ key: null, ordinal: 0, text: 'needle' }]);
  assert.equal(found.hits[0].node.data, 'needle in prose');
});

test('the composer draft is never searched', () => {
  const root = element('div', {
    children: [
      element('div', { dataset: { chatAnchorKey: 'row-a' }, children: [text('real transcript')] }),
      element('div', { attrs: ['data-composer-seat'], children: [text('real draft text')] }),
    ],
  });
  const found = core.collectMatches(root, 'real', {});
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].key, 'row-a');
});

test('an opt-out subtree is pruned so plugin chrome cannot match itself', () => {
  const root = element('div', {
    children: [
      text('find me'),
      element('div', { attrs: ['data-chat-search-skip'], children: [text('find me too')] }),
    ],
  });
  const found = core.collectMatches(root, 'find me', {});
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].node.data, 'find me');
});

test('folded content stays searchable', () => {
  // Collapsed rows and reasoning keep `hidden="until-found"`; the walk must not skip
  // them, or a match inside a folded turn could never be found.
  const root = transcript([
    {
      key: 'row-a',
      children: [
        element('div', {
          attrs: ['hidden'],
          children: [element('p', { children: [text('buried answer')] })],
        }),
      ],
    },
  ]);
  const found = core.collectMatches(root, 'buried', {});
  assert.deepEqual(summarize(found.hits), [{ key: 'row-a', ordinal: 0, text: 'buried' }]);
});

test('the walk propagates an unusable pattern', () => {
  const root = transcript([{ key: 'row-a', children: [text('anything')] }]);
  const found = core.collectMatches(root, '(', { regex: true });
  assert.equal(found.ok, false);
  assert.deepEqual(found.hits, []);
});

test('the walk truncates at the ceiling and says so', () => {
  const root = transcript([{ key: 'row-a', children: [text('a'.repeat(core.MAX_MATCHES + 20))] }]);
  const found = core.collectMatches(root, 'a', {});
  assert.equal(found.truncated, true);
  assert.equal(found.hits.length, core.MAX_MATCHES);
});

test('an empty root is not an error', () => {
  assert.deepEqual(core.collectMatches(null, 'x', {}), { ok: true, truncated: false, hits: [] });
  assert.deepEqual(core.collectMatches(transcript([]), 'x', {}).hits, []);
});

test('ownerRowKey walks past non-element ancestors', () => {
  const row = element('div', { dataset: { chatAnchorKey: 'row-a' }, children: [text('hi')] });
  const textNode = row.firstChild;
  assert.equal(core.ownerRowKey(textNode), 'row-a');
  assert.equal(core.ownerRowKey({ nodeType: 3, parentNode: null }), null);
});

test('isSkippedElement reads the element tag and its opt-out attributes', () => {
  assert.equal(core.isSkippedElement(element('script')), true);
  assert.equal(core.isSkippedElement(element('TEXTAREA')), true);
  assert.equal(core.isSkippedElement(element('div', { attrs: ['data-composer-seat'] })), true);
  assert.equal(core.isSkippedElement(element('div', { attrs: ['data-chat-search-skip'] })), true);
  assert.equal(core.isSkippedElement(element('div')), false);
});

//#endregion

//#region shortcut routing

/** Build a fake find-bar handle for the registry. */
function handle(overrides = {}) {
  return {
    isOpen: () => false,
    open() {},
    close() {},
    ownsFocus: () => false,
    isVisible: () => true,
    area: () => 100,
    ...overrides,
  };
}

/** Run one body with a clean registry, so tests cannot leak handles into each other. */
function withRegistry(entries, run) {
  core.registry.clear();
  for (const entry of entries) core.registry.set(entry, entry);
  try {
    run();
  } finally {
    core.registry.clear();
  }
}

test('the shortcut resolves to nothing when no conversation is resident', () => {
  withRegistry([], () => {
    assert.equal(core.pickSearchTarget(), null);
  });
});

test('the shortcut resolves to the only resident conversation', () => {
  const only = handle();
  withRegistry([only], () => {
    assert.equal(core.pickSearchTarget(), only);
  });
});

test('the shortcut prefers the conversation that holds focus', () => {
  const main = handle({ area: () => 5000 });
  const docked = handle({ ownsFocus: () => true, area: () => 100 });
  withRegistry([main, docked], () => {
    assert.equal(core.pickSearchTarget(), docked);
  });
});

test('the shortcut prefers the widest visible conversation when none holds focus', () => {
  const main = handle({ area: () => 5000 });
  const docked = handle({ area: () => 100 });
  withRegistry([docked, main], () => {
    assert.equal(core.pickSearchTarget(), main);
  });
});

test('the shortcut falls back to the first conversation when none is measurable', () => {
  const first = handle({ isVisible: () => false });
  const second = handle({ isVisible: () => false });
  withRegistry([first, second], () => {
    assert.equal(core.pickSearchTarget(), first);
  });
});

test('opening one bar closes every other bar', () => {
  const closed = [];
  const self = handle();
  const other = handle({ isOpen: () => true, close: () => closed.push('other') });
  const quiet = handle({ isOpen: () => false, close: () => closed.push('quiet') });
  withRegistry([self, other, quiet], () => {
    core.closeOtherBars(self);
  });
  assert.deepEqual(closed, ['other']);
});

//#endregion
