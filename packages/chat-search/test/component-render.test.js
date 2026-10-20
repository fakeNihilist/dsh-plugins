/**
 * Render smoke tests for the header control.
 *
 * A slot occupant that throws is not merely invisible: the framework reports the
 * error and the entry *abdicates* its cell, so the plugin silently disappears while
 * every registration test still passes. These tests therefore call the component the
 * way the slot owner does — one plain function call with the props the framework
 * composes — under a minimal hook runtime.
 *
 * That is enough to catch the whole class of failure this bug belongs to: an
 * identifier the bundle assumed the browser would provide, a missing module export,
 * or a hook consumed out of order.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, loadBundle } from './load-bundle.js';

/**
 * A hook runtime with real state cells, so a component renders exactly as React would
 * on its first pass and hook-order mistakes surface as missing cells.
 *
 * Effects are collected rather than run: the render path is what these tests own.
 */
function createHarness() {
  let cells = [];
  let index = 0;
  let effects = [];

  const sameDeps = (left, right) =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, at) => Object.is(value, right[at]));

  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const at = index++;
      if (!(at in cells)) cells[at] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = cells[at];
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next;
        },
      ];
    },
    useRef(initial) {
      const at = index++;
      if (!(at in cells)) cells[at] = { value: { current: initial } };
      return cells[at].value;
    },
    useCallback(callback, deps) {
      const at = index++;
      const cell = cells[at];
      if (cell === undefined || !sameDeps(cell.deps, deps)) cells[at] = { value: callback, deps };
      return cells[at].value;
    },
    useEffect(effect, deps) {
      index += 1;
      effects.push({ effect, deps, kind: 'effect' });
    },
    useLayoutEffect(effect, deps) {
      index += 1;
      effects.push({ effect, deps, kind: 'layout' });
    },
  };

  return {
    react,
    /** @returns the element tree the component returned for one render pass. */
    render(component, props) {
      index = 0;
      effects = [];
      const tree = component(props);
      return { tree, effects, hookCount: cells.length };
    },
  };
}

/** Walk an element tree and collect every element descriptor. */
function elementsOf(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, found);
    return found;
  }
  if ('type' in node) {
    found.push(node);
    for (const child of node.children ?? []) elementsOf(child, found);
  }
  return found;
}

