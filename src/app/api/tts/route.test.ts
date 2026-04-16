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

test('tts routes return a JSON error when no ElevenLabs API key is configured', () => {
  // Regression: both routes previously returned the raw error string via
  // `new NextResponse(message, { status: 500 })`, which serialized to a
  // `{"type":"Buffer","data":[...]}` blob on the CLI side because the response
  // had no content-type. They must now return a proper JSON error body.
  const output = runWithTempDataDir<{
    ttsStatus: number
    ttsContentType: string | null
    ttsPayload: { error?: string }
    streamStatus: number
    streamContentType: string | null
    streamPayload: { error?: string }
  }>(`
    delete process.env.ELEVENLABS_API_KEY
    const ttsRouteMod = await import('./src/app/api/tts/route')
    const ttsStreamRouteMod = await import('./src/app/api/tts/stream/route')
    const ttsRoute = ttsRouteMod.default || ttsRouteMod
    const ttsStreamRoute = ttsStreamRouteMod.default || ttsStreamRouteMod

    const ttsResponse = await ttsRoute.POST(new Request('http://local/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    }))

    const ttsStreamResponse = await ttsStreamRoute.POST(new Request('http://local/api/tts/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    }))

    console.log(JSON.stringify({
      ttsStatus: ttsResponse.status,
      ttsContentType: ttsResponse.headers.get('content-type'),
      ttsPayload: await ttsResponse.json(),
      streamStatus: ttsStreamResponse.status,
      streamContentType: ttsStreamResponse.headers.get('content-type'),
      streamPayload: await ttsStreamResponse.json(),
    }))
  `, { prefix: 'swarmclaw-tts-route-' })

  assert.equal(output.ttsStatus, 500)
  assert.ok(output.ttsContentType?.includes('application/json'), `expected JSON content-type, got ${output.ttsContentType}`)
  assert.match(output.ttsPayload.error ?? '', /ElevenLabs API key/i)

  assert.equal(output.streamStatus, 500)
  assert.ok(output.streamContentType?.includes('application/json'), `expected JSON content-type, got ${output.streamContentType}`)
  assert.match(output.streamPayload.error ?? '', /ElevenLabs API key/i)
})
