# dsh-plugin-browser

Host-side Playwright browser tools for DeepSeek Harness (DSH).

A model-facing browser: a real Chromium runs on the Host, and the agent opens pages,
reads an ARIA tree, clicks, types, captures screenshots, handles dialogs and downloads,
and records WebM. Unlike the user-facing Sidebar browser, this plugin owns its own
browser process and drives it through `playwright-core`; it does not depend on any
DSH-internal webview, preload API, or client bundle.

The plugin is **Host-only**. It registers ten `browser_*` tools plus one prompt section
on the Host. There is no client half, so there is no UI entry — `browser_view` opens a
separate Chrome window, not the DSH Sidebar panel.

## Tools

| Tool | Purpose |
|---|---|
| `browser_open` | Open an HTTP(S) URL, reusing a same-site tab by default |
| `browser_tabs` | List, select, close, or mark tabs `handoff`/`deliverable` |
| `browser_snapshot` | Compact ARIA tree of the main frame and every child frame |
| `browser_read` | Targeted text/HTML/attribute/value/box read |
| `browser_act` | One action: click, dblclick, fill, type, press, check, uncheck, select, hover, focus, scroll, drag, evaluate, CUA coordinate actions, wait. Set `waitForNavigation` when the action is expected to change the tab URL. |
| `browser_capture` | Page (optionally full-page) or element PNG |
| `browser_dialog` | List, accept, or dismiss a JavaScript dialog |
| `browser_download` | List saved downloads or copy one to a workspace path |
| `browser_record` | WebM recording, optionally with an action DSL |
| `browser_view` | Show/hide a headed Chrome window (separate from the DSH Sidebar; restarts the browser and reopens recent tab URLs) |

## Requirements

- DeepSeek Harness with a profile. The plugin runs inside the Host process; nothing is
  built for the browser side.
- Node.js. The runtime code imports only Node builtins and `playwright-core` (tested on
  Node 24); the package has a single runtime dependency.
- A locally installed Chrome, Edge, or Chromium. The plugin never downloads a browser:
  it tries `browserPath`, then `channel`, then the first standard install location.
  `DSH_BROWSER_PATH`, `CHROME_PATH`, `EDGE_PATH`, and
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` are also honored when discovering a browser.
- For `browser_record` only, Playwright's bundled ffmpeg:
  `node node_modules/playwright-core/cli.js install ffmpeg`.
  Without it only recording fails; every other tool still works.

## Install

The plugin is a DSH profile bundle. Installing it means four things: make the package
resolvable from the profile, add it to `dsh.profile.bundles`, let the bundled
`cordis.patch.yml` insert its Cordis component, and restart the Host.

### Automated (Windows)

```powershell
pwsh -File install.ps1 -Profile desktop          # link + contract tests
pwsh -File install.ps1 -Profile desktop -Restart # also stop a running app
```

`install.ps1` performs the manual steps below:

1. adds `"@local/dsh-plugin-browser": "link:<this directory>"` to the profile's
   `package.json` dependencies;
2. appends `@local/dsh-plugin-browser` to `dsh.profile.bundles` and sets
   `dsh.profile.patchReload: "live"`;
3. creates the `node_modules/@local/dsh-plugin-browser` junction that the Host resolves
   the bundle through;
4. runs the contract tests from the linked package;
5. with `-Restart`, stops a running DeepSeek Harness process (relaunch it afterwards).

### Manual (any platform)

1. Add the package to `<DSH_HOME>/profiles/<profile>/package.json`:

   ```jsonc
   {
     "dependencies": {
       "@local/dsh-plugin-browser": "link:/absolute/path/to/dsh-plugin-browser"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@local/dsh-plugin-browser"
         ],
         "patchReload": "live"
       }
     }
   }
   ```

2. Link the package into the profile's `node_modules` (the dependency spec above only
   records the link):

   ```powershell
   # Windows
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@local" | Out-Null
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@local\dsh-plugin-browser" `
     -Target "C:\absolute\path\to\dsh-plugin-browser"
   ```

   ```bash
   # macOS / Linux
   mkdir -p ~/.dsh/profiles/<profile>/node_modules/@local
   ln -s /absolute/path/to/dsh-plugin-browser \
     ~/.dsh/profiles/<profile>/node_modules/@local/dsh-plugin-browser
   ```

3. Restart the Host or open a new session. `browser_*` tools then appear in the tool
   list.

Because the package is linked rather than copied, Host-side source edits are picked up
on the next Host restart.

### How the bundle patch works

`package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. The
profile bundle loader applies that patch, which inserts a Cordis component:

