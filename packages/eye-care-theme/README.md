# dsh-plugin-eye-care-theme

A warm, low-blue-light color layer for the **DeepSeek Harness (DSH)** Web GUI.

The built-in dark theme is a neutral blue-grey: near-black `#151517` surfaces, pure
white text, and blue accents. This plugin keeps the layout and every interaction
exactly as shipped, and only repaints the color tokens:

- **Dark** — surfaces move to a faintly moss-tinted near-black (`#161a15`), text
  becomes warm cream (`#e8e4d6`) instead of pure white, and the accents (links,
  focus rings, running indicators, selection) drop from blue to muted celadon
  (`#86b8a2`). Contrast stays high enough to read comfortably, but the screen no
  longer glares: lower luminance, less blue, softer status colors.
- **Light** — the same character in the other direction: warm paper `#f5f3e8`
  instead of `#ffffff`, warm ink `#2a3027`, and the same celadon accents.

Both palettes ship together, so the layer follows the user's `light` / `dark` /
`system` preference (and an OS scheme flip while `system` is selected) without
storing any state of its own.

## Features

- **Eye-care dark palette.** Low-saturation dark green-grey surfaces, cream text,
  celadon accents, softened red/amber/green status colors, and a warm-white text
  selection. Blue is reduced rather than removed: links and focus rings stay
  clearly recognizable, they are simply no longer the loudest thing on screen.
- **Warm light palette.** The light mode is not left untouched: switching to
  `浅色` gets warm paper surfaces and ink, so the app does not flash back to pure
  white and blue.
- **Surfaces, borders, menus, code, diffs, scrollbars, toasts, and tooltips** are
  covered — not just the four base tokens. The override table targets the
  `--dsw-alias-*` and `--dsw-specific-*` color tokens the components already read.
- **Layout untouched.** Radii, shadows, blur filters, mask alphas, typography
  scales, and every non-color token keep their shipped values.
- **No saved-state side effects.** The plugin never writes the theme preference
  and never registers a theme id: it stacks one `ctx.theme.overrideTokens` layer,
  so disabling or removing the plugin restores the built-in palette exactly.
- **Nothing model-visible.** The Host half is empty; the plugin adds no route,
  service, tool, or prompt, so it cannot affect a request or its KV cache.
- **No build step.** `client.js` is plain JavaScript shipped as-is; the tests
  read that same file.

## Why `overrideTokens` instead of a registered theme

The theme service supports both extension points:

| Mechanism | Result in this DSH release |
| --- | --- |
| `ctx.theme.register({ id, colorScheme, tokens })` | Registers an in-process theme id, but the Appearance settings row only offers `浅色` / `深色` / `跟随系统` — a third-party id does not cross the built-in settings schema, so it could never be selected. |
| `ctx.theme.overrideTokens(source, { light, dark })` | Stacks a partial token layer on top of whatever theme is active. The Appearance options keep working, and the palette follows them. |

This plugin therefore uses the override layer. If a later DSH release adds a theme
picker to the Appearance row, registering an id becomes worthwhile; until then a
registered id would be dead weight that never affects a single pixel.

## Install

The plugin is a DSH profile bundle with both a Host half (`index.js` via
`cordis.patch.yml`) and a browser half (`client.js`). Install it like the other
packages in this repository:

1. Add the package as a `link:` (or `file:`) dependency in the profile's
   `package.json` (typically `<DSH_HOME>/profiles/<profile>/package.json`):

   ```jsonc
   {
     "dependencies": {
       "dsh-plugin-eye-care-theme": "link:../../dsh-plugins/packages/eye-care-theme"
     }
   }
   ```

2. Register it as a profile bundle in the same file:

   ```jsonc
   {
     "dsh": {
       "profile": {
         "bundles": ["dsh-plugin-eye-care-theme"]
       }
     }
   }
   ```

   The plugin manager's install action performs both steps and links the package
   into the profile's `node_modules`.

