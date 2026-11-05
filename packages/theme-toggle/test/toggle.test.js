/**
 * Contract tests for the shipped theme-toggle bundle.
 *
 * A quick switch is three promises: it renders into the additive sidebar footer
 * seat (not over the account menu's own occupant), it computes the opposite
 * preference from the *resolved* scheme, and it writes only through the theme
 * service's preference entry instead of touching storage itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBundle } from './load-bundle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const readJson = (path) => JSON.parse(readFileSync(join(PACKAGE_ROOT, path), 'utf8'));

/** Theme snapshot stub with one resolved scheme. */
function snapshotOf(colorScheme) {
  return {
    preference: colorScheme,
    fontSizes: { text: 14, code: 11, terminal: 13 },
    fontFamilies: { text: '', code: '', terminal: '' },
    active: { id: colorScheme, colorScheme, tokens: {} },
    themes: [],
    revision: 1,
  };
}

/** Fake browser Cordis context recording registrations and writes. */
function createContext() {
  const record = { effects: [], locales: [], injections: [], registrations: [], writes: [] };
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
        record.injections.push(key);
        record.registrations.push(callback());
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
    on(event, listener) {
      record.subscriptions = record.subscriptions ?? [];
      record.subscriptions.push({ event, listener });
      return () => {};
    },
    theme: {
      getTheme: () => snapshotOf('dark'),
      setTheme: (id) => {
        record.writes.push(id);
      },
    },
  };
  return { ctx, record };
}

test('the bundle registers under the package name the Host serves', () => {
  const { id } = loadBundle();
  assert.equal(id, 'dsh-plugin-theme-toggle');
});

test('the client half injects exactly the services it uses', () => {
  const { exports } = loadBundle();
  assert.deepEqual(exports.inject, ['slots', 'locale', 'theme']);
  assert.equal(typeof exports.apply, 'function');
});

test('apply registers dictionaries and one sidebar footer action', () => {
  const { exports } = loadBundle();
  const { ctx, record } = createContext();
  exports.apply(ctx);

  assert.equal(record.locales.length, 1);
  assert.equal(record.locales[0].ns, 'theme-toggle');
  assert.ok(record.effects.some((effect) => /dictionaries/.test(effect.label)));

  assert.deepEqual(record.injections, ['sidebar.footer.action']);
  const { options, component } = record.registrations[0];
  assert.equal(options.name, 'sidebar.footer.action');
  assert.equal(options.id, 'theme-toggle');
  assert.equal(options.order, 10);
  assert.equal(options.locale, 'theme-toggle');
  assert.equal(typeof component, 'function');
  assert.equal(typeof options.inject, 'function');
});

test('the inject face exposes the theme read, write, and subscription', () => {
  const { exports } = loadBundle();
  const writes = [];
  const subscriptions = [];
  let capturedOptions = null;
  const ctx = {
    effect: () => () => {},
    locale: { register: () => () => {} },
    slots: {
      inject(key, callback) {
        callback();
      },
      register(options) {
        capturedOptions = options;
        return () => {};
      },
    },
    on(event, listener) {
      subscriptions.push({ event, listener });
      return () => {};
    },
    theme: {
      getTheme: () => snapshotOf('dark'),
      setTheme: (id) => writes.push(id),
    },
  };
  exports.apply(ctx);

  const face = capturedOptions.inject();
  assert.equal(typeof face.getTheme, 'function');
  assert.equal(typeof face.setTheme, 'function');
  assert.equal(typeof face.subscribeTheme, 'function');
  assert.equal(face.getTheme().active.colorScheme, 'dark');
  face.setTheme('light');
  assert.deepEqual(writes, ['light']);
  // The subscription targets the documented event and returns a disposer.
  const dispose = face.subscribeTheme(() => {});
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(subscriptions.map(({ event }) => event), ['theme/change']);
});

test('a click always asks for the opposite fixed preference', () => {
  const { exports } = loadBundle();
  const { nextPreference } = exports.__internals;
  assert.equal(nextPreference('dark'), 'light');
  assert.equal(nextPreference('light'), 'dark');
  assert.equal(nextPreference(undefined), 'dark');
});

test('both locale dictionaries carry the same complete key set', () => {
  const { exports } = loadBundle();
  const { zh, en } = exports.__internals;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.length > 0, `zh.${key} is empty`);
    assert.ok(en[key].length > 0, `en.${key} is empty`);
  }
  assert.equal(zh.switchToLight, '切换到浅色');
  assert.equal(zh.switchToDark, '切换到深色');
});

test('the plugin manifest wires the bundle the Host expects', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.name, 'dsh-plugin-theme-toggle');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-locale',
  ]);
  assert.match(readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'), /id: theme-toggle/);
});

test('the bundle ships display metadata and an original icon', () => {
  for (const locale of ['zh', 'en']) {
    const dict = readJson(`locale/${locale}.json`);
    assert.ok(dict.meta.title.trim().length > 0, `${locale} title is empty`);
    assert.ok(dict.meta.description.trim().length > 0, `${locale} description is empty`);
  }
  const icon = readFileSync(join(PACKAGE_ROOT, 'icon.svg'), 'utf8');
  assert.match(icon, /^<svg[\s>]/);
  assert.match(icon, /viewBox="0 0 64 64"/);
  assert.equal(readJson('package.json').icon, './icon.svg');
});
