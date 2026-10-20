# dsh-plugins

一组面向 **[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)** 的开源插件：让模型自己操作浏览器、在会话内查找、统计 Token 用量，以及在任务完成或等待确认时弹出桌面通知。

*Plugins for DeepSeek Harness (DSH) — [English below](#english).*

---

## 中文

*[English](#english) · 本仓库以中文为主，英文版见文末。*

每个插件都是一个独立的 DSH profile bundle，可以单独安装，彼此之间不共享代码或运行时状态。

### 插件列表

| 包 | 形态 | 说明 |
| --- | --- | --- |
| [`browser`](packages/browser) | Host，`browser_*` 工具 | 通过 Playwright 驱动真实 Chromium：打开页面、读取 ARIA 树、点击/输入、截图、处理对话框与下载、录制 WebM。纯 Host 插件，没有客户端 UI。 |
| [`chat-search`](packages/chat-search) | Host + Web 客户端 | 会话内查找：在会话头部打开查找栏，边输入边高亮已渲染对话中的匹配并逐个跳转，不修改对话 DOM。 |
| [`notification`](packages/notification) | Host + Web 客户端 | 桌面消息通知：任务完成、等待确认或等待回答时弹出系统通知，两种场景提示音不同，点击通知直接打开对应会话（窗口隐藏时经 `dsh://open` 唤回）。 |
| [`usage-stats`](packages/usage-stats) | Host + Web 客户端 | 跨全部会话的 Token 用量统计：当日/累计 Token、缓存命中率、一年活动热力图、每日趋势、按模型明细。只读本地会话日志，数据不出本机。 |

### 环境要求

- 已安装并可用的 DeepSeek Harness，至少有一个 profile。
- Node.js 22 或更新版本（browser 插件基于 Node 24 开发）。
- 仅 **browser** 需要：本机已安装 Chrome、Edge 或 Chromium（插件不会下载浏览器）；需要 WebM 录制时还要 Playwright 的 ffmpeg。
- 仅 **chat-search** / **usage-stats** / **notification** 需要：Web 客户端（桌面版或 `dsh web`）。

### 安装

每个包都是一个 DSH profile bundle。安装一个插件要做四件事：

1. 让 profile 能解析到这个包；
2. 把它加入 `dsh.profile.bundles`；
3. 让它自带的 `cordis.patch.yml` 插入对应的 Cordis 组件；
4. 重启 Host（带客户端的插件还需要刷新一次 Web 页面）。

#### 1. 克隆仓库

```powershell
git clone https://github.com/fakeNihilist/dsh-plugins.git
```

#### 2. 把包加进 profile

编辑 `<DSH_HOME>/profiles/<profile>/package.json` —— 默认 profile 是 `desktop`，`DSH_HOME` 通常是 `~/.dsh`：

```jsonc
{
  "dependencies": {
    "@local/dsh-plugin-browser": "link:D:/code/dsh-plugins/packages/browser",
    "dsh-plugin-chat-search": "link:D:/code/dsh-plugins/packages/chat-search",
    "dsh-plugin-usage-stats": "link:D:/code/dsh-plugins/packages/usage-stats",
    "dsh-plugin-notification": "link:D:/code/dsh-plugins/packages/notification"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-plugin-browser",
        "dsh-plugin-chat-search",
        "dsh-plugin-usage-stats",
        "dsh-plugin-notification"
      ],
      "patchReload": "live"
    }
  }
}
```

路径按你的实际情况调整；不需要的插件删掉即可。browser 插件保留历史包名 `@local/dsh-plugin-browser`，其余使用普通的 `dsh-plugin-*` 名字。所有包都设置了 `"private": true` —— 它们从 checkout 安装，不发布到 npm。

#### 3. 让 profile 能解析到这个包

`link:` 只记录路径，包仍然要出现在 profile 的 `node_modules` 里。通过 DSH 插件管理器安装时它会自动处理；如果是手动 checkout，就自己创建链接：

```powershell
$profileRoot = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$nodeModules = Join-Path $profileRoot 'node_modules'
New-Item -ItemType Directory -Force $nodeModules | Out-Null

New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-chat-search') `
  -Target 'D:\code\dsh-plugins\packages\chat-search'
New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-usage-stats') `
  -Target 'D:\code\dsh-plugins\packages\usage-stats'
New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-notification') `
  -Target 'D:\code\dsh-plugins\packages\notification'
```

```bash
# macOS / Linux
ln -s /path/to/dsh-plugins/packages/chat-search "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-chat-search"
ln -s /path/to/dsh-plugins/packages/usage-stats "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-usage-stats"
ln -s /path/to/dsh-plugins/packages/notification "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-notification"
```

browser 插件自带安装脚本，会完成它自己那一步（包括创建 `node_modules/@local` junction 和跑契约测试）：

```powershell
pwsh -File packages/browser/install.ps1 -Profile desktop
```

#### 4. 重启

重启 Host（或新开一个会话），`browser_*` 工具才会出现。`chat-search`、`usage-stats` 与 `notification` 还带有 Web 客户端 bundle：重启后再刷新一次浏览器窗口。

各包的配置项、用法和排错见它们自己的 README：

- [`packages/browser/README.md`](packages/browser/README.md)
- [`packages/chat-search/README.md`](packages/chat-search/README.md)
- [`packages/notification/README.md`](packages/notification/README.md)
- [`packages/usage-stats/README.md`](packages/usage-stats/README.md)

### 开发

仓库根目录没有依赖：每个包都是自成一体的。在包目录里开发，只有要跑测试时才需要安装该包的开发依赖。

```powershell
# 依次跑每个包的测试（Node.js 测试运行器）
node scripts/test-all.mjs

# 只跑单个包
cd packages/chat-search
npm test
```

有些沙箱禁止 `node:test` fork 子进程所需的管道。这种情况下改用 in-process 方式跑：

```powershell
$env:NODE_TEST_FLAGS = '--experimental-test-isolation=none'
node scripts/test-all.mjs
```

browser 插件的契约测试与 smoke 测试还需要真实的 DSH 环境（提供 `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`）以及启动 Chromium 的权限；受限沙箱里会报 `browser_unavailable` 或 `ERR_MODULE_NOT_FOUND`。具体命令见该包的 README。

### 仓库结构

```
dsh-plugins/
├─ packages/
│  ├─ browser/          # browser_* 工具（纯 Host）
│  ├─ chat-search/      # 会话内查找（Host + Web 客户端）
│  ├─ notification/     # 桌面消息通知（Host + Web 客户端）
│  └─ usage-stats/      # Token 用量仪表盘（Host + Web 客户端）
├─ scripts/
│  └─ test-all.mjs      # 依次跑每个包的测试
├─ LICENSE
└─ package.json         # workspace 根，无依赖
```

### 隐私

- `usage-stats` 在本机读取 DSH 会话日志并渲染，不发起网络请求，数据不出本机。
- `browser` 驱动本机浏览器；它会发出什么网络请求，取决于被打开的页面。页面内容对模型而言是不可信数据。
- `chat-search` 只读取当前 Web 客户端里已经渲染的对话。
- `notification` 只读取本机 Session 列表并生成本机系统通知，不向任何服务发送通知内容。

### 许可证

[MIT](./LICENSE) © 2026 fakeNihilist

---

## English

*[返回中文](#中文)*

Each plugin is an independent DSH profile bundle. They can be installed separately, and they share no code or runtime state with each other.

### Plugins

| Package | Surface | What it does |
| --- | --- | --- |
| [`browser`](packages/browser) | Host, `browser_*` tools | Drives a real Chromium through Playwright: open pages, read the ARIA tree, click/type, capture screenshots, handle dialogs and downloads, record WebM. Host-only, no client UI. |
| [`chat-search`](packages/chat-search) | Host + Web client | Find-in-conversation: a find bar in the Session header highlights matches in the rendered transcript and steps through them in place, without mutating the conversation DOM. |
| [`notification`](packages/notification) | Host + Web client | Desktop notifications: native toasts with distinct sounds when a task finishes or a Session waits for approval or an answer; clicking a toast opens that Session (and restores the window through `dsh://open` when it was hidden). |
| [`usage-stats`](packages/usage-stats) | Host + Web client | Whole-corpus token usage: today/cumulative tokens, cache hit rate, a year-long activity heatmap, daily trend, and a per-model breakdown. Read-only from local session logs — nothing leaves the machine. |

### Requirements

- A DeepSeek Harness installation with at least one profile.
- Node.js 22 or newer (the browser plugin is developed against Node 24).
- **browser** only: a locally installed Chrome, Edge, or Chromium (the plugin never downloads a browser), plus Playwright's ffmpeg if you want WebM recording.
- **chat-search** / **usage-stats** / **notification** only: the Web client (desktop app or `dsh web`).

### Install

Every package is a DSH profile bundle. Installing one means four things:

1. make the package resolvable from the profile,
2. add it to `dsh.profile.bundles`,
3. let its bundled `cordis.patch.yml` insert its Cordis component,
4. restart the Host (and reload the Web client for the client-side plugins).

#### 1. Clone the repository

```powershell
git clone https://github.com/fakeNihilist/dsh-plugins.git
```

#### 2. Add the package to the profile

Edit `<DSH_HOME>/profiles/<profile>/package.json` — the default profile is `desktop`, and `DSH_HOME` is usually `~/.dsh`:

```jsonc
{
  "dependencies": {
    "@local/dsh-plugin-browser": "link:D:/code/dsh-plugins/packages/browser",
    "dsh-plugin-chat-search": "link:D:/code/dsh-plugins/packages/chat-search",
    "dsh-plugin-usage-stats": "link:D:/code/dsh-plugins/packages/usage-stats",
    "dsh-plugin-notification": "link:D:/code/dsh-plugins/packages/notification"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-plugin-browser",
        "dsh-plugin-chat-search",
        "dsh-plugin-usage-stats",
        "dsh-plugin-notification"
      ],
      "patchReload": "live"
    }
  }
}
```

Adjust the paths and remove the plugins you do not want. The browser plugin keeps its historical package name `@local/dsh-plugin-browser`; the others use plain `dsh-plugin-*` names. All of them set `"private": true` — they are installed from a checkout, not published to npm.

#### 3. Make the package resolvable from the profile

A `link:` spec only records the path; the package still has to appear in the profile's `node_modules`. When you install through the DSH plugin manager it takes care of this. For a manual checkout, create the link yourself:

```powershell
$profileRoot = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$nodeModules = Join-Path $profileRoot 'node_modules'
New-Item -ItemType Directory -Force $nodeModules | Out-Null

New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-chat-search') `
  -Target 'D:\code\dsh-plugins\packages\chat-search'
New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-usage-stats') `
  -Target 'D:\code\dsh-plugins\packages\usage-stats'
New-Item -ItemType Junction -Path (Join-Path $nodeModules 'dsh-plugin-notification') `
  -Target 'D:\code\dsh-plugins\packages\notification'
```

```bash
# macOS / Linux
ln -s /path/to/dsh-plugins/packages/chat-search "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-chat-search"
ln -s /path/to/dsh-plugins/packages/usage-stats "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-usage-stats"
ln -s /path/to/dsh-plugins/packages/notification "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-notification"
```

The browser plugin has an installer that does its step — including the `node_modules/@local` junction and its contract tests — for you:

```powershell
pwsh -File packages/browser/install.ps1 -Profile desktop
```

#### 4. Restart

Restart the Host (or open a new session) so `browser_*` tools appear. `chat-search`, `usage-stats`, and `notification` also add a Web client bundle: reload the browser window once after the restart.

Each package README documents its own configuration keys, usage, and troubleshooting:

- [`packages/browser/README.md`](packages/browser/README.md)
- [`packages/chat-search/README.md`](packages/chat-search/README.md)
- [`packages/notification/README.md`](packages/notification/README.md)
- [`packages/usage-stats/README.md`](packages/usage-stats/README.md)

### Development

There are no root dependencies: every package is self-contained. Work inside a package directory, and install its dev dependencies only if you run its tests.

```powershell
# Every package, one after another (Node.js test runner)
node scripts/test-all.mjs

# A single package
cd packages/chat-search
npm test
```

Some sandboxes deny the child-process pipes that `node:test` uses to fork one process per test file. In that case run the runner in-process:

```powershell
$env:NODE_TEST_FLAGS = '--experimental-test-isolation=none'
node scripts/test-all.mjs
```

The browser plugin's contract tests and smoke test additionally need a real DSH environment (for `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis`) and permission to start Chromium; a restricted sandbox reports `browser_unavailable` or `ERR_MODULE_NOT_FOUND` instead. See its README for the exact commands.

### Repository layout

```
dsh-plugins/
├─ packages/
│  ├─ browser/          # browser_* tools (Host-only)
│  ├─ chat-search/      # in-conversation search (Host + Web client)
│  ├─ notification/     # desktop notifications (Host + Web client)
│  └─ usage-stats/      # token usage dashboard (Host + Web client)
├─ scripts/
│  └─ test-all.mjs      # run every package's tests
├─ LICENSE
└─ package.json         # workspace root, no dependencies
```

### Privacy

- `usage-stats` reads DSH session logs on the local machine and renders them; it makes no network requests and nothing leaves the machine.
- `browser` drives a local browser; what it sends over the network is whatever the pages it is pointed at request. Page content is treated as untrusted data by the agent.
- `chat-search` only reads the rendered conversation in the current Web client.
- `notification` reads the local Session list and raises local operating-system notifications; notification content is never sent anywhere.

### License

[MIT](./LICENSE) © 2026 fakeNihilist
