/**
 * Integration tests against the shipped bundle: start `apply()` on a fake browser
 * context, publish Session attention snapshots, and assert the Host-toast path,
 * the renderer fallback, the two sounds, the suppression rules, click
 * navigation, and reveal-based toast activation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createAudioContextClass,
  createDocument,
  createNotificationClass,
  createRow,
  settle,
  startPlugin,
} from "./harness.js";

/** @returns a status record for a running Session. */
function running(pendingInteraction) {
  return pendingInteraction === undefined ? { running: true } : { running: true, pendingInteraction };
}

test("the bundle registers under its package id and exposes its services", () => {
  const plugin = startPlugin();
  assert.equal(plugin.bundle.id, "dsh-plugin-notification");
  assert.deepEqual(plugin.bundle.exports.inject, ["sessions", "uiSession", "uiWorkspace", "locale"]);
  assert.equal(typeof plugin.bundle.exports.apply, "function");
  plugin.dispose();
});

test("the renderer fallback shows one native notification with the completion sound", async () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();

  const [notification] = plugin.notifications();
  assert.ok(notification !== undefined, "expected one fallback notification");
  assert.equal(notification.title, "任务完成");
  assert.match(notification.options.body, /会话 main/);
  assert.equal(notification.options.silent, true, "custom sound is played instead of the system one");
  assert.equal(plugin.window.AudioContext.instances[0].oscillators, 3, "completion motif has three notes");
  assert.equal(plugin.events().length, 1);
  assert.equal(plugin.events()[0].type, "dsh-notification");
  assert.equal(plugin.events()[0].detail.kind, "completed");
  assert.equal(plugin.events()[0].detail.channel, "renderer-notification");
  assert.equal(plugin.events()[0].detail.shown, true);
  plugin.dispose();
});

test("the renderer fallback uses the confirmation sound for an approval wait", async () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", running({ kind: "approval", toolName: "bash" })]]));
  await settle();

  const [notification] = plugin.notifications();
  assert.equal(notification.title, "需要你确认");
  assert.match(notification.options.body, /正在等待授权确认/);
  assert.equal(plugin.window.AudioContext.instances[0].oscillators, 4, "confirmation motif has four notes");
  assert.equal(plugin.events()[0].detail.sound, "confirm");
  plugin.dispose();
});

test("a user question produces the answer-needed copy", async () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", running({ kind: "question" })]]));
  await settle();
  assert.equal(plugin.notifications()[0].title, "需要你回答");
  assert.match(plugin.notifications()[0].options.body, /有一个问题等待回答/);
  plugin.dispose();
});

