/**
 * Integration tests against the shipped bundle: start `apply()` on a fake browser
 * context, publish Session attention snapshots, and assert the native
 * notification, the sound motif, the suppression rules, and click navigation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createAudioContextClass,
  createDocument,
  createNotificationClass,
  createRow,
  startPlugin,
} from "./harness.js";

/** @returns a status record for a running Session. */
function running(pendingInteraction) {
  return pendingInteraction === undefined ? { running: true } : { running: true, pendingInteraction };
}

test("a finished root Session produces one native notification with the completion sound", () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  assert.equal(plugin.notifications().length, 0);

  plugin.status.set(new Map([["main", { running: false }]]));

  const [notification] = plugin.notifications();
  assert.ok(notification !== undefined, "expected one notification");
  assert.equal(notification.title, "任务完成");
  assert.match(notification.options.body, /会话 main/);
  assert.equal(notification.options.silent, true, "custom sound is played instead of the system one");
  assert.equal(plugin.window.AudioContext.instances[0].oscillators, 3, "completion motif has three notes");
  assert.equal(plugin.events().length, 1);
  assert.equal(plugin.events()[0].type, "dsh-notification");
  assert.equal(plugin.events()[0].detail.kind, "completed");
  assert.equal(plugin.events()[0].detail.shown, true);
  plugin.dispose();
});

test("an approval wait produces the confirmation sound and copy", () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  const pending = { kind: "approval", toolName: "bash" };
  plugin.status.set(new Map([["main", running(pending)]]));

  const [notification] = plugin.notifications();
  assert.equal(notification.title, "需要你确认");
  assert.match(notification.options.body, /正在等待授权确认/);
  assert.equal(plugin.window.AudioContext.instances[0].oscillators, 4, "confirmation motif has four notes");
  assert.deepEqual(plugin.events()[0].detail, {
    kind: "approval",
    sessionId: "main",
    title: "需要你确认",
    body: notification.options.body,
    sound: "confirm",
    shown: true,
    time: plugin.events()[0].detail.time,
  });
  plugin.dispose();
});

test("a user question produces the answer-needed copy", () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", running({ kind: "question" })]]));
  assert.equal(plugin.notifications()[0].title, "需要你回答");
  assert.match(plugin.notifications()[0].options.body, /有一个问题等待回答/);
  plugin.dispose();
});

test("viewing the Session in a focused window suppresses the notification", () => {
  const plugin = startPlugin({
    rows: { main: createRow("main", { retainedBy: { mainView: 1 } }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  assert.equal(plugin.notifications().length, 0);
  assert.equal(plugin.events().length, 0);
  plugin.dispose();
});

test("viewing a Session while the window is unfocused still notifies", () => {
  const plugin = startPlugin({
    window: { document: createDocument({ focused: false }) },
    rows: { main: createRow("main", { retainedBy: { mainView: 1 } }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  assert.equal(plugin.notifications().length, 1);
  plugin.dispose();
});

test("a retained Session hidden behind another panel still notifies", () => {
  const plugin = startPlugin({
    window: { document: createDocument({ transcript: false }) },
    rows: { main: createRow("main", { retainedBy: { mainView: 1 } }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  assert.equal(plugin.notifications().length, 1);
  plugin.dispose();
});

test("subagent Sessions do not emit completion notifications", () => {
  const plugin = startPlugin({
    rows: {
      main: createRow("main"),
      child: createRow("child", { parentSessionId: "main", origin: "subagent" }),
    },
    initialStatus: new Map([["child", running()]]),
  });
  plugin.status.set(new Map([["child", { running: false }]]));
  assert.equal(plugin.notifications().length, 0);
  plugin.dispose();
});

test("an approval wait inside a subagent Session still notifies", () => {
  const plugin = startPlugin({
    rows: {
      main: createRow("main"),
      child: createRow("child", { parentSessionId: "main", origin: "subagent" }),
    },
    initialStatus: new Map([["child", running()]]),
  });
  plugin.status.set(new Map([["child", running({ kind: "approval" })]]));
  assert.equal(plugin.notifications().length, 1);
  assert.equal(plugin.notifications()[0].title, "需要你确认");
  plugin.dispose();
});

test("clicking a notification opens the Session and focuses the window", () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", { running: false }]]));
  const [notification] = plugin.notifications();
  notification.onclick();
  assert.deepEqual(plugin.opened, ["main"]);
  assert.ok(plugin.window.focusCalls >= 1);
  assert.equal(notification.closed, true);
  plugin.dispose();
});

test("clicking while the window is hidden asks the Host to restore it", () => {
  const plugin = startPlugin({
    window: { document: createDocument({ focused: false }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  plugin.notifications()[0].onclick();
  assert.deepEqual(plugin.opened, ["main"]);
  assert.equal(plugin.window.fetchCalls.length, 1);
  assert.equal(plugin.window.fetchCalls[0].url, "api/notification.focus");
  assert.equal(plugin.window.fetchCalls[0].init.method, "POST");
  plugin.dispose();
});

test("clicking in a focused window does not ask the Host to restore it", () => {
  const plugin = startPlugin({ initialStatus: new Map([["main", running()]]) });
  plugin.status.set(new Map([["main", { running: false }]]));
  plugin.notifications()[0].onclick();
  assert.equal(plugin.window.fetchCalls.length, 0);
  plugin.dispose();
});

test("focus requests are queued no faster than the cooldown", () => {
  const calls = [];
  const window = {
    document: createDocument({ focused: false }),
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true });
    },
  };
  const restoreWindow = startPlugin().bundle.exports.__internals.restoreWindow;
  restoreWindow(window);
  restoreWindow(window);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "api/notification.focus");
});

test("English locales are used when the client locale is English", () => {
  const plugin = startPlugin({
    locale: "en",
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  const [notification] = plugin.notifications();
  assert.equal(notification.title, "Task completed");
  assert.match(notification.options.body, /Session “会话 main” finished/);
  plugin.dispose();
});

test("a browser without Web Audio falls back to the system notification sound", () => {
  const plugin = startPlugin({
    window: { AudioContext: undefined },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  assert.equal(plugin.notifications()[0].options.silent, false);
  assert.equal(plugin.events()[0].detail.sound, "system");
  plugin.dispose();
});

test("a context that is still suspended reports no custom sound", () => {
  const plugin = startPlugin({
    window: { AudioContext: createAudioContextClass({ state: "suspended" }) },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  assert.equal(plugin.notifications()[0].options.silent, false);
  plugin.dispose();
});

test("no notification is constructed while permission is undecided", () => {
  const Notification = createNotificationClass({ permission: "default" });
  const plugin = startPlugin({
    window: { Notification },
    initialStatus: new Map([["main", running()]]),
  });
  plugin.status.set(new Map([["main", { running: false }]]));
  assert.equal(Notification.instances.length, 0);
  assert.ok(Notification.state.requestCalls >= 1, "permission was requested");
  assert.equal(plugin.events()[0].detail.shown, false);
  plugin.dispose();
});

test("the debug hook is exposed only when its storage flag is set", () => {
  const off = startPlugin();
  assert.equal(off.window.__dshNotificationDebug, undefined);
  off.dispose();

  const on = startPlugin({ window: { localStorage: { getItem: () => "1" } } });
  assert.ok(on.window.__dshNotificationDebug !== undefined);
  const state = on.window.__dshNotificationDebug.state();
  assert.equal(state.permission, "granted");
  assert.equal(state.audio, true);
  assert.ok(Array.isArray(state.notifications));
  on.window.__dshNotificationDebug.simulate("completed", "main");
  assert.equal(on.notifications().length, 1);
  on.dispose();
});
