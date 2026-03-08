import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inferAutomaticMemoryCategory,
  normalizeMemoryCategory,
  shouldAutoCaptureMemory,
  shouldInjectMemoryContext,
} from './memory-policy'

test('normalizeMemoryCategory maps flat categories into hierarchical buckets', () => {
  assert.equal(normalizeMemoryCategory('preference', 'User prefers terse replies'), 'identity/preferences')
  assert.equal(normalizeMemoryCategory('decision', 'Ship the Docker path'), 'projects/decisions')
  assert.equal(normalizeMemoryCategory('error', 'Root cause found'), 'execution/errors')
  assert.equal(normalizeMemoryCategory('project', 'Repo setup'), 'projects/context')
})

test('shouldInjectMemoryContext skips low-signal greetings and acknowledgements', () => {
  assert.equal(shouldInjectMemoryContext('thanks'), false)
  assert.equal(shouldInjectMemoryContext('hello'), false)
  assert.equal(shouldInjectMemoryContext('Remember this for later'), false)
  assert.equal(shouldInjectMemoryContext('Compare the current deployment plan with what we decided yesterday'), true)
})

test('shouldAutoCaptureMemory filters noisy turns', () => {
  assert.equal(shouldAutoCaptureMemory({ message: 'thanks', response: 'Happy to help with that.', source: 'chat' }), false)
  assert.equal(shouldAutoCaptureMemory({ message: 'Please save this to memory', response: 'Stored memory "note".', source: 'chat' }), false)
  assert.equal(shouldAutoCaptureMemory({
    message: 'We decided to use the shared staging environment and keep the worker count at 2 for now.',
    response: 'Decision captured: shared staging, worker count 2, and we will revisit after load testing next week.',
    source: 'chat',
  }), true)
})

test('inferAutomaticMemoryCategory picks a stable automatic bucket', () => {
  assert.equal(
    inferAutomaticMemoryCategory('The user prefers direct status updates.', 'I will keep future updates terse and direct.'),
    'identity/preferences',
  )
  assert.equal(
    inferAutomaticMemoryCategory('We decided to ship the GitHub import first.', 'Decision locked for the next milestone.'),
    'projects/decisions',
  )
})
