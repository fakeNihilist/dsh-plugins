/**
 * Host-half tests: the package identity the Loader row needs and the exact Fetch
 * route the browser half calls after a notification click. The route handler itself
 * launches the desktop protocol and is intentionally not executed here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FOCUS_PATH, apply, inject, name } from "../index.js";

test("the Host half keeps the Loader identity and the connection dependency", () => {
  assert.equal(name, "notification");
  assert.deepEqual(inject, ["connection"]);
  assert.equal(FOCUS_PATH, "/api/notification.focus");
});

test("apply claims the POST focus route on the connection Fetch channel", () => {
  let route;
  const ctx = {
    connection: {
      fetch: {
        register(candidate) {
          route = candidate;
          return () => {};
        },
      },
    },
    effect(factory) {
      const dispose = factory();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
  };
  apply(ctx);
  assert.ok(route !== undefined, "expected a registered route");
  assert.equal(route.path, FOCUS_PATH);
  assert.deepEqual(route.methods, ["POST"]);
  assert.equal(route.requestBody, "buffered");
  assert.equal(typeof route.fetch, "function");
});

test("apply stays inert when no connection service is mounted", () => {
  assert.doesNotThrow(() => apply({}));
});
