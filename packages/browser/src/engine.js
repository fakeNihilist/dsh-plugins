/**
 * Browser and tab lifecycle.
 *
 * One Chromium process is launched lazily per plugin lifetime. Each DSH session
 * gets its own `BrowserContext` (cookie/storage isolation) and each tab is a
 * Playwright `Page`. Commands for one session are serialized because Playwright
 * page actions are not safe to interleave; different sessions may run in
 * parallel up to the engine's own limits.
 *
 * @module dsh-plugin-browser/engine
 */

import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'
import { browserLaunchCandidates, describeLaunchCandidate } from './chromium.js'
import { BrowserPolicyError, assertAllowedUrl, resolveArtifactPath, sanitizeFilename } from './policy.js'

/** Viewport limits shared with the ZCode browser contract. */
export const VIEWPORT_LIMITS = Object.freeze({
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
})

/** Optional engine trace, enabled with BROWSER_DEBUG=1. */
function debug(...args) {
  if (process.env.BROWSER_DEBUG === '1') process.stderr.write(`[browser-engine] ${args.join(' ')}\n`)
}

/** Wait for a page title without letting a busy page stall a listing. */
async function safeTitle(page) {  try {
    return await Promise.race([
      page.title(),
      new Promise((resolve) => setTimeout(() => resolve(''), 2_000)),
    ])
  } catch {
    return ''
  }
}

/** Validate one viewport pair against the shared limits. */
export function validateViewport(width, height) {
  if (
    !Number.isInteger(width) ||
    width < VIEWPORT_LIMITS.minWidth ||
    width > VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(height) ||
    height < VIEWPORT_LIMITS.minHeight ||
    height > VIEWPORT_LIMITS.maxHeight
  ) {
    throw new BrowserPolicyError(
      'invalid_viewport',
      `Viewport must be integer width ${VIEWPORT_LIMITS.minWidth}..${VIEWPORT_LIMITS.maxWidth} and height ${VIEWPORT_LIMITS.minHeight}..${VIEWPORT_LIMITS.maxHeight}`,
    )
  }
}

