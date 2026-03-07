import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  advanceConnectorReconnectState,
  createConnectorReconnectState,
} from './manager'

test('advanceConnectorReconnectState applies exponential backoff and exhaustion', () => {
  const policy = {
    initialBackoffMs: 30_000,
    maxBackoffMs: 15 * 60 * 1000,
    maxAttempts: 3,
  }

  const initial = createConnectorReconnectState({}, policy)

  const first = advanceConnectorReconnectState(initial, 'boom-1', 1_000, policy)
  assert.equal(first.attempts, 1)
  assert.equal(first.backoffMs, 30_000)
  assert.equal(first.nextRetryAt, 31_000)
  assert.equal(first.exhausted, false)

  const second = advanceConnectorReconnectState(first, 'boom-2', 31_000, policy)
  assert.equal(second.attempts, 2)
  assert.equal(second.backoffMs, 60_000)
  assert.equal(second.nextRetryAt, 91_000)
  assert.equal(second.exhausted, false)

  const third = advanceConnectorReconnectState(second, 'boom-3', 91_000, policy)
  assert.equal(third.attempts, 3)
  assert.equal(third.backoffMs, 120_000)
  assert.equal(third.nextRetryAt, 211_000)
  assert.equal(third.exhausted, true)
})

test('createConnectorReconnectState respects custom initial backoff', () => {
  const state = createConnectorReconnectState(
    { error: 'seeded' },
    { initialBackoffMs: 45_000 },
  )

  assert.equal(state.attempts, 0)
  assert.equal(state.backoffMs, 45_000)
  assert.equal(state.nextRetryAt, 0)
  assert.equal(state.error, 'seeded')
  assert.equal(state.exhausted, false)
})