```yaml
- insert:
    - id: browser-tools
      name: '@local/dsh-plugin-browser'
```

`id: browser-tools` is also the handle used to override the component's config.

## Configuration

Override the component by id in the profile's `cordis.patch.yml`:

```yaml
- id: browser-tools
  name: '@local/dsh-plugin-browser'
  config:
    enabled: true
    channel: chrome          # example; unset by default → auto-discovery
    browserPath: null        # explicit executablePath wins over channel
    headed: false            # true opens a visible Chrome window
    viewport: { width: 1280, height: 800 }
    timeoutMs: 90000
    navigationTimeoutMs: 30000
    actionTimeoutMs: 5000
    snapshotMaxChars: 60000
    idleCloseMs: 1800000
    browserIdleCloseMs: 300000
    maxDownloadBytes: 209715200
    outputDir: .dsh-browser
    allowPrivateNetwork: loopback  # all | loopback | none
    allowFileUrls: false
    allowEvaluate: true
    persistCookies: false
    launchArgs: []
    recording: { enabled: true }
```

The block above lists every supported key. Values shown are the plugin defaults, except
`channel`, which is only an example — leave it unset (with `browserPath` unset) to
auto-detect the installed browser.

- `channel` / `browserPath` select the browser binary; without either, the plugin uses
  the first installed Chrome, Edge, or Chromium it finds.
- `allowPrivateNetwork` is a destination policy, not a browser permission: `loopback`
  allows localhost/127.0.0.1/::1 but refuses RFC1918, link-local, and cloud metadata;
  `all` allows private addresses but still refuses metadata; `none` refuses every
  non-public destination. Hostnames are resolved before navigation, so a public-looking
  name cannot point at loopback.
- `headed` starts a visible Chrome window; `browser_view` toggles the same setting at
  runtime by restarting the browser.
- `outputDir` is relative to the session workspace and holds screenshots, downloads,
  and recordings.
- `idleCloseMs` closes an idle session's tabs/browser context; `browserIdleCloseMs`
  closes the shared Chromium process.
- `allowFileUrls` and `allowEvaluate` gate the two deliberate escape hatches
  (`file:` URLs and page-context JavaScript).

## Usage

The plugin contributes a prompt section that teaches the observation loop:

1. `browser_open` → tab id.
2. `browser_snapshot` → ARIA tree (roles, names, states, shadow DOM, frames).
3. Build a target from snapshot facts:
   `{ "by": "role", "role": "button", "name": "Sign in" }`.
4. `browser_act` → one state-changing action.
5. Re-observe with `browser_snapshot` or a targeted `browser_read`.

Page content is untrusted data; the prompt section and every snapshot say so.
`browser_act` with `action: "evaluate"` is the only page-code escape hatch. It can
change page state and should be used only when the high-level actions cannot express
the intent.

### Artifacts

Screenshots, downloads, recordings, and (when `persistCookies` is enabled) cookie state
live under `<session workspace>/.dsh-browser/` and stay in the workspace. `browser_capture`
defaults to `.dsh-browser/shots/` and returns a path; open that path with the image
reader — a third-party plugin cannot mint an inline Host attachment. `browser_record`
reopens the tab URL in a dedicated recording context, so in-memory form state is not
carried into the take.

## Development

```bash
npm install    # one runtime dependency: playwright-core
```

```powershell
# Unit tests (no browser): URL policy, host classification, path safety,
# target inference, snapshot truncation, and output formatting.
npm test

# Contract tests: real tool layer, Cordis plugin load, and Host schema validation.
# Run from the installed profile link so @deepseek-ai/cordis and
# @deepseek-ai/dsh-tools resolve from the Host profile.
npm run test:contract

# Full engine smoke test: launch Chrome and exercise every core capability
# against local HTML fixtures.
npm run smoke
```

Logs/artifacts from tests (`*.log`, `.dsh-browser-smoke/`) are git-ignored.

Some sandboxes deny process spawning, which `node:test` needs to fork one process per
test file. In that case run the tests in-process instead:

```powershell
node --test --experimental-test-isolation=none `
  test/policy.test.mjs test/target.test.mjs test/format.test.mjs

node --test --experimental-test-isolation=none `
  test/plugin.test.mjs test/tools.test.mjs test/cordis.test.mjs test/host-schema.test.mjs
```

