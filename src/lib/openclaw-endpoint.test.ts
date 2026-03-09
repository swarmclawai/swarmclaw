import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveOpenClawWsUrl,
  isLocalOpenClawEndpoint,
  normalizeOpenClawEndpoint,
  normalizeProviderEndpoint,
} from './openclaw-endpoint'

test('normalizeOpenClawEndpoint handles ws/http/path variants', () => {
  assert.equal(
    normalizeOpenClawEndpoint('ws://127.0.0.1:18789'),
    'http://127.0.0.1:18789/v1',
  )
  assert.equal(
    normalizeOpenClawEndpoint('http://localhost:18789'),
    'http://localhost:18789/v1',
  )
  assert.equal(
    normalizeOpenClawEndpoint('http://localhost:18789/v1/chat/completions'),
    'http://localhost:18789/v1',
  )
})

test('deriveOpenClawWsUrl strips v1 suffix and preserves host', () => {
  assert.equal(
    deriveOpenClawWsUrl('http://localhost:18789/v1'),
    'ws://localhost:18789',
  )
  assert.equal(
    deriveOpenClawWsUrl('https://openclaw.example.com/v1'),
    'wss://openclaw.example.com',
  )
})

test('normalizeProviderEndpoint only rewrites openclaw provider', () => {
  assert.equal(
    normalizeProviderEndpoint('openclaw', 'ws://localhost:18789'),
    'http://localhost:18789/v1',
  )
  assert.equal(
    normalizeProviderEndpoint('openai', 'https://api.openai.com/v1/'),
    'https://api.openai.com/v1',
  )
  assert.equal(
    normalizeProviderEndpoint('openai', null),
    null,
  )
})

test('isLocalOpenClawEndpoint detects loopback hosts', () => {
  assert.equal(isLocalOpenClawEndpoint('ws://localhost:18789'), true)
  assert.equal(isLocalOpenClawEndpoint('http://127.0.0.1:18789/v1'), true)
  assert.equal(isLocalOpenClawEndpoint('http://[::1]:18789/v1'), true)
  assert.equal(isLocalOpenClawEndpoint('https://openclaw.example.com/v1'), false)
})
