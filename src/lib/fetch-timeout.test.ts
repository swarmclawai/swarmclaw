import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchWithTimeout } from './fetch-timeout'

const originalFetch = global.fetch
const originalSetTimeout = global.setTimeout
const originalClearTimeout = global.clearTimeout

test.afterEach(() => {
  global.fetch = originalFetch
  global.setTimeout = originalSetTimeout
  global.clearTimeout = originalClearTimeout
})

test('fetchWithTimeout throws TimeoutError with a clear message on timeout', async () => {
  global.setTimeout = (((callback: (...args: unknown[]) => void) => {
    queueMicrotask(() => callback())
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  global.clearTimeout = (() => {}) as typeof clearTimeout
  global.fetch = (((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const onAbort = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    if (init?.signal?.aborted) onAbort()
    else init?.signal?.addEventListener('abort', onAbort, { once: true })
  })) as typeof fetch)

  await assert.rejects(
    () => fetchWithTimeout('/slow', {}, 5_000),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, 'TimeoutError')
      assert.match(err.message, /5000ms/)
      return true
    },
  )
})

test('fetchWithTimeout preserves caller abort signals', async () => {
  const controller = new AbortController()
  const expectedError = new DOMException('Manual cancel', 'AbortError')
  controller.abort(expectedError)
  global.fetch = (((_input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.reject(init?.signal?.reason ?? expectedError)
  }) as typeof fetch)

  await assert.rejects(
    () => fetchWithTimeout('/aborted', { signal: controller.signal }, 5_000),
    (err: unknown) => {
      assert.strictEqual(err, expectedError)
      return true
    },
  )
})
