# dsh-plugin-theme-toggle

A one-click light/dark switch for the **DeepSeek Harness (DSH)** Web GUI.

A single button joins the sidebar foot, directly above the account button: the
sun icon + `浅色` while the page is dark, the moon icon + `深色` while it is
light. Clicking it flips the **saved** theme preference, so the choice survives
restarts and reaches every open page through the theme service. The button
itself is drawn with `--dsw-*` tokens, so it follows whichever theme (or palette
override) is active.

## Where the button lives, and why

The requested placement was inside the account flyout (the menu that opens from
the avatar: `设置` / `意见反馈` / `退出登录`). That menu is the **single occupant**
of the `settings.launcher` seat (`client-ui-settings-account AccountMenu`).
A register call into that seat replaces the occupant outright: the menu — and
with it Settings, Feedback, and Sign out — would disappear. The shell exposes no
list slot for extra rows inside the flyout.

The nearest additive seat is the one the shell itself documents as "optional
actions beside Settings at the sidebar foot":

```
footArea
├─ footerActions      ← sidebar.footer.action (list, replaceRisk: none)
└─ settingsArea       ← sidebar.settings (the account button)
```

So the button renders as its own row immediately above the account button, in
the same footer block, and it never touches the shipped menu. While the account
flyout is open it is a floating layer over that area, so the row is hidden
behind it — close the menu and it is right there again.

## Behavior

- **Targets the resolved scheme.** `ctx.theme.getTheme().active.colorScheme`
  already resolves `system` through the OS; the button computes the opposite
  fixed preference, so a click from `system` lands on a concrete `light` or
  `dark`.
- **Writes through the sanctioned entry only.** `ctx.theme.setTheme` is the
  theme service's single preference write; it persists through the Host settings
  store and every page follows with the `theme/change` event. The plugin never
  touches storage itself.
- **Follows the active theme.** The label, colors, and hover layer come from
  `--dsw-*` tokens, so the button looks right under the built-in dark/light
  themes and under a palette layer such as
  [`eye-care-theme`](../eye-care-theme/README.md).
- **Localized.** `切换` labels come from the `theme-toggle` locale namespace and
  re-read on a language switch.
- **Sidebar collapse aware.** The `wide` owner prop switches the row to a
  centered icon button in the 56px rail.
- **Nothing model-visible.** The Host half is empty: no route, service, tool, or
  prompt.
- **No build step.** `client.js` is plain JavaScript shipped as-is; the tests
  read that same file.

## Install

The plugin is a DSH profile bundle with both a Host half (`index.js` via
`cordis.patch.yml`) and a browser half (`client.js`).

1. Add the package as a `link:` (or `file:`) dependency in the profile's
   `package.json`:

   ```jsonc
   {
     "dependencies": {
       "dsh-plugin-theme-toggle": "link:../../dsh-plugins/packages/theme-toggle"
     }
   }
   ```

2. Register it as a profile bundle:

   ```jsonc
   {
     "dsh": {
       "profile": {
         "bundles": ["dsh-plugin-theme-toggle"]
       }
     }
   }
   ```

   The plugin manager's install action performs both steps and links the package
   into the profile's `node_modules`.

3. Restart the Host (or let the live patch reload apply it) and reload the Web
   page once so the browser half loads.

To uninstall, disable or remove the bundle with the plugin manager and reload
the page.

## How it works

`client.js` registers one `window.__ModuleLoader__.load({ id, factory })` bundle.
Its plugin object injects `slots`, `locale`, and `theme`, registers the
`theme-toggle` dictionaries, and registers a component into
`sidebar.footer.action`:

```js
ctx.slots.inject("sidebar.footer.action", () =>
  ctx.slots.register(
    { name: "sidebar.footer.action", id: "theme-toggle", order: 10, locale: NS,
      inject: () => ({ getTheme, setTheme, subscribeTheme }) },
    ThemeToggle,
  ),
);
```

The component reads the snapshot once, subscribes to `theme/change` for later
changes, and renders a token-colored row (icon + target label). A click calls
`setTheme(opposite)`. Everything else is the shell's own machinery.

## Verification

- `npm test` checks the bundle contract, the exact slot registration, the
  inject face (read/write/subscribe), the opposite-preference rule, both locale
  dictionaries, and the shipped manifest/icon/locales.
- Manual check: the row appears above the account button; clicking it flips the
  page and the persisted `ui-theme.preference`; the icon/label swap; the account
  menu still opens normally.

## Troubleshooting

- **No button appears.** Reload the Web page once after installing, and confirm
  the bundle row is enabled in the Plugins page. The seat only exists while
  `ui-sidebar` is mounted.
- **The button disappears while the account menu is open.** Expected: the flyout
  is a floating layer above the footer block.
- **The page changed but the preference did not persist.** The write goes
  through the `ui-theme` plugin's Host settings; if that plugin is disabled, the
  button falls back to in-page state only.

## Privacy

The plugin reads the current theme state and writes the theme preference through
the existing theme service. It makes no network requests and reads no session
data.

## License

[MIT](../../LICENSE) © 2026 fakeNihilist
