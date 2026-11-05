/**
 * Contract tests for the shipped eye-care theme bundle.
 *
 * The theme is a token layer, so "it works" is three separate promises:
 *
 * 1. the bundle registers under the package name the Host serves, declares the
 *    `theme` service, and stacks exactly one override layer whose disposer is
 *    handed to a Cordis effect (unload restores the built-in palette);
 * 2. the token map is complete for the alias tokens the Appearance row exposes,
 *    carries a value for both color schemes, and every value is a CSS color the
 *    browser can parse; and
 * 3. the resulting palettes are actually eye-care: text-on-background contrast
 *    stays readable instead of drifting to low-contrast mush, and the dark
 *    palette keeps its blue channel under control.
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

/** The alias tokens the built-in Appearance preference exposes; a theme must cover them. */
const REQUIRED_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
];

const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(|color-mix\(in srgb,|color\(|transparent$|currentcolor$)/i;

/** Fake browser Cordis context recording the theme seat. */
function createContext() {
  const record = { effects: [], layers: [] };
  const ctx = {
    effect(factory, label) {
      record.effects.push({ label, dispose: factory() });
      return () => {};
    },
    theme: {
      overrideTokens(source, tokens) {
        record.layers.push({ source, tokens });
        return () => {};
      },
    },
  };
  return { ctx, record };
}

/** Apply the plugin once and return what it told the theme service. */
function applyTheme() {
  const { exports } = loadBundle();
  const { ctx, record } = createContext();
  exports.apply(ctx);
  assert.equal(record.layers.length, 1, 'expected exactly one token layer');
  return { exports, record, ...record.layers[0] };
}

/** `#rrggbb` / `#rrggbbaa` to `[r, g, b]`; other formats are asserted separately. */
function hexToRgb(value) {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  assert.ok(match, `expected a hex color, got "${value}"`);
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = () => applyTheme().tokens;

test('the bundle registers under the package name the Host serves', () => {
  const { id } = loadBundle();
  assert.equal(id, 'dsh-plugin-eye-care-theme');
});

test('the client half declares the theme service and an apply function', () => {
  const { exports } = loadBundle();
  assert.deepEqual(exports.inject, ['theme']);
  assert.equal(typeof exports.apply, 'function');
});

test('applying stacks one override layer through a Cordis effect', () => {
  const { record, source, tokens: layer } = applyTheme();
  assert.equal(source, 'dsh-plugin-eye-care-theme');
  assert.ok(Object.keys(layer).length >= REQUIRED_TOKENS.length);
  assert.equal(record.effects.length, 1);
  assert.match(record.effects[0].label, /token layer/i);
});

test('every layered token carries both a light and a dark value', () => {
  for (const [name, modes] of Object.entries(tokens())) {
    assert.match(name, /^--dsw-[a-z0-9-]+$/);
    assert.equal(typeof modes, 'object', `${name} must use the { light, dark } shape`);
    for (const scheme of ['light', 'dark']) {
      assert.equal(typeof modes[scheme], 'string', `${name}.${scheme} must be a string`);
      assert.ok(modes[scheme].trim().length > 0, `${name}.${scheme} must not be empty`);
    }
    assert.notEqual(modes.light, modes.dark, `${name} must differ between schemes`);
  }
});

test('every color value is a CSS color the browser can parse', () => {
  for (const [name, modes] of Object.entries(tokens())) {
    for (const scheme of ['light', 'dark']) {
      assert.match(modes[scheme], CSS_COLOR, `${name}.${scheme} is not a recognizable color`);
    }
  }
});

test('the alias tokens the Appearance row exposes are all overridden', () => {
  const layer = tokens();
  for (const name of REQUIRED_TOKENS) {
    assert.ok(name in layer, `missing required token ${name}`);
  }
});

test('dark text stays readable on the dark surfaces', () => {
  const layer = tokens();
  const base = hexToRgb(layer['--dsw-alias-bg-base'].dark);
  assert.ok(
    contrast(hexToRgb(layer['--dsw-alias-label-primary'].dark), base) >= 10,
    'primary dark text should stay far above AA against the base surface',
  );
  assert.ok(
    contrast(hexToRgb(layer['--dsw-alias-label-secondary'].dark), base) >= 4.5,
    'secondary dark text should pass AA for small text',
  );
  assert.ok(
    contrast(hexToRgb(layer['--dsw-alias-label-tertiary'].dark), base) >= 3,
    'tertiary dark text is the shipped de-emphasized tier; keep it readable',
  );
});

test('light text stays readable on the light surfaces', () => {
  const layer = tokens();
  const base = hexToRgb(layer['--dsw-alias-bg-base'].light);
  assert.ok(contrast(hexToRgb(layer['--dsw-alias-label-primary'].light), base) >= 10);
  assert.ok(contrast(hexToRgb(layer['--dsw-alias-label-secondary'].light), base) >= 4.5);
  assert.ok(contrast(hexToRgb(layer['--dsw-alias-label-tertiary'].light), base) >= 3);
});

test('the dark palette is warm and low-blue rather than neutral grey', () => {
  const layer = tokens();
  const [r, g, b] = hexToRgb(layer['--dsw-alias-bg-base'].dark);
  // The base carries a faint moss tint: green leads, blue trails, and nothing is so
  // saturated that the app reads as a "green theme" instead of a calm dark surface.
  assert.ok(g > r && r > b, `expected green > red > blue, got ${r},${g},${b}`);
  assert.ok(g - b <= 10, `tint too strong: blue trails green by ${g - b}`);
  // Cream text keeps the red channel highest so it reads warm, not bluish white.
  const [tr, tg, tb] = hexToRgb(layer['--dsw-alias-label-primary'].dark);
  assert.ok(tr >= tg && tg > tb, `expected warm text, got ${tr},${tg},${tb}`);
});

test('the plugin manifest wires the bundle the Host expects', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.name, 'dsh-plugin-eye-care-theme');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-theme']);
  assert.match(readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'), /id: eye-care-theme/);
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
  // The Host reads the top-level `icon` field of a package-root plugin before it
  // falls back to the injected default artwork.
  assert.equal(readJson('package.json').icon, './icon.svg');
});
