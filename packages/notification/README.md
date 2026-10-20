# notification

任务完成或会话等待你处理时，让 **DeepSeek Harness（DSH）** 在 Windows 上弹出一条真正的系统通知：两种场景提示音不同，点击通知回到对应会话。

*Desktop notifications for DeepSeek Harness — [English below](#english).*

---

## 中文

### 它做什么

| 时机 | 通知标题 | 提示音 |
| --- | --- | --- |
| 顶层会话完成一轮回答（Agent 从 `running` 变回 `idle`） | 任务完成 | 三音上行铃音（C5–E5–G5） |
| 会话等待授权审批（`approval/request`） | 需要你确认 | 四音下行急促提示（B5–E5–B5–E5） |
| 会话等待你回答提问（`ask_user_question`） | 需要你回答 | 同上 |

点击通知会通过本机私有协议把被点击的会话写回，由页面打开它（`ctx.uiWorkspace.openSession`）；若窗口在托盘/最小化，同时经 `dsh://open` 把桌面窗口唤回。

### 为什么通知在 Host 侧发送

这版 Windows 桌面应用里，Electron 渲染进程创建的 HTML5 `Notification` 对象**不会真正投递到 Windows 通知中心**——构造函数成功、权限为 `granted`，但通知中心里看不到（已在本机打包版上实测）。因此：

- **Host 半边** 负责发通知：调用 Windows WinRT Toast，并用 `System.Media.SoundPlayer` 播放现场合成的 WAV；
- **Web 客户端半边** 只负责判断「什么时候该提醒」、过滤噪音，以及处理「用户点了哪条通知」。

### 点击链路

1. Toast 的启动参数是私有协议 `dsh-notify://reveal/<sessionId>`；
2. 插件在 `HKCU\Software\Classes\dsh-notify` 注册协议处理脚本 `reveal.vbs`（由 GUI 子系统的 `wscript.exe` 运行，**不会闪出控制台黑框**）；
3. 点击后脚本把 sessionId 写入 `<DSH_HOME>/notification/reveal.json`（按 UTF-8 解码百分号转义；激活日志上限 1 MB，超过即重建），并调用 `dsh://open` 唤回桌面窗口；
4. 页面轮询 `GET /api/notification.reveal`，拿到 sessionId 后打开对应会话。

### 什么时候会弹 / 不会弹

- **会弹**：DSH 处于活跃状态、但你正在看别的会话、首页、设置页或其他面板时；窗口最小化、隐藏到托盘、失焦时。
- **不弹**：你正看着该会话、窗口可见且聚焦、对话内容已经挂载。
- 子代理（subagent）会话的**完成**不通知，避免一次任务里被大量内部会话刷屏；但子代理的**审批 / 提问**照常通知。
- 同一会话、同一类提醒 5 秒内只弹一次；相邻两条提醒至少间隔约 1.2 秒。一次状态变化里出现多个会话时，通知会排队而不是同时刷屏。
- 插件启用后第一次加载页面时，如果已有会话正等着你确认/回答，会补一次通知。

### 安装与生效

本包是标准的 DSH profile bundle，安装方式与仓库里其他插件一致（见[仓库根 README](../../README.md)）。用 DSH 插件管理器安装会自动完成 profile 接线。

**安装完成后需要重启一次 DSH**（Host 半边要重新加载，并写出 Toast 脚本、两个 WAV 与协议注册）。如果重启后窗口没有重新加载页面（插件客户端未生效），按一次 `Ctrl+R` 刷新窗口即可。插件升级后同理：重启 DSH 让 Host 半边重新加载，再刷新页面让客户端半边生效。

### 本机副作用

启用后会在本机写入：

- `HKCU\Software\Classes\dsh-notify`（Toast 点击激活用的 URL 协议，指向下面的脚本）；
- `<DSH_HOME>/notification/`：`toast.ps1`、`reveal.vbs`、`complete.wav`、`confirm.wav`，以及运行时的 `reveal.json`、`reveal.log`（上限 1 MB，超过即重建）、`payload-*.json`。

以上都是本机文件与单个 HKCU 键，不发网络请求；卸载插件后可手动删除这些残留（注册表键可按 `reg delete "HKCU\Software\Classes\dsh-notify" /f` 删除）。

### 平台与权限

- **Windows**：走 Host WinRT Toast（本插件的主要目标平台），不需要浏览器通知权限。
- **macOS / Linux**：Host 不提供 Toast 路由，客户端自动回退到 HTML5 `Notification` + Web Audio 合成音（能否显示取决于系统与权限）。
- 声音由代码合成，不依赖系统声音方案；Toast 显式 `silent="true"`，由 `SoundPlayer` 播放自定义 WAV，因此两种场景的音色明显不同。

### 调试

在 Web 页面控制台执行：

```js
localStorage.setItem('dsh-notification:debug', '1');
location.reload();
```

刷新后：

```js
window.__dshNotificationDebug.state();   // 权限、音频、sessionStatus、最近通知（含 channel）、已处理的点击次数
window.__dshNotificationDebug.simulate('completed', '<sessionId>');  // 走真实 Host Toast
window.__dshNotificationDebug.simulate('approval', '<sessionId>');
window.__dshNotificationDebug.reveal();  // 手动检查一次点击回传
window.__dshNotificationDebug.open('<sessionId>');
window.__dshNotificationDebug.sounds();  // 仅调试用：播放渲染端合成的两段音
```

每次注意力变化也会在页面上派发 `dsh-notification` 事件，detail 里包含 `kind`、`sessionId`、`title`、`body`、`channel`（`host-toast` 或 `renderer-notification`）、`shown`、`time`。若点击 Toast 后没有跳转，可查看 `<DSH_HOME>/notification/reveal.log`，确认协议处理脚本是否被调用。

### 实现说明

- 注意力来源是 DSH 客户端内置的 `ctx.uiSession.sessionStatus`（`running` / `pendingInteraction` / `completionUnread`），后台会话与审批等待都能感知；不需要 Host 侧轮询会话。
- Host 半边注册三个本地 Fetch 路由：`GET/POST /api/notification.toast`（等待 toast 进程退出、最多 5 秒后回报是否成功，失败时客户端回退）、`GET /api/notification.reveal`、`GET/POST /api/notification.focus`（渲染回退路径用）；不注册工具、不写会话、不发起外部网络请求。
- `client.js` 是可直接被浏览器加载的纯 JavaScript，无构建步骤；`index.js` 是标准 Cordis Host 插件。

### 已知限制

- 通知投递依赖 Web 客户端页面存活：完全退出 DSH 后没有任何组件能发通知；页面未加载插件时也不会提醒（刷新窗口恢复）。
- Windows 侧 toast 失败（PowerShell 不可用、脚本被杀、AUMID 注册丢失等）时，Host 会把失败回报给客户端并回退到页面通知与合成提示音；打包版 Windows 的页面通知本身不可见，此时可能只剩提示音。
- 点击回传依赖页面轮询 `/api/notification.reveal`；如果点击时页面被系统完全挂起，恢复后会在下一次轮询/聚焦时打开会话。
- 会话完成判定依赖 Agent 的 `running → idle` 边沿，失败/中断的回合也会提示“任务完成”；会话被直接删除/归档时不会补发完成通知。
- 首次加载时“补一次通知”依赖启动时序：如果状态快照在插件订阅前已经就绪，就不会补发。
- Windows Host 被远程客户端（`dsh web` + 其他设备）访问时，通知仍显示在 Host 机器的桌面上，是否可见取决于 Host 是不是你正在用的机器。
- 卸载插件不会自动清理 HKCU 协议键和 `<DSH_HOME>/notification/`；旧的 Action Center 通知被点击时会因脚本已删除而报错。
- `uiSession.sessionStatus` 属于客户端内部 API，DSH 大版本升级后可能需要跟随调整。

### 测试

```powershell
cd packages/notification
npm test
```

测试直接加载仓库里发布的 `client.js` / `index.js`，覆盖注意力差分、Host Toast 请求与渲染回退、两种声音、抑制规则、点击跳转、reveal 回传（含 BOM）、Host 路由、toast 失败路径、WAV 合成、通知去重与间隔。

### 隐私

通知内容只在本机生成：会话标题来自本地 Session 列表，Toast 与声音都在本机渲染，数据不出本机。

### 许可证

[MIT](./LICENSE)

---

## English

### What it does

| Event | Notification title | Sound |
| --- | --- | --- |
| A top-level Session finishes a turn (`running → idle`) | Task completed | three-note ascending bell |
| A Session waits for an approval (`approval/request`) | Confirmation needed | four-note staccato alert |
| A Session waits for an answer (`ask_user_question`) | Answer needed | same alert |

Clicking the toast records the clicked Session through a private URL protocol and the Web client opens it (`ctx.uiWorkspace.openSession`); a tray/minimized window is restored through `dsh://open` at the same time.

### Why the Host delivers the toast

In the packaged Electron app, HTML5 `Notification` objects created by the renderer are accepted by Chromium but never reach the Windows notification platform (verified locally: the constructor succeeds, permission is `granted`, and the Action Center stays empty). The plugin therefore splits the work:

- the **Host half** raises a WinRT toast, waits for the helper process to exit (up to 5 s) so it can report failure, and plays a locally synthesized WAV through `System.Media.SoundPlayer`;
- the **Web client half** decides when to notify, filters noise, and resolves which toast was clicked.

### Click chain

1. the toast's launch argument is the private `dsh-notify://reveal/<sessionId>`;
2. the plugin registers that protocol under `HKCU\Software\Classes\dsh-notify`, pointing at `reveal.vbs` (run by the GUI-subsystem `wscript.exe`, so **no console window flashes** on click);
3. the handler writes the Session id (percent-decoded as UTF-8) to `<DSH_HOME>/notification/reveal.json`, caps its activation log at 1 MiB, and launches `dsh://open` to restore the desktop window;
4. the page polls `GET /api/notification.reveal` and opens that Session.

### When it fires

- It fires while DSH is focused on another Session, the home screen, Settings, or any other panel, and also while the window is minimized, tray-hidden, or unfocused.
- It stays quiet only when the user is already looking at that Session in a visible, focused window with the transcript mounted.
- Completion notices are root-Session only; approval/question waits still notify for subagents.
- Identical `(Session, kind)` notices collapse within 5 s and consecutive notices are spaced ~1.2 s apart, so a burst queues instead of stacking.
- A pending interaction present when the page boots is announced once.

### Install and activation

A standard DSH profile bundle; follow the repository README. Installing through the plugin manager wires the profile automatically.

**Restart DSH once after installing** so the Host half reloads and writes the toast scripts, both WAV files, and the protocol registration. If the window does not reload its page after the restart (client half not active), press `Ctrl+R` once. Upgrades need the same restart-then-reload cycle.

### Local side effects

Enabling the plugin writes:

- `HKCU\Software\Classes\dsh-notify` (the toast activation protocol, pointing at the helper script);
- `<DSH_HOME>/notification/`: `toast.ps1`, `reveal.vbs`, `complete.wav`, `confirm.wav`, plus transient `reveal.json`, `reveal.log` (capped at 1 MiB; recreated when it grows past that), and `payload-*.json`.

Everything stays local with no network requests. Removing the plugin leaves those files and key behind; delete them manually (`reg delete "HKCU\Software\Classes\dsh-notify" /f`) if desired.

### Platforms

- **Windows**: Host WinRT toast, the primary target; no browser notification permission involved.
- **macOS / Linux**: no Host toast route, so the client falls back to HTML5 `Notification` plus Web Audio motifs.

### Known limitations

- Delivery depends on the Web client page staying alive: nothing can notify after DSH fully exits, and a page that did not load the plugin stays quiet until reload.
- When the Windows side rejects the toast (PowerShell unavailable, helper killed, AUMID registration lost), the Host reports the failure and the client falls back to the page notification plus the synthesized sound; in the packaged Windows app that page notification is invisible, so only the sound may remain.
- Click-through relies on the page polling `GET /api/notification.reveal`; a suspended page opens the Session on the next poll or focus.
- Completion is inferred from the Agent's `running → idle` edge, so failed or interrupted turns also say "Task completed"; deleted/archived Sessions get no completion notice.
- The one-time announcement of pending interactions at page boot depends on boot order; an already-ready status snapshot is not replayed.
- With a Windows Host serving a remote client (`dsh web` from another device), notifications still appear on the Host machine's desktop.
- Uninstalling the plugin leaves the HKCU protocol key and `<DSH_HOME>/notification/` behind; clicking an old Action Center notification then fails because the helper script is gone.
- `uiSession.sessionStatus` is a client-internal API and may need adjustment after a major DSH upgrade.

### Debug

Set `localStorage['dsh-notification:debug'] = '1'` and reload to expose `window.__dshNotificationDebug` (`state`, `simulate`, `reveal`, `open`, `sounds`). Every observed attention transition also dispatches a `dsh-notification` CustomEvent carrying `channel` (`host-toast` / `renderer-notification`).

### Privacy

Everything is computed locally from the local Session list and rendered locally; nothing leaves the machine.

### License

[MIT](./LICENSE)
