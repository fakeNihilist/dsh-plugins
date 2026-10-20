/**
 * Host half of the desktop-notification plugin.
 *
 * The browser half owns the attention signal: it watches
 * `ctx.uiSession.sessionStatus` and decides when a Session finished or started
 * waiting for the user. Delivering that as a *visible* Windows notification is a
 * Host job, because HTML5 `Notification` objects created in this Electron
 * renderer are accepted by Chromium but never reach the Windows notification
 * platform (verified on the packaged app: the constructor succeeds while the
 * Action Center stays empty).
 *
 * This half therefore:
 *
 *  1. claims `POST /api/notification.toast` and raises a real WinRT toast from
 *     PowerShell, with a synthesized WAV played through `SoundPlayer` so the two
 *     attention kinds sound different;
 *  2. registers a `dsh-notify:` URL protocol (HKCU) whose handler writes the
 *     clicked Session id into a small reveal file and then launches the DSH
 *     desktop app's own `dsh://open` protocol to restore the window;
 *  3. claims `GET /api/notification.reveal`, which the browser half polls to learn
 *     "the user clicked the toast for this Session" and open it in the main view;
 *  4. keeps `POST /api/notification.focus` for the renderer fallback path.
 *
 * Everything is local: one registry key under HKCU, helper scripts and two WAV
 * files under `<DSH_HOME>/notification/`, and no network traffic beyond
 * loopback. The plugin registers no tool and writes no Session data.
 *
 * @module dsh-plugin-notification
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cordis plugin name. */
export const name = 'notification';

/** Services this plugin needs: the `/api` Fetch channel the browser half calls. */
export const inject = ['connection'];

/** Restore/focus the window (renderer fallback path). */
export const FOCUS_PATH = '/api/notification.focus';

/** Raise one Windows toast on behalf of the browser half. */
export const TOAST_PATH = '/api/notification.toast';

/** Hand a clicked toast's Session to the browser half, then clear it. */
export const REVEAL_PATH = '/api/notification.reveal';

/** Private URL protocol registered for toast activation. */
export const PROTOCOL = 'dsh-notify';

/** AUMID of the packaged desktop app (matches its Start Menu shortcut). */
const DESKTOP_AUMID = 'electron.app.DeepSeek Harness';

/** Fallback AUMID when the desktop app is not installed/registered. */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** WAV file names under the plugin directory. */
const SOUND_FILES = { completed: 'complete.wav', confirm: 'confirm.wav' };

/** Minimum gap between two focus round trips, so a double click cannot stack instances. */
const FOCUS_COOLDOWN_MS = 3000;

/** Toast copy limits, so a long Session title cannot overflow the toast. */
const TITLE_MAX = 96;
const BODY_MAX = 320;

/** Timestamp of the last accepted focus request. */
let lastFocusAt = 0;

//#region paths and assets

/**
 * The plugin's private directory under the Harness home.
 * @returns absolute directory path.
 */
export function notificationDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'notification');
}

/**
 * The Windows PowerShell executable.
 * @returns absolute path.
 */
function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** `toast.ps1`: build and show one WinRT toast, then play its WAV. */
const TOAST_SCRIPT = String.raw`param([string]$PayloadPath)
$ErrorActionPreference = 'SilentlyContinue'
$json = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$launch = 'dsh-notify://reveal/' + [uri]::EscapeDataString([string]$json.sessionId)
$title = [Security.SecurityElement]::Escape([string]$json.title)
$body = [Security.SecurityElement]::Escape([string]$json.body)
$xml = '<toast activationType="protocol" launch="' + $launch + '" duration="long"><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual><audio silent="true" /></toast>'
$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $document
$shown = $false
foreach ($aumid in @([string]$json.aumid, [string]$json.fallbackAumid)) {
  if ($aumid -eq '') { continue }
  try {
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
    $shown = $true
    break
  } catch {
    $shown = $false
  }
}
if (-not $shown) { exit 2 }
if ($json.sound -and (Test-Path -LiteralPath ([string]$json.sound))) {
  try {
    $player = New-Object System.Media.SoundPlayer ([string]$json.sound)
    $player.PlaySync()
  } catch {
  }
}
Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue
`;

