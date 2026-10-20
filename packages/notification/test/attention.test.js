/**
 * Pure-piece tests for the shipped browser bundle: the attention diff, title
 * clamping, template filling, root-session filtering, and viewing detection.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadBundle } from "./load-bundle.js";
import { createDocument, createRow } from "./harness.js";

const { exports } = loadBundle();
const { collectAttentionEvents, clampTitle, fill, isRootSessionRow, viewingSession, zh, en } = exports.__internals;

test("the bundle registers under its package id and exposes its services", () => {
  assert.equal(exports.inject.length, 4);
  assert.deepEqual(exports.inject, ["sessions", "uiSession", "uiWorkspace", "locale"]);
  assert.equal(typeof exports.apply, "function");
});

test("running true to false reports one completion", () => {
  const previous = new Map([["s1", { running: true }]]);
  const next = new Map([["s1", { running: false, completionUnread: true }]]);
  assert.deepEqual(collectAttentionEvents(previous, next), [{ kind: "completed", sessionId: "s1" }]);
});

test("a first observation never reports a completion", () => {
  const previous = new Map();
  const next = new Map([["s1", { running: false }]]);
  assert.deepEqual(collectAttentionEvents(previous, next), []);
});

test("re-applying an unchanged snapshot reports nothing", () => {
  const snapshot = new Map([["s1", { running: false }]]);
  assert.deepEqual(collectAttentionEvents(new Map(snapshot), snapshot), []);
});

test("a new approval interaction is reported once, as approval", () => {
  const previous = new Map([["s1", { running: true }]]);
  const next = new Map([["s1", { running: true, pendingInteraction: { kind: "approval", toolName: "bash" } }]]);
  assert.deepEqual(collectAttentionEvents(previous, next), [{ kind: "approval", sessionId: "s1" }]);
  assert.deepEqual(collectAttentionEvents(next, new Map(next)), []);
});

test("a new user question is reported as a question", () => {
  const previous = new Map([["s1", { running: true }]]);
  const next = new Map([["s1", { running: true, pendingInteraction: { kind: "question" } }]]);
  assert.deepEqual(collectAttentionEvents(previous, next), [{ kind: "question", sessionId: "s1" }]);
});

test("a plan review counts as a question", () => {
  const previous = new Map([["s1", { running: true }]]);
  const next = new Map([["s1", { running: true, pendingInteraction: { kind: "plan-review" } }]]);
  assert.deepEqual(collectAttentionEvents(previous, next), [{ kind: "question", sessionId: "s1" }]);
});

test("becoming idle while a pending interaction is still open is not a completion", () => {
  const previous = new Map([["s1", { running: true }]]);
  const next = new Map([["s1", { running: false, pendingInteraction: { kind: "approval" } }]]);
  const events = collectAttentionEvents(previous, next);
  assert.deepEqual(events, [{ kind: "approval", sessionId: "s1" }]);
});

test("a pending interaction present at first observation is reported", () => {
  const previous = new Map();
  const next = new Map([["s1", { running: true, pendingInteraction: { kind: "approval" } }]]);
  assert.deepEqual(collectAttentionEvents(previous, next), [{ kind: "approval", sessionId: "s1" }]);
});

test("titles are trimmed and clamped with an ellipsis", () => {
  assert.equal(clampTitle("  hello  "), "hello");
  assert.equal(clampTitle("   "), undefined);
  assert.equal(clampTitle(undefined), undefined);
  const long = "长".repeat(200);
  const clamped = clampTitle(long);
  assert.equal(clamped.length, exports.__internals.TITLE_MAX);
  assert.ok(clamped.endsWith("…"));
});

test("fill replaces only known placeholders", () => {
  assert.equal(fill("会话「{title}」完成", { title: "T" }), "会话「T」完成");
  assert.equal(fill("{title} {other}", { title: "T" }), "T {other}");
});

test("only top-level conversation rows are root sessions", () => {
  assert.equal(isRootSessionRow(createRow("s1")), true);
  assert.equal(isRootSessionRow(createRow("s1", { parentId: "parent" })), false);
  assert.equal(isRootSessionRow(createRow("s1", { origin: "subagent" })), false);
  assert.equal(isRootSessionRow(createRow("s1", { parentId: "parent", origin: "subagent" })), false);
  assert.equal(isRootSessionRow(undefined), false);
});

test("viewing requires retention, focus, visibility, and the conversation mounted for that Session", () => {
  const row = createRow("s1", { retainedBy: { mainView: 1 } });
  assert.equal(viewingSession(createDocument({ sessionId: "s1" }), row, "s1"), true);
  assert.equal(viewingSession(createDocument({ sessionId: "s2" }), row, "s1"), false);
  assert.equal(viewingSession(createDocument({ focused: false }), row, "s1"), false);
  assert.equal(viewingSession(createDocument({ visible: false }), row, "s1"), false);
  assert.equal(viewingSession(createDocument({ transcript: false }), row, "s1"), false);
  assert.equal(viewingSession(createDocument(), createRow("s1"), "s1"), false);
  assert.equal(viewingSession(undefined, row, "s1"), false);
});

test("both locales carry the complete copy set", () => {
  for (const dictionary of [zh, en]) {
    for (const key of ["completedTitle", "completedBody", "approvalTitle", "approvalBody", "questionTitle", "questionBody", "untitled"]) {
      assert.equal(typeof dictionary[key], "string", key);
    }
  }
});
