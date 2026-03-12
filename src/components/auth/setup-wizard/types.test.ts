import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEP_ORDER } from './types'

test('STEP_ORDER is [profile, providers, agents]', () => {
  assert.deepEqual(STEP_ORDER, ['profile', 'providers', 'agents'])
})

test('STEP_ORDER has exactly 3 steps', () => {
  assert.equal(STEP_ORDER.length, 3)
})
