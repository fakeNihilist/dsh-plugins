# dsh-plugins

A small collection of open-source plugins for **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)**:

a browser the model can drive, find-in-conversation, and token usage statistics.

Each plugin is an independent DSH profile bundle. They can be installed separately, and
they share no code or runtime state with each other.

## Plugins

| Package | Surface | What it does |
| --- | --- | --- |
| [`browser`](packages/browser) | Host, `browser_*` tools | Drives a real Chromium through Playwright: open pages, read the ARIA tree, click/type, capture screenshots, handle dialogs and downloads, record WebM. Host-only, no client UI. |
| [`chat-search`](packages/chat-search) | Host + Web client | Find-in-conversation: a find bar in the Session header highlights matches in the rendered transcript and steps through them in place, without mutating the conversation DOM. |
| [`usage-stats`](packages/usage-stats) | Host + Web client | Whole-corpus token usage: today/cumulative tokens, cache hit rate, a year-long activity heatmap, daily trend, and a per-model breakdown. Read-only from local session logs — nothing leaves the machine. |

## Requirements

- A DeepSeek Harness installation with at least one profile.
- Node.js 22 or newer (the browser plugin is developed against Node 24).
- **browser** only: a locally installed Chrome, Edge, or Chromium (the plugin never
  downloads a browser), plus Playwright's ffmpeg if you want WebM recording.
- **chat-search** / **usage-stats** only: the Web client (desktop app or `dsh web`).

## Install

Every package is a DSH profile bundle. Installing one means four things:

1. make the package resolvable from the profile,
2. add it to `dsh.profile.bundles`,
3. let its bundled `cordis.patch.yml` insert its Cordis component,
4. restart the Host (and reload the Web client for the two client-side plugins).

### 1. Clone the repository

```powershell
git clone https://github.com/fakeNihilist/dsh-plugins.git
```

### 2. Add the package to the profile

Edit `<DSH_HOME>/profiles/<profile>/package.json` — the default profile is `desktop`, and
`DSH_HOME` is usually `~/.dsh`:

```jsonc
{
  "dependencies": {
    "@local/dsh-plugin-browser": "link:D:/code/dsh-plugins/packages/browser",
    "dsh-plugin-chat-search": "link:D:/code/dsh-plugins/packages/chat-search",
    "dsh-plugin-usage-stats": "link:D:/code/dsh-plugins/packages/usage-stats"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-plugin-browser",
        "dsh-plugin-chat-search",
        "dsh-plugin-usage-stats"
      ],
      "patchReload": "live"
    }
  }
}
```

Adjust the paths and remove the plugins you do not want. The browser plugin keeps its
historical package name `@local/dsh-plugin-browser`; the other two use plain
`dsh-plugin-*` names. All three set `"private": true` — they are installed from a
checkout, not published to npm.

### 3. Make the package resolvable from the profile

A `link:` spec only records the path; the package still has to appear in the profile's
`node_modules`. When you install through the DSH plugin manager it takes care of this. For
a manual checkout, create the link yourself:

```powershell
$profileRoot = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$nodeModules = Join-Path $profileRoot 'node_modules'
New-Item -ItemType Directory -Force $nodeModules | Out-Null

New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-chat-search') `
  -Target 'D:\code\dsh-plugins\packages\chat-search'
New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-usage-stats') `
  -Target 'D:\code\dsh-plugins\packages\usage-stats'
```

```bash
# macOS / Linux
ln -s /path/to/dsh-plugins/packages/chat-search "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-chat-search"
ln -s /path/to/dsh-plugins/packages/usage-stats "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-usage-stats"
```

The browser plugin has an installer that does its step — including the
`node_modules/@local` junction and its contract tests — for you:

```powershell
pwsh -File packages/browser/install.ps1 -Profile desktop
```

### 4. Restart

Restart the Host (or open a new session) so `browser_*` tools appear. `chat-search` and
`usage-stats` also add a Web client bundle: reload the browser window once after the
restart.

Each package README documents its own configuration keys, usage, and troubleshooting:

- [`packages/browser/README.md`](packages/browser/README.md)
- [`packages/chat-search/README.md`](packages/chat-search/README.md)
- [`packages/usage-stats/README.md`](packages/usage-stats/README.md)

## Development

There are no root dependencies: every package is self-contained. Work inside a package
directory, and install its dev dependencies only if you run its tests.

```powershell
# Every package, one after another (Node.js test runner)
node scripts/test-all.mjs

# A single package
cd packages/chat-search
npm test
```

Some sandboxes deny the child-process pipes that `node:test` uses to fork one process per
test file. In that case run the runner in-process:

```powershell
$env:NODE_TEST_FLAGS = '--experimental-test-isolation=none'
node scripts/test-all.mjs
```

The browser plugin's contract tests and smoke test additionally need a real DSH
environment (for `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`) and permission to start
Chromium; a restricted sandbox reports `browser_unavailable` or `ERR_MODULE_NOT_FOUND`
instead. See its README for the exact commands.

## Repository layout

```
dsh-plugins/
├─ packages/
│  ├─ browser/          # browser_* tools (Host-only)
│  ├─ chat-search/      # in-conversation search (Host + Web client)
│  └─ usage-stats/      # token usage dashboard (Host + Web client)
├─ scripts/
│  └─ test-all.mjs      # run every package's tests
├─ LICENSE
└─ package.json         # workspace root, no dependencies
```

## Privacy

- `usage-stats` reads DSH session logs on the local machine and renders them; it makes no
  network requests and nothing leaves the machine.
- `browser` drives a local browser; what it sends over the network is whatever the pages
  it is pointed at request. Page content is treated as untrusted data by the agent.
- `chat-search` only reads the rendered conversation in the current Web client.

## License

[MIT](./LICENSE) © 2026 fakeNihilist
