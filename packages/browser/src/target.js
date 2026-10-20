/**
 * Locator construction from the flat target descriptor the tools accept.
 *
 * The descriptor mirrors Playwright's public locator vocabulary but is a plain
 * JSON object so a model can produce it without writing code:
 *
 *   { by: 'role', role: 'button', name: 'Submit' }
 *   { by: 'text', text: 'Sign in' }
 *   { by: 'testId', testId: 'submit' }
 *   { by: 'css', selector: '#main .card', first: true }
 *
 * @module dsh-plugin-browser/target
 */

import { BrowserPolicyError } from './policy.js'

/** Infer the locator family when `by` is omitted. */
export function inferTargetBy(target) {
  if (!target || typeof target !== 'object') return undefined
  if (target.by) return target.by
  if (target.role) return 'role'
  if (target.text) return 'text'
  if (target.label) return 'label'
  if (target.placeholder) return 'placeholder'
  if (target.testId) return 'testId'
  if (target.selector) return 'css'
  return undefined
}

/** A compact human-readable target description for errors and logs. */
export function targetLabel(target) {
  if (!target) return '(page)'
  const by = inferTargetBy(target)
  if (!by) return '(unresolved target)'
  switch (by) {
    case 'role':
      return `role=${target.role}${target.name ? ` name=${JSON.stringify(target.name)}` : ''}`
    case 'text':
      return `text=${JSON.stringify(target.text)}`
    case 'label':
      return `label=${JSON.stringify(target.label)}`
    case 'placeholder':
      return `placeholder=${JSON.stringify(target.placeholder)}`
    case 'testId':
      return `testId=${JSON.stringify(target.testId)}`
    case 'css':
      return `css=${JSON.stringify(target.selector)}`
    default:
      return String(by)
  }
}

/** Build a locator for one target, optionally scoped into an iframe. */
export function buildLocator(root, target) {
  if (!target || typeof target !== 'object') {
    throw new BrowserPolicyError('invalid_target', 'A target descriptor is required for this action')
  }

  let scope = root
  if (target.frame) scope = scope.frameLocator(String(target.frame))

  const by = inferTargetBy(target)
  const exact = target.exact === true ? { exact: true } : {}
  let locator

  switch (by) {
    case 'role': {
      if (!target.role) throw new BrowserPolicyError('invalid_target', 'role target requires role')
      const options = {}
      if (target.name !== undefined) options.name = String(target.name)
      if (target.exact !== undefined) options.exact = target.exact === true
      locator = scope.getByRole(String(target.role), options)
      break
    }
    case 'text':
      if (target.text === undefined) throw new BrowserPolicyError('invalid_target', 'text target requires text')
      locator = scope.getByText(String(target.text), exact)
      break
    case 'label':
      if (target.label === undefined) throw new BrowserPolicyError('invalid_target', 'label target requires label')
      locator = scope.getByLabel(String(target.label), exact)
      break
    case 'placeholder':
      if (target.placeholder === undefined) {
        throw new BrowserPolicyError('invalid_target', 'placeholder target requires placeholder')
      }
      locator = scope.getByPlaceholder(String(target.placeholder), exact)
      break
    case 'testId':
      if (target.testId === undefined) throw new BrowserPolicyError('invalid_target', 'testId target requires testId')
      locator = scope.getByTestId(String(target.testId))
      break
    case 'css':
      if (target.selector === undefined) throw new BrowserPolicyError('invalid_target', 'css target requires selector')
      locator = scope.locator(String(target.selector))
      break
    default:
      throw new BrowserPolicyError(
        'invalid_target',
        'Target needs one of role/text/label/placeholder/testId/selector (or an explicit by)',
      )
  }

  if (target.nth !== undefined) {
    if (!Number.isInteger(target.nth) || target.nth < 0) {
      throw new BrowserPolicyError('invalid_target', 'nth must be a non-negative integer')
    }
    locator = locator.nth(target.nth)
  } else if (target.first === true) {
    locator = locator.first()
  } else if (target.last === true) {
    locator = locator.last()
  }

  return locator
}
