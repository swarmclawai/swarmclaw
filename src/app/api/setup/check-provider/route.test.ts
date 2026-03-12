import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeOllamaSetupEndpoint, normalizeOpenClawUrl, parseErrorMessage } from './route'

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

// ---------------------------------------------------------------------------
// normalizeOpenClawUrl
// ---------------------------------------------------------------------------

test('normalizeOpenClawUrl adds http:// to bare host:port', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('myhost:18789')
  assert.equal(httpUrl, 'http://myhost:18789')
  assert.equal(wsUrl, 'ws://myhost:18789')
})

test('normalizeOpenClawUrl converts ws:// to http:// and vice-versa', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('ws://192.168.1.5:18789')
  assert.equal(httpUrl, 'http://192.168.1.5:18789')
  assert.equal(wsUrl, 'ws://192.168.1.5:18789')
})

test('normalizeOpenClawUrl converts wss:// to https:// and vice-versa', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('wss://gateway.example.com')
  assert.equal(httpUrl, 'https://gateway.example.com')
  assert.equal(wsUrl, 'wss://gateway.example.com')
})

test('normalizeOpenClawUrl strips trailing slashes', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('http://localhost:18789///')
  assert.equal(httpUrl, 'http://localhost:18789')
  assert.equal(wsUrl, 'ws://localhost:18789')
})

test('normalizeOpenClawUrl defaults to localhost when empty', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('')
  assert.equal(httpUrl, 'http://localhost:18789')
  assert.equal(wsUrl, 'ws://localhost:18789')
})

test('normalizeOpenClawUrl preserves existing http://', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('http://10.0.0.1:9999')
  assert.equal(httpUrl, 'http://10.0.0.1:9999')
  assert.equal(wsUrl, 'ws://10.0.0.1:9999')
})

test('normalizeOpenClawUrl preserves https://', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('https://secure.example.com')
  assert.equal(httpUrl, 'https://secure.example.com')
  assert.equal(wsUrl, 'wss://secure.example.com')
})

// ---------------------------------------------------------------------------
// parseErrorMessage
// ---------------------------------------------------------------------------

function fakeResponse(body: string, status = 400): Response {
  return new Response(body, { status })
}

test('parseErrorMessage extracts JSON .error.message', async () => {
  const res = fakeResponse(JSON.stringify({ error: { message: 'bad key' } }))
  assert.equal(await parseErrorMessage(res, 'fallback'), 'bad key')
})

test('parseErrorMessage extracts JSON .error string', async () => {
  const res = fakeResponse(JSON.stringify({ error: 'rate limited' }))
  assert.equal(await parseErrorMessage(res, 'fallback'), 'rate limited')
})

test('parseErrorMessage extracts JSON .detail string', async () => {
  const res = fakeResponse(JSON.stringify({ detail: 'not found' }))
  assert.equal(await parseErrorMessage(res, 'fallback'), 'not found')
})

test('parseErrorMessage returns raw text for non-JSON', async () => {
  const res = fakeResponse('Service Unavailable')
  assert.equal(await parseErrorMessage(res, 'fallback'), 'Service Unavailable')
})

test('parseErrorMessage returns fallback for empty body', async () => {
  const res = fakeResponse('')
  assert.equal(await parseErrorMessage(res, 'fallback'), 'fallback')
})

test('parseErrorMessage extracts .message from JSON', async () => {
  const res = fakeResponse(JSON.stringify({ message: 'quota exceeded' }))
  assert.equal(await parseErrorMessage(res, 'fallback'), 'quota exceeded')
})
