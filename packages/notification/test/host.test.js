/**
 * Host-half tests: the Loader identity, the three Fetch routes, the toast payload
 * validation, the reveal handoff, and the two pure helpers (copy clamping and WAV
 * synthesis). Raising a real PowerShell toast is deliberately not exercised here;
 * the route shape and payload gate are.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FOCUS_PATH,
  REVEAL_PATH,
  TOAST_PATH,
  clampText,
  inject,
  name,
  registerRoutes,
  synthesizeWav,
  takeReveal,
} from "../index.js";

/**
 * Fake Host context that records declared routes.
 * @returns `{ ctx, routes }`.
 */
function createContext() {
  const routes = new Map();
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(`${route.methods.join(",")} ${route.path}`, route);
          return () => {};
        },
      },
    },
    effect(factory) {
      factory();
      return () => {};
    },
  };
  return { ctx, routes };
}

test("the Host half keeps the Loader identity and the connection dependency", () => {
  assert.equal(name, "notification");
  assert.deepEqual(inject, ["connection"]);
  assert.equal(TOAST_PATH, "/api/notification.toast");
  assert.equal(REVEAL_PATH, "/api/notification.reveal");
  assert.equal(FOCUS_PATH, "/api/notification.focus");
});

test("registerRoutes claims the toast, reveal, and focus routes", () => {
  const { ctx, routes } = createContext();
  registerRoutes(ctx, undefined);
  assert.equal(routes.size, 3);
  const toast = routes.get(`GET,POST ${TOAST_PATH}`);
  assert.equal(typeof toast.fetch, "function");
  assert.equal(routes.get(`GET ${REVEAL_PATH}`).requestBody, "buffered");
  assert.equal(routes.get(`GET,POST ${FOCUS_PATH}`).methods.join(","), "GET,POST");
});

test("the toast route accepts both GET query parameters and POST JSON", async () => {
  const { ctx, routes } = createContext();
  registerRoutes(ctx, undefined);
  const toast = routes.get(`GET,POST ${TOAST_PATH}`);
  const viaGet = await toast.fetch(new Request(
    "http://x/api/notification.toast?kind=completed&sessionId=s1&title=%E4%BB%BB%E5%8A%A1&body=%E6%AD%A3%E6%96%87",
  ));
  assert.equal(viaGet.status, 503, "parsed fine, only the windows assets are missing");
  const viaPost = await toast.fetch(new Request("http://x/api/notification.toast", {
    method: "POST",
    body: JSON.stringify({ kind: "confirm", sessionId: "s2", title: "t", body: "b" }),
  }));
  assert.equal(viaPost.status, 503);
});

test("the toast route rejects malformed payloads", async () => {
  const { ctx, routes } = createContext();
  registerRoutes(ctx, undefined);
  const toast = routes.get(`GET,POST ${TOAST_PATH}`);
  const invalid = await toast.fetch(new Request("http://x/api/notification.toast", { method: "POST", body: "not-json" }));
  assert.equal(invalid.status, 400);
  const missing = await toast.fetch(new Request("http://x/api/notification.toast", { method: "POST", body: JSON.stringify({ title: "x" }) }));
  assert.equal(missing.status, 400);
  const missingGet = await toast.fetch(new Request("http://x/api/notification.toast?kind=completed"));
  assert.equal(missingGet.status, 400);
});

test("the toast route reports unavailable when windows assets are absent", async () => {
  const { ctx, routes } = createContext();
  registerRoutes(ctx, undefined);
  const toast = routes.get(`GET,POST ${TOAST_PATH}`);
  const response = await toast.fetch(new Request("http://x/api/notification.toast", {
    method: "POST",
    body: JSON.stringify({ kind: "completed", sessionId: "s1", title: "任务完成", body: "正文" }),
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).shown, false);
});

test("the reveal route hands over and clears the clicked Session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-notification-test-"));
  try {
    writeFileSync(join(directory, "reveal.json"), "session-clicked", "utf8");
    const { ctx, routes } = createContext();
    registerRoutes(ctx, { directory });
    const reveal = routes.get(`GET ${REVEAL_PATH}`);
    const first = await (await reveal.fetch(new Request("http://x/api/notification.reveal"))).json();
    assert.equal(first.sessionId, "session-clicked");
    const second = await (await reveal.fetch(new Request("http://x/api/notification.reveal"))).json();
    assert.equal(second.sessionId, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("clampText collapses whitespace and truncates", () => {
  assert.equal(clampText("  a \n b  ", 32), "a b");
  assert.equal(clampText(undefined, 32), "");
  const long = "长".repeat(500);
  const clamped = clampText(long, 320);
  assert.equal(clamped.length, 320);
  assert.ok(clamped.endsWith("…"));
});

test("synthesizeWav emits a valid mono 16-bit RIFF/WAVE file", () => {
  const wav = synthesizeWav([{ frequency: 523.25, offset: 0, duration: 0.2, volume: 0.2 }], "sine");
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit samples");
  assert.equal(wav.length, 44 + Number(wav.readUInt32LE(40)));
  assert.ok(wav.length > 44);
});

test("the two motifs have different lengths and payloads", () => {
  const completion = synthesizeWav(
    [
      { frequency: 523.25, offset: 0, duration: 0.34, volume: 0.16 },
      { frequency: 659.25, offset: 0.09, duration: 0.34, volume: 0.15 },
      { frequency: 783.99, offset: 0.18, duration: 0.42, volume: 0.14 },
    ],
    "sine",
  );
  const confirm = synthesizeWav(
    [
      { frequency: 987.77, offset: 0, duration: 0.1, volume: 0.22 },
      { frequency: 659.25, offset: 0.14, duration: 0.1, volume: 0.22 },
    ],
    "triangle",
  );
  assert.notEqual(completion.length, confirm.length);
  assert.notEqual(completion.subarray(44, 2048).toString("base64"), confirm.subarray(44, 2048).toString("base64"));
});

test("takeReveal tolerates a missing plugin directory", () => {
  assert.equal(takeReveal(undefined), undefined);
  assert.equal(takeReveal(join(tmpdir(), "dsh-notification-missing-dir")), undefined);
});
