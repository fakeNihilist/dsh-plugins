/**
 * Action execution.
 *
 * Every action receives one tab and one flat argument object. Locator actions
 * use Playwright's auto-waiting and strict mode; coordinate actions use the
 * real mouse/keyboard so canvas and custom-drawn controls still work.
 *
 * @module dsh-plugin-browser/actions
 */

import { BrowserPolicyError, assertAllowedUrl } from './policy.js'
import { buildLocator, targetLabel } from './target.js'

/** Normalize modifier names to Playwright's vocabulary. */
export function normalizeModifiers(input) {
  if (input === undefined || input === null) return undefined
  const values = Array.isArray(input) ? input : [input]
  const map = {
    ctrl: 'Control',
    control: 'Control',
    shift: 'Shift',
    alt: 'Alt',
    option: 'Alt',
    meta: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
    win: 'Meta',
  }
  const result = []
  for (const value of values) {
    const normalized = map[String(value).toLowerCase()]
    if (!normalized) throw new BrowserPolicyError('invalid_action', `Unsupported modifier: ${value}`)
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result.length > 0 ? result : undefined
}

/** CDP modifier bitmask: Alt=1, Control=2, Meta=4, Shift=8. */
function modifierBits(modifiers) {
  let bits = 0
  for (const modifier of modifiers ?? []) {
    if (modifier === 'Alt') bits |= 1
    else if (modifier === 'Control') bits |= 2
    else if (modifier === 'Meta') bits |= 4
    else if (modifier === 'Shift') bits |= 8
  }
  return bits
}

/** Optional action trace, enabled with BROWSER_DEBUG=1. */
function debug(...args) {
  if (process.env.BROWSER_DEBUG === '1') process.stderr.write(`[browser-action] ${args.join(' ')}\n`)
}

/**
 * Click through CDP input rather than `locator.click`.
 *
 * A page handler that opens `alert()`/`confirm()`/`prompt()` suspends the
 * renderer, and Playwright's locator click waits for that dialog to be handled.
 * CDP input returns after dispatch, so the dialog is recorded by the tab
 * listener and the model can handle it in a later call — the same shape as the
 * ZCode browser's getJsDialog/handleDialog flow.
 */
async function clickThroughCdp(tab, locator, options) {
  const { button = 'left', modifiers, doubleClick = false, timeout } = options
  debug('scroll start')
  await locator.scrollIntoViewIfNeeded({ timeout })
  debug('scroll done')
  const box = await locator.boundingBox({ timeout })
  debug('box', JSON.stringify(box))
  if (!box) throw new BrowserPolicyError('target_not_found', 'Target has no visible bounding box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const bits = modifierBits(modifiers)

  let cdp = tab.cdpSession
  if (!cdp) {
    debug('cdp session start')
    cdp = await tab.page.context().newCDPSession(tab.page)
    tab.cdpSession = cdp
    debug('cdp session done')
  }

  /**
   * Dispatch one input event and tolerate the one case where its response is
   * suspended: the event opened a JavaScript dialog. The dialog event is
   * already recorded on the tab, so the click is complete for our purposes.
   */
  const dispatch = async (type, clickCount) => {
    debug('dispatch', type, clickCount)
    const command = cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      clickCount,
      modifiers: bits,
    })
    command.catch(() => {})
    const outcome = await Promise.race([
      command.then(() => 'ok', () => 'error'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 750)),
    ])
    if (outcome === 'ok') {
      debug('dispatch done', type)
      return 'ok'
    }
    if (outcome === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (tab.dialog) {
        debug('dispatch opened a dialog', type)
        return 'dialog'
      }
      throw new BrowserPolicyError('timeout', `Browser input ${type} did not complete`)
    }
    throw new BrowserPolicyError('action_failed', `Browser input ${type} failed`)
  }

  await dispatch('mouseMoved', 0)
  const sequence = async (count) => {
    if (await dispatch('mousePressed', count) === 'dialog') return 'dialog'
    return await dispatch('mouseReleased', count)
  }
  if (doubleClick) {
    if (await sequence(1) === 'dialog') return
    await sequence(2)
  } else {
    await sequence(1)
  }
  debug('click complete')
}

/** Normalize a mouse button name. */
export function normalizeButton(input) {
  if (input === undefined || input === null) return 'left'
  const value = String(input).toLowerCase()
  if (['left', 'right', 'middle'].includes(value)) return value
  if (['1', 'left'].includes(value)) return 'left'
  if (['2', 'middle'].includes(value)) return 'middle'
  if (['3', 'right'].includes(value)) return 'right'
  throw new BrowserPolicyError('invalid_action', `Unsupported mouse button: ${input}`)
}

