import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('tts routes reject malformed JSON with a 400', () => {
  const output = runWithTempDataDir<{
    ttsStatus: number
    ttsPayload: { error?: string }
    streamStatus: number
    streamPayload: { error?: string }
  }>(`
    const ttsRouteMod = await import('./src/app/api/tts/route')
    const ttsStreamRouteMod = await import('./src/app/api/tts/stream/route')
    const ttsRoute = ttsRouteMod.default || ttsRouteMod
    const ttsStreamRoute = ttsStreamRouteMod.default || ttsStreamRouteMod

    const ttsResponse = await ttsRoute.POST(new Request('http://local/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad-json',
    }))

    const ttsStreamResponse = await ttsStreamRoute.POST(new Request('http://local/api/tts/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad-json',
    }))

    console.log(JSON.stringify({
      ttsStatus: ttsResponse.status,
      ttsPayload: await ttsResponse.json(),
      streamStatus: ttsStreamResponse.status,
      streamPayload: await ttsStreamResponse.json(),
    }))
  `, { prefix: 'swarmclaw-tts-route-' })

  assert.equal(output.ttsStatus, 400)
  assert.equal(output.ttsPayload.error, 'Invalid or missing request body')
  assert.equal(output.streamStatus, 400)
  assert.equal(output.streamPayload.error, 'Invalid or missing request body')
})

test('tts routes reject empty text with a validation error', () => {
  const output = runWithTempDataDir<{
    ttsStatus: number
    ttsPayload: { error?: string; issues?: Array<{ path: string; message: string }> }
    streamStatus: number
    streamPayload: { error?: string; issues?: Array<{ path: string; message: string }> }
  }>(`
    const ttsRouteMod = await import('./src/app/api/tts/route')
    const ttsStreamRouteMod = await import('./src/app/api/tts/stream/route')
    const ttsRoute = ttsRouteMod.default || ttsRouteMod
    const ttsStreamRoute = ttsStreamRouteMod.default || ttsStreamRouteMod

    const ttsResponse = await ttsRoute.POST(new Request('http://local/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    }))

    const ttsStreamResponse = await ttsStreamRoute.POST(new Request('http://local/api/tts/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    }))

    console.log(JSON.stringify({
      ttsStatus: ttsResponse.status,
      ttsPayload: await ttsResponse.json(),
      streamStatus: ttsStreamResponse.status,
      streamPayload: await ttsStreamResponse.json(),
    }))
  `, { prefix: 'swarmclaw-tts-route-' })

  assert.equal(output.ttsStatus, 400)
  assert.equal(output.ttsPayload.error, 'Validation failed')
  assert.deepEqual(output.ttsPayload.issues, [{ path: 'text', message: 'No text provided' }])
  assert.equal(output.streamStatus, 400)
  assert.equal(output.streamPayload.error, 'Validation failed')
  assert.deepEqual(output.streamPayload.issues, [{ path: 'text', message: 'No text provided' }])
})
