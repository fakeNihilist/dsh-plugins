/**
 * Host half of the desktop-notification plugin.
 *
 * The notification itself is a browser concern: the Web client owns the Session
 * attention store, synthesizes the two sounds, and calls the page's own
 * `Notification` API. This half exists for one thing the renderer cannot do —
 * restore a window that the user hid to the tray or minimized.
 *
 * A click in the renderer is handled by the page: it opens the Session in the
 * main view and, when the window is not focused, asks this half to bring the
 * window forward. `window.focus()` in Chromium cannot restore a minimized or
 * tray-hidden window and an installed bundle has no shell IPC, so the Host does
 * the only supported round trip: launch the DSH desktop app's registered
 * `dsh://open` protocol. The already-running instance's single-instance handler
 * restores, shows, and focuses the primary window; a second process exits
 * immediately. Launching a protocol from the Host process needs no registry
 * change: the desktop app registers it when packaged.
 *
 * The route is a local Fetch route on the shared `/api` channel, the documented
 * seam for installed bundles (the Client `ctx.remote.*` namespaces are a
 * build-time fixed set an installed bundle cannot extend). It is not
 * model-visible: no tool, no prompt, no session write.
 *
 * @module dsh-plugin-notification
 */

import { spawn } from 'node:child_process';

/** Cordis plugin name. */
export const name = 'notification';

/** Services this plugin needs: the `/api` Fetch channel the browser half calls. */
export const inject = ['connection'];

/** Exact Fetch route path, absolute below the `/api` channel. */
export const FOCUS_PATH = '/api/notification.focus';

/** Minimum gap between two focus round trips, so a double click cannot stack instances. */
const FOCUS_COOLDOWN_MS = 3000;

/** Timestamp of the last accepted focus request. */
let lastFocusAt = 0;

/**
 * Ask the running desktop instance to restore and focus its primary window by
 * launching the registered `dsh://open` protocol. Best effort: on a `dsh web`
 * deployment (no desktop app, no protocol registration) the launch simply fails
 * and the page's own navigation still stands.
 * @returns whether a launch was started.
 */
export function focusPrimaryWindow() {
  const now = Date.now();
  if (now - lastFocusAt < FOCUS_COOLDOWN_MS) return false;
  lastFocusAt = now;
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', 'dsh://open']]
      : process.platform === 'darwin'
        ? ['open', ['dsh://open']]
        : ['xdg-open', ['dsh://open']];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      // No protocol handler / no desktop app: the in-page navigation already happened.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim the focus route so the browser half can bring the window forward after
 * a notification click.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  const connection = ctx.connection;
  const fetchRegistry = connection === undefined || connection === null ? undefined : connection.fetch;
  if (fetchRegistry === undefined || fetchRegistry === null) return;
  ctx.effect(
    () =>
      fetchRegistry.register({
        path: FOCUS_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: () => {
          focusPrimaryWindow();
          return new Response(null, { status: 204 });
        },
      }),
    `notification: POST ${FOCUS_PATH}`,
  );
}
