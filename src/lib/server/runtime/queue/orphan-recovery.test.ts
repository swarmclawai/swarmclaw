import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_ORPHAN_RECOVERY_ATTEMPTS,
  pruneOrphanRecovery,
  trackOrphanRecovery,
} from './orphan-recovery'

test('allows recovery for the first attempts and flags only the first one', () => {
  const attempts: Record<string, number> = {}

  const first = trackOrphanRecovery(attempts, 'task-1')
  assert.deepEqual(first, { action: 'recover', attempt: 1, firstAttempt: true })

  const second = trackOrphanRecovery(attempts, 'task-1')
  assert.deepEqual(second, { action: 'recover', attempt: 2, firstAttempt: false })

  const third = trackOrphanRecovery(attempts, 'task-1')
  assert.deepEqual(third, { action: 'recover', attempt: 3, firstAttempt: false })
})

test('dead-letters once the attempt cap is exceeded', () => {
  const attempts: Record<string, number> = { 'task-1': MAX_ORPHAN_RECOVERY_ATTEMPTS }

  const decision = trackOrphanRecovery(attempts, 'task-1')
  assert.deepEqual(decision, { action: 'dead_letter', attempt: MAX_ORPHAN_RECOVERY_ATTEMPTS + 1 })
})

test('tracks tasks independently', () => {
  const attempts: Record<string, number> = {}
  trackOrphanRecovery(attempts, 'task-1')
  trackOrphanRecovery(attempts, 'task-1')
  const other = trackOrphanRecovery(attempts, 'task-2')
  assert.equal(other.action, 'recover')
  assert.equal(other.attempt, 1)
})

test('prune drops counters for tasks no longer orphaned', () => {
  const attempts: Record<string, number> = { 'task-1': 2, 'task-2': 1 }
  pruneOrphanRecovery(attempts, new Set(['task-2']))
  assert.deepEqual(attempts, { 'task-2': 1 })
})

test('honors a custom max', () => {
  const attempts: Record<string, number> = {}
  assert.equal(trackOrphanRecovery(attempts, 'task-1', 1).action, 'recover')
  assert.equal(trackOrphanRecovery(attempts, 'task-1', 1).action, 'dead_letter')
})