The contract group and the smoke test also need permission to start Chromium; a
sandbox that refuses to spawn the browser reports `browser_unavailable`.

Set `BROWSER_DEBUG=1` to trace browser/tab lifecycle to stderr.

## Design notes

- **Zero Host-package imports at runtime.** The plugin ships its own small tool
  compiler/validator (`src/tool.js`) and imports only `playwright-core` plus Node
  builtins. A linked install therefore resolves correctly from its real source path
  without `--preserve-symlinks` or a copy of the Host's `node_modules`.
- **One Chromium process, one `BrowserContext` per DSH session.** Tabs are Playwright
  pages; commands for one session are serialized.
- **Clicks use CDP input, not `locator.click`.** A click that opens
  `alert`/`confirm`/`prompt` suspends the renderer; CDP input returns, the dialog is
  recorded, and `browser_dialog` handles it later.
- **Snapshots aggregate every frame** through `ariaSnapshot()`, so same- and
  cross-origin iframe content is readable without a webview.
- **Artifacts stay in the workspace** under `.dsh-browser/`.
- **Screenshots return a path**, not an inline attachment.

## Directory layout

```
dsh-plugin-browser/
├─ index.js              # Cordis plugin: config, tool registration, prompt section
├─ src/
│  ├─ actions.js         # browser_act implementation
│  ├─ capture.js         # PNG screenshots (page / element)
│  ├─ chromium.js        # installed-browser discovery and launch candidates
│  ├─ engine.js          # browser/tab lifecycle, sessions, downloads, headed mode
│  ├─ format.js          # model-facing text rendering for tool output
│  ├─ policy.js          # URL/network policy, path safety, filename sanitizing
│  ├─ recording.js       # WebM recording and action DSL
│  ├─ snapshot.js        # ARIA tree snapshot and truncation
│  ├─ target.js          # target descriptor → Playwright locator
│  └─ tool.js            # small JSON-schema compiler/validator (zero Host imports)
├─ cordis.patch.yml      # bundle patch inserting the `browser-tools` component
├─ install.ps1           # link the package into a DSH profile and run contract tests
├─ test/                 # unit, contract, and smoke tests plus HTML fixtures
├─ LICENSE
├─ package.json
└─ README.md
```

## Troubleshooting

- **Tools do not appear.** Check that the package name is in `dsh.profile.bundles`,
  that the profile `node_modules` link exists, and that the Host was restarted.
- **`browser_unavailable`.** No launch candidate worked; set `browserPath` or `channel`,
  and make sure the sandbox permits starting a browser process.
- **`recording_unavailable`.** Install Playwright ffmpeg (see Requirements) or set
  `recording.enabled: false`.
- **`ambiguous_target`.** Tighten the target (role + name, a scoped container, or an
  explicit `nth`) — targets must come from the latest snapshot.
- **`dialog_pending`.** A JavaScript dialog blocks the tab; call `browser_dialog` before
  any other action on that tab.

## Known limitations

- **`browser_view` is not the DSH Sidebar.** It shows a separate Chrome window; the
  right-Sidebar screencast panel is not implemented.
- **No DSH Sidebar user tabs.** This plugin owns its browser; it cannot list or claim
  tabs opened in the built-in Sidebar browser.
- **Recording requires ffmpeg** and reopens the page.
- **Native `<select>` popups** are OS UI; use `browser_act` with `action: "select"`
  instead of clicking the control.
- **File upload** is not exposed yet.
- **No inline image attachment**; screenshots are files.
- **Headed mode** opens a separate Chrome window, not the DSH Sidebar.

## License

[MIT](./LICENSE) © 2026 fakeNihilist

---

## 中文简介

面向 DeepSeek Harness 的 Host 端浏览器插件：在宿主进程内用 Playwright 驱动真实
Chromium，让模型自己打开页面、读取 ARIA 树、点击输入、截图、处理 JavaScript
对话框与下载、录制 WebM。它是 Host-only 插件，不提供客户端 UI；`browser_view`
打开的是独立 Chrome 窗口，不是 DSH 侧栏浏览器。

安装：在 profile 的 `package.json` 中加入指向本目录的 `link:` 依赖，把
`@local/dsh-plugin-browser` 加进 `dsh.profile.bundles`，在 profile 的
`node_modules/@local` 下建立链接（Windows 上也可直接运行 `install.ps1`），然后重启
Host。配置在 profile 的 `cordis.patch.yml` 中按 `id: browser-tools` 覆盖。
