import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSetupDone } from './setup-done-detection'

test('resolveSetupDone returns true when both fetches failed', () => {
  assert.equal(resolveSetupDone({}, {}, true), true)
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