/** Load the bundle against the harness's React and return a render helper. */
function setup() {
  const harness = createHarness();
  const loaded = loadBundle({ document: createDocument(), modules: { react: harness.react } });
  const Control = loaded.exports.__internals.ChatSearchControl;
  const t = (key, params) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`;
  return {
    ...loaded,
    harness,
    Control,
    render: (props = {}) => harness.render(Control, { t, sessionId: 'session-1', ...props }),
  };
}

test('the control renders a trigger button from the props the slot owner composes', () => {
  const { render } = setup();
  const { tree } = render();
  assert.equal(tree.type, 'button');
  assert.equal(tree.props.type, 'button');
  assert.equal(tree.props['aria-label'], 'open');
  assert.equal(tree.props['aria-expanded'], 'false');
  // The trigger is labelled and titled for both pointer and assistive use.
  assert.equal(tree.props.title, 'open');
  assert.equal(typeof tree.props.onClick, 'function');
  assert.equal(typeof tree.props.ref, 'object');
});

test('the closed trigger renders the magnifier icon, not raw text', () => {
  const { render } = setup();
  const { tree } = render();
  const icons = elementsOf(tree).filter((node) => typeof node.type === 'function');
  assert.equal(icons.length, 1);
  assert.equal(icons[0].type().type, 'IconSearchOutlineRegular');
});

test('an older client that spells icons by pixel size still resolves them', () => {
  // The 0.1 line exported `IconSearchOutline16`; the resolver must accept either spelling.
  const legacy = {
    IconSearchOutline16: () => ({ type: 'IconSearchOutline16' }),
    IconChevronUpOutline14: () => ({ type: 'IconChevronUpOutline14' }),
    IconChevronDownOutline14: () => ({ type: 'IconChevronDownOutline14' }),
    IconCloseOutline16: () => ({ type: 'IconCloseOutline16' }),
  };
  const harness = createHarness();
  const loaded = loadBundle({
    document: createDocument(),
    modules: { react: harness.react, '@deepseek-ai/dsh-client-ui-primitives': legacy },
  });
  const t = (key) => key;
  const { tree } = harness.render(loaded.exports.__internals.ChatSearchControl, {
    t,
    sessionId: 'session-1',
  });
  const icons = elementsOf(tree).filter((node) => typeof node.type === 'function');
  assert.equal(icons[0].type().type, 'IconSearchOutline16');
});

test('a client whose primitives export no icons still renders the control', () => {
  // This is the failure that made the entry abdicate its slot cell and disappear: a
  // missing export arrived at React as an invalid element type. The resolver draws the
  // glyph instead, so the control survives a dropped or renamed icon export.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const harness = createHarness();
    const loaded = loadBundle({
      document: createDocument(),
      modules: { react: harness.react, '@deepseek-ai/dsh-client-ui-primitives': {} },
    });
    const { tree } = harness.render(loaded.exports.__internals.ChatSearchControl, {
      t: (key) => key,
      sessionId: 'session-1',
    });
    assert.equal(tree.type, 'button');
    // The trigger still draws something: the fallback is a component that renders a glyph.
    const icon = tree.children[0];
    assert.equal(typeof icon.type, 'function', 'a fallback icon component must be rendered');
    const drawn = icon.type(icon.props ?? {});
    assert.equal(drawn.type, 'svg');
    assert.equal(drawn.children[0].type, 'path');
    // ...and the substitution is reported once, so the drift is discoverable.
    assert.ok(warnings.some((message) => message.includes('IconSearchOutline')));
  } finally {
    console.warn = originalWarn;
  }
});

test('the control renders without a locale translator rather than throwing', () => {
  // The framework always supplies `t`, but a plugin that hard-fails on a missing prop
  // abdicates its cell and disappears with no visible explanation.
  const { Control, harness } = setup();
  assert.doesNotThrow(() => harness.render(Control, { sessionId: 'session-1' }));
});

test('the control renders without a session id rather than throwing', () => {
  const { Control, harness } = setup();
  assert.doesNotThrow(() => harness.render(Control, { t: (key) => key }));
});

test('a second render consumes the same hooks in the same order', () => {
  const { render, harness } = setup();
  const first = render();
  const second = render();
  assert.equal(first.hookCount, second.hookCount);
  assert.equal(second.tree.type, 'button');
  // Stable callbacks across renders: `openBar`/`close` take no changing dependency.
  assert.equal(first.tree.props.onClick, second.tree.props.onClick);
});

test('opening the control portals the find bar beside the trigger', () => {
  const { render } = setup();
  const first = render();
  // Flip the open flag the way the trigger's click handler does.
  first.tree.props.onClick();

  const { tree } = render();
  // The trigger and the portalled bar are siblings: createPortal is stubbed to identity.
  assert.equal(typeof tree.type, 'symbol');
  const [trigger, bar] = tree.children;
  assert.equal(trigger.type, 'button');

  assert.equal(bar.type, 'div');
  assert.equal(bar.props.role, 'search');
  assert.equal(bar.props.className, 'dcs-bar');
  // The resting anchor is replaced by a measurement in a layout effect; a bar that
  // waited for that measurement would render nothing at all.
  assert.equal(typeof bar.props.style.top, 'number');
  assert.equal(typeof bar.props.style.right, 'number');

  const parts = elementsOf(bar);
  const input = parts.find((node) => node.type === 'input');
  assert.equal(input.props.placeholder, 'placeholder');
  assert.equal(input.props.value, '');

  // Case, regex, previous, next, and close.
  const buttons = parts.filter((node) => node.type === 'button');
  assert.equal(buttons.length, 5);
  assert.deepEqual(
    buttons.map((node) => node.props['aria-label']),
    ['caseSensitive', 'regex', 'prev', 'next', 'close'],
  );
  // A fresh bar has nothing to step through, so both steppers start disabled.
  assert.equal(buttons[2].props.disabled, true);
  assert.equal(buttons[3].props.disabled, true);
  assert.equal(bar.props['data-invalid'], undefined);
  assert.equal(typeof bar.props.onKeyDown, 'function');
});
