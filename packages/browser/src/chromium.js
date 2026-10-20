/**
 * Browser executable discovery and launch candidates.
 *
 * The plugin deliberately uses an installed Chrome/Edge/Chromium rather than
 * downloading a second browser. A configured path/channel always wins; the
 * fallback order prefers Chrome, then Edge, then any Chromium.
 *
 * @module dsh-plugin-browser/chromium
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Whether an environment variable names an existing executable. */
function envPath(name) {
  const value = process.env[name]?.trim()
  return value && existsSync(value) ? value : undefined
}

/** Standard install locations for the current platform. */
function standardPaths() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    const programFiles = process.env.PROGRAMFILES
    const programFilesX86 = process.env['PROGRAMFILES(X86)']
    return [
      local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFiles && join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFilesX86 && join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFilesX86 && join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      programFiles && join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      local && join(local, 'Chromium', 'Application', 'chrome.exe'),
    ].filter(Boolean)
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
}

/** Find the first installed browser executable, if any. */
export function findInstalledBrowser() {
  for (const name of ['DSH_BROWSER_PATH', 'CHROME_PATH', 'EDGE_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']) {
    const found = envPath(name)
    if (found) return found
  }
  for (const candidate of standardPaths()) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Ordered launch candidates. Playwright accepts either `executablePath` or a
 * `channel`; trying both covers machines where a channel lookup fails but the
 * executable is present (and the reverse).
 */
export function browserLaunchCandidates(config = {}) {
  const candidates = []
  if (config.browserPath) candidates.push({ executablePath: String(config.browserPath) })
  else if (config.channel) candidates.push({ channel: String(config.channel) })
  else {
    const installed = findInstalledBrowser()
    if (installed) candidates.push({ executablePath: installed })
    candidates.push({ channel: 'chrome' })
    candidates.push({ channel: 'msedge' })
    candidates.push({ channel: 'chromium' })
  }

  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = candidate.executablePath ? `path:${candidate.executablePath}` : `channel:${candidate.channel}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** One-line description used in launch-failure diagnostics. */
export function describeLaunchCandidate(candidate) {
  return candidate.executablePath ? candidate.executablePath : `channel:${candidate.channel}`
}