/**
 * `reveal.vbs`: toast activation handler; record the Session and restore the app.
 *
 * A `.vbs` run by `wscript.exe` is a GUI-subsystem mechanism: Windows never
 * creates a console window for it. Launching `powershell.exe` from the protocol
 * key would flash (or leave) a black console window even with `-WindowStyle
 * Hidden`, which is exactly the artifact this handler must avoid.
 */
const REVEAL_SCRIPT = String.raw`Option Explicit
On Error Resume Next
Dim url, here, id, target, staging, stream, shell, fso
url = WScript.Arguments(0)
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Dim logFile
Set logFile = fso.OpenTextFile(here & "\reveal.log", 8, True)
logFile.WriteLine Now & " " & url
logFile.Close
If InStr(1, url, "dsh-notify://reveal/", vbTextCompare) = 1 Then
  id = Mid(url, Len("dsh-notify://reveal/") + 1)
  id = UrlDecode(id)
  target = here & "\reveal.json"
  staging = here & "\reveal." & Replace(fso.GetTempName(), ".", "") & ".tmp"
  Set stream = CreateObject("ADODB.Stream")
  stream.Type = 2
  stream.Charset = "utf-8"
  stream.Open
  stream.WriteText id
  stream.SaveToFile staging, 2
  stream.Close
  fso.DeleteFile target, True
  fso.MoveFile staging, target
End If
Set shell = CreateObject("WScript.Shell")
shell.Run "dsh://open", 0, False

Function UrlDecode(value)
  Dim index, code, result
  result = value
  index = 1
  Do While index <= Len(result) - 2
    If Mid(result, index, 1) = "%" Then
      code = Mid(result, index + 1, 2)
      result = Left(result, index - 1) & Chr(CLng("&H" & code)) & Mid(result, index + 3)
    End If
    index = index + 1
  Loop
  UrlDecode = result
End Function
`;

/**
 * Synthesize one short WAV motif. Kept in the Host so the plugin ships no binary
 * assets; the browser half has its own Web Audio version of the same motifs for
 * the non-Windows fallback.
 * @param notes - `{ frequency, offset, duration, volume }` list.
 * @param wave - "sine" or "triangle".
 * @returns RIFF/WAVE bytes.
 */
