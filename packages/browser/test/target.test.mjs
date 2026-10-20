import test from 'node:test'
import assert from 'node:assert/strict'
import { inferTargetBy, targetLabel } from '../src/target.js'

test('target family is inferred from its populated field', () => {
  assert.equal(inferTargetBy({ role: 'button', name: 'Go' }), 'role')
  assert.equal(inferTargetBy({ text: 'Next' }), 'text')
  assert.equal(inferTargetBy({ label: 'Email' }), 'label')
  assert.equal(inferTargetBy({ placeholder: 'Search' }), 'placeholder')
  assert.equal(inferTargetBy({ testId: 'submit' }), 'testId')
  assert.equal(inferTargetBy({ selector: '#main' }), 'css')
  assert.equal(inferTargetBy({ by: 'css', selector: '#main' }), 'css')
  assert.equal(inferTargetBy({}), undefined)
})

test('target labels are readable in errors', () => {
  assert.equal(targetLabel({ by: 'role', role: 'button', name: 'Go' }), 'role=button name="Go"')
  assert.equal(targetLabel({ by: 'text', text: 'Next' }), 'text="Next"')
  assert.equal(targetLabel({ by: 'css', selector: '#main' }), 'css="#main"')
  assert.equal(targetLabel(undefined), '(page)')
})
