/**
 * Screenshot capture for pages and elements.
 *
 * @module dsh-plugin-browser/capture
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrowserPolicyError, resolveArtifactPath, resolveUserPath, sanitizeFilename } from './policy.js'
import { buildLocator } from './target.js'

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

/** Ensure a screenshot path carries a .png extension. */
function pngPath(value) {
  return /\.png$/i.test(value) ? value : `${value}.png`
}

/**
 * Capture a full page, the viewport, or one element.
 *
 * @param {object} session - SessionBrowser.
 * @param {object} tab - tab record.
 * @param {{ kind?: 'page'|'element', target?: object, fullPage?: boolean, path?: string, timeoutMs?: number }} args
 * @param {object} config - resolved plugin config.
 * @returns {Promise<{ path: string, bytes: number, kind: string, url: string }>}
 */
export async function capture(session, tab, args, config) {
  if (tab.dialog) {
    throw new BrowserPolicyError(
      'dialog_pending',
      'A JavaScript dialog is blocking this tab; call browser_dialog with accept or dismiss first',
    )
  }
  const page = tab.page
  const kind = args.kind ?? 'page'
  const timeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : config.actionTimeoutMs
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fallback = `${urlSlug(page.url())}-${kind}-${stamp}.png`
  const destination = args.path
    ? pngPath(resolveUserPath(session.cwd, args.path, fallback))
    : resolveArtifactPath(session.cwd, join(config.outputDir, 'shots'), fallback)
  await fs.mkdir(dirname(destination), { recursive: true })

  if (kind === 'element') {
    if (!args.target) throw new BrowserPolicyError('invalid_target', 'element screenshot requires a target')
    const locator = buildLocator(page, args.target)
    await locator.scrollIntoViewIfNeeded({ timeout })
    await locator.screenshot({ path: destination, timeout, animations: 'disabled' })
  } else if (kind === 'page') {
    await page.screenshot({
      path: destination,
      fullPage: args.fullPage === true,
      timeout,
      animations: 'disabled',
    })
  } else {
    throw new BrowserPolicyError('invalid_action', `Unknown capture kind '${kind}'`)
  }

  const stat = await fs.stat(destination)
  return { path: destination, bytes: stat.size, kind, url: page.url() }
}
