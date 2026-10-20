# dsh-plugin-chat-search

In-conversation search for **DeepSeek Harness (DSH)**. A magnifier joins the Session
header: click it — or press **Ctrl/Cmd+F** — and a find bar opens under it. Matches are
highlighted in the transcript as you type, and **Enter** / **Shift+Enter** (or the
chevrons) walk the hits, wrapping at both ends. **Esc**, the close button, or the magnifier
again puts the transcript back exactly as it was.

This is a conversation search, not a page search: it reads the rendered conversation
column, not the whole application shell.

## Features

- **Find as you type.** Results update on every keystroke (debounced), with the active
  match highlighted more strongly than the rest.
- **Case and regex toggles.** `Aa` switches to case-sensitive matching; `.*` treats the
  query as a JavaScript regular expression. Literal, case-insensitive search is the
  default.
- **Match counter.** `n/m` shows the active match and the total. A trailing `+` means the
  match ceiling was reached (`2000+`), so the count is a lower bound.
- **Wraparound stepping.** Prev/next chevrons, **Enter** / **Shift+Enter**, or
  **F3** / **Shift+F3** move between matches and wrap at both ends.
- **Folded content stays searchable.** Collapsed transcript rows and folded reasoning are
  searched; stepping onto a hidden match reveals it through the browser's own `beforematch`
  seam, so the Chat view decides what can be unfolded.
- **Highlights without DOM mutation.** Matches are painted with the
  [CSS Custom Highlight API], overlaying ranges on existing text instead of wrapping it in
  new elements. A search can never break a React re-render, and a re-render can never break
  the search. Where the API is unavailable the bar still counts and scrolls.
- **Precise scrolling.** A step scrolls to the matched characters — not to the message row
  — moving every scroll box that could hide the hit, innermost first.
- **Streaming-aware.** A streaming transcript re-indexes under the bar without moving the
  reader's viewport or losing the current match.
- **Nothing model-visible.** The Host half is deliberately empty: the plugin adds no route,
  service, tool, or prompt, so it cannot affect a request, its prompt, or its KV cache.
- **No build step.** `client.js` is plain JavaScript shipped as-is; tests read that same
  file.

## Install

The plugin is a DSH profile bundle with both a Host half (`index.js` via
`cordis.patch.yml`) and a browser half (`client.js`). It is installed by linking the
package into a profile and enabling it there.

1. Add the package as a `link:` (or `file:`) dependency in the profile's `package.json`
   (typically `<DSH_HOME>/profiles/<profile>/package.json`):

   ```jsonc
   {
     "dependencies": {
       "dsh-plugin-chat-search": "link:../../dsh-plugins/packages/chat-search"
     }
   }
   ```

   (`link:` points at this package directory — adjust the relative path for your layout;
   `file:` also works.)

2. Register it as a profile bundle in the same file:

   ```jsonc
   {
     "dsh": {
       "profile": {
         "bundles": ["dsh-plugin-chat-search"]
       }
     }
   }
   ```

3. Restart DSH (or reload the profile) and then **reload the browser window**. A newly
   installed client bundle is picked up on the next page load.

### Client requirements

