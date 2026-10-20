/**
 * Integration tests: the real component, real React DOM, a real transcript tree.
 *
 * These mount the shipped bundle inside jsdom and drive the find flow end to end. They
 * earn their extra dependencies by catching what the unit suites structurally cannot:
 * an element type React rejects, an effect that throws on mount, a highlight layer that
 * silently never fills, and the transcript DOM contract the Chat view actually publishes.
 *
 * `browser-env.js` must be imported first — see its module doc for why.
 *
 * Run with `npm run test:dom` (after `npm install` for the devDependencies). `npm test`
 * stays dependency-free.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createContext,
  document,
  highlights,
  scrollCalls,
  window,
} from './browser-env.js';

import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { loadBundle } from '../load-bundle.js';

/** The transcript text every stage supplies. */
const ROWS = [
  ['row-a', 'The quick brown fox jumps over the lazy dog.'],
  ['row-b', 'A second row mentioning fox again.'],
  ['row-c', 'Nothing to find here.'],
];

/** The client primitives the bundle draws with, as identifiable marker components. */
function createPrimitives() {
  const icon = (name) =>
    function Icon({ size }) {
      return React.createElement('svg', { 'data-icon': name, width: size });
    };
  return {
    IconSearchOutlineRegular: icon('IconSearchOutlineRegular'),
    IconChevronUpOutlineRegular: icon('IconChevronUpOutlineRegular'),
    IconChevronDownOutlineRegular: icon('IconChevronDownOutlineRegular'),
    IconCloseOutlineRegular: icon('IconCloseOutlineRegular'),
  };
}

/**
 * Build one isolated stage: a wrapper that owns both a synthetic transcript and the
 * control, mirroring the real layout where the Session header and the Chat view are
 * siblings under one Session-scoped conversation container.
 */
