import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSetupDone } from './setup-done-detection'

test('resolveSetupDone returns false when both fetches failed so the wizard is shown', () => {
  // When both API calls fail we cannot determine setup state — default to
  // showing the wizard so the user doesn't land in a broken app.
  assert.equal(resolveSetupDone({}, {}, true), false)
})

test('resolveSetupDone returns true when setupCompleted is true', () => {
  assert.equal(resolveSetupDone({ setupCompleted: true }, {}, false), true)
})

test('resolveSetupDone returns true when credentials exist', () => {
  assert.equal(resolveSetupDone({}, { 'cred-1': { id: '1' } }, false), true)
})

test('resolveSetupDone returns false when no creds and not completed', () => {
  assert.equal(resolveSetupDone({}, {}, false), false)
})

test('resolveSetupDone returns false when setupCompleted is undefined and creds empty', () => {
  assert.equal(resolveSetupDone({ setupCompleted: undefined }, {}, false), false)
})

test('resolveSetupDone returns true when both creds and setupCompleted present', () => {
  assert.equal(resolveSetupDone({ setupCompleted: true }, { key: {} }, false), true)
})