/** The same-site key used by `open()` to reuse an existing tab. */
function siteKey(value) {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** One session's browser context and tabs. */
export class SessionBrowser {  /** @param {{ manager: object, sessionId: string, context: object, cwd: string, config: object, log: object }} input */
  constructor(input) {
    this.manager = input.manager
    this.sessionId = input.sessionId
    this.context = input.context
    this.cwd = input.cwd
    this.config = input.config
    this.log = input.log
    this.tabs = new Map()
    this.activeTabId = undefined
    this.lastUsed = Date.now()
    this.queue = Promise.resolve()
    this.tabSeq = 0
    this.downloadSeq = 0
    this.downloads = new Map()
    this.closed = false
    this.adopted = new WeakSet()

    this.context.on('page', (page) => {
      const record = this.adopt(page)
      this.activeTabId = record.id
      this.touch()
    })
  }

  /** Mark activity so the idle sweep does not close a session in use. */
  touch() {
    this.lastUsed = Date.now()
  }

  /** Update the workspace root used for artifacts. */
  setCwd(cwd) {
    if (typeof cwd === 'string' && cwd) this.cwd = cwd
  }

  /** Register one Playwright page as a tab. Idempotent. */
  adopt(page) {
    if (this.adopted.has(page)) {
      return [...this.tabs.values()].find((record) => record.page === page)
    }
    this.adopted.add(page)
    this.tabSeq += 1
    const record = {
      id: `tab-${this.tabSeq}`,
      page,
      lifecycle: 'active',
      createdAt: Date.now(),
      dialog: undefined,
      consoleErrors: [],
      lastError: undefined,
    }
    this.tabs.set(record.id, record)
    this.activeTabId = record.id
    this.installListeners(record)
    return record
  }

  /** Attach page-level listeners exactly once. */
  installListeners(record) {
    const { page } = record
    page.setDefaultTimeout(this.config.actionTimeoutMs)
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)

    page.on('dialog', (dialog) => {
      record.dialog = dialog
      this.touch()
    })
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      try {
        record.consoleErrors.push(message.text().slice(0, 500))
        if (record.consoleErrors.length > 20) record.consoleErrors.shift()
      } catch {
        /* a message from a closed page is not useful */
      }
    })
    page.on('pageerror', (error) => {
      record.lastError = error instanceof Error ? error.message : String(error)
    })
    page.on('crash', () => {
      record.lastError = 'page crashed'
      record.crashed = true
    })
    page.on('download', (download) => {
      void this.trackDownload(record, download)
    })
    page.on('close', () => {
      if (record.dialog) {
        record.dialog = undefined
      }
      void record.cdpSession?.detach().catch(() => {})
      record.cdpSession = undefined
      this.tabs.delete(record.id)
      if (this.activeTabId === record.id) {
        this.activeTabId = [...this.tabs.keys()].at(-1)
      }
    })
  }

  /** Serialize one session's commands. */
  async run(fn) {
    const previous = this.queue
    let release
    this.queue = new Promise((resolve) => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** Resolve an explicit tab or the active/last tab. */
  resolveTab(tabId) {
    if (tabId) {
      const record = this.tabs.get(tabId)
      if (!record) throw new BrowserPolicyError('tab_not_found', `Browser tab '${tabId}' is not open`)
      return record
    }
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (active) return active
    const last = [...this.tabs.values()].at(-1)
    if (last) return last
    throw new BrowserPolicyError('tab_not_found', 'No browser tab is open; call browser_open first')
  }

  /** Snapshot one tab's identity for tool output. */
  async summary(record) {
    const { page } = record
    const viewport = page.viewportSize() ?? this.config.viewport
    return {
      tabId: record.id,
      url: page.url(),
      title: await safeTitle(page),
      active: record.id === this.activeTabId,
      lifecycle: record.lifecycle,
      viewport: { width: viewport.width, height: viewport.height },
    }
  }

  /**
   * Open a URL, reusing an existing controlled tab with the same hostname
   * unless the caller explicitly asked for a new tab.
   */
  async openTab({ url, newTab = false, reuseTab = true } = {}) {
    if (this.closed) throw new BrowserPolicyError('browser_unavailable', 'This browser session is closed')
    if (url && !newTab && reuseTab) {
      const key = siteKey(url)
      const reusable = key
        ? [...this.tabs.values()].find((record) => siteKey(record.page.url()) === key)
        : undefined
      if (reusable) {
        this.activeTabId = reusable.id
        await reusable.page.bringToFront().catch(() => {})
        await reusable.page.goto(url, { waitUntil: 'domcontentloaded' })
        try {
          await assertAllowedUrl(reusable.page.url(), this.config)
        } catch (error) {
          await reusable.page.goto('about:blank').catch(() => {})
          throw error
        }
        this.touch()
        return this.summary(reusable)
      }
    }

    const page = await this.context.newPage()
    const record = this.adopt(page)
    this.activeTabId = record.id
    if (url) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await assertAllowedUrl(page.url(), this.config)
      } catch (error) {
        // Leave a half-open tab only when it has real content; otherwise close
        // it so a failed open does not pollute the registry.
        if (page.url() === 'about:blank') await page.close().catch(() => {})
        throw error
      }
    }
    this.touch()
    return this.summary(record)
  }

  /** List every controlled tab. */
  async listTabs() {
    return await Promise.all([...this.tabs.values()].map((record) => this.summary(record)))
  }

  /** Activate one tab. */
  async selectTab(tabId) {
    const record = this.resolveTab(tabId)
    this.activeTabId = record.id
    await record.page.bringToFront().catch(() => {})
    this.touch()
    return this.summary(record)
  }

  /** Close one tab. */
  async closeTab(tabId) {
    const record = this.resolveTab(tabId)
    await record.cdpSession?.detach().catch(() => {})
    record.cdpSession = undefined
    await record.page.close({ runBeforeUnload: false }).catch(() => {})
    this.tabs.delete(record.id)
    if (this.activeTabId === record.id) this.activeTabId = [...this.tabs.keys()].at(-1)
    this.touch()
    return { closed: record.id, remaining: [...this.tabs.keys()] }
  }

  /** Mark tabs as handoff/deliverable; unlisted tabs keep their lifecycle. */
  async finalize(keep = []) {
    for (const entry of keep) {
      const record = this.tabs.get(entry.tabId)
      if (record) record.lifecycle = entry.status
    }
    this.touch()
    return await this.listTabs()
  }

  /** Resize one tab's viewport. */
  async setViewport(tabId, width, height) {
    validateViewport(width, height)
    const record = this.resolveTab(tabId)
    await record.page.setViewportSize({ width, height })
    this.touch()
    return await this.summary(record)
  }

  /** Read the pending JavaScript dialog, if any. */
  getDialog(tabId) {
    return this.resolveTab(tabId).dialog
  }

  /** Forget a handled dialog. */
  clearDialog(tabId) {
    const record = this.tabs.get(tabId)
    if (record) record.dialog = undefined
  }

  /** Save one download to the artifact directory and enforce a size cap. */
  async trackDownload(record, download) {
    this.downloadSeq += 1
    const id = `dl-${this.downloadSeq}`
    const filename = sanitizeFilename(download.suggestedFilename(), 'download')
    const destination = resolveArtifactPath(this.cwd, join(this.config.outputDir, 'downloads'), `${id}-${filename}`)
    const entry = {
      id,
      tabId: record.id,
      filename,
      path: destination,
      state: 'saving',
      bytes: 0,
      error: undefined,
      promise: undefined,
    }
    this.downloads.set(id, entry)
    entry.promise = (async () => {
      try {
        await fs.mkdir(dirname(destination), { recursive: true })
        await download.saveAs(destination)
        const failure = await download.failure().catch(() => undefined)
        if (failure) throw new Error(failure)
        const stat = await fs.stat(destination)
        if (stat.size > this.config.maxDownloadBytes) {
          await fs.rm(destination, { force: true })
          throw new Error(`download exceeds ${this.config.maxDownloadBytes} bytes`)
        }
        entry.bytes = stat.size
        entry.state = 'saved'
      } catch (error) {
        entry.state = 'failed'
        entry.error = error instanceof Error ? error.message : String(error)
        this.log?.warn?.('browser download failed', { id, error: entry.error })
      }
    })()
    this.touch()
  }

  /** List downloads and wait for in-flight saves. */
  async listDownloads(tabId) {
    const entries = [...this.downloads.values()].filter((entry) => !tabId || entry.tabId === tabId)
    await Promise.all(entries.map((entry) => entry.promise))
    return entries.map(({ promise: _promise, ...entry }) => ({ ...entry }))
  }

  /** Copy one saved download to a workspace path. */
  async saveDownload(downloadId, targetPath) {
    const entry = this.downloads.get(downloadId)
    if (!entry) throw new BrowserPolicyError('download_not_found', `Download '${downloadId}' is unknown`)
    await entry.promise
    if (entry.state !== 'saved') {
      throw new BrowserPolicyError('download_failed', entry.error ?? 'download did not complete')
    }
    await fs.mkdir(dirname(targetPath), { recursive: true })
    await fs.copyFile(entry.path, targetPath)
    return { path: targetPath, bytes: entry.bytes }
  }

  /** Persist cookies when configured, then close the context. */
  async dispose() {
    if (this.closed) return
    this.closed = true
    for (const record of this.tabs.values()) {
      await record.cdpSession?.detach().catch(() => {})
      record.cdpSession = undefined
    }
    if (this.config.persistCookies) {
      try {
        const statePath = join(this.cwd, '.dsh-browser', 'state', 'cookies.json')
        await fs.mkdir(dirname(statePath), { recursive: true })
        await this.context.storageState({ path: statePath })
      } catch (error) {
        this.log?.warn?.('browser cookie persistence failed', { error: String(error) })
      }
    }
    await this.context.close().catch((error) => {
      this.log?.warn?.('browser context close failed', { error: String(error) })
    })
    this.tabs.clear()
    this.downloads.clear()
  }
}

