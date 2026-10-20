/**
 * Browser-window stubs shared by the notification tests.
 *
 * The bundle is plain JavaScript loaded by the Platform Seed, so a test supplies
 * the same surface the browser does: `document`, `Notification`, `AudioContext`,
 * `CustomEvent`, storage, event listeners, `fetch`, and the Session/Workspace
 * services the plugin is injected with. Nothing here reimplements plugin logic.
 */

import { loadBundle } from "./load-bundle.js";

/**
 * Build a page document stub.
 * @param overrides - focus, visibility, transcript-mount state, and the Session id the
 *   conversation root reports (the real client marks it on `[data-conversation-session]`).
 * @returns document stub.
 */
export function createDocument(overrides = {}) {
  const focused = overrides.focused ?? true;
  const visible = overrides.visible ?? true;
  const transcript = overrides.transcript ?? true;
  const mountedSession = overrides.sessionId ?? "main";
  return {
    visibilityState: visible ? "visible" : "hidden",
    hasFocus: () => focused,
    querySelector(selector) {
      if (!transcript) return null;
      if (selector === "[data-conversation-session]") {
        return { getAttribute: (name) => (name === "data-conversation-session" ? mountedSession : null) };
      }
      if (selector === "[data-chat-flow]") return { getAttribute: () => null };
      return null;
    },
  };
}

/**
 * Notification constructor stub with a per-test instance registry.
 * @param overrides - static permission and permission-request behavior.
 * @returns the constructor, with `instances` and `state`.
 */
export function createNotificationClass(overrides = {}) {
  const instances = [];
  const state = { permission: overrides.permission ?? "granted", requestCalls: 0 };
  class FakeNotification {
    static get permission() {
      return state.permission;
    }

    static requestPermission() {
      state.requestCalls += 1;
      return Promise.resolve(state.permission);
    }

    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      instances.push(this);
    }

    close() {
      this.closed = true;
    }
  }
  Object.defineProperty(FakeNotification, "instances", { value: instances });
  Object.defineProperty(FakeNotification, "state", { value: state });
  return FakeNotification;
}

/**
 * AudioContext stub that counts scheduled oscillators.
 * @param overrides - initial context state.
 * @returns the constructor, with `instances`.
 */
export function createAudioContextClass(overrides = {}) {
  const instances = [];
  const blocked = overrides.blocked === true;
  class FakeAudioContext {
    constructor() {
      this.state = overrides.state ?? "running";
      this.currentTime = 0;
      this.destination = {};
      this.oscillators = 0;
      instances.push(this);
    }

    resume() {
      if (blocked) return Promise.resolve();
      // A real AudioContext transitions asynchronously: the state stays
      // "suspended" until the returned promise settles.
      return Promise.resolve().then(() => {
        this.state = "running";
      });
    }

    createOscillator() {
      this.oscillators += 1;
      return {
        type: "",
        frequency: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
        disconnect() {},
        onended: null,
      };
    }

    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    }
  }
  Object.defineProperty(FakeAudioContext, "instances", { value: instances });
  return FakeAudioContext;
}

/**
 * Observable `sessionStatus` store stub.
 * @param initial - initial Map<SessionId, SessionStatus>.
 * @returns the store, with `set()` to publish a new snapshot.
 */
export function createStatusSource(initial = new Map()) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * Session list row stub shaped like the client Session list projection:
 * `{ id, displayTitle, running, retainedBy, parentId?, origin? }`.
 * @param sessionId - Session identity.
 * @param overrides - row fields to override.
 * @returns a row shaped like the client Session list projection.
 */
export function createRow(sessionId, overrides = {}) {
  return {
    id: sessionId,
    displayTitle: `会话 ${sessionId}`,
    running: false,
    retainedBy: { mainView: 0 },
    ...overrides,
  };
}

/**
 * Window stub carrying the globals the bundle reads. The default `fetch`
 * simulates a Host without the Windows toast route, so the renderer fallback is
 * the default test path; `startPlugin({ hostToast: true })` swaps in a Host that
 * accepts toasts and serves reveals.
 * @param overrides - document, notification, audio, and storage replacements.
 * @returns the window stub.
 */
export function createWindow(overrides = {}) {
  const window = {
    document: overrides.document ?? createDocument(),
    Notification: overrides.Notification ?? createNotificationClass(),
    AudioContext: "AudioContext" in overrides ? overrides.AudioContext : createAudioContextClass(),
    localStorage: {
      getItem: () => null,
      ...overrides.localStorage,
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) {
      window.events.push(event);
      return true;
    },
    fetch(url, init) {
      window.fetchCalls.push({ url: String(url), init });
      const spec = String(url);
      if (spec.includes("notification.toast")) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ shown: false }) });
      }
      if (spec.includes("notification.reveal")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ sessionId: null }) });
      }
      return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
    },
    focus() {
      window.focusCalls += 1;
    },
    events: [],
    fetchCalls: [],
    focusCalls: 0,
  };
  window.CustomEvent = class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init === undefined ? undefined : init.detail;
    }
  };
  return window;
}

/**
 * Evaluate the shipped bundle and start the plugin against a fake browser context.
 * @param options - rows, initial status, locale, window overrides, and Host behavior.
 * @returns the running test surface.
 */
export function startPlugin(options = {}) {
  const rows = options.rows ?? { main: createRow("main") };
  const window = createWindow(options.window);
  if (options.hostToast === true) {
    const reveals = [...(options.reveals ?? [])];
    window.fetch = (url, init) => {
      window.fetchCalls.push({ url: String(url), init });
      const spec = String(url);
      if (spec.includes("notification.toast")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ shown: true, mode: "host-toast" }) });
      }
      if (spec.includes("notification.reveal")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ sessionId: reveals.shift() ?? null }) });
      }
      return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
    };
  }
  const bundle = loadBundle(window);
  const messages = options.locale === "en" ? bundle.exports.__internals.en : bundle.exports.__internals.zh;
  const translate = (key) => messages[key];
  const status = options.status ?? createStatusSource(options.initialStatus ?? new Map());
  const opened = [];
  const disposers = [];
  const ctx = {
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => {};
    },
    locale: {
      register() {},
      bind: () => translate,
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: rows }) },
    },
    uiSession: { sessionStatus: status },
    uiWorkspace: { openSession: (sessionId) => opened.push(sessionId) },
  };
  bundle.exports.apply(ctx);
  return {
    bundle,
    window,
    status,
    rows,
    opened,
    translate,
    notifications: () => window.Notification.instances,
    events: () => window.events,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

/**
 * Let queued microtasks and promise chains settle. `deliver` asks the Host for a
 * toast first, so notification records appear one or two ticks later.
 * @returns a settled promise.
 */
export async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
