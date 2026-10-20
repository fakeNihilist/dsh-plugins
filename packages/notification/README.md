# notification

任务完成或会话等待你处理时，让 **DeepSeek Harness（DSH）** 弹出一条桌面通知：两种场景使用不同提示音，点击通知直接打开对应会话。

*Desktop notifications for DeepSeek Harness — [English below](#english).*

---

## 中文

### 它做什么

| 时机 | 通知标题 | 提示音 |
| --- | --- | --- |
| 顶层会话完成一轮回答（Agent 从 `running` 变回 `idle`） | 任务完成 | 三音上行铃音（C5–E5–G5） |
| 会话等待授权审批（`approval/request`） | 需要你确认 | 四音下行急促提示（B5–E5–B5–E5） |
| 会话等待你回答提问（`ask_user_question`） | 需要你回答 | 同上 |

点击通知会：

1. 用 DSH 自己的会话导航打开对应会话（`ctx.uiWorkspace.openSession`）；
2. 若窗口已最小化或收进托盘，再通过 DSH 桌面版注册的 `dsh://open` 协议把窗口唤回前台。

### 什么时候会弹 / 不会弹

- **会弹**：DSH 处于活跃状态、但你正在看别的会话、首页、设置页或其他面板时；窗口最小化、隐藏到托盘、失焦时。
- **不弹**：你正看着该会话、窗口可见且聚焦、对话内容已经挂载——这时答案就在眼前。
- 子代理（subagent）会话的**完成**不通知，避免一次任务里被大量内部会话刷屏；但子代理的**审批 / 提问**照常通知，因为那是真的在等人。
- 插件启用后第一次加载页面时，如果已有会话正等着你确认/回答，会补一次通知。
- 通知只针对 Web 客户端页面：桌面窗口关到托盘后页面仍存活，通知和声音照常工作；如果彻底退出 DSH，Host 已停止，任何插件都无法通知。

### 安装

本包是标准的 DSH profile bundle，安装方式与仓库里其他插件完全一致（详见[仓库根 README](../../README.md)）：

1. 让 profile 能解析到本包（`dependencies` 里写 `link:<本包绝对路径>`，或跑 `pnpm add "link:<路径>"`）；
2. 把 `dsh-plugin-notification` 加入 `dsh.profile.bundles`；
3. 重启 Host（`patchReload: live` 的 profile 通常由插件管理器即时生效；最稳妥是重启一次）；
4. 刷新 DSH 的 Web 窗口/页面，浏览器才会加载 `client.js`。

用 DSH 插件管理器安装时，`install_bundle` 会自动完成 1–3 步；随后刷新页面即可。若用 `dsh web`（非桌面版），第 2 步的窗口唤回会静默跳过——页面内的会话切换仍然有效。

### 权限与平台

- **DSH 桌面版**：渲染进程的 `Notification.permission` 默认就是 `granted`（桌面外壳对非麦克风权限一律放行），不需要额外授权。
- **普通浏览器打开 Web 客户端**：首次通知会请求浏览器通知权限，需要允许；被拒绝时插件仍会在 `dsh-notification` 事件里汇报，但不会弹系统通知。
- 支持 Windows / macOS / Linux 的系统原生通知；提示音由 Web Audio 合成，不依赖系统声音文件。
- 提示音需要 AudioContext 处于运行状态。桌面版默认允许自动播放；浏览器里若受自动播放策略限制，第一次点击/按键后会自动解锁。极端情况下（音频仍未解锁）通知会退回使用系统默认通知音，保证「有声音」。

### 调试

在 Web 页面控制台执行：

```js
localStorage.setItem('dsh-notification:debug', '1');
location.reload();
```

刷新后会出现调试钩子：

```js
window.__dshNotificationDebug.state();        // 权限、音频、当前 sessionStatus、最近通知记录
window.__dshNotificationDebug.simulate('completed', '<sessionId>');  // 模拟完成
window.__dshNotificationDebug.simulate('approval', '<sessionId>');   // 模拟待确认
window.__dshNotificationDebug.open('<sessionId>');                   // 验证点击跳转
window.__dshNotificationDebug.sounds();                              // 依次播放两种提示音
```

另外，插件对每次注意力变化都会在页面上派发 `dsh-notification` 事件：

```js
window.addEventListener('dsh-notification', (event) => console.log(event.detail));
// { kind: 'completed'|'approval'|'question', sessionId, title, body, sound: 'completion'|'confirm'|'system', shown, time }
```

调试钩子只在 `localStorage` 标志为 `1` 时暴露，正常使用不会挂到 `window` 上。

### 实现说明

- **纯 Web 客户端插件**：注意力状态来自 DSH 客户端内置的 `ctx.uiSession.sessionStatus`（`running` / `pendingInteraction` / `completionUnread`），审批与提问卡片本来就会把等待状态发布到这里，因此后台会话也能感知，不需要额外轮询 Host。
- **Host 半边只做一件事**：注册 `POST /api/notification.focus`，收到请求时启动 `dsh://open` 协议，让已运行的桌面窗口恢复并聚焦（渲染进程做不到这件事，也拿不到外壳 IPC）。该路由不是模型可见面：没有工具、没有提示词注入、不写会话。
- 提示音用 Web Audio 现场合成，仓库里没有音频文件；`client.js` 是可直接被浏览器加载的纯 JavaScript，无构建步骤。
- 插件不在服务端保存任何状态，也不发起任何外部网络请求。

### 已知限制

- 会话完成判定依赖 Agent 的 `running → idle` 边沿；会话被直接删除/归档时不会补发完成通知。
- `uiSession.sessionStatus` 属于客户端内部 API，DSH 大版本升级后可能需要跟随调整。
- 通知正文只带会话标题，不展开回答内容，避免把长文本塞进系统通知中心。

### 测试

```powershell
cd packages/notification
npm test
```

测试直接加载仓库里发布的 `client.js`（而不是复制品），覆盖注意力差分、声音选择、抑制规则、点击跳转、窗口唤回请求与 Host 路由注册。

### 隐私

通知内容只在本机生成：会话标题来自本地 Session 列表，不发起网络请求，数据不出本机。

### 许可证

[MIT](./LICENSE)

---

## English

### What it does

| Event | Notification title | Sound |
| --- | --- | --- |
| A top-level Session finishes a turn (`running → idle`) | Task completed | three-note ascending bell |
| A Session waits for an approval (`approval/request`) | Confirmation needed | four-note descending alert |
| A Session waits for an answer (`ask_user_question`) | Answer needed | same four-note alert |

Clicking the notification opens that Session through DSH's own navigation (`ctx.uiWorkspace.openSession`) and, when the window was minimized or hidden in the tray, asks the Host to restore the desktop window via the registered `dsh://open` protocol.

### When it fires

- It fires while DSH is focused on another Session, the home screen, Settings, or any other panel, and also while the window is minimized, tray-hidden, or unfocused.
- It stays quiet only when the user is already looking at that Session in a visible, focused window with the transcript mounted.
- Completion notices are root-Session only, so subagent churn does not spam the desktop; approval/question waits still notify for subagents because a human is genuinely blocked.
- Notifications require the Web client page to be alive. Closing the desktop window to the tray keeps the page alive; quitting DSH stops the Host and nothing can notify anymore.

### Install

A standard DSH profile bundle; follow the repository README: make the package resolvable from the profile, add `dsh-plugin-notification` to `dsh.profile.bundles`, restart the Host, and reload the Web window so the browser loads `client.js`. DSH's plugin manager (`install_bundle`) does the profile wiring automatically.

### Permissions

The DSH desktop shell grants renderer notifications by default. A plain browser tab asks for notification permission on first use. Sounds are synthesized with the Web Audio API; when Chromium keeps the AudioContext suspended, the plugin falls back to the system notification sound so the alert is never silent.

### Debug

Set `localStorage['dsh-notification:debug'] = '1'` and reload to expose `window.__dshNotificationDebug` (`state`, `simulate`, `open`, `sounds`). Every observed attention transition also dispatches a `dsh-notification` CustomEvent with a JSON-safe detail object.

### Privacy

Everything is computed locally from the local Session list; no network requests, nothing leaves the machine.

### License

[MIT](./LICENSE)