/** Plugin-lifetime Chromium process and per-session contexts. */
export class BrowserManager {
  /** @param {object} config - resolved plugin config. @param {object} log - logger. */
  constructor(config, log) {
    this.config = config
    this.log = log
    this.browser = undefined
    this.launchPromise = undefined
    this.sessions = new Map()
    this.disposed = false
    this.headed = config.headed === true
    this.lastBrowserUse = Date.now()
    this.sweep = setInterval(() => {
      void this.runSweep()
    }, 60_000)
    this.sweep.unref?.()
  }

  /** Launch (or reuse) the shared Chromium process. */
  async ensureBrowser() {
    if (this.disposed) throw new BrowserPolicyError('browser_unavailable', 'Browser plugin is disposed')
    if (this.browser?.isConnected()) return this.browser
    if (this.launchPromise) return await this.launchPromise

    this.launchPromise = (async () => {
      const candidates = browserLaunchCandidates(this.config)
      const failures = []
      for (const candidate of candidates) {
        try {
          const browser = await chromium.launch({
            ...candidate,
            headless: !this.headed,
            timeout: 30_000,
            args: [
              '--no-first-run',
              '--no-default-browser-check',
              ...(this.config.launchArgs ?? []),
            ],
          })
          browser.on('disconnected', () => {
            if (this.browser === browser) this.browser = undefined
          })
          this.browser = browser
          this.lastBrowserUse = Date.now()
          debug('launched', browser.version(), describeLaunchCandidate(candidate))
          this.log?.info?.('browser launched', {
            candidate: describeLaunchCandidate(candidate),
            version: browser.version(),
          })
          return browser
        } catch (error) {
          const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
          failures.push(`${describeLaunchCandidate(candidate)}: ${message}`)
          this.log?.warn?.('browser launch candidate failed', {
            candidate: describeLaunchCandidate(candidate),
            error: message,
          })
        }
      }
      throw new BrowserPolicyError(
        'browser_unavailable',
        `No Chromium browser could be launched. Tried:\n${failures.join('\n')}\nSet browserPath or channel in the plugin config.`,
      )
    })().finally(() => {
      this.launchPromise = undefined
    })

    return await this.launchPromise
  }

