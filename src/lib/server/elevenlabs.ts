import { decryptKey, loadSettings, loadSecrets } from './storage'

const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

export function resolveElevenLabsConfig(voiceId?: string | null): {
  apiKey: string
  voiceId: string
} {
  const apiKeys = resolveElevenLabsApiKeyCandidates()
  if (!apiKeys.length) {
    throw new Error('No ElevenLabs API key. Set one in Settings > Voice.')
  }

  const settings = loadSettings()
  const resolvedVoiceId = String(
    voiceId
    || settings.elevenLabsVoiceId
    || process.env.ELEVENLABS_VOICE
    || DEFAULT_VOICE_ID,
  ).trim()

  return { apiKey: apiKeys[0], voiceId: resolvedVoiceId || DEFAULT_VOICE_ID }
}

function resolveElevenLabsApiKeyCandidates(): string[] {
  const settings = loadSettings()
  const candidates: string[] = []

  const pushCandidate = (value: unknown) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed) candidates.push(trimmed)
  }

  pushCandidate(settings.elevenLabsApiKey)
  pushCandidate(process.env.ELEVENLABS_API_KEY)

  for (const secret of Object.values(loadSecrets()) as Array<Record<string, unknown>>) {
    const label = [
      typeof secret.id === 'string' ? secret.id : '',
      typeof secret.name === 'string' ? secret.name : '',
      typeof secret.service === 'string' ? secret.service : '',
    ].join(' ').toLowerCase()
    if (!label.includes('eleven')) continue
    if (typeof secret.encryptedValue !== 'string' || !secret.encryptedValue) continue
    try {
      pushCandidate(decryptKey(secret.encryptedValue))
    } catch {
      // Ignore undecryptable secrets and continue.
    }
  }

  return [...new Set(candidates)]
}

function shouldRetryWithFallbackVoice(voiceId: string, errBody: string): boolean {
  if (!voiceId || voiceId === DEFAULT_VOICE_ID) return false
  return /paid_plan_required|library voices via the api|voice_not_found|voice with voice_id .* was not found/i.test(errBody)
}

async function postElevenLabsTts(params: {
  apiKey: string
  voiceId: string
  text: string
  stability: number
  similarityBoost: number
  stream?: boolean
}): Promise<Response> {
  const endpoint = params.stream
    ? `https://api.elevenlabs.io/v1/text-to-speech/${params.voiceId}/stream`
    : `https://api.elevenlabs.io/v1/text-to-speech/${params.voiceId}`
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': params.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: params.stream ? params.text.slice(0, 2000) : params.text,
      model_id: DEFAULT_MODEL_ID,
      voice_settings: {
        stability: params.stability,
        similarity_boost: params.similarityBoost,
      },
      ...(params.stream ? { output_format: 'mp3_22050_32' } : {}),
    }),
  })
}

async function requestElevenLabsAudioWithFallback(params: {
  text: string
  voiceId?: string | null
  stability: number
  similarityBoost: number
  stream?: boolean
}): Promise<Response> {
  const settings = loadSettings()
  const voiceId = String(
    params.voiceId
    || settings.elevenLabsVoiceId
    || process.env.ELEVENLABS_VOICE
    || DEFAULT_VOICE_ID,
  ).trim() || DEFAULT_VOICE_ID
  const apiKeys = resolveElevenLabsApiKeyCandidates()
  if (!apiKeys.length) {
    throw new Error('No ElevenLabs API key. Set one in Settings > Voice.')
  }

  let lastError = ''
  for (const apiKey of apiKeys) {
    const firstRes = await postElevenLabsTts({
      apiKey,
      voiceId,
      text: params.text,
      stability: params.stability,
      similarityBoost: params.similarityBoost,
      stream: params.stream,
    })
    if (firstRes.ok) return firstRes

    const firstErr = await firstRes.text().catch(() => '')
    lastError = firstErr || `ElevenLabs request failed (${firstRes.status})`

    if (shouldRetryWithFallbackVoice(voiceId, firstErr)) {
      const fallbackRes = await postElevenLabsTts({
        apiKey,
        voiceId: DEFAULT_VOICE_ID,
        text: params.text,
        stability: params.stability,
        similarityBoost: params.similarityBoost,
        stream: params.stream,
      })
      if (fallbackRes.ok) return fallbackRes

      const fallbackErr = await fallbackRes.text().catch(() => '')
      lastError = fallbackErr
        ? `${lastError} | fallback voice failed: ${fallbackErr}`
        : lastError
      if (!shouldTryNextApiKey(lastError)) {
        throw new Error(lastError)
      }
      continue
    }

    if (!shouldTryNextApiKey(firstErr)) {
      throw new Error(lastError)
    }
  }

  throw new Error(lastError || 'ElevenLabs request failed')
}

function shouldTryNextApiKey(errBody: string): boolean {
  return /invalid_api_key|missing_permissions|detected_unusual_activity/i.test(errBody)
}

export async function synthesizeElevenLabsMp3(params: {
  text: string
  voiceId?: string | null
  stability?: number
  similarityBoost?: number
}): Promise<Buffer> {
  const text = params.text.trim()
  if (!text) throw new Error('No text provided for ElevenLabs synthesis.')

  const stability = Number.isFinite(params.stability) ? Math.max(0, Math.min(1, Number(params.stability))) : 0.5
  const similarityBoost = Number.isFinite(params.similarityBoost) ? Math.max(0, Math.min(1, Number(params.similarityBoost))) : 0.75

  const apiRes = await requestElevenLabsAudioWithFallback({
    text,
    voiceId: params.voiceId,
    stability,
    similarityBoost,
  })

  const audioBuffer = await apiRes.arrayBuffer()
  return Buffer.from(audioBuffer)
}

export async function requestElevenLabsMp3Stream(params: {
  text: string
  voiceId?: string | null
}): Promise<Response> {
  const text = params.text.trim()
  if (!text) throw new Error('No text provided for ElevenLabs stream.')

  const apiRes = await requestElevenLabsAudioWithFallback({
    text,
    voiceId: params.voiceId,
    stability: 0.5,
    similarityBoost: 0.75,
    stream: true,
  })

  return apiRes
}

export function explainElevenLabsError(err: unknown): string {
  return getErrorMessage(err)
}
