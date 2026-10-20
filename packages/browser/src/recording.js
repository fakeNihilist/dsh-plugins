/**
 * WebM recording.
 *
 * Playwright records through a dedicated browser context created with
 * `recordVideo`; the target tab's current URL is reopened in that context so
 * the take starts from the same page but not from its in-memory state. The
 * bundled ffmpeg binary is required (`npx playwright-core install ffmpeg`).
 *
 * @module dsh-plugin-browser/recording
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { performAction } from './actions.js'
import { validateViewport } from './engine.js'
import { BrowserPolicyError, resolveUserPath, resolveArtifactPath } from './policy.js'

/** Clamp a requested duration into the supported range. */
function clampDuration(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(90_000, Math.max(500, Math.trunc(number)))
}

/** A filesystem-safe slug derived from the page URL. */
function urlSlug(url) {
  try {
    const parsed = new URL(url)
    const raw = `${parsed.hostname}${parsed.pathname}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return raw.slice(0, 50) || 'page'
  } catch {
    return 'page'
  }
}

/** Ensure a recording path carries a .webm extension. */
function webmPath(value) {
  return /\.webm$/i.test(value) ? value : `${value}.webm`
}

/**
 * Translate the documented recording DSL into the flat action shape
 * `performAction` accepts. The DSL names a selector while the action API names
 * a target descriptor; this is the only place that difference is bridged.
 */
function normalizeRecordingAction(item) {
  const type = item.type ?? item.action
  const action = { ...item, action: type }
  if (!action.target && item.selector) action.target = { by: 'css', selector: item.selector }
  if (type === 'move') action.action = 'cua_move'
  if (type === 'scrollTo') action.action = 'scrollTo'
  if (type === 'wheel') action.action = 'wheel'
  if (type === 'drag') {
    action.action = 'drag'
    if (item.from && !action.target) action.target = { by: 'css', selector: item.from }
    if (item.to && !action.toTarget) action.toTarget = { by: 'css', selector: item.to }
  }
  if (type === 'waitFor') {
    action.action = 'wait'
    if (item.selector) {
      action.waitFor = 'target'
      action.target = { by: 'css', selector: item.selector }
    } else {
      action.waitFor = 'timeout'
      action.durationMs = item.durationMs ?? item.timeoutMs ?? 1_000
    }
  }
  if (type === 'wait') {
    action.action = 'wait'
    if (action.waitFor === undefined) {
      action.waitFor = item.durationMs !== undefined ? 'timeout' : 'load'
    }
  }
  return action
}

/** Detect and rewrite the missing-ffmpeg failure into an actionable message. */
function explainRecordingError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/ffmpeg/i.test(message)) {
    return new BrowserPolicyError(
      'recording_unavailable',
      'Video recording requires Playwright ffmpeg. Run: node node_modules/playwright-core/cli.js install ffmpeg',
    )
  }
  return error
}

/**
 * Record a sequence of actions (or a fixed wait) into a WebM file.
 *
 * @param {object} session - SessionBrowser.
 * @param {object} tab - tab record.
 * @param {{ actions?: object[], durationMs?: number, width?: number, height?: number, outputPath?: string }} args
 * @param {object} config - resolved plugin config.
 * @param {object} manager - BrowserManager.
 * @returns {Promise<{ path: string, bytes: number, actions: number, durationMs: number }>}
 */
export async function record(session, tab, args, config, manager) {
  if (!config.recording.enabled) {
    throw new BrowserPolicyError('recording_unavailable', 'Recording is disabled by the browser plugin config')
  }
  const width = Number.isInteger(args.width) ? args.width : config.viewport.width
  const height = Number.isInteger(args.height) ? args.height : config.viewport.height
  validateViewport(width, height)

  const actions = Array.isArray(args.actions) ? args.actions : []
  const durationMs = clampDuration(args.durationMs, 7_000)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fallback = `${urlSlug(tab.page.url())}-${stamp}.webm`
  const destination = args.outputPath
    ? webmPath(resolveUserPath(session.cwd, args.outputPath, fallback))
    : resolveArtifactPath(session.cwd, join(config.outputDir, 'recordings'), fallback)
  await fs.mkdir(dirname(destination), { recursive: true })

  const tempDir = join(session.cwd, '.dsh-browser', 'recordings', `.tmp-${stamp}`)
  await fs.mkdir(tempDir, { recursive: true })

  const browser = await manager.ensureBrowser()
  const storageState = await session.context.storageState()
  let recordingContext
  try {
    recordingContext = await browser.newContext({
      recordVideo: { dir: tempDir, size: { width, height } },
      viewport: { width, height },
      storageState,
      acceptDownloads: false,
    })
    const page = await recordingContext.newPage()
    const targetUrl = tab.page.url()
    if (targetUrl && targetUrl !== 'about:blank') {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs })
    }
    const recordingTab = { id: 'recording', page, lifecycle: 'active' }

    for (const item of actions) {
      await performAction(recordingTab, normalizeRecordingAction(item), config)
    }
    if (actions.length === 0) await page.waitForTimeout(durationMs)

    const video = page.video()
    await page.close()
    await recordingContext.close()
    recordingContext = undefined
    const source = await video.path()
    await fs.copyFile(source, destination)
    const stat = await fs.stat(destination)
    return { path: destination, bytes: stat.size, actions: actions.length, durationMs }
  } catch (error) {
    throw explainRecordingError(error)
  } finally {
    await recordingContext?.close().catch(() => {})
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
