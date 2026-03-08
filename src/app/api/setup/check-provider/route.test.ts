import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeOllamaSetupEndpoint } from './route'

test('normalizeOllamaSetupEndpoint strips local /v1 suffixes but preserves cloud endpoints', () => {
  assert.equal(
    normalizeOllamaSetupEndpoint('http://localhost:11434/v1', false),
    'http://localhost:11434',
  )
  assert.equal(
    normalizeOllamaSetupEndpoint('http://localhost:11434/', false),
    'http://localhost:11434',
  )
  assert.equal(
    normalizeOllamaSetupEndpoint('https://ollama.com/v1', true),
    'https://ollama.com/v1',
  )
})
