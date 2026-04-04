import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('logs route accepts client-side error reports and persists them', () => {
  const output = runWithTempDataDir<{
    status: number
    payload: { ok?: boolean }
    entries: Array<{ tag?: string; message?: string; data?: string }>
  }>(`
    const routeMod = await import('./src/app/api/logs/route')
    const route = routeMod.default || routeMod

    const postResponse = await route.POST(new Request('http://local/api/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'error-boundary',
        message: 'Client render failed',
        componentStack: 'at DemoComponent',
      }),
    }))

    const getResponse = await route.GET(new Request('http://local/api/logs?lines=5&search=Client%20render%20failed'))

    console.log(JSON.stringify({
      status: postResponse.status,
      payload: await postResponse.json(),
      entries: (await getResponse.json()).entries,
    }))
  `, { prefix: 'swarmclaw-logs-route-' })

  assert.equal(output.status, 200)
  assert.equal(output.payload.ok, true)
  assert.ok(output.entries.some((entry) => entry.tag === 'error-boundary' && entry.message === 'Client render failed'))
})

test('logs route rejects malformed client error payloads with a 400', () => {
  const output = runWithTempDataDir<{
    status: number
    payload: { error?: string }
  }>(`
    const routeMod = await import('./src/app/api/logs/route')
    const route = routeMod.default || routeMod

    const response = await route.POST(new Request('http://local/api/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad-json',
    }))

    console.log(JSON.stringify({
      status: response.status,
      payload: await response.json(),
    }))
  `, { prefix: 'swarmclaw-logs-route-' })

  assert.equal(output.status, 400)
  assert.equal(output.payload.error, 'Invalid or missing request body')
})