test("the Windows Host path sends one toast request and skips the renderer notification", async () => {
  const plugin = startPlugin({ hostToast: true, initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();

  assert.equal(plugin.notifications().length, 0, "the Host toast owns delivery on Windows");
  const toastCall = plugin.window.fetchCalls.find((call) => call.url.includes("notification.toast"));
  assert.ok(toastCall !== undefined, "expected a toast request");
  assert.equal(toastCall.init.method, "GET");
  const query = new URL(toastCall.url, "http://x").searchParams;
  assert.equal(query.get("kind"), "completed");
  assert.equal(query.get("sessionId"), "main");
  assert.equal(query.get("title"), "任务完成");
  assert.match(query.get("body"), /会话 main/);
  assert.equal(plugin.events()[0].detail.channel, "host-toast");
  assert.equal(plugin.events()[0].detail.sound, "host");
  assert.equal(plugin.events()[0].detail.shown, true);
  assert.equal(plugin.window.AudioContext.instances[0].oscillators, 0, "the Host plays the WAV instead");
  plugin.dispose();
});

test("a clicked Host toast is revealed and opens the Session", async () => {
  const plugin = startPlugin({
    hostToast: true,
    reveals: ["session-target"],
    window: { localStorage: { getItem: () => "1" } },
  });
  assert.ok(plugin.window.__dshNotificationDebug !== undefined);
  await plugin.window.__dshNotificationDebug.reveal();
  assert.deepEqual(plugin.opened, ["session-target"]);
  plugin.dispose();
});

test("reveal polling is skipped while the page is hidden", async () => {
  const plugin = startPlugin({
    hostToast: true,
    reveals: ["session-target"],
    window: { document: createDocument({ visible: false, focused: false }), localStorage: { getItem: () => "1" } },
  });
  await plugin.window.__dshNotificationDebug.reveal();
  assert.deepEqual(plugin.opened, []);
  plugin.dispose();
});

test("viewing the Session in a focused window suppresses the notification", async () => {
  const plugin = startPlugin({
    rows: { main: createRow("main", { retainedBy: { mainView: 1 } }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  assert.equal(plugin.notifications().length, 0);
  assert.equal(plugin.events().length, 0);
  assert.equal(plugin.window.fetchCalls.length, 0, "no toast request is made either");
  plugin.dispose();
});

test("viewing a Session while the window is unfocused still notifies", async () => {
  const plugin = startPlugin({
    window: { document: createDocument({ focused: false }) },
    rows: { main: createRow("main", { retainedBy: { mainView: 1 } }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  assert.equal(plugin.notifications().length, 1);
  plugin.dispose();
});

test("a retained Session hidden behind another panel still notifies", async () => {
  const plugin = startPlugin({
    window: { document: createDocument({ transcript: false }) },
    rows: { main: createRow("main", { retainedBy: { mainView: 1 } }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  assert.equal(plugin.notifications().length, 1);
  plugin.dispose();
});

test("subagent Sessions do not emit completion notifications", async () => {
  const plugin = startPlugin({
    rows: {
      main: createRow("main"),
      child: createRow("child", { parentSessionId: "main", origin: "subagent" }),
    },
    initialStatus: new Map([["child", running()]]),
  });
  plugin.status.set(new Map([["child", { running: false }]]));
  await settle();
  assert.equal(plugin.notifications().length, 0);
  assert.equal(plugin.window.fetchCalls.length, 0);
  plugin.dispose();
});

test("an approval wait inside a subagent Session still notifies", async () => {
  const plugin = startPlugin({
    rows: {
      main: createRow("main"),
      child: createRow("child", { parentSessionId: "main", origin: "subagent" }),
    },
    initialStatus: new Map([["child", running()]]),
  });
  plugin.status.set(new Map([["child", running({ kind: "approval" })]]));
  await settle();
  assert.equal(plugin.notifications().length, 1);
  assert.equal(plugin.notifications()[0].title, "需要你确认");
  plugin.dispose();
});

test("clicking a fallback notification opens the Session and focuses the window", async () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  const [notification] = plugin.notifications();
  notification.onclick();
  assert.deepEqual(plugin.opened, ["main"]);
  assert.ok(plugin.window.focusCalls >= 1);
  assert.equal(notification.closed, true);
  plugin.dispose();
});

test("clicking a hidden fallback notification asks the Host to restore the window", async () => {
  const plugin = startPlugin({
    window: { document: createDocument({ focused: false }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  plugin.notifications()[0].onclick();
  assert.deepEqual(plugin.opened, ["main"]);
  const focusCalls = plugin.window.fetchCalls.filter((call) => call.url.includes("notification.focus"));
  assert.equal(focusCalls.length, 1);
  assert.equal(focusCalls[0].init.method, "GET");
  plugin.dispose();
});

test("clicking in a focused window does not ask the Host to restore it", async () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  plugin.notifications()[0].onclick();
  const focusCalls = plugin.window.fetchCalls.filter((call) => call.url.includes("notification.focus"));
  assert.equal(focusCalls.length, 0);
  plugin.dispose();
});

test("focus requests are queued no faster than the cooldown", () => {
  const calls = [];
  const window = {
    document: createDocument({ focused: false }),
    fetch: (url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve({ ok: true });
    },
  };
  const restoreWindow = startPlugin().bundle.exports.__internals.restoreWindow;
  restoreWindow(window);
  restoreWindow(window);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "api/notification.focus");
});

test("English locales are used when the client locale is English", async () => {
  const plugin = startPlugin({
    locale: "en",
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  const [notification] = plugin.notifications();
  assert.equal(notification.title, "Task completed");
  assert.match(notification.options.body, /Session “会话 main” finished/);
  plugin.dispose();
});

test("a browser without Web Audio falls back to the system notification sound", async () => {
  const plugin = startPlugin({
    window: { AudioContext: undefined },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  assert.equal(plugin.notifications()[0].options.silent, false);
  assert.equal(plugin.events()[0].detail.sound, "system");
  plugin.dispose();
});

test("a context whose autoplay is blocked reports no custom sound", async () => {
  const plugin = startPlugin({
    window: { AudioContext: createAudioContextClass({ state: "suspended", blocked: true }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  assert.equal(plugin.notifications()[0].options.silent, false);
  plugin.dispose();
});

test("no fallback notification is constructed while permission is undecided", async () => {
  const Notification = createNotificationClass({ permission: "default" });
  const plugin = startPlugin({
    window: { Notification },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  await settle();
  assert.equal(Notification.instances.length, 0);
  assert.ok(Notification.state.requestCalls >= 1, "permission was requested");
  assert.equal(plugin.events()[0].detail.shown, false);
  plugin.dispose();
});

test("the debug hook is exposed only when its storage flag is set", async () => {
  const off = startPlugin();
  assert.equal(off.window.__dshNotificationDebug, undefined);
  off.dispose();

  const on = startPlugin({ window: { localStorage: { getItem: () => "1" } } });
  assert.ok(on.window.__dshNotificationDebug !== undefined);
  const state = on.window.__dshNotificationDebug.state();
  assert.equal(state.permission, "granted");
  assert.equal(state.audio, true);
  assert.equal(state.revealed, 0);
  assert.ok(Array.isArray(state.notifications));
  on.window.__dshNotificationDebug.simulate("completed", "main");
  await settle();
  assert.equal(on.notifications().length, 1);
  on.dispose();
});
