import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { requestElevenLabsMp3Stream, resolveElevenLabsConfig, synthesizeElevenLabsMp3 } from './elevenlabs'
import { loadSettings, saveSettings } from './storage'

describe('elevenlabs helpers', () => {
  it('prefers agent override first, then settings default, then env fallback', () => {
    const originalSettings = loadSettings()
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE

    try {
      saveSettings({
        ...originalSettings,
        elevenLabsApiKey: 'settings-key',
        elevenLabsVoiceId: 'settings-voice',
      })
      process.env.ELEVENLABS_API_KEY = 'env-key'
      process.env.ELEVENLABS_VOICE = 'env-voice'

      assert.deepEqual(resolveElevenLabsConfig('agent-voice'), {
        apiKey: 'settings-key',
        voiceId: 'agent-voice',
      })
      assert.deepEqual(resolveElevenLabsConfig(null), {
        apiKey: 'settings-key',
        voiceId: 'settings-voice',
      })

      saveSettings({
        ...originalSettings,
        elevenLabsApiKey: 'settings-key',
        elevenLabsVoiceId: null,
      })

      assert.deepEqual(resolveElevenLabsConfig(undefined), {
        apiKey: 'settings-key',
        voiceId: 'env-voice',
      })
    } finally {
      saveSettings(originalSettings)
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = originalKey
      if (originalVoice === undefined) delete process.env.ELEVENLABS_VOICE
      else process.env.ELEVENLABS_VOICE = originalVoice
    }
  })

  it('synthesizeElevenLabsMp3 posts TTS request and returns audio bytes', async () => {
    const originalFetch = global.fetch
    const originalSettings = loadSettings()
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    saveSettings({
      ...originalSettings,
      elevenLabsApiKey: null,
      elevenLabsVoiceId: null,
    })
    process.env.ELEVENLABS_API_KEY = 'test-key'
    process.env.ELEVENLABS_VOICE = 'voice-123'

    let called = false
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      called = true
      assert.equal(String(input), 'https://api.elevenlabs.io/v1/text-to-speech/voice-123')
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>)['xi-api-key'], 'test-key')
      return new Response(Buffer.from('abc'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const out = await synthesizeElevenLabsMp3({ text: 'hello world' })
      assert.ok(called)
      assert.equal(out.toString('utf8'), 'abc')
    } finally {
      global.fetch = originalFetch
      saveSettings(originalSettings)
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = originalKey
      if (originalVoice === undefined) delete process.env.ELEVENLABS_VOICE
      else process.env.ELEVENLABS_VOICE = originalVoice
    }
  })

  it('requestElevenLabsMp3Stream calls streaming endpoint', async () => {
    const originalFetch = global.fetch
    const originalSettings = loadSettings()
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    saveSettings({
      ...originalSettings,
      elevenLabsApiKey: null,
      elevenLabsVoiceId: null,
    })
    process.env.ELEVENLABS_API_KEY = 'test-key'
    process.env.ELEVENLABS_VOICE = 'voice-xyz'

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), 'https://api.elevenlabs.io/v1/text-to-speech/voice-xyz/stream')
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>)['xi-api-key'], 'test-key')
      return new Response('stream', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const res = await requestElevenLabsMp3Stream({ text: 'streaming text' })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'stream')
    } finally {
      global.fetch = originalFetch
      saveSettings(originalSettings)
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = originalKey
      if (originalVoice === undefined) delete process.env.ELEVENLABS_VOICE
      else process.env.ELEVENLABS_VOICE = originalVoice
    }
  })
})
