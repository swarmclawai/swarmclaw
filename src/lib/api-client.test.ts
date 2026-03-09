import test from 'node:test'
import assert from 'node:assert/strict'

import { api } from './api-client'

const originalFetch = global.fetch

test.afterEach(() => {
  global.fetch = originalFetch
})

test('dedupes concurrent GET requests for the same path', async () => {
  let calls = 0
  global.fetch = (async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 25))
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  const [first, second] = await Promise.all([
    api<{ ok: boolean }>('GET', '/dedupe-check'),
    api<{ ok: boolean }>('GET', '/dedupe-check'),
  ])

  assert.deepEqual(first, { ok: true })
  assert.deepEqual(second, { ok: true })
  assert.equal(calls, 1)
})

test('does not dedupe non-GET requests', async () => {
  let calls = 0
  global.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  await Promise.all([
    api<{ ok: boolean }>('POST', '/dedupe-check', { hello: 'one' }),
    api<{ ok: boolean }>('POST', '/dedupe-check', { hello: 'two' }),
  ])

  assert.equal(calls, 2)
})

test('retries GET requests that fail with TimeoutError', async () => {
  let calls = 0
  global.fetch = (async () => {
    calls += 1
    if (calls === 1) {
      const error = new Error('Request timed out after 12000ms')
      error.name = 'TimeoutError'
      throw error
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  const result = await api<{ ok: boolean }>('GET', '/timeout-retry')

  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2)
})
