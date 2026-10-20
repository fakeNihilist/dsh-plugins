/**
 * Where a step lands.
 *
 * The original implementation scrolled the transcript row (`[data-chat-anchor-key]`)
 * into view. A row is not a match: one Chat row can hold an entire answer, a reasoning
 * block, or a tool result and be much taller than the viewport, so centering the row can
 * leave the matched characters off screen — and several matches inside one row produced
 * no visible movement at all. These tests pin the scroll target to the match itself, and
 * to every scroll box between it and the document (a capped process group has its own
 * scroller), using a synthetic layout so geometry is deterministic.
 *
 * Geometry is modelled as offsets inside parents minus each scrollport's scroll offset,
 * which is enough to check the order of writes and the final viewport position without
 * a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadBundle } from './load-bundle.js';

//#region fake layout

function createWorld() {
  const matches = new Map();
  const order = [];

  const world = { matches, order };

  /** Whether one axis of an element scrolls its own content. */
  const scrollsY = (el) =>
    el.overflowY === 'auto' && el.scrollHeight > el.clientHeight && el.clientHeight > 0;
  const scrollsX = (el) =>
    el.overflowX === 'auto' && el.scrollWidth > el.clientWidth && el.clientWidth > 0;

  /** Layout top of an element in viewport coordinates. */
  function viewportTop(node) {
    let top = 0;
    for (let el = node; el !== null && el !== undefined; el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      top += el.offsetTop ?? 0;
      const parent = el.parentNode;
      if (parent !== null && parent !== undefined && parent.nodeType === 1 && scrollsY(parent)) {
        top -= parent.scrollTop;
      }
    }
    return top;
  }

  /** Layout left of an element in viewport coordinates. */
  function viewportLeft(node) {
    let left = 0;
    for (let el = node; el !== null && el !== undefined; el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      left += el.offsetLeft ?? 0;
      const parent = el.parentNode;
      if (parent !== null && parent !== undefined && parent.nodeType === 1 && scrollsX(parent)) {
        left -= parent.scrollLeft;
      }
    }
    return left;
  }

  /** The rect the next `document.createRange()` reports for one text node. */
  function rectOf(node) {
    const match = matches.get(node);
    if (match === undefined) return null;
    const element = match.element;
    const ownTop = scrollsY(element) ? element.scrollTop : 0;
    const ownLeft = scrollsX(element) ? element.scrollLeft : 0;
    const top = viewportTop(element) + match.offsetTop - ownTop;
    const left = viewportLeft(element) + match.offsetLeft - ownLeft;
    return {
      top,
      bottom: top + match.height,
      left,
      right: left + match.width,
      width: match.width,
      height: match.height,
    };
  }

  const document = {
    createRange() {
      let target = null;
      return {
        setStart(node) {
          target = node;
        },
        setEnd() {},
        getClientRects() {
          const rect = target === null ? null : rectOf(target);
          return rect === null ? [] : [rect];
        },
        getBoundingClientRect() {
          return (
            (target === null ? null : rectOf(target)) ?? {
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              width: 0,
              height: 0,
            }
          );
        },
      };
    },
  };

  return { matches, order, document, viewportTop, viewportLeft };
}

/** Make one fake element with scrollport geometry. */
function makeElement(world, options = {}) {
  return {
    nodeType: 1,
    tagName: (options.tag ?? 'div').toUpperCase(),
    dataset: { ...(options.dataset ?? {}) },
    offsetTop: options.offsetTop ?? 0,
    offsetLeft: options.offsetLeft ?? 0,
    clientLeft: 0,
    clientTop: 0,
    clientWidth: options.clientWidth ?? 0,
    clientHeight: options.clientHeight ?? 0,
    scrollWidth: options.scrollWidth ?? 0,
    scrollHeight: options.scrollHeight ?? 0,
    scrollLeft: 0,
    scrollTop: 0,
    overflowX: options.overflowX ?? 'visible',
    overflowY: options.overflowY ?? 'visible',
    attrs: new Set(options.attrs ?? []),
    parentNode: null,
    firstChild: null,
    nextSibling: null,
    calls: [],
    intoView: null,
    events: [],
    hasAttribute(name) {
      return this.attrs.has(name);
    },
    dispatchEvent(event) {
      this.events.push(event.type);
      world.order.push(event.type);
    },
    getBoundingClientRect() {
      const top = world.viewportTop(this);
      const left = world.viewportLeft(this);
      return {
        top,
        bottom: top + this.clientHeight,
        left,
        right: left + this.clientWidth,
        width: this.clientWidth,
        height: this.clientHeight,
      };
    },
    scrollTo(target) {
      this.calls.push(target);
      world.order.push('scroll');
      this.scrollLeft = target.left;
      this.scrollTop = target.top;
    },
    scrollIntoView(target) {
      this.intoView = target;
      world.order.push('row');
    },
  };
}

