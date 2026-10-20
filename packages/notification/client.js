/**
 * Browser half of the desktop-notification plugin.
 *
 * Notifies the user with a native desktop notification when a DSH Session
 * finishes a turn or starts waiting for the user (an approval request or an
 * `ask_user_question` card), with a different synthesized sound for each case.
 * Clicking the notification brings the user back to that exact Session.
 *
 * Four decisions shape this module.
 *
 * 1. The attention source is the built-in Session UI store, not a private
 *    polling loop. `ctx.uiSession.sessionStatus` already tracks every Session's
 *    `running` flag, its pending interaction, and completion unread state across
 *    the whole Host connection; the approval and user-question composer plugins
 *    publish into it, so a Session the user is *not* looking at still shows up
 *    here. Nothing in the Host is involved, which keeps the plugin working
 *    against any DSH Web client (desktop app or `dsh web`).
 * 2. Notification sounds are synthesized with the Web Audio API instead of
 *    shipping WAV assets: the browser half is a single `client.js` file loaded
 *    from the profile, so a data URI or an extra asset route would only add
 *    weight. Two distinct short motifs make "finished" and "needs you"
 *    audibly different.
 * 3. The notification is always shown when the user is away from the Session —
 *    including while the app is focused on another Session, the home screen, or
 *    Settings. Only the combination "viewing that Session + focused + visible"
 *    suppresses it, because the user is already looking at the answer.
 * 4. Clicking a notification calls `ctx.uiWorkspace.openSession`, the same
 *    navigation the Session list uses, then focuses the window. A click never
 *    depends on a protocol handler or a second process.
 *
 * Plain JavaScript by design. An installed client bundle receives the Platform
 * Seed's module table from the browser, so no build step is involved;
 * `package.json`'s `dsh.client` declaration is what discovers this file.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-notification",
  factory() {
    //#region constants

    /** Locale namespace owned by this plugin. */
    const NS = "notification";

    /** Introspection event fired for every attention transition the plugin observed. */
    const EVENT_NAME = "dsh-notification";

    /** `localStorage` flag that exposes the manual test hook (see README). */
    const DEBUG_KEY = "dsh-notification:debug";

    /**
     * Relative Fetch route the Host half registers to restore a minimized or
     * tray-hidden desktop window. A renderer cannot do that itself.
     */
    const FOCUS_PATH = "api/notification.focus";

    /**
     * Relative Fetch route the Host half registers to raise a real Windows toast.
     * HTML5 `Notification` is invisible in the packaged Electron renderer, so the
     * Host delivers the toast and plays the WAV on Windows.
     */
    const TOAST_PATH = "api/notification.toast";

    /**
     * Relative Fetch route the Host half registers to hand back the Session the
     * user clicked in a toast. Polled by this half.
     */
    const REVEAL_PATH = "api/notification.reveal";

    /** Reveal polling interval; local loopback fetch is cheap. */
    const REVEAL_POLL_MS = 1500;

    /** Minimum gap between two focus requests, so a double click cannot stack app instances. */
    const FOCUS_COOLDOWN_MS = 3000;

    /** Timestamp of the last focus round trip. */
    let lastFocusAt = 0;

    /**
     * DOM seams that prove the conversation area is mounted. The current client
     * marks the viewed Session on the conversation root; older clients exposed the
     * transcript flow element without an id.
     */
    const VIEW_SELECTORS = ["[data-conversation-session]", "[data-chat-flow]"];

    /** Longest Session title carried into a notification body. */
    const TITLE_MAX = 64;

    /** In-memory ring size for debug/state inspection. */
    const RECORD_MAX = 20;

    /** Ascending bell motif for "task finished". */
    const COMPLETION_NOTES = [
      { frequency: 523.25, offset: 0, duration: 0.34, volume: 0.16 },
      { frequency: 659.25, offset: 0.09, duration: 0.34, volume: 0.15 },
      { frequency: 783.99, offset: 0.18, duration: 0.42, volume: 0.14 },
    ];

    /** Staccato alert motif for "needs the user"; deliberately unlike the bell. */
    const CONFIRM_NOTES = [
      { frequency: 987.77, offset: 0, duration: 0.1, volume: 0.22 },
      { frequency: 659.25, offset: 0.14, duration: 0.1, volume: 0.22 },
      { frequency: 987.77, offset: 0.3, duration: 0.1, volume: 0.22 },
      { frequency: 659.25, offset: 0.44, duration: 0.16, volume: 0.2 },
    ];

    /** Simplified Chinese copy; the built-in approval/question classes speak this tone. */
    const zh = {
      completedTitle: "任务完成",
      completedBody: "会话「{title}」已完成，点击打开",
      approvalTitle: "需要你确认",
      approvalBody: "会话「{title}」正在等待授权确认，点击打开",
      questionTitle: "需要你回答",
      questionBody: "会话「{title}」有一个问题等待回答，点击打开",
      untitled: "未命名会话",
    };

    /** English copy. */
    const en = {
      completedTitle: "Task completed",
      completedBody: "Session “{title}” finished. Click to open.",
      approvalTitle: "Confirmation needed",
      approvalBody: "Session “{title}” is waiting for approval. Click to open.",
      questionTitle: "Answer needed",
      questionBody: "Session “{title}” has a question waiting for you. Click to open.",
      untitled: "Untitled session",
    };

    //#endregion

    //#region pure helpers

    /**
     * Clamp one Session title to a length a toast can render without clipping.
     * @param value - raw title text, possibly empty.
     * @returns trimmed text, or undefined when nothing usable remains.
     */
    function clampTitle(value) {
      if (typeof value !== "string") return undefined;
      const text = value.trim();
      if (text.length === 0) return undefined;
      return text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`;
    }

    /**
     * Fill `{name}` placeholders without depending on the locale service's own
     * interpolation grammar; the two templates this plugin owns are fixed.
     * @param template - localized template.
     * @param values - replacement values by placeholder name.
     * @returns rendered text.
     */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/gu, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
      );
    }

    /**
     * Compare two `sessionStatus` snapshots and report the attention transitions
     * worth notifying. Running→idle is "finished"; a pending interaction that was
     * not pending before is either an approval or a user question. A Session that
     * becomes idle right after answering its own pending interaction is not
     * reported as a fresh completion: the user was already being asked.
     * @param previous - previous Map<SessionId, SessionStatus>.
     * @param next - current Map<SessionId, SessionStatus>.
     * @returns ordered attention events.
     */
    function collectAttentionEvents(previous, next) {
      const events = [];
      for (const [sessionId, status] of next) {
        const before = previous.get(sessionId);
        const pending = status === undefined ? undefined : status.pendingInteraction;
        const wasPending = before !== undefined && before.pendingInteraction !== undefined;
        if (pending !== undefined && !wasPending) {
          events.push({
            kind: pending.kind === "approval" ? "approval" : "question",
            sessionId,
          });
        }
        if (
          before !== undefined &&
          before.running === true &&
          status !== undefined &&
          status.running === false &&
          !wasPending &&
          pending === undefined
        ) {
          events.push({ kind: "completed", sessionId });
        }
      }
      return events;
    }

    /**
     * Whether a row is a top-level Session (a workspace conversation). Subagent
     * children finish constantly while their parent still works; notifying for
     * each of them would be noise, so completion notices are root-only, while
     * approval/question notices stay enabled for every Session because those
     * genuinely block a human answer.
     * @param row - Session list row, if any.
     * @returns true for a root Session row.
     */
    function isRootSessionRow(row) {
      return row !== undefined && row.parentSessionId === undefined && row.origin !== "subagent";
    }

    /**
     * Whether the user is currently looking at one Session: the page is visible and
     * focused, the Session is retained by the main view, and the conversation area
     * is mounted for that exact Session (a Settings page keeps the retention but
     * unmounts the conversation; another Session mounts its own id).
     * @param doc - the page document.
     * @param row - Session list row for the candidate, if any.
     * @param sessionId - the candidate Session identity.
     * @returns true when suppressing would be correct.
     */
    function viewingSession(doc, row, sessionId) {
      if (doc === undefined || doc === null) return false;
      if (doc.visibilityState !== undefined && doc.visibilityState !== "visible") return false;
      if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return false;
      if (row === undefined || (row.retainedBy !== undefined && (row.retainedBy.mainView ?? 0) === 0)) return false;
      if (typeof doc.querySelector !== "function") return false;
      for (const selector of VIEW_SELECTORS) {
        const mounted = doc.querySelector(selector);
        if (mounted === null || mounted === undefined) continue;
        if (typeof mounted.getAttribute !== "function") return true;
        const mountedId = mounted.getAttribute("data-conversation-session");
        if (mountedId === null || mountedId === undefined || mountedId === "") return true;
        return mountedId === sessionId;
      }
      return false;
    }

    //#endregion

    //#region audio

    /**
     * Own the one AudioContext and both motifs.
     *
     * The context is created eagerly so the first notification does not pay for
     * construction, and `unlock()` is wired to the page's own pointer/keyboard
     * activity: the desktop app normally allows autoplay, but a plain browser tab
     * may keep the context suspended until the first gesture.
     * @param win - the browser window.
     * @returns the audio kit.
     */
    function createAudioKit(win) {
      let context;
      let unavailable = false;

      /** @returns the AudioContext, or undefined when Web Audio is unavailable. */
      function ensure() {
        if (context !== undefined || unavailable) return context;
        const Ctor = win.AudioContext ?? win.webkitAudioContext;
        if (typeof Ctor !== "function") {
          unavailable = true;
          return undefined;
        }
        try {
          context = new Ctor();
        } catch {
          unavailable = true;
          return undefined;
        }
        return context;
      }

      /** @returns true when the context is running and can schedule sound now. */
      function ready() {
        const audio = ensure();
        if (audio === undefined) return false;
        if (audio.state === "running") return true;
        try {
          const result = audio.resume();
          if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
        } catch {
          /* the next real gesture retries */
        }
        return audio.state === "running";
      }

      /**
       * Schedule one enveloped tone.
       * @param audio - running AudioContext.
       * @param note - motif note.
       * @param at - absolute start time in seconds.
       * @param type - oscillator wave shape.
       */
      function tone(audio, note, at, type) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(note.frequency, at);
        const end = at + note.duration;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(note.volume, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(at);
        oscillator.stop(end + 0.02);
        oscillator.onended = () => {
          try {
            oscillator.disconnect();
            gain.disconnect();
          } catch {
            /* already detached */
          }
        };
      }

      /**
       * Play one motif.
       * @param kind - "completion" or "confirm".
       * @returns true when the sound was scheduled.
       */
      function play(kind) {
        if (!ready()) return false;
        const audio = ensure();
        const notes = kind === "completion" ? COMPLETION_NOTES : CONFIRM_NOTES;
        const wave = kind === "completion" ? "sine" : "triangle";
        const base = audio.currentTime + 0.02;
        try {
          for (const note of notes) tone(audio, note, base + note.offset, wave);
        } catch (error) {
          console.warn("[dsh-notification] could not play the notification sound", error);
          return false;
        }
        return true;
      }

      return {
        /** @returns whether custom sound is available synchronously. */
        ready,
        /** Create/resume the context; the next gesture retries when suspended. */
        unlock: ready,
        /**
         * Play one motif.
         * @param kind - "completion" or "confirm".
         * @returns true when scheduled.
         */
        play,
        /** Play both motifs, spaced, so a human can check them by ear. */
        test() {
          play("completion");
          win.setTimeout(() => play("confirm"), 900);
        },
      };
    }

    //#endregion

    //#region notifications

    /**
     * Ask for notification permission once. The DSH desktop shell answers `true`
     * for every non-media permission, so this settles silently there; a browser
     * tab shows the usual prompt.
     * @param win - the browser window.
     */
    function requestPermission(win) {
      const ctor = win.Notification;
      if (typeof ctor !== "function") return;
      if (ctor.permission === "granted" || ctor.permission === "denied") return;
      try {
        const result = ctor.requestPermission();
        if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
      } catch {
        /* permission can still be requested on the next notification attempt */
      }
    }

    /**
     * Open one Session in the main view and try to focus the window.
     * @param ctx - the browser plugin context.
     * @param sessionId - Session to reveal.
     */
    function openSession(ctx, sessionId) {
      try {
        if (typeof window !== "undefined" && typeof window.focus === "function") window.focus();
      } catch {
        /* focus is best effort; the navigation below is what matters */
      }
      try {
        ctx.uiWorkspace.openSession(sessionId);
      } catch (error) {
        console.warn("[dsh-notification] could not open the Session from its notification", error);
      }
    }

    /**
     * Ask the Host half to restore a minimized or tray-hidden desktop window.
     *
     * The renderer cannot do that itself: `window.focus()` does not restore a
     * minimized/hidden BrowserWindow and an installed bundle has no shell IPC, so
     * the Host launches the desktop app's registered `dsh://open` protocol and the
     * running instance's single-instance handler focuses the primary window. Only
     * needed when the page is hidden or unfocused; the in-page navigation above
     * already handles the common case.
     * @param win - the browser window.
     */
    function restoreWindow(win) {
      const doc = win.document;
      const visible = doc === undefined || doc.visibilityState === undefined || doc.visibilityState === "visible";
      const focused = doc === undefined || typeof doc.hasFocus !== "function" || doc.hasFocus();
      if (visible && focused) return;
      const now = Date.now();
      if (now - lastFocusAt < FOCUS_COOLDOWN_MS) return;
      lastFocusAt = now;
      try {
        if (typeof win.fetch !== "function") return;
        const result = win.fetch(FOCUS_PATH, { method: "GET", keepalive: true, credentials: "same-origin", cache: "no-store" });
        if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
      } catch {
        /* focusing is best effort; the Session is already open in the main view */
      }
    }

    /**
     * Resolve the display title of one Session from the Session list projection.
     * @param ctx - the browser plugin context.
     * @param sessionId - target Session.
     * @returns clamped title, or undefined when the row is gone.
     */
    function sessionTitleOf(ctx, sessionId) {
      try {
        const row = ctx.sessions.list.getSnapshot().byId[sessionId];
        if (row === undefined) return undefined;
        return clampTitle(row.displayTitle ?? row.title ?? sessionId);
      } catch {
        return undefined;
      }
    }

    /**
     * Whether the Host still lists one Session as a root conversation.
     * @param ctx - the browser plugin context.
     * @param sessionId - target Session.
     * @returns true for a live root Session.
     */
    function rootSessionOf(ctx, sessionId) {
      try {
        return isRootSessionRow(ctx.sessions.list.getSnapshot().byId[sessionId]);
      } catch {
        return false;
      }
    }

    /**
     * Whether the user is already looking at one Session.
     * @param ctx - the browser plugin context.
     * @param sessionId - target Session.
     * @param doc - the page document.
     * @returns true when the notification would be redundant.
     */
    function lookingAtSession(ctx, sessionId, doc) {
      try {
        return viewingSession(doc, ctx.sessions.list.getSnapshot().byId[sessionId], sessionId);
      } catch {
        return false;
      }
    }

    /**
     * Announce one delivered (or skipped) attention event on the window for
     * diagnostics and integration tests.
     * @param win - the browser window.
     * @param record - JSON-safe record.
     */
    function announce(win, record) {
      try {
        const Ctor = win.CustomEvent;
        const event = typeof Ctor === "function" ? new Ctor(EVENT_NAME, { detail: record }) : { type: EVENT_NAME, detail: record };
        win.dispatchEvent(event);
      } catch {
        /* diagnostics must never break delivery */
      }
    }

    /**
     * Ask the Host half for one real Windows toast. Resolves true only when the
     * Host reports that its PowerShell toast was spawned; every other outcome
     * (non-Windows Host, missing plugin route, transport failure) falls back to
     * the renderer notification path.
     * @param win - the browser window.
     * @param payload - `{ kind, sessionId, title, body }`.
     * @returns whether the Host accepted the toast.
     */
    function requestHostToast(win, payload) {
      try {
        if (typeof win.fetch !== "function") return Promise.resolve(false);
        const query = new URLSearchParams({
          kind: payload.kind,
          sessionId: payload.sessionId,
          title: payload.title,
          body: payload.body,
        });
        const result = win.fetch(`${TOAST_PATH}?${query.toString()}`, {
          method: "GET",
          keepalive: true,
          credentials: "same-origin",
          cache: "no-store",
        });
        return Promise.resolve(result)
          .then((response) => {
            if (response === undefined || response === null || response.ok !== true) return false;
            const parsed = typeof response.json === "function" ? response.json() : Promise.resolve({});
            return Promise.resolve(parsed)
              .then((data) => data !== null && typeof data === "object" && data.shown === true)
              .catch(() => false);
          })
          .catch(() => false);
      } catch {
        return Promise.resolve(false);
      }
    }

    /**
     * Poll the Host for a toast click and open the Session it names. Called on a
     * timer and on focus/visibility changes, so a click that restores a hidden
     * window navigates as soon as the page is visible again.
     * @param ctx - the browser plugin context.
     * @param win - the browser window.
     * @param state - watcher state carrying the in-flight guard and click count.
     * @returns the poll promise, settled even on transport errors.
     */
    function checkReveal(ctx, win, state) {
      if (state.revealBusy === true) return Promise.resolve();
      if (win.document !== undefined && win.document !== null && win.document.visibilityState === "hidden") return Promise.resolve();
      state.revealBusy = true;
      try {
        if (typeof win.fetch !== "function") {
          state.revealBusy = false;
          return Promise.resolve();
        }
        return Promise.resolve(
          win.fetch(REVEAL_PATH, { method: "GET", credentials: "same-origin", cache: "no-store" }),
        )
          .then((response) => {
            if (response === undefined || response === null || response.ok !== true) return undefined;
            const parsed = typeof response.json === "function" ? response.json() : Promise.resolve({});
            return Promise.resolve(parsed).catch(() => ({}));
          })
          .then((data) => {
            if (data === null || typeof data !== "object") return;
            const sessionId = data.sessionId;
            if (typeof sessionId !== "string" || sessionId.length === 0) return;
            state.revealed += 1;
            openSession(ctx, sessionId);
          })
          .catch(() => {})
          .finally(() => {
            state.revealBusy = false;
          });
      } catch {
        state.revealBusy = false;
        return Promise.resolve();
      }
    }

    /**
     * Deliver one attention event: Host toast on Windows, renderer notification
     * fallback elsewhere. Records exactly one diagnostic entry per event.
     * @param ctx - the browser plugin context.
     * @param t - bound notification translator.
     * @param audio - audio kit.
     * @param records - debug record ring.
     * @param event - attention event from {@link collectAttentionEvents}.
     */
    function deliver(ctx, t, audio, records, event) {
      const win = window;
      const doc = win.document;
      const sessionId = event.sessionId;
      if (event.kind === "completed" && !rootSessionOf(ctx, sessionId)) return;
      if (lookingAtSession(ctx, sessionId, doc)) return;

      const titleKey = event.kind === "completed" ? "completedTitle" : event.kind === "approval" ? "approvalTitle" : "questionTitle";
      const bodyKey = event.kind === "completed" ? "completedBody" : event.kind === "approval" ? "approvalBody" : "questionBody";
      const sessionTitle = sessionTitleOf(ctx, sessionId) ?? t("untitled");
      const title = t(titleKey);
      const body = fill(t(bodyKey), { title: sessionTitle });
      const base = { kind: event.kind, sessionId, title, body, shown: false, channel: "none", time: Date.now() };

      /**
       * Finish one delivery.
       * @param record - final diagnostic record.
       */
      const finish = (record) => {
        records.push(record);
        if (records.length > RECORD_MAX) records.shift();
        announce(win, record);
      };

      /**
       * Renderer fallback: Web Audio motif plus HTML5 Notification. Used on
       * macOS/Linux and whenever the Host toast route is unavailable.
       * @returns the settled record.
       */
      const fallback = () => {
        const sound = event.kind === "completed" ? "completion" : "confirm";
        const played = audio.play(sound);
        const NotificationCtor = win.Notification;
        const canNotify = typeof NotificationCtor === "function" && NotificationCtor.permission === "granted";
        const record = { ...base, sound: played ? sound : "system", channel: "renderer-notification" };
        if (canNotify) {
          try {
            const notification = new NotificationCtor(title, {
              body,
              tag: `dsh-notification:${event.kind}:${sessionId}`,
              silent: played,
              requireInteraction: false,
            });
            notification.onclick = () => {
              openSession(ctx, sessionId);
              restoreWindow(win);
              try {
                notification.close();
              } catch {
                /* already closed */
              }
            };
            record.shown = true;
          } catch (error) {
            console.warn("[dsh-notification] the desktop notification could not be shown", error);
          }
        } else {
          requestPermission(win);
        }
        finish(record);
        return record;
      };

      return requestHostToast(win, { kind: event.kind, sessionId, title, body }).then((toastShown) => {
        if (toastShown) {
          finish({ ...base, sound: "host", channel: "host-toast", shown: true });
          return;
        }
        fallback();
      });
    }

    //#endregion

    //#region plugin

    /** Services this browser half needs. */
    const inject = ["sessions", "uiSession", "uiWorkspace", "locale"];

    /**
     * Wire the attention watcher, the audio kit, and the debug hook.
     * @param ctx - the browser plugin context.
     * @returns disposer owned by the surrounding effect.
     */
    function startWatcher(ctx) {
      const win = window;
      const t = ctx.locale.bind(NS);
      const audio = createAudioKit(win);
      const records = [];
      const status = ctx.uiSession.sessionStatus;
      const revealState = { revealBusy: false, revealed: 0 };
      let previous = new Map(status.getSnapshot());

      const unsubscribe = status.subscribe(() => {
        const next = status.getSnapshot();
        const events = collectAttentionEvents(previous, next);
        previous = new Map(next);
        for (const event of events) deliver(ctx, t, audio, records, event);
      });

      // A click in a Host toast restores the window through the desktop app's
      // single-instance handler and writes a reveal file; pick it up as soon as
      // the page is visible again and on a slow idle poll.
      const pollReveal = () => {
        checkReveal(ctx, win, revealState);
      };
      const poll = typeof win.setInterval === "function" ? win.setInterval(pollReveal, REVEAL_POLL_MS) : undefined;
      win.addEventListener("focus", pollReveal);
      win.addEventListener("visibilitychange", pollReveal);

      requestPermission(win);
      audio.unlock();

      let debug;
      try {
        if (win.localStorage?.getItem(DEBUG_KEY) === "1") {
          debug = {
            state: () => ({
              permission: typeof win.Notification === "function" ? win.Notification.permission : "unavailable",
              audio: audio.ready(),
              sessionStatus: [...previous.entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
              notifications: [...records],
              revealed: revealState.revealed,
            }),
            simulate: (kind, sessionId) => {
              const event = {
                kind: kind === "completed" ? "completed" : kind === "question" ? "question" : "approval",
                sessionId,
              };
              deliver(ctx, t, audio, records, event);
            },
            open: (sessionId) => openSession(ctx, sessionId),
            sounds: () => audio.test(),
            reveal: () => checkReveal(ctx, win, revealState),
          };
          win.__dshNotificationDebug = debug;
        }
      } catch {
        /* a sandboxed storage must not disable the plugin */
      }

      /** Ask for permission and unlock audio on the page's own input activity. */
      function onGesture() {
        requestPermission(win);
        audio.unlock();
      }
      win.addEventListener("pointerdown", onGesture, { capture: true, passive: true });
      win.addEventListener("keydown", onGesture, { capture: true });

      return () => {
        unsubscribe();
        if (poll !== undefined && typeof win.clearInterval === "function") win.clearInterval(poll);
        win.removeEventListener("focus", pollReveal);
        win.removeEventListener("visibilitychange", pollReveal);
        win.removeEventListener("pointerdown", onGesture, { capture: true });
        win.removeEventListener("keydown", onGesture, { capture: true });
        if (debug !== undefined) {
          try {
            delete win.__dshNotificationDebug;
          } catch {
            /* readonly window */
          }
        }
      };
    }

    /**
     * Install the plugin: localized copy plus the one attention watcher.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-notification: dictionaries");
      ctx.effect(() => startWatcher(ctx), "dsh-notification: attention watcher");
    }

    //#endregion

    /**
     * Inert extras: the module loader reads `inject` and `apply`; tests use these
     * to exercise the shipped artifact without a browser.
     */
    const __internals = {
      NS,
      EVENT_NAME,
      DEBUG_KEY,
      FOCUS_PATH,
      TOAST_PATH,
      REVEAL_PATH,
      TITLE_MAX,
      COMPLETION_NOTES,
      CONFIRM_NOTES,
      zh,
      en,
      clampTitle,
      fill,
      collectAttentionEvents,
      isRootSessionRow,
      viewingSession,
      createAudioKit,
      restoreWindow,
      requestHostToast,
      checkReveal,
    };

    return { inject, apply, __internals };
  },
});