The browser half is declared in `package.json`:

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-renderer",
      "@deepseek-ai/dsh-client-ui-session"
    ]
  }
}
```

Those `@deepseek-ai/dsh-client-*` packages must be present in the Web client's module
table, since they provide the locale service, the conversation header slot, and the
render/session context the control mounts into. The browser half itself injects only
`ctx.slots` and `ctx.locale`.

## Usage

| Control | Meaning |
| --- | --- |
| Magnifier (Session header) | Open or close the find bar. |
| `Ctrl+F` / `Cmd+F` | Open the find bar (browser find is suppressed while a conversation is resident). |
| `Aa` | Match case. Off by default (case-insensitive). |
| `.*` | Regular expression. Off by default (literal query). |
| `n/m` | Active match / total matches. `2000+` means the match ceiling was reached. |
| Chevrons | Previous / next match, wrapping. `Enter` / `Shift+Enter` do the same. |
| `F3` / `Shift+F3` | Next / previous match while the bar has focus. |
| `Esc` | Close the bar and clear every highlight. |

Details worth knowing:

- The bar opens anchored under the magnifier, with the input focused and its text selected,
  so the shortcut is one keystroke away from typing.
- The shortcut addresses the conversation that holds focus; with none focused, it picks the
  widest visible resident conversation (the main column when the Sidebar chat is also
  docked).
- One find bar exists at a time: opening one closes any other, and switching to a different
  Session closes the bar rather than carrying a stale query across.
- An unusable regular expression is reported on the bar (`Invalid pattern`) instead of
  throwing; an empty query clears all hits.
- Closing restores focus to whatever was focused before the bar opened and clears both
  highlight layers.
- Searched: everything rendered in the conversation column — user messages, assistant
  prose, reasoning, tool calls and output, command rows, and collapsed content. Skipped:
  the composer draft, `<script>` / `<style>` / `<textarea>` / `<template>` content, and
  anything marked `data-chat-search-skip`.
- Not searched: turns of history that have not been paged into the DOM yet (see
  [Limitations](#limitations)).

## How it works

Four decisions shape the implementation.

**The transcript is searched as rendered DOM, not as Session events.** Folding, Markdown,
syntax highlighting, and tool-card presentation all live in the render tree, so the text a
reader can see is the text this plugin matches — and a hit can be scrolled to without
maintaining a second projection of the conversation that could drift from the first.

**Matches are painted with the [CSS Custom Highlight API].** Ranges are laid over the
existing text instead of wrapping it in new elements, so a search never mutates the
React-owned DOM it is reading: no re-render can be broken by a search, and no search can be
wiped out by a re-render.

**Collapsed content stays searchable.** Folded rows and folded reasoning stay mounted with
`hidden="until-found"`, so their text is in the walk. Stepping onto such a match dispatches
the browser's own `beforematch` event — the same fold seam the Chat view already exposes
for browser find — so the app's own handler decides whether a row can be revealed.

**A step lands on the characters, not on the message row.** One row can hold an entire
answer, a reasoning block, or a tool result and be far taller than the viewport, so
centering the row can leave the matched text off screen. The plugin measures the hit's
`Range` and moves every scroll box that can hide it, innermost first: a capped process
group's own body, then the conversation scrollport. A folded row is revealed before the
measurement, and an animating reveal is followed until its geometry rests.

Searching is debounced (150 ms) and re-runs on transcript mutations, so a streaming answer
is re-indexed while the reader keeps the viewport. A re-index keeps the reader on the match
they were on; a fresh pattern resumes near the previous position instead of jumping back to
the top of the conversation.

[CSS Custom Highlight API]: https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API

## Client contracts

The plugin reads a small, verified set of contracts from the client. They are listed here
so a Harness upgrade that changes them is diagnosable:

- Slot `conversation.session.header.utilities` (list, Session scope), declared by
  `@deepseek-ai/dsh-client-ui-conversation`.
- `[data-chat-flow]` on the transcript column and `[data-chat-anchor-key]` on each message
  row, published by the Chat view.
- `hidden="until-found"` plus the `beforematch` event for folded content, from the Chat
  view's searchable-hidden seam.
- The Platform Seed module table: `react`, `react-dom`, and
  `@deepseek-ai/dsh-client-ui-primitives`.
- `ctx.slots` and `ctx.locale` — the only services the browser half injects.

Two compatibility defences are worth calling out, because each failure is silent:

- **Icon export names drift between Harness lines.** The client names icons either by size
  class (`IconSearchOutlineRegular`) or by pixel suffix (`IconSearchOutline16`). A missing
  export reaches React as an invalid element type, and a slot entry that throws during
  render abdicates its own cell — the control would vanish with no visible cause. The
  resolver therefore tries each known spelling and ends at a glyph drawn in place, with one
  console warning naming the icon it could not find.
- **A stylesheet constant named `CSS` silently disables highlighting.** `CSS` is also the
  platform global that owns the highlight registry; a lexical binding by that name shadows
  it, so highlight support would answer "unsupported" forever: every match counted, none
  painted, nothing thrown. The constant is `STYLES`, the registry is read through
  `globalThis`, and a unit test asserts both.

## Limitations

- **Only the loaded window is searched.** The conversation pages history in as the reader
  scrolls up; older Turns that have not been loaded are not in the DOM and cannot be
  matched. Use cross-Session search for the whole transcript.
- **Case folding is conservative.** A few characters change length when lowercased
  (U+0130 `İ` is the classic case). Rather than return spans pointing at the wrong
  characters, the matcher falls back to an exact scan for such text, so `İSTANBUL` does not
  case-insensitively match `İstanbul`.
- **One find bar at a time.** Opening a second resident conversation's bar closes the
  first; the shortcut targets the focused conversation, then the widest visible one.
- **2,000 matches per search**, marked with a trailing `+` on the counter.
- **Patterns are capped at 512 characters.**

## Development

Requirements: Node.js 24 (the version this package is verified with) and npm for the test
devDependencies. There is no build step — the shipped artifact is `client.js` itself.

```sh
npm install       # jsdom + React, used only by the DOM integration suite