export function synthesizeWav(notes, wave) {
  const sampleRate = 44100;
  const totalSeconds = notes.reduce((end, note) => Math.max(end, note.offset + note.duration + 0.03), 0);
  const frames = Math.ceil(totalSeconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  const envelope = (seconds) => Math.min(1, seconds / 0.012) * Math.exp(-seconds * 6);
  for (let index = 0; index < frames; index += 1) {
    const time = index / sampleRate;
    let sample = 0;
    for (const note of notes) {
      if (time < note.offset || time > note.offset + note.duration) continue;
      const local = time - note.offset;
      const phase = 2 * Math.PI * note.frequency * local;
      const shape = wave === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(phase)) : Math.sin(phase);
      sample += shape * note.volume * envelope(local);
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(clamped * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Completion motif: ascending soft bell (C5–E5–G5), matching the browser half. */
const COMPLETION_NOTES = [
  { frequency: 523.25, offset: 0, duration: 0.34, volume: 0.16 },
  { frequency: 659.25, offset: 0.09, duration: 0.34, volume: 0.15 },
  { frequency: 783.99, offset: 0.18, duration: 0.42, volume: 0.14 },
];

/** Confirmation motif: staccato alert, deliberately unlike the bell. */
const CONFIRM_NOTES = [
  { frequency: 987.77, offset: 0, duration: 0.1, volume: 0.22 },
  { frequency: 659.25, offset: 0.14, duration: 0.1, volume: 0.22 },
  { frequency: 987.77, offset: 0.3, duration: 0.1, volume: 0.22 },
  { frequency: 659.25, offset: 0.44, duration: 0.16, volume: 0.2 },
];

/**
 * Write helper scripts and both WAV files, and register the toast protocol. Runs
 * on every activation; all writes are idempotent and only under HKCU plus the
 * plugin's own directory.
 * @returns the runtime asset paths, or undefined when the platform is not Windows.
 */
export function prepareAssets() {
  if (process.platform !== 'win32') return undefined;
  const directory = notificationDir();
  const toastScript = join(directory, 'toast.ps1');
  const revealScript = join(directory, 'reveal.vbs');
  const legacyRevealScript = join(directory, 'reveal.ps1');
  const completionSound = join(directory, SOUND_FILES.completed);
  const confirmSound = join(directory, SOUND_FILES.confirm);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(toastScript, TOAST_SCRIPT, 'utf8');
    writeFileSync(revealScript, REVEAL_SCRIPT, 'utf8');
    // Older builds registered a PowerShell activation handler; it flashed a
    // console window on click, so remove both the script and stale artifacts.
    try {
      rmSync(legacyRevealScript, { force: true });
    } catch {
      /* another process may be reading it */
    }
    // Fresh activation log per Host boot; it only records protocol invocations.
    try {
      rmSync(join(directory, 'reveal.log'), { force: true });
    } catch {
      /* ignore */
    }
    if (!existsSync(completionSound)) writeFileSync(completionSound, synthesizeWav(COMPLETION_NOTES, 'sine'));
    if (!existsSync(confirmSound)) writeFileSync(confirmSound, synthesizeWav(CONFIRM_NOTES, 'triangle'));
    for (const entry of readdirSafe(directory)) {
      if (!entry.startsWith('payload-') || !entry.endsWith('.json')) continue;
      try {
        rmSync(join(directory, entry), { force: true });
      } catch {
        /* a live toast may still hold the file */
      }
    }
    registerProtocol(revealScript);
    return { directory, toastScript, revealScript, completionSound, confirmSound };
  } catch (error) {
    console.warn('[dsh-notification] could not prepare Windows toast assets', error);
    return undefined;
  }
}

/**
 * List a directory, tolerating a missing one.
 * @param directory - directory path.
 * @returns entry names.
 */
function readdirSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Register the private protocol under HKCU. Idempotent; `reg.exe` overwrites the
 * command key on every activation so upgrades keep working.
 *
 * The handler is `wscript.exe` (GUI subsystem, no console window) rather than a
 * console host such as PowerShell or cmd, so clicking a toast never flashes a
 * black box. `//nologo` suppresses the banner; the script itself runs hidden.
 * @param revealScript - absolute path of the activation handler.
 */
export function registerProtocol(revealScript) {
  const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  const command = `"${wscript}" //nologo "${revealScript}" "%1"`;
  const keys = [
    ['HKCU\\Software\\Classes\\dsh-notify', ['/ve', '/d', 'URL:DSH Notification', '/f']],
    ['HKCU\\Software\\Classes\\dsh-notify', ['/v', 'URL Protocol', '/d', '', '/f']],
    ['HKCU\\Software\\Classes\\dsh-notify\\shell\\open\\command', ['/ve', '/d', command, '/f']],
  ];
  for (const [key, args] of keys) {
    try {
      const result = spawnSync('reg.exe', ['add', key, ...args], { windowsHide: true, stdio: 'ignore' });
      if (result.error !== undefined) console.warn('[dsh-notification] protocol registration failed', result.error);
    } catch (error) {
      console.warn('[dsh-notification] protocol registration failed', error);
    }
  }
}

//#endregion

//#region toast and focus

/**
 * Escape and clamp one text line for the toast.
 * @param value - raw text.
 * @param limit - maximum characters.
 * @returns safe single-line text.
 */
export function clampText(value, limit) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Show one Windows toast for an attention event. Fire-and-forget: a slow
 * PowerShell start must never stall the agent loop that raised the event.
 * @param assets - prepared asset paths.
 * @param event - `{ kind, sessionId, title, body }`.
 * @returns whether the toast process was spawned.
 */
export function showToast(assets, event) {
  if (assets === undefined) return false;
  const payloadPath = join(assets.directory, `payload-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  const payload = {
    sessionId: event.sessionId,
    title: event.title,
    body: event.body,
    sound: event.kind === 'completed' ? assets.completionSound : assets.confirmSound,
    aumid: DESKTOP_AUMID,
    fallbackAumid: POWERSHELL_AUMID,
  };
  try {
    writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', assets.toastScript, '-PayloadPath', payloadPath],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 2000) stderr += String(chunk);
      });
    }
    child.on('error', (error) => {
      console.warn('[dsh-notification] could not start the toast process', error);
      try {
        rmSync(payloadPath, { force: true });
      } catch {
        /* ignore */
      }
    });
    child.on('close', (code) => {
      if (code === 0) return;
      console.warn('[dsh-notification] the toast script failed', code, stderr.trim());
      try {
        rmSync(payloadPath, { force: true });
      } catch {
        /* ignore */
      }
    });
    child.unref();
    return true;
  } catch (error) {
    console.warn('[dsh-notification] could not raise the Windows toast', error);
    try {
      rmSync(payloadPath, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * Read and clear the reveal file written by the toast activation handler.
 * @param directory - plugin directory.
 * @returns the Session id the user clicked, or undefined.
 */
export function takeReveal(directory) {
  if (directory === undefined) return undefined;
  const target = join(directory, 'reveal.json');
  try {
    if (!existsSync(target)) return undefined;
    const sessionId = readFileSync(target, 'utf8').trim();
    rmSync(target, { force: true });
    return sessionId.length === 0 ? undefined : sessionId;
  } catch {
    return undefined;
  }
}

/**
 * Ask the running desktop instance to restore and focus its primary window.
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
      /* no desktop app / no protocol registration: nothing else to do */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

//#endregion

//#region routes

/**
 * JSON response helper.
 * @param body - JSON-serializable body.
 * @param status - HTTP status.
 * @returns the response.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Claim every route this plugin serves.
 * @param ctx - the Host plugin context.
 * @param assets - prepared toast assets, or undefined on non-Windows platforms.
 */
export function registerRoutes(ctx, assets) {
  const connection = ctx.connection;
  const fetchRegistry = connection === undefined || connection === null ? undefined : connection.fetch;
  if (fetchRegistry === undefined || fetchRegistry === null) return;
  const directory = assets === undefined ? undefined : assets.directory;

  ctx.effect(
    () =>
      fetchRegistry.register({
        path: TOAST_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let payload;
          try {
            if (request.method === 'GET') {
              const url = new URL(request.url);
              payload = {
                kind: url.searchParams.get('kind') ?? undefined,
                sessionId: url.searchParams.get('sessionId') ?? undefined,
                title: url.searchParams.get('title') ?? undefined,
                body: url.searchParams.get('body') ?? undefined,
              };
            } else {
              payload = JSON.parse(await request.text());
            }
          } catch {
            return json({ error: 'invalid payload' }, 400);
          }
          if (payload === null || typeof payload !== 'object' || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
            return json({ error: 'sessionId is required' }, 400);
          }
          const shown = showToast(assets, {
            kind: payload.kind === 'completed' ? 'completed' : 'confirm',
            sessionId: payload.sessionId,
            title: clampText(payload.title, TITLE_MAX),
            body: clampText(payload.body, BODY_MAX),
          });
          return shown ? json({ shown: true, mode: 'host-toast' }) : json({ shown: false, mode: 'unavailable' }, 503);
        },
      }),
    `notification: GET|POST ${TOAST_PATH}`,
  );

  ctx.effect(
    () =>
      fetchRegistry.register({
        path: REVEAL_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => json({ sessionId: takeReveal(directory) ?? null }),
      }),
    `notification: GET ${REVEAL_PATH}`,
  );

  ctx.effect(
    () =>
      fetchRegistry.register({
        path: FOCUS_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: () => {
          focusPrimaryWindow();
          return new Response(null, { status: 204 });
        },
      }),
    `notification: GET|POST ${FOCUS_PATH}`,
  );
}

//#endregion

/**
 * Activate the plugin: prepare Windows assets and claim the Fetch routes.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  const assets = prepareAssets();
  registerRoutes(ctx, assets);
}
