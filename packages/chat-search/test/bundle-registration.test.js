/**
 * Registration tests for the shipped browser bundle.
 *
 * A plugin can be logically perfect and still be invisible: the module table, the slot
 * id, the locale namespace, and the shortcut binding are all contracts with the running
 * client. These tests load the real `client.js` through the stub loader and assert those
 * contracts, plus the Host half's shape, so a packaging mistake fails before install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDocument, loadBundle } from './load-bundle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

/** Fake browser Cordis context that records every registration. */
function createContext() {
  const record = {
    effects: [],
    locales: [],
    slotInjections: [],
    slots: [],
  };
  const ctx = {
    effect(factory, label) {
      record.effects.push({ label, dispose: factory() });
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

test('the bundle registers under the package name the Host loads', () => {
  const { id } = loadBundle();
  assert.equal(id, 'dsh-plugin-chat-search');
});

test('the bundle declares the services and entry points the client expects', () => {
  const { exports } = loadBundle();
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.__internals.ChatSearchControl, 'function');
});

test('the bundle requires only modules the Platform Seed provides', () => {
  // The stub loader throws on any other specifier, so reaching this assertion at all
  // proves the bundle stays inside the seed table: react, react-dom, and primitives.
  const { exports } = loadBundle();
  assert.equal(typeof exports.apply, 'function');
});

test('apply registers the stylesheet, the dictionaries, and the header slot', () => {
  const { exports, document } = loadBundle();
  const { ctx, record } = createContext();
  exports.apply(ctx);

  assert.deepEqual(record.slotInjections, ['conversation.session.header.utilities']);
  assert.equal(record.slots.length, 1);
  const registration = record.slots[0];
  assert.equal(registration.options.name, 'conversation.session.header.utilities');
  assert.equal(registration.options.id, 'chat-search');
  assert.equal(registration.options.locale, 'chatSearch');
  assert.equal(registration.options.order, 20);
  assert.equal(registration.component, exports.__internals.ChatSearchControl);
  assert.deepEqual(registration.options.inject(), {});

  assert.deepEqual(
    record.locales.map((entry) => entry.ns),
    ['chatSearch'],
  );
  assert.ok(record.effects.some((entry) => entry.label === 'chat-search: stylesheet'));
  assert.ok(record.effects.some((entry) => entry.label === 'chat-search: dictionaries'));
  assert.ok(record.effects.some((entry) => entry.label === 'chat-search: find shortcut'));

  // The stylesheet is tagged the way shipped bundles tag theirs, so a second
  // activation of the same page does not stack duplicate rules.
  const style = document.head.children[0];
  assert.equal(style.dataset.plugin, 'dsh-plugin-chat-search');
  assert.equal(style.dataset.pluginCss, exports.__internals.CSS_TAG_ID);
  assert.match(style.textContent, /::highlight\(dsh-chat-search\)/);
  assert.match(style.textContent, /\.dcs-bar\{/);
});

test('both dictionaries carry exactly the same key set', () => {
  const { exports } = loadBundle();
  const zh = Object.keys(exports.__internals.zh).sort();
  const en = Object.keys(exports.__internals.en).sort();
  assert.deepEqual(zh, en);
  assert.ok(zh.length > 0);
});

test('the shipped locale files match the embedded dictionaries', () => {
  const { exports } = loadBundle();
  for (const [locale, dict] of [
    ['en', exports.__internals.en],
    ['zh', exports.__internals.zh],
  ]) {
    const file = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'locale', `${locale}.json`), 'utf8'));
    assert.deepEqual(file, dict, `locale/${locale}.json drifted from the embedded dictionary`);
  }
});

test('the shortcut is captured and routed, and stands down with no conversation', () => {
  const { exports, document } = loadBundle();
  const { ctx } = createContext();
  exports.apply(ctx);

  const handlers = document.listenersFor('keydown');
  assert.equal(handlers.length, 1);
  const onKeyDown = handlers[0];

  /** A keydown record shaped like the DOM event the handler reads. */
  const key = (overrides = {}) => ({
    key: 'f',
    code: 'KeyF',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...overrides,
  });

  // No resident conversation: the browser keeps its own find, untouched.
  exports.__internals.registry.clear();
  const alone = key();
  onKeyDown(alone);
  assert.equal(alone.defaultPrevented, false);

  // A resident conversation: the shortcut is consumed and the bar opens.
  let opened = 0;
  const handle = {
    isOpen: () => false,
    open() {
      opened += 1;
    },
    close() {},
    ownsFocus: () => false,
    isVisible: () => true,
    area: () => 100,
  };
  exports.__internals.registry.set(handle, handle);
  try {
    const pressed = key();
    onKeyDown(pressed);
    assert.equal(pressed.defaultPrevented, true);
    assert.equal(opened, 1);

    // A non-Latin layout reports the physical key with a localized `key`.
    const cyrillic = key({ key: 'а' });
    onKeyDown(cyrillic);
    assert.equal(cyrillic.defaultPrevented, true);
    assert.equal(opened, 2);

    // Modified presses stay with the browser and the shell.
    for (const ignored of [
      key({ key: 'g', code: 'KeyG' }),
      key({ key: 'F', ctrlKey: false, metaKey: false }),
      key({ altKey: true }),
      key({ key: 'f', ctrlKey: false, metaKey: false }),
    ]) {
      onKeyDown(ignored);
      assert.equal(ignored.defaultPrevented, false);
      assert.equal(opened, 2);
    }

    // An event an earlier handler already consumed is left alone.
    const consumed = key({ defaultPrevented: true });
    onKeyDown(consumed);
    assert.equal(consumed.defaultPrevented, true);
    assert.equal(opened, 2);

    // Command on macOS is the same gesture.
    const mac = key({ ctrlKey: false, metaKey: true });
    onKeyDown(mac);
    assert.equal(mac.defaultPrevented, true);
    assert.equal(opened, 3);
  } finally {
    exports.__internals.registry.clear();
  }
});

test('a second activation does not append a duplicate stylesheet', () => {
  const document = createDocument();
  loadBundle({ document }).exports.apply(createContext().ctx);
  loadBundle({ document }).exports.apply(createContext().ctx);
  assert.equal(document.head.children.length, 1);
});

test('the Host half is a pure surface plugin', async () => {
  const host = await import('../index.js');
  assert.equal(host.name, 'chat-search');
  assert.equal(typeof host.apply, 'function');
  // Applying it must not touch any Host surface; the plugin owns no route or tool.
  assert.equal(host.apply(), undefined);
  assert.equal(host.inject, undefined);
});

test('the bundle patch inserts the package the Host loader imports', () => {
  const patch = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /-\s+id:\s*chat-search/);
  assert.match(patch, /name:\s*'dsh-plugin-chat-search'/);
});

test('the manifest points the bundle patch and the browser half at real files', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-plugin-chat-search');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './client.js');
  for (const relative of [manifest.dsh.bundle.patch, manifest.exports['./client'], manifest.exports['.']]) {
    assert.doesNotThrow(() => readFileSync(join(PACKAGE_ROOT, relative)));
  }
});