npm test          # 66 unit tests, no external dependencies
npm run test:dom  # 12 integration tests against real React DOM in jsdom
```

The unit suite loads the shipped `client.js` through a stub module loader and exercises the
query compiler, the transcript walk, hit identity, the highlight layers, the stylesheet, the
scroll target (including nested scrollers and folded rows), and the shortcut's target
routing. The DOM suite mounts the real component with real React DOM over a synthetic
transcript and drives the whole flow: open, count, paint, step, wrap, the case and regex
flags, an unusable pattern, folding, streaming appends, and close.

Some sandboxes (including the DSH Windows sandbox) forbid the child processes that
`node --test` spawns for per-file isolation, so `npm test` fails there with `spawn EPERM`.
Run the same files in-process instead, listing them explicitly:

```sh
node --test --experimental-test-isolation=none test/search-core.test.js test/highlight.test.js test/scroll-target.test.js test/bundle-registration.test.js test/component-render.test.js
node --test --experimental-test-isolation=none test/dom/find-flow.test.js
```

### Directory layout

```text
dsh-plugin-chat-search/
├─ client.js              # browser half: find bar, matcher, DOM walk, highlights, scrolling
├─ index.js               # host half: empty apply; only makes the browser bundle discoverable
├─ cordis.patch.yml       # host bundle patch: inserts the plugin into the Loader tree
├─ locale/
│  ├─ en.json             # UI strings (English)
│  └─ zh.json             # UI strings (Simplified Chinese)
├─ icon.svg               # package icon
├─ test/
│  ├─ load-bundle.js      # loads the shipped client bundle into unit tests
│  ├─ search-core.test.js         # matcher + transcript walk
│  ├─ highlight.test.js           # highlight layers and stylesheet
│  ├─ scroll-target.test.js       # hit measurement and nested scrolling
│  ├─ bundle-registration.test.js # module shape, dictionaries, slot registration
│  ├─ component-render.test.js    # control rendering without a browser
│  └─ dom/
│     ├─ browser-env.js   # jsdom + React harness
│     └─ find-flow.test.js        # end-to-end find flow
├─ package.json
├─ LICENSE
└─ README.md
```

## License

[MIT](./LICENSE) © 2026 fakeNihilist

---

## 中文简介

本插件为 DeepSeek Harness（DSH）提供**会话内搜索**：会话头部出现放大镜按钮，点击或按
`Ctrl/Cmd+F` 打开查找栏，边输入边高亮并可用 `Enter / Shift+Enter`、`F3 / Shift+F3`
或上下箭头在匹配项间循环跳转，`Esc` 关闭。支持区分大小写（`Aa`）与正则（`.*`），会搜索
已渲染的对话内容（含折叠内容与流式追加的文本），基于 CSS Custom Highlight API 高亮而不修改
对话 DOM；Host 侧为空，不产生任何模型可见内容。

安装：在 profile 的 `package.json` 中加入 `"dsh-plugin-chat-search": "link:<插件目录>"` 依赖，
并在 `dsh.profile.bundles` 中追加 `"dsh-plugin-chat-search"`，然后重载浏览器页面。客户端还依赖 `@deepseek-ai/dsh-client-locale`、
`dsh-client-ui-conversation`、`dsh-client-ui-renderer`、`dsh-client-ui-session` 四个包
（已声明在 `dsh.client.inject` 中）。

测试：`npm test`（66 个单元测试）与 `npm run test:dom`（12 个 jsdom 集成测试）；沙箱禁止
子进程时改用 `node --test --experimental-test-isolation=none <文件列表>`。

License：MIT。
