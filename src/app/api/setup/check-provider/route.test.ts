import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeOllamaSetupEndpoint, normalizeOpenClawUrl, parseErrorMessage } from './helpers'
import { POST } from './route'

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

// ---------------------------------------------------------------------------
// normalizeOpenClawUrl — additional edge cases
// ---------------------------------------------------------------------------

test('normalizeOpenClawUrl handles https:// endpoint correctly', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('https://gateway.tailnet.ts.net')
  assert.equal(httpUrl, 'https://gateway.tailnet.ts.net')
  assert.equal(wsUrl, 'wss://gateway.tailnet.ts.net')
})

test('normalizeOpenClawUrl handles bare IP:port', () => {
  const { httpUrl, wsUrl } = normalizeOpenClawUrl('10.0.0.5:18789')
  assert.equal(httpUrl, 'http://10.0.0.5:18789')
  assert.equal(wsUrl, 'ws://10.0.0.5:18789')
})

test('POST returns provider diagnostics with normalized LM Studio targets and redacted errors', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'google/gemma-4-e4b' }] }), { status: 200 })
    }
    return new Response(
      JSON.stringify({ error: { message: 'Malformed token sk-local-secret provided.' } }),
      { status: 400 },
    )
  }) as typeof fetch

  try {
    const res = await POST(new Request('http://localhost/api/setup/check-provider', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'lmstudio',
        endpoint: 'http://10.2.0.2:1234',
      }),
    }))
    const payload = await res.json()

    assert.equal(payload.ok, false)
    assert.equal(payload.normalizedEndpoint, 'http://10.2.0.2:1234/v1')
    assert.deepEqual(calls, [
      'http://10.2.0.2:1234/v1/models',
      'http://10.2.0.2:1234/v1/chat/completions',
    ])
    assert.ok(Array.isArray(payload.diagnostics))
    assert.equal(payload.diagnostics[0].target, 'http://10.2.0.2:1234/v1')
    assert.equal(payload.message, 'Malformed token sk-... provided.')
    assert.equal(
      payload.diagnostics.some((step: { detail?: string }) => step.detail?.includes('sk-local-secret')),
      false,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST rejects TokenMix setup checks without an API key', async () => {
  const res = await POST(new Request('http://localhost/api/setup/check-provider', {
    method: 'POST',
    body: JSON.stringify({ provider: 'tokenmix' }),
  }))
  const payload = await res.json()

  assert.equal(res.status, 200)
  assert.equal(payload.ok, false)
  assert.equal(payload.message, 'TokenMix API key is required.')
})

test('POST checks MiniMax OpenAI-compatible endpoints with the Flash default model', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OPENAI_SETUP_OK' } }] }), { status: 200 })
  }) as typeof fetch

  try {
    const res = await POST(new Request('http://localhost/api/setup/check-provider', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'minimax',
        apiKey: 'minimax-test-key',
        endpoint: 'https://api.minimax.io/v1',
      }),
    }))
    const payload = await res.json()
    const body = JSON.parse(String(calls[0]?.init?.body || '{}'))

    assert.equal(payload.ok, true)
    assert.equal(calls[0]?.url, 'https://api.minimax.io/v1/chat/completions')
    assert.equal(body.model, 'MiniMax-M3.1-Flash')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('POST checks MiniMax Anthropic-compatible endpoints with the Anthropic protocol', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ANTHROPIC_SETUP_OK' }] }), { status: 200 })
  }) as typeof fetch

  try {
    const res = await POST(new Request('http://localhost/api/setup/check-provider', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'minimax',
        apiKey: 'minimax-test-key',
        endpoint: 'https://api.minimaxi.com/anthropic',
      }),
    }))
    const payload = await res.json()
    const headers = new Headers(calls[0]?.init?.headers)
    const body = JSON.parse(String(calls[0]?.init?.body || '{}'))

    assert.equal(payload.ok, true)
    assert.equal(payload.message, 'Connected to MiniMax. Sample: ANTHROPIC_SETUP_OK')
    assert.equal(calls[0]?.url, 'https://api.minimaxi.com/anthropic/v1/messages')
    assert.equal(headers.get('x-api-key'), 'minimax-test-key')
    assert.equal(headers.get('anthropic-version'), '2023-06-01')
    assert.equal(body.model, 'MiniMax-M3.1-Flash')
  } finally {
    globalThis.fetch = originalFetch
  }
})