function createStage() {
  const wrapper = document.createElement('div');
  const column = document.createElement('div');
  column.setAttribute('data-chat-flow', '');
  for (const [key, text] of ROWS) {
    const row = document.createElement('div');
    row.setAttribute('data-chat-anchor-key', key);
    row.setAttribute('data-chat-flow-key', key);
    row.textContent = text;
    column.appendChild(row);
  }
  const mountPoint = document.createElement('div');
  wrapper.append(column, mountPoint);
  document.body.appendChild(wrapper);

  const caught = [];
  const root = createRoot(mountPoint, {
    onCaughtError: (error) => caught.push(error),
    onUncaughtError: (error) => caught.push(error),
    onRecoverableError: (error) => caught.push(error),
  });

  const loaded = loadBundle({
    windowObject: window,
    document,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (fn) => window.setTimeout(fn, 0),
    modules: {
      react: React,
      'react-dom': ReactDOM,
      '@deepseek-ai/dsh-client-ui-primitives': createPrimitives(),
    },
  });

  // Activate the plugin the way the client does, so the stylesheet and the shortcut are
  // part of the stage rather than something only the unit suite knows about.
  const activation = createContext();
  loaded.exports.apply(activation.ctx);

  const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`);
  act(() => {
    root.render(
      React.createElement(loaded.exports.__internals.ChatSearchControl, { t, sessionId: 'session-1' }),
    );
  });

  // The bar is portalled to the document body, so it is found document-wide; each stage
  // disposes before the next one builds, so only one bar exists at a time.
  const bar = () => document.querySelector('.dcs-bar');
  const count = () => document.querySelector('.dcs-count')?.textContent ?? null;
  const input = () => document.querySelector('.dcs-input');
  const buttons = () => [...document.querySelectorAll('.dcs-bar .dcs-btn')];
  const trigger = () => mountPoint.querySelector('button');

  const click = (element) => {
    act(() => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  /** Type a query and wait past the search debounce. */
  const type = async (value) => {
    const field = input();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    act(() => {
      setter.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await settle();
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  };
  /** Names of the registry entries currently holding at least one range. */
  const painted = () =>
    [...highlights.registry.entries()]
      .filter(([, value]) => value.ranges.length > 0)
      .map(([name]) => name)
      .sort();

  return {
    document, column, wrapper, mountPoint, caught, activation, loaded,
    trigger, bar, count, input, buttons, click, type, settle, painted,
    open: () => click(mountPoint.querySelector('button')),
    activeText: () =>
      highlights.registry.get('dsh-chat-search-active')?.ranges?.[0]?.toString() ?? null,
    /** Unmount and remove the stage so the next test starts from a clean document. */
    dispose() {
      act(() => root.unmount());
      wrapper.remove();
      highlights.registry.clear();
      scrollCalls.length = 0;
    },
  };
}

/** Run one body with a fresh stage and always dispose it. */
function withStage(t, body) {
  const stage = createStage();
  t.after(() => stage.dispose());
  return body(stage);
}

test('activating the plugin injects the stylesheet and the shortcut', (t) => {
  withStage(t, (stage) => {
    const injected = [...document.head.querySelectorAll('style[data-plugin-css]')]
      .map((node) => node.dataset.pluginCss);
    assert.ok(
      injected.includes('dsh-plugin-chat-search/FindBar.css'),
      'apply must inject the find-bar stylesheet',
    );
    assert.deepEqual(stage.activation.record.slotInjections, [
      'conversation.session.header.utilities',
    ]);
    assert.equal(stage.activation.record.locales[0].ns, 'chatSearch');

    // Ctrl+F opens the bar in the resident conversation; a non-Latin layout
    // reports `key: 'а'` while the physical key stays `KeyF`.
    act(() => {
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'а',
          code: 'KeyF',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.ok(stage.bar() !== null, 'the shortcut must open the find bar');
  });
});

test('the control mounts and renders a labelled trigger', (t) => {
  withStage(t, (stage) => {
    const trigger = stage.trigger();
    assert.ok(trigger !== null, 'the trigger must render');
    assert.equal(trigger.getAttribute('aria-label'), 'open');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.querySelector('svg')?.dataset.icon, 'IconSearchOutlineRegular');
    assert.deepEqual(stage.caught, [], 'mounting must not throw');
  });
});

test('the find bar opens as a body portal anchored below its trigger', (t) => {
  withStage(t, (stage) => {
    stage.open();
    const bar = stage.bar();
    assert.ok(bar !== null);
    assert.equal(bar.getAttribute('role'), 'search');
    assert.equal(bar.parentElement, document.body, 'the bar must escape header clipping');
    // Anchored under the measured trigger (bottom 68 + the 8px gap).
    assert.equal(bar.style.top, '76px');
    assert.equal(bar.style.right, '40px');
    assert.equal(stage.trigger().getAttribute('aria-expanded'), 'true');
    // The class carries the fixed positioning; the stylesheet must define it.
    const rule = [...document.head.querySelectorAll('style[data-plugin-css]')]
      .map((node) => node.textContent)
      .join('');
    assert.match(rule, /\.dcs-bar\{position:fixed/);
  });
});

test('a query counts matches across rows and paints both highlight layers', async (t) => {
  await withStage(t, async (stage) => {
    stage.open();
    await stage.type('fox');

    assert.equal(stage.count(), '1/2');
    assert.deepEqual(stage.painted(), ['dsh-chat-search', 'dsh-chat-search-active']);
    assert.equal(highlights.registry.get('dsh-chat-search').ranges.length, 2);
    assert.equal(stage.activeText(), 'fox', 'the active layer must highlight the match itself');
    assert.ok(scrollCalls.length > 0, 'the active match must be scrolled into view');
    assert.deepEqual(stage.caught, []);
  });
});

test('stepping moves the active match and wraps at both ends', async (t) => {
  await withStage(t, async (stage) => {
    stage.open();
    await stage.type('fox');
    const up = stage.buttons()[2];
    const down = stage.buttons()[3];

    assert.equal(down.disabled, false);
    stage.click(down);
    assert.equal(stage.count(), '2/2');
    stage.click(down);
    assert.equal(stage.count(), '1/2', 'stepping past the end wraps to the first match');
    stage.click(up);
    assert.equal(stage.count(), '2/2', 'stepping before the start wraps to the last match');
  });
});

test('match case and regular expression flags change the result', async (t) => {
  await withStage(t, async (stage) => {
    stage.open();

    await stage.type('FOX');
    assert.equal(stage.count(), '1/2', 'a literal query is case-insensitive by default');

    stage.click(stage.buttons()[0]);
    await stage.settle();
    assert.equal(stage.count(), 'noResults', 'match case must make FOX miss lowercase fox');
    assert.equal(stage.buttons()[0].getAttribute('aria-pressed'), 'true');

    await stage.type('f.x');
    assert.equal(stage.count(), 'noResults', 'a literal dot is not a wildcard');
    stage.click(stage.buttons()[1]);
    await stage.settle();
    assert.equal(stage.count(), '1/2', 'the regex flag must make the dot a wildcard');
    assert.equal(stage.buttons()[1].getAttribute('aria-pressed'), 'true');
  });
});

test('an unusable pattern is reported on the bar instead of thrown', async (t) => {
  await withStage(t, async (stage) => {
    stage.open();
    stage.click(stage.buttons()[1]);
    await stage.settle();
    await stage.type('f(');

    assert.equal(stage.count(), 'invalidPattern');
    assert.equal(stage.bar().getAttribute('data-invalid'), 'true');
    assert.deepEqual(stage.painted(), [], 'an unusable pattern must clear any painting');
    assert.deepEqual(stage.caught, []);
  });
});

test('a folded row is searched, and stepping onto it dispatches beforematch', async (t) => {
  await withStage(t, async (stage) => {
    const folded = document.createElement('div');
    folded.setAttribute('data-chat-anchor-key', 'row-d');
    // The Chat view keeps collapsed rows in the DOM with exactly this attribute.
    folded.setAttribute('hidden', 'until-found');
    let reveals = 0;
    folded.addEventListener('beforematch', () => {
      reveals += 1;
      folded.removeAttribute('hidden');
    });
    const inner = document.createElement('p');
    inner.textContent = 'a buried pangolin';
    folded.appendChild(inner);
    stage.column.appendChild(folded);

    stage.open();
    await stage.type('pangolin');
    assert.equal(stage.count(), '1/1', 'folded text must be searchable');
    assert.equal(reveals, 1, 'stepping onto a folded match must ask the row to reveal itself');
  });
});

test('a transcript row with no anchor key is still searched', async (t) => {
  await withStage(t, async (stage) => {
    const loose = document.createElement('div');
    loose.textContent = 'a loose pangolin outside any row';
    stage.column.appendChild(loose);

    stage.open();
    await stage.type('loose pangolin');
    assert.equal(stage.count(), '1/1');
  });
});

test('no matches disables stepping and says so', async (t) => {
  await withStage(t, async (stage) => {
    stage.open();
    assert.equal(stage.count(), '', 'an empty query shows no counter');
    assert.equal(stage.buttons()[2].disabled, true);
    assert.equal(stage.buttons()[3].disabled, true);

    await stage.type('zzzz');
    assert.equal(stage.count(), 'noResults');
    assert.equal(stage.buttons()[2].disabled, true);
  });
});

test('closing removes the bar, clears the layers, and resets the query', async (t) => {
  await withStage(t, async (stage) => {
    stage.open();
    await stage.type('fox');
    assert.equal(highlights.registry.size, 2);

    stage.click(stage.buttons().at(-1));
    assert.equal(stage.bar(), null, 'the portal must unmount');
    assert.equal(highlights.registry.size, 0, 'both layers must be dropped');
    assert.equal(stage.trigger().getAttribute('aria-expanded'), 'false');

    stage.open();
    assert.equal(stage.input().value, '', 'reopening must start from an empty query');
  });
});

test('a streaming transcript re-indexes the search under the reader', async (t) => {
  await withStage(t, async (stage) => {
    stage.open();
    await stage.type('fox');
    assert.equal(stage.count(), '1/2');

    // A new row arrives while the bar is open, exactly as a streaming turn would append.
    const row = document.createElement('div');
    row.setAttribute('data-chat-anchor-key', 'row-e');
    row.textContent = 'a third fox appears';
    stage.column.appendChild(row);
    await stage.settle();

    assert.equal(stage.count(), '1/3', 'the observer must pick up appended transcript rows');
    assert.equal(highlights.registry.get('dsh-chat-search').ranges.length, 3);
  });
});
