import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { requestElevenLabsMp3Stream, resolveElevenLabsConfig, synthesizeElevenLabsMp3 } from './elevenlabs'
import { encryptKey, loadSecrets, loadSettings, saveSecrets, saveSettings } from './storage'

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

  it('synthesizeElevenLabsMp3 retries with the built-in fallback voice when the configured voice is paid-only', async () => {
    const originalFetch = global.fetch
    const originalSettings = loadSettings()
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    saveSettings({
      ...originalSettings,
      elevenLabsApiKey: 'settings-key',
      elevenLabsVoiceId: 'paid-only-voice',
    })
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_VOICE

    const calls: string[] = []
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/paid-only-voice')) {
        return new Response(
          '{"detail":{"type":"payment_required","code":"paid_plan_required","message":"Free users cannot use library voices via the API."}}',
          { status: 402, headers: { 'Content-Type': 'application/json' } },
        )
      }
      assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb')
      return new Response(Buffer.from('fallback-audio'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const out = await synthesizeElevenLabsMp3({ text: 'hello world' })
      assert.equal(out.toString('utf8'), 'fallback-audio')
      assert.deepEqual(calls, [
        'https://api.elevenlabs.io/v1/text-to-speech/paid-only-voice',
        'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb',
      ])
    } finally {
      global.fetch = originalFetch
      saveSettings(originalSettings)
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = originalKey
      if (originalVoice === undefined) delete process.env.ELEVENLABS_VOICE
      else process.env.ELEVENLABS_VOICE = originalVoice
    }
  })

  it('synthesizeElevenLabsMp3 retries with the built-in fallback voice when the configured voice id is missing', async () => {
    const originalFetch = global.fetch
    const originalSettings = loadSettings()
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    saveSettings({
      ...originalSettings,
      elevenLabsApiKey: 'settings-key',
      elevenLabsVoiceId: 'missing-voice',
    })
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_VOICE

    const calls: string[] = []
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/missing-voice')) {
        return new Response(
          '{"detail":{"type":"not_found","code":"voice_not_found","message":"A voice with voice_id \'missing-voice\' was not found."}}',
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      }
      assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb')
      return new Response(Buffer.from('fallback-audio'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const out = await synthesizeElevenLabsMp3({ text: 'hello world' })
      assert.equal(out.toString('utf8'), 'fallback-audio')
      assert.deepEqual(calls, [
        'https://api.elevenlabs.io/v1/text-to-speech/missing-voice',
        'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb',
      ])
    } finally {
      global.fetch = originalFetch
      saveSettings(originalSettings)
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = originalKey
      if (originalVoice === undefined) delete process.env.ELEVENLABS_VOICE
      else process.env.ELEVENLABS_VOICE = originalVoice
    }
  })

  it('synthesizeElevenLabsMp3 falls back from an invalid settings key to a stored ElevenLabs secret', async () => {
    const originalFetch = global.fetch
    const originalSettings = loadSettings()
    const originalSecrets = loadSecrets()
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    saveSettings({
      ...originalSettings,
      elevenLabsApiKey: 'invalid-settings-key',
      elevenLabsVoiceId: 'voice-123',
    })
    saveSecrets({
      eleven_secret: {
        id: 'eleven_secret',
        name: 'ElevenLabs API Key',
        service: 'custom',
        scope: 'global',
        agentIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encryptedValue: encryptKey('secret-fallback-key'),
      },
    })
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_VOICE

    const calls: string[] = []
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>)['xi-api-key'] || '')
      calls.push(key)
      if (key === 'invalid-settings-key') {
        return new Response(
          '{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}',
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
      assert.equal(key, 'secret-fallback-key')
      return new Response(Buffer.from('secret-audio'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const out = await synthesizeElevenLabsMp3({ text: 'hello world' })
      assert.equal(out.toString('utf8'), 'secret-audio')
      assert.deepEqual(calls, ['invalid-settings-key', 'secret-fallback-key'])
    } finally {
      global.fetch = originalFetch
      saveSettings(originalSettings)
      saveSecrets(originalSecrets)
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

  it('requestElevenLabsMp3Stream retries with the built-in fallback voice when the configured voice is paid-only', async () => {
    const originalFetch = global.fetch
    const originalSettings = loadSettings()
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    saveSettings({
      ...originalSettings,
      elevenLabsApiKey: 'settings-key',
      elevenLabsVoiceId: 'paid-only-voice',
    })
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_VOICE

    const calls: string[] = []
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/paid-only-voice/stream')) {
        return new Response(
          '{"detail":{"type":"payment_required","code":"paid_plan_required","message":"Free users cannot use library voices via the API."}}',
          { status: 402, headers: { 'Content-Type': 'application/json' } },
        )
      }
      assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream')
      return new Response('fallback-stream', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const res = await requestElevenLabsMp3Stream({ text: 'streaming text' })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'fallback-stream')
      assert.deepEqual(calls, [
        'https://api.elevenlabs.io/v1/text-to-speech/paid-only-voice/stream',
        'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream',
      ])
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