/** Require a finite coordinate. */
function coordinate(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new BrowserPolicyError('invalid_action', `${name} must be a number`)
  return number
}

/** Parse a select option; a JSON object is accepted for label/value/index. */
function selectOption(input) {
  const text = String(input ?? '')
  if (text.trim().startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/** Read a title without letting a busy page stall the result. */
async function safeTitle(page) {
  try {
    return await Promise.race([
      page.title(),
      new Promise((resolve) => setTimeout(() => resolve(''), 2_000)),
    ])
  } catch {
    return ''
  }
}

/**
 * A click, key, or form submit may navigate somewhere the initial URL policy
 * never saw (including through a redirect). Re-check the settled URL and blank
 * the tab when it is refused.
 */
async function enforceFinalUrl(page, beforeUrl, config) {
  const finalUrl = page.url()
  if (finalUrl === beforeUrl || finalUrl === 'about:blank') return
  try {
    await assertAllowedUrl(finalUrl, config)
  } catch (error) {
    await page.goto('about:blank').catch(() => {})
    throw error
  }
}

/** Build the locator for an action, or throw a clear target error. */
function requireLocator(page, target, action) {
  if (!target) throw new BrowserPolicyError('invalid_target', `${action} requires a target descriptor`)
  return buildLocator(page, target)
}

/** Run one page action. */
export async function performAction(tab, args, config) {
  const page = tab.page
  const beforeUrl = page.url()
  const action = String(args.action ?? '')
  const timeout = Number.isFinite(args.timeoutMs) ? args.timeoutMs : config.actionTimeoutMs
  const button = normalizeButton(args.button)
  const modifiers = normalizeModifiers(args.modifiers)
  // Opt-in navigation settlement: set up the waiter before the action so a
  // fast navigation cannot slip between dispatch and the observation.
  const navigation = args.waitForNavigation === true
    ? page.waitForURL((url) => url.href !== beforeUrl, { timeout }).catch(() => {})
    : undefined

  if (tab.dialog) {
    throw new BrowserPolicyError(
      'dialog_pending',
      'A JavaScript dialog is blocking this tab; call browser_dialog with accept or dismiss first',
    )
  }

  switch (action) {
    case 'click':
    case 'dblclick': {
      const locator = requireLocator(page, args.target, action)
      await clickThroughCdp(tab, locator, {
        button,
        modifiers,
        doubleClick: action === 'dblclick',
        timeout,
      })
      break
    }
    case 'fill': {
      const locator = requireLocator(page, args.target, action)
      await locator.fill(String(args.text ?? ''), { timeout })
      break
    }
    case 'type': {
      const locator = requireLocator(page, args.target, action)
      await locator.focus({ timeout })
      await locator.pressSequentially(String(args.text ?? ''), {
        delay: Number.isFinite(args.delay) ? Math.max(0, args.delay) : 0,
        timeout,
      })
      if (args.submit === true) await locator.press('Enter', { timeout })
      break
    }
    case 'press': {
      const key = String(args.key ?? '')
      if (!key) throw new BrowserPolicyError('invalid_action', 'press requires key')
      if (args.target) {
        const locator = requireLocator(page, args.target, action)
        await locator.press(key, { timeout })
      } else {
        await page.keyboard.press(key)
      }
      break
    }
    case 'check':
    case 'uncheck': {
      const locator = requireLocator(page, args.target, action)
      await locator[action]({ timeout })
      break
    }
    case 'select': {
      const locator = requireLocator(page, args.target, action)
      await locator.selectOption(selectOption(args.option), { timeout })
      break
    }
    case 'hover': {
      const locator = requireLocator(page, args.target, action)
      await locator.hover({ timeout })
      break
    }
    case 'focus': {
      const locator = requireLocator(page, args.target, action)
      await locator.focus({ timeout })
      break
    }
    case 'scroll':
    case 'wheel': {
      if (action === 'scroll' && args.target) {
        const locator = requireLocator(page, args.target, action)
        await locator.scrollIntoViewIfNeeded({ timeout })
      } else {
        const deltaX = Number.isFinite(args.deltaX) ? args.deltaX : 0
        const deltaY = Number.isFinite(args.deltaY) ? args.deltaY : 0
        await page.mouse.wheel(deltaX, deltaY)
      }
      break
    }
    case 'scrollTo': {
      const x = Number.isFinite(args.x) ? args.x : 0
      const y = Number.isFinite(args.y) ? args.y : 0
      await page.evaluate(({ left, top }) => window.scrollTo(left, top), { left: x, top: y })
      break
    }
    case 'drag': {
      if (args.target && args.toTarget) {
        const from = buildLocator(page, args.target)
        const to = buildLocator(page, args.toTarget)
        await from.dragTo(to, { timeout })
      } else if (Array.isArray(args.path) && args.path.length >= 2) {
        const [first, ...rest] = args.path
        await page.mouse.move(coordinate(first.x, 'path.x'), coordinate(first.y, 'path.y'))
        await page.mouse.down({ button })
        for (const point of rest) {
          await page.mouse.move(coordinate(point.x, 'path.x'), coordinate(point.y, 'path.y'), { steps: 5 })
        }
        await page.mouse.up({ button })
      } else {
        throw new BrowserPolicyError('invalid_action', 'drag requires target + toTarget, or a path array')
      }
      break
    }
    case 'evaluate': {
      if (!config.allowEvaluate) {
        throw new BrowserPolicyError('policy_denied', 'evaluate is disabled by the browser plugin config')
      }
      const expression = String(args.expression ?? '')
      if (!expression) throw new BrowserPolicyError('invalid_action', 'evaluate requires expression')
      const value = (await page.evaluate(expression)) ?? null
      if (navigation) await navigation
      await enforceFinalUrl(page, beforeUrl, config)
      return { action, value, url: page.url(), title: await safeTitle(page) }
    }
    case 'cua_click':
    case 'cua_dblclick': {
      const x = coordinate(args.x, 'x')
      const y = coordinate(args.y, 'y')
      if (action === 'cua_click') await page.mouse.click(x, y, { button })
      else await page.mouse.dblclick(x, y, { button })
      break
    }
    case 'cua_move': {
      const x = coordinate(args.x, 'x')
      const y = coordinate(args.y, 'y')
      await page.mouse.move(x, y, { steps: Number.isFinite(args.steps) ? Math.max(1, args.steps) : 1 })
      break
    }
    case 'cua_scroll': {
      const x = coordinate(args.x, 'x')
      const y = coordinate(args.y, 'y')
      await page.mouse.move(x, y)
      await page.mouse.wheel(Number.isFinite(args.deltaX) ? args.deltaX : 0, Number.isFinite(args.deltaY) ? args.deltaY : 0)
      break
    }
    case 'cua_drag': {
      if (!Array.isArray(args.path) || args.path.length < 2) {
        throw new BrowserPolicyError('invalid_action', 'cua_drag requires a path with at least two points')
      }
      const [first, ...rest] = args.path
      await page.mouse.move(coordinate(first.x, 'path.x'), coordinate(first.y, 'path.y'))
      await page.mouse.down({ button })
      for (const point of rest) {
        await page.mouse.move(coordinate(point.x, 'path.x'), coordinate(point.y, 'path.y'), { steps: 5 })
      }
      await page.mouse.up({ button })
      break
    }
    case 'cua_keypress': {
      const keys = Array.isArray(args.keys) ? args.keys : String(args.key ?? '').split('+')
      const combination = keys.map((key) => String(key).trim()).filter(Boolean).join('+')
      if (!combination) throw new BrowserPolicyError('invalid_action', 'cua_keypress requires keys')
      await page.keyboard.press(combination)
      break
    }
    case 'cua_type': {
      await page.keyboard.type(String(args.text ?? ''), {
        delay: Number.isFinite(args.delay) ? Math.max(0, args.delay) : 0,
      })
      break
    }
    case 'wait': {
      const mode = String(args.waitFor ?? (args.durationMs !== undefined ? 'timeout' : 'load'))
      if (mode === 'timeout') {
        await page.waitForTimeout(Number.isFinite(args.durationMs) ? Math.max(0, args.durationMs) : 1000)
      } else if (mode === 'url') {
        await page.waitForURL(String(args.url ?? ''), { timeout })
      } else if (mode === 'target') {
        const locator = requireLocator(page, args.target, 'wait')
        await locator.waitFor({ state: 'visible', timeout })
      } else {
        await page.waitForLoadState(mode === 'load' ? 'load' : 'domcontentloaded', { timeout })
      }
      break
    }
    default:
      throw new BrowserPolicyError(
        'invalid_action',
        `Unknown action '${action}'. Supported: click, dblclick, fill, type, press, check, uncheck, select, hover, focus, scroll, scrollTo, wheel, drag, evaluate, cua_click, cua_dblclick, cua_move, cua_scroll, cua_drag, cua_keypress, cua_type, wait`,
      )
  }

  if (navigation) await navigation
  await enforceFinalUrl(page, beforeUrl, config)
  return {
    action,
    ...(args.target ? { target: targetLabel(args.target) } : {}),
    url: page.url(),
    title: await safeTitle(page),
  }
}
