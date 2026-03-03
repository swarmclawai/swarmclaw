import fs from 'node:fs'
import path from 'node:path'
import { decryptKey, loadCredentials, loadSettings } from '../storage'
import { mimeFromPath } from './media'
import type { InboundMessage, InboundMedia } from './types'

const PLACEHOLDER_TEXT = new Set([
  '',
  '(media message)',
  '(audio message)',
  '(voice message)',
  '<media:attachment>',
])

const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const TRANSCRIPTION_UNAVAILABLE_NOTE = '[Voice note received — automatic transcription is unavailable (no STT provider key configured).]'
const TRANSCRIPTION_FAILED_NOTE = '[Voice note received — automatic transcription failed. Please check STT provider configuration/logs.]'
const AUDIO_DOWNLOAD_FAILED_NOTE = '[Voice note received — audio attachment could not be loaded for transcription.]'

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false
  return fallback
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(String(process.env[name] || '').trim(), 10)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return raw
}

function normalizeLanguageCode(raw: unknown): string | undefined {
  const normalized = typeof raw === 'string' ? raw.trim() : ''
  if (!normalized) return undefined
  const token = normalized.split(/[-_]/)[0]?.toLowerCase() || ''
  return /^[a-z]{2,3}$/.test(token) ? token : undefined
}

function isAudioPlaceholder(text: string): boolean {
  return PLACEHOLDER_TEXT.has(text.trim().toLowerCase())
}

function pickInboundAudio(msg: InboundMessage): InboundMedia | null {
  if (!Array.isArray(msg.media) || msg.media.length === 0) return null
  for (const media of msg.media) {
    if (!media) continue
    const isAudio = media.type === 'audio'
      || (typeof media.mimeType === 'string' && media.mimeType.toLowerCase().startsWith('audio/'))
    if (!isAudio) continue
    const localPath = typeof media.localPath === 'string' ? media.localPath.trim() : ''
    if (!localPath || !fs.existsSync(localPath)) continue
    return media
  }
  return null
}

function hasInboundAudio(msg: InboundMessage): boolean {
  if (!Array.isArray(msg.media) || msg.media.length === 0) return false
  return msg.media.some((media) => media?.type === 'audio'
    || (typeof media?.mimeType === 'string' && media.mimeType.toLowerCase().startsWith('audio/')))
}

function extractTranscriptText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const obj = payload as Record<string, unknown>
  if (typeof obj.text === 'string' && obj.text.trim()) return obj.text.trim()
  if (Array.isArray(obj.transcripts)) {
    const merged = obj.transcripts
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return ''
        const text = (entry as Record<string, unknown>).text
        return typeof text === 'string' ? text.trim() : ''
      })
      .filter(Boolean)
      .join(' ')
      .trim()
    if (merged) return merged
  }
  return ''
}

function resolveOpenAiApiKey(preferredCredentialId?: string | null): string | null {
  const envKey = String(process.env.SWARMCLAW_OPENAI_STT_API_KEY || process.env.OPENAI_API_KEY || '').trim()
  if (envKey) return envKey

  const creds = loadCredentials() as Record<string, { provider?: string; encryptedKey?: string }>
  const candidates: string[] = []
  if (preferredCredentialId) candidates.push(preferredCredentialId)
  for (const [id, cred] of Object.entries(creds)) {
    const provider = String(cred?.provider || '').trim().toLowerCase()
    if (provider === 'openai') candidates.push(id)
  }
  const seen = new Set<string>()
  for (const id of candidates) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const cred = creds[id]
    const provider = String(cred?.provider || '').trim().toLowerCase()
    if (provider !== 'openai') continue
    if (!cred?.encryptedKey) continue
    try {
      const decrypted = decryptKey(cred.encryptedKey).trim()
      if (decrypted) return decrypted
    } catch { /* ignore invalid credential */ }
  }

  return null
}

function resolveElevenLabsKey(): string | null {
  const settings = loadSettings()
  const key = String(settings.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '').trim()
  return key || null
}

async function transcribeWithElevenLabs(params: {
  apiKey: string
  audioPath: string
  fileName: string
  mimeType: string
  language?: string
  timeoutMs: number
}): Promise<string> {
  const form = new FormData()
  const modelId = String(process.env.SWARMCLAW_ELEVENLABS_STT_MODEL || 'scribe_v1').trim() || 'scribe_v1'
  form.set('model_id', modelId)
  if (params.language) form.set('language_code', params.language)
  const fileBuffer = fs.readFileSync(params.audioPath)
  const blob = new Blob([fileBuffer], { type: params.mimeType })
  form.set('file', blob, params.fileName)

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': params.apiKey },
    body: form,
    signal: AbortSignal.timeout(params.timeoutMs),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`elevenlabs stt ${response.status}: ${body.slice(0, 160)}`)
  }
  const json = await response.json().catch(() => null)
  return extractTranscriptText(json)
}