3. Restart the Host (or let the live patch reload apply it) and reload the Web
   page once so the browser half loads.

To uninstall, disable or remove the bundle with the plugin manager and reload the
page; the override layer is disposed with the plugin fiber and the built-in
palette returns. Nothing needs to be cleaned up by hand.

## How it works

`client.js` registers one `window.__ModuleLoader__.load({ id, factory })` bundle.
Its plugin object injects the `theme` service and, inside a Cordis effect, stacks
one layer:

```js
ctx.effect(() => ctx.theme.overrideTokens(SOURCE, tokens), "eye-care-theme: token layer");
```

The service composes the active theme's tokens with every override layer, picks
the value for the current color scheme, and the layout presenter writes the result
onto `document.body` as inline CSS variables. Because the layer carries both
`light` and `dark` values, a scheme change re-composes without any code running
in this plugin. The effect's disposer removes the layer when the plugin unloads.

The mapping for the primary surfaces:

| Token | Built-in dark | Eye-care dark | Built-in light | Eye-care light |
| --- | --- | --- | --- | --- |
| `--dsw-alias-bg-base` | `#151517` | `#161a15` | `#ffffff` | `#f5f3e8` |
| `--dsw-alias-bg-layer-1` | `#232324` | `#1e231d` | `#ffffff` | `#fcfbf5` |
| `--dsw-alias-bg-layer-2` | `#2c2c2e` | `#262c25` | `#ffffff` | `#fcfbf5` |
| `--dsw-specific-sidebar-fill` | `#1b1b1c` | `#131712` | `#f9fafb` | `#f6f4ea` |
| `--dsw-alias-label-primary` | `#f9fafb` | `#e8e4d6` | `#0f1115` | `#2a3027` |
| `--dsw-alias-label-secondary` | `#cfd3d6` | `#bdb9ab` | `#61666b` | `#5c6355` |
| `--dsw-alias-border-l1` | `#ffffff0f` | `#e8e4d614` | `#0000000a` | `#2b322710` |
| `--dsw-alias-state-business-primary` | `#7aaaff` | `#86b8a2` | `#4176e6` | `#3d7a62` |
| `--dsw-alias-state-error-primary` | `#f25a5a` | `#d97b6a` | `#ec1313` | `#c14a3a` |

The complete table (114 tokens) lives in `client.js`, grouped by surface role:
base surfaces, borders, labels, brand and buttons, interaction layers, states,
scrollbars, markdown and diffs, menus and small controls.

## Verification

- `npm test` in this package checks the bundle contracts, the token completeness,
  the color syntax, the shipped manifest/icon/locales, and two palette properties
  that are easy to regress: text contrast on both schemes, and the "warm and
  low-blue" tint of the dark base.
- Manual check in a running profile: the composer, transcript, Settings >
  General, Plugins page, and plugin row icon should all render in the warm
  palette, with no console errors. The bundle half reports no errors when the
  layer applies.
- The Appearance row still offers `浅色` / `深色` / `跟随系统`; selecting `深色`
  gives the eye-care dark palette and selecting `浅色` gives the eye-care light
  palette. That is the intended behavior, not a missing theme entry.

## Troubleshooting

- **The GUI still looks blue-grey.** The browser half loads with the page; reload
  the Web page once after installing. Confirm the bundle row is enabled in the
  Plugins page.
- **Only part of the UI changed.** A component that hardcodes a color instead of
  reading a `--dsw-*` token is outside this plugin's reach; file an issue with a
  screenshot and the element.
- **A theme choice does not persist.** This plugin does not own the preference;
  the built-in `ui-theme` row does. The palette follows that choice.

## Privacy

The plugin makes no network requests, reads no session data, and changes no
persisted setting. It only writes CSS variables on the page while it is enabled.

## License

[MIT](../../LICENSE) © 2026 fakeNihilist