  /** Get or create one session's isolated context. */
  async getSession(sessionId, cwd) {
    if (this.disposed) throw new BrowserPolicyError('browser_unavailable', 'Browser plugin is disposed')
    this.lastBrowserUse = Date.now()
    const id = String(sessionId)
    let session = this.sessions.get(id)
    if (session) {
      session.setCwd(cwd)
      session.touch()
      return session
    }

    const browser = await this.ensureBrowser()
    const storagePath = join(cwd, '.dsh-browser', 'state', 'cookies.json')
    const storageState = this.config.persistCookies && existsSync(storagePath) ? storagePath : undefined
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: this.config.viewport,
      ...(storageState ? { storageState } : {}),
    })
    session = new SessionBrowser({
      manager: this,
      sessionId: id,
      context,
      cwd,
      config: this.config,
      log: this.log,
    })
    this.sessions.set(id, session)
    return session
  }

  /** Close one session's context. */
  async closeSession(sessionId) {
    const id = String(sessionId)
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.dispose()
  }

  /** Close every session context while keeping the manager alive. */
  async closeAllSessions() {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(sessions.map((session) => session.dispose()))
  }

  /**
   * Show or hide a headed Chrome window.
   *
   * Headless and headed are different launch modes, so this restarts the
   * browser. Recent tab URLs are reopened; form state, scroll position, and
   * history are not preserved. Cookies survive only when persistCookies is on.
   */
  async setHeaded(visible) {
    if (this.disposed) throw new BrowserPolicyError('browser_unavailable', 'Browser plugin is disposed')
    const target = visible === true
    if (this.headed === target) return { visible: target, changed: false, restored: 0 }

    const snapshots = [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      urls: [...session.tabs.values()]
        .map((record) => record.page.url())
        .filter((url) => url && url !== 'about:blank')
        .slice(0, 4),
    }))

    await this.closeAllSessions()
    const previous = this.browser
    this.browser = undefined
    await previous?.close().catch(() => {})
    this.headed = target

    try {
      await this.ensureBrowser()
    } catch (error) {
      this.headed = !target
      await this.ensureBrowser().catch(() => {})
      throw error
    }

    let restored = 0
    for (const snapshot of snapshots) {
      try {
        const session = await this.getSession(snapshot.sessionId, snapshot.cwd)
        for (const url of snapshot.urls) {
          try {
            await session.openTab({ url, newTab: true })
            restored += 1
          } catch (error) {
            this.log?.warn?.('browser view tab restore failed', { url, error: String(error) })
          }
        }
      } catch (error) {
        this.log?.warn?.('browser view session restore failed', { error: String(error) })
      }
    }
    return { visible: target, changed: true, restored }
  }

  /** Idle sweep: close sessions, then an unused browser process. */
  async runSweep() {
    if (this.disposed) return
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > this.config.idleCloseMs) {
        this.sessions.delete(id)
        await session.dispose()
        this.log?.info?.('browser session closed after idle', { sessionId: id })
      }
    }
    if (this.sessions.size === 0 && this.browser && now - this.lastBrowserUse > this.config.browserIdleCloseMs) {
      const browser = this.browser
      this.browser = undefined
      await browser.close().catch(() => {})
      this.log?.info?.('browser process closed after idle')
    }
  }

  /** Close every context and the browser process. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    debug('dispose start', 'hasBrowser=' + String(Boolean(this.browser)), 'connected=' + String(this.browser?.isConnected?.() ?? false))
    clearInterval(this.sweep)
    await this.closeAllSessions()
    const browser = this.browser
    this.browser = undefined
    if (browser) {
      debug('closing browser')
      let timer
      try {
        await Promise.race([
          browser.close().catch((error) => debug('browser close failed', String(error))),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 10_000)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      debug('browser close settled', 'connected=' + String(browser.isConnected?.() ?? false))
    }
  }
}