async function transcribeWithOpenAI(params: {
  apiKey: string
  audioPath: string
  fileName: string
  mimeType: string
  language?: string
  timeoutMs: number
}): Promise<string> {
  const form = new FormData()
  const model = String(process.env.SWARMCLAW_OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe').trim() || 'gpt-4o-mini-transcribe'
  form.set('model', model)
  if (params.language) form.set('language', params.language)
  const fileBuffer = fs.readFileSync(params.audioPath)
  const blob = new Blob([fileBuffer], { type: params.mimeType })
  form.set('file', blob, params.fileName)

  const base = String(process.env.SWARMCLAW_OPENAI_STT_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(params.timeoutMs),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`openai stt ${response.status}: ${body.slice(0, 160)}`)
  }
  const json = await response.json().catch(() => null)
  return extractTranscriptText(json)
}

/**
 * Convert inbound audio media into text before routing to the agent.
 * This prevents "(media message)" placeholders from reaching the model.
 */
export async function enrichInboundMessageWithAudioTranscript(params: {
  msg: InboundMessage
  preferredCredentialId?: string | null
}): Promise<InboundMessage> {
  const { preferredCredentialId } = params
  const msg = params.msg
  if (!boolFromEnv('SWARMCLAW_CONNECTOR_AUDIO_TRANSCRIBE', true)) return msg

  const originalText = String(msg.text || '').trim()
  if (!isAudioPlaceholder(originalText)) return msg

  const inboundAudio = pickInboundAudio(msg)
  if (!inboundAudio) {
    if (hasInboundAudio(msg)) return { ...msg, text: AUDIO_DOWNLOAD_FAILED_NOTE }
    return msg
  }

  const localPath = String(inboundAudio.localPath || '').trim()
  if (!localPath || !fs.existsSync(localPath)) return { ...msg, text: AUDIO_DOWNLOAD_FAILED_NOTE }

  const maxBytes = numberFromEnv('SWARMCLAW_CONNECTOR_AUDIO_TRANSCRIBE_MAX_BYTES', DEFAULT_MAX_AUDIO_BYTES)
  const stat = fs.statSync(localPath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    return { ...msg, text: TRANSCRIPTION_FAILED_NOTE }
  }

  const mimeType = (inboundAudio.mimeType || mimeFromPath(localPath) || 'application/octet-stream').split(';')[0].trim()
  const fileName = inboundAudio.fileName || path.basename(localPath)
  const timeoutMs = numberFromEnv('SWARMCLAW_CONNECTOR_AUDIO_TRANSCRIBE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
  const language = normalizeLanguageCode(loadSettings().speechRecognitionLang)

  const attempts: Array<{ provider: 'elevenlabs' | 'openai'; run: () => Promise<string> }> = []
  const elevenKey = resolveElevenLabsKey()
  if (elevenKey) {
    attempts.push({
      provider: 'elevenlabs',
      run: () => transcribeWithElevenLabs({
        apiKey: elevenKey,
        audioPath: localPath,
        fileName,
        mimeType,
        language,
        timeoutMs,
      }),
    })
  }

  const openAiKey = resolveOpenAiApiKey(preferredCredentialId)
  if (openAiKey) {
    attempts.push({
      provider: 'openai',
      run: () => transcribeWithOpenAI({
        apiKey: openAiKey,
        audioPath: localPath,
        fileName,
        mimeType,
        language,
        timeoutMs,
      }),
    })
  }

  if (attempts.length === 0) return { ...msg, text: TRANSCRIPTION_UNAVAILABLE_NOTE }

  for (const attempt of attempts) {
    try {
      const transcript = (await attempt.run()).replace(/\s+/g, ' ').trim()
      if (!transcript) continue
      console.log(`[connector] Inbound audio transcribed via ${attempt.provider}: ${path.basename(localPath)}`)
      return { ...msg, text: transcript }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[connector] Inbound audio transcription failed via ${attempt.provider}: ${reason}`)
    }
  }

  return { ...msg, text: TRANSCRIPTION_FAILED_NOTE }
}
