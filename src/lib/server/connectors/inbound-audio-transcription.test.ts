import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { enrichInboundMessageWithAudioTranscript } from './inbound-audio-transcription'
import type { InboundMessage } from './types'
import { UPLOAD_DIR, loadSettings, saveSettings } from '../storage'

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'SWARMCLAW_OPENAI_STT_API_KEY',
  'SWARMCLAW_OPENAI_STT_BASE_URL',
  'SWARMCLAW_OPENAI_STT_MODEL',
  'SWARMCLAW_ELEVENLABS_STT_MODEL',
  'SWARMCLAW_CONNECTOR_AUDIO_TRANSCRIBE',
  'SWARMCLAW_CONNECTOR_AUDIO_TRANSCRIBE_TIMEOUT_MS',
  'SWARMCLAW_CONNECTOR_AUDIO_TRANSCRIBE_MAX_BYTES',
  'ELEVENLABS_API_KEY',
] as const

type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>

let originalFetch: typeof fetch
let originalSettings: Record<string, unknown>
let originalEnv: EnvSnapshot
let tempFiles: string[] = []

function setEnv(name: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function createAudioFixture(name: string): string {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  const filePath = path.join(UPLOAD_DIR, `${Date.now()}-${name}.ogg`)
  fs.writeFileSync(filePath, Buffer.from('voice-note-bytes'))
  tempFiles.push(filePath)
  return filePath
}

function buildInboundMessage(localPath: string, text = '(media message)'): InboundMessage {
  return {
    platform: 'whatsapp',
    channelId: '15550001111@s.whatsapp.net',
    senderId: '15550001111@s.whatsapp.net',
    senderName: 'Tester',
    text,
    media: [{ type: 'audio', localPath, mimeType: 'audio/ogg', fileName: 'voice.ogg' }],
  }
}

beforeEach(() => {
  originalFetch = global.fetch
  originalSettings = loadSettings()
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as EnvSnapshot
  tempFiles = []
})

afterEach(() => {
  global.fetch = originalFetch
  saveSettings(originalSettings)
  for (const key of ENV_KEYS) setEnv(key, originalEnv[key])
  for (const filePath of tempFiles) fs.rmSync(filePath, { force: true })
})

describe('enrichInboundMessageWithAudioTranscript', () => {
  it('transcribes placeholder audio messages with OpenAI STT', async () => {
    const audioPath = createAudioFixture('openai')
    setEnv('OPENAI_API_KEY', 'openai-test-key')
    setEnv('SWARMCLAW_CONNECTOR_AUDIO_TRANSCRIBE_TIMEOUT_MS', '5000')
    saveSettings({
      ...originalSettings,
      elevenLabsEnabled: false,
      elevenLabsApiKey: null,
    })

    let called = 0
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      called += 1
      const url = String(input)
      assert.ok(url.endsWith('/audio/transcriptions'))
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer openai-test-key')
      return new Response(JSON.stringify({ text: 'Please move this task to tomorrow morning.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const inbound = buildInboundMessage(audioPath)
    const enriched = await enrichInboundMessageWithAudioTranscript({ msg: inbound })

    assert.equal(called, 1)
    assert.equal(enriched.text, 'Please move this task to tomorrow morning.')
  })

  it('tries ElevenLabs first and falls back to OpenAI when ElevenLabs fails', async () => {
    const audioPath = createAudioFixture('fallback')
    setEnv('OPENAI_API_KEY', 'openai-fallback-key')
    saveSettings({
      ...originalSettings,
      elevenLabsEnabled: true,
      elevenLabsApiKey: 'el-test-key',
    })

    const calledUrls: string[] = []
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calledUrls.push(url)
      if (url.includes('api.elevenlabs.io/v1/speech-to-text')) {
        return new Response(JSON.stringify({ detail: 'upstream unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/audio/transcriptions')) {
        return new Response(JSON.stringify({ text: 'Fallback transcription succeeded.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('unexpected url', { status: 404 })
    }) as typeof fetch

    const inbound = buildInboundMessage(audioPath)
    const enriched = await enrichInboundMessageWithAudioTranscript({ msg: inbound })

    assert.equal(enriched.text, 'Fallback transcription succeeded.')
    assert.equal(calledUrls.length, 2)
    assert.ok(calledUrls[0].includes('api.elevenlabs.io/v1/speech-to-text'))
    assert.ok(calledUrls[1].endsWith('/audio/transcriptions'))
  })

  it('skips transcription when the inbound message already has non-placeholder text', async () => {
    const audioPath = createAudioFixture('skip')
    setEnv('OPENAI_API_KEY', 'openai-test-key')

    let called = false
    global.fetch = (async () => {
      called = true
      return new Response(JSON.stringify({ text: 'should not be used' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const inbound = buildInboundMessage(audioPath, 'Already typed this manually')
    const enriched = await enrichInboundMessageWithAudioTranscript({ msg: inbound })

    assert.equal(enriched.text, 'Already typed this manually')
    assert.equal(called, false)
  })

  it('returns a clear failure note when STT providers error out', async () => {
    const audioPath = createAudioFixture('provider-error')
    setEnv('OPENAI_API_KEY', 'openai-error-key')
    saveSettings({
      ...originalSettings,
      elevenLabsEnabled: true,
      elevenLabsApiKey: 'el-error-key',
    })

    global.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'upstream down' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const inbound = buildInboundMessage(audioPath)
    const enriched = await enrichInboundMessageWithAudioTranscript({ msg: inbound })

    assert.ok(enriched.text.toLowerCase().includes('automatic transcription failed'))
  })

  it('returns a clear note when inbound audio cannot be loaded from disk', async () => {
    const inbound: InboundMessage = {
      platform: 'whatsapp',
      channelId: '15550001111@s.whatsapp.net',
      senderId: '15550001111@s.whatsapp.net',
      senderName: 'Tester',
      text: '(media message)',
      media: [{ type: 'audio', localPath: '/tmp/nonexistent-voice-note.ogg', mimeType: 'audio/ogg', fileName: 'voice.ogg' }],
    }

    const enriched = await enrichInboundMessageWithAudioTranscript({ msg: inbound })
    assert.ok(enriched.text.toLowerCase().includes('audio attachment could not be loaded'))
  })
})