/** Append a child, maintaining the `firstChild`/`nextSibling`/`parentNode` links. */
function append(parent, child) {
  child.parentNode = parent;
  if (parent.firstChild === null) {
    parent.firstChild = child;
  } else {
    let last = parent.firstChild;
    while (last.nextSibling !== null) last = last.nextSibling;
    last.nextSibling = child;
  }
  return child;
}

function textNode(data, parent) {
  return { nodeType: 3, data, parentNode: parent, firstChild: null, nextSibling: null };
}

/** Load the shipped bundle against one world, with synchronous animation frames. */
function loadWorld(world, requestAnimationFrame) {
  return loadBundle({
    windowObject: { innerWidth: 1440 },
    document: world.document,
    requestAnimationFrame: requestAnimationFrame ?? ((fn) => fn()),
  }).exports.__internals;
}

/**
 * Install the style and motion globals the bundle reads, run `body`, then restore them.
 * `getComputedStyle` is a free global in the browser; Node has no layout, so the fake
 * elements carry the two overflow values the bundle needs.
 */
function withBrowserGlobals(body, overrides = {}) {
  const previous = {
    getComputedStyle: globalThis.getComputedStyle,
    matchMedia: globalThis.matchMedia,
  };
  globalThis.getComputedStyle = (element) => ({
    overflowX: element.overflowX ?? 'visible',
    overflowY: element.overflowY ?? 'visible',
  });
  if (overrides.matchMedia !== undefined) globalThis.matchMedia = overrides.matchMedia;
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

/** Build a scrollport + transcript row + one match, the common test skeleton. */
function makeTranscript(world, options = {}) {
  const outer = makeElement(world, {
    overflowY: 'auto',
    clientHeight: options.viewportHeight ?? 200,
    scrollHeight: options.contentHeight ?? 2000,
  });
  const column = makeElement(world, { dataset: { chatFlow: '' } });
  const row = makeElement(world, {
    dataset: { chatAnchorKey: options.rowKey ?? 'row-a' },
    attrs: options.rowAttrs ?? [],
  });
  const paragraph = makeElement(world, { tag: 'p', offsetTop: options.matchTop ?? 1500 });
  append(outer, column);
  append(column, row);
  append(row, paragraph);
  const text = textNode(options.text ?? 'The quick brown fox', paragraph);
  append(paragraph, text);
  world.matches.set(text, {
    element: paragraph,
    offsetTop: 0,
    offsetLeft: 0,
    height: 16,
    width: options.matchWidth ?? 60,
  });
  return { outer, column, row, paragraph, text };
}

//#endregion

//#region scrolling to the match

test('a match in a tall row is centered on the match, not on the row', () => {
  withBrowserGlobals(() => {
    const world = createWorld();
    const { outer, column, row, text } = makeTranscript(world);
    const core = loadWorld(world);

    core.scrollToHit({ node: text, start: 4, end: 7, key: 'row-a', ordinal: 0 }, column);

    assert.equal(outer.calls.length, 1, 'the scrollport must be scrolled exactly once');
    // 1500 (match top) - (200 - 16) / 2 = 1408.
    assert.equal(outer.calls[0].top, 1408);
    assert.equal(outer.calls[0].behavior, 'smooth');
    assert.equal(row.intoView, null, 'the row must not be the scroll target');
  });
});

test('a match already inside the comfortable band is left alone', () => {
  withBrowserGlobals(() => {
    const world = createWorld();
    const { outer, column, row, text } = makeTranscript(world, { matchTop: 80 });
    const core = loadWorld(world);

    core.scrollToHit({ node: text, start: 0, end: 7, key: 'row-a', ordinal: 0 }, column);

    assert.deepEqual(outer.calls, [], 'an already visible match must not move the viewport');
    assert.equal(row.intoView, null);
  });
});

test('a nested scroller is moved before the outer scrollport, and both land', () => {
  withBrowserGlobals(() => {
    const world = createWorld();
    const outer = makeElement(world, {
      overflowY: 'auto',
      clientHeight: 400,
      scrollHeight: 4000,
    });
    const column = makeElement(world, { dataset: { chatFlow: '' } });
    const group = makeElement(world, { offsetTop: 1000, dataset: { chatAnchorKey: 'group:g' } });
    const body = makeElement(world, {
      overflowY: 'auto',
      offsetTop: 30,
      clientHeight: 200,
      scrollHeight: 600,
    });
    const content = makeElement(world, { dataset: { chatFlow: '' } });
    const paragraph = makeElement(world, { tag: 'p', offsetTop: 400 });
    append(outer, column);
    append(column, group);
    append(group, body);
    append(body, content);
    append(content, paragraph);
    const text = textNode('a buried match', paragraph);
    append(paragraph, text);
    world.matches.set(text, {
      element: paragraph,
      offsetTop: 0,
      offsetLeft: 0,
      height: 16,
      width: 60,
    });

    const core = loadWorld(world);
    core.scrollToHit({ node: text, start: 2, end: 8, key: 'group:g', ordinal: 0 }, column);

    // The group body centers first: match at 1430, body at 1030, height 200.
    assert.equal(body.calls.length, 1, 'the capped group body must scroll');
    assert.equal(body.calls[0].top, 308);
    // Then the outer scrollport sees the hit at 1430 - 308 = 1122 and centers it.
    assert.equal(outer.calls.length, 1, 'the conversation scrollport must scroll too');
    assert.equal(outer.calls[0].top, 930);
    assert.equal(group.intoView, null, 'no row scrollIntoView should be used');
    // The final position is inside both boxes: inner 1030..1230, outer 0..400.
    const finalTop = 1430 - body.scrollTop - outer.scrollTop;
    assert.ok(finalTop >= 0 && finalTop + 16 <= 400);
  });
});

test('a horizontal code line is only brought into view, not centered', () => {
  withBrowserGlobals(() => {
    const world = createWorld();
    const outer = makeElement(world, {
      overflowY: 'auto',
      clientHeight: 200,
      scrollHeight: 2000,
    });
    const column = makeElement(world, { dataset: { chatFlow: '' } });
    const row = makeElement(world, { dataset: { chatAnchorKey: 'row-a' } });
    const pre = makeElement(world, {
      tag: 'pre',
      offsetTop: 40,
      overflowX: 'auto',
      clientWidth: 300,
      scrollWidth: 1000,
    });
    append(outer, column);
    append(column, row);
    append(row, pre);
    const text = textNode('const needle = 1', pre);
    append(pre, text);
    // The match starts 700px into a 300px-wide code viewport.
    world.matches.set(text, {
      element: pre,
      offsetTop: 0,
      offsetLeft: 700,
      height: 16,
      width: 200,
    });

    const core = loadWorld(world);
    core.scrollToHit({ node: text, start: 6, end: 12, key: 'row-a', ordinal: 0 }, column);

    assert.equal(pre.calls.length, 1, 'the code line must scroll horizontally');
    // Minimal reveal: the right edge stops on the 24px comfort edge (300 - 24 = 276).
    assert.equal(pre.calls[0].left, 900 - 276);
    assert.deepEqual(outer.calls, [], 'a vertically visible match must not move the transcript');
  });
});

test('a folded row is revealed before the scroll is measured', () => {
  withBrowserGlobals(() => {
    const world = createWorld();
    const { column, row, text } = makeTranscript(world, {
      matchTop: 1200,
      rowAttrs: ['hidden'],
    });
    const core = loadWorld(world);

    core.scrollToHit({ node: text, start: 0, end: 6, key: 'row-a', ordinal: 0 }, column);

    assert.deepEqual(row.events, ['beforematch'], 'the folded row must be asked to open');
    assert.deepEqual(world.order, ['beforematch', 'scroll']);
  });
});

test('reduced motion turns the viewport move into an instant one', () => {
  withBrowserGlobals(
    () => {
      const world = createWorld();
      const { outer, column, text } = makeTranscript(world);
      const core = loadWorld(world);

      core.scrollToHit({ node: text, start: 0, end: 6, key: 'row-a', ordinal: 0 }, column);

      assert.equal(outer.calls[0].behavior, 'auto');
    },
    { matchMedia: () => ({ matches: true }) },
  );
});

test('stepping again cancels a reveal that is still settling', () => {
  withBrowserGlobals(() => {
    const world = createWorld();
    const outer = makeElement(world, {
      overflowY: 'auto',
      clientHeight: 200,
      scrollHeight: 3000,
    });
    const column = makeElement(world, { dataset: { chatFlow: '' } });
    const foldedRow = makeElement(world, {
      dataset: { chatAnchorKey: 'row-folded' },
      attrs: ['hidden'],
    });
    const foldedText = makeElement(world, { tag: 'p', offsetTop: 1200 });
    append(outer, column);
    append(column, foldedRow);
    append(foldedRow, foldedText);
    const folded = textNode('buried answer', foldedText);
    append(foldedText, folded);
    world.matches.set(folded, {
      element: foldedText,
      offsetTop: 0,
      offsetLeft: 0,
      height: 16,
      width: 60,
    });

    const plainRow = makeElement(world, { dataset: { chatAnchorKey: 'row-plain' } });
    const plainText = makeElement(world, { tag: 'p', offsetTop: 300 });
    append(column, plainRow);
    append(plainRow, plainText);
    const plain = textNode('visible answer', plainText);
    append(plainText, plain);
    world.matches.set(plain, {
      element: plainText,
      offsetTop: 0,
      offsetLeft: 0,
      height: 16,
      width: 60,
    });

    const frames = [];
    const core = loadWorld(world, (fn) => frames.push(fn));
    const flush = () => {
      while (frames.length > 0) frames.shift()();
    };

    // The folded hit starts a multi-frame settle.
    core.scrollToHit(
      { node: folded, start: 0, end: 6, key: 'row-folded', ordinal: 0 },
      column,
    );
    assert.equal(outer.scrollTop, 0, 'nothing moves before the first frame');
    frames.shift()();
    assert.equal(outer.scrollTop, 1108, 'the reveal frame lands on the folded hit');
    assert.equal(frames.length, 1, 'the folded hit keeps settling');

    // A second step must take ownership; the pending settle must not pull back.
    core.scrollToHit({ node: plain, start: 0, end: 7, key: 'row-plain', ordinal: 0 }, column);
    flush();

    assert.equal(outer.scrollTop, 208, 'the latest target owns the final position');
  });
});

test('without a measurable scroll box the row is still centered', () => {
  withBrowserGlobals(() => {
    const world = createWorld();
    const column = makeElement(world, { dataset: { chatFlow: '' } });
    const row = makeElement(world, { dataset: { chatAnchorKey: 'row-a' } });
    const paragraph = makeElement(world, { tag: 'p', offsetTop: 20 });
    append(column, row);
    append(row, paragraph);
    const text = textNode('fallback text', paragraph);
    append(paragraph, text);
    world.matches.set(text, {
      element: paragraph,
      offsetTop: 0,
      offsetLeft: 0,
      height: 16,
      width: 60,
    });

    const core = loadWorld(world);
    core.scrollToHit({ node: text, start: 0, end: 8, key: 'row-a', ordinal: 0 }, column);

    assert.deepEqual(row.intoView, { block: 'center', inline: 'nearest', behavior: 'auto' });
  });
});

//#endregion
