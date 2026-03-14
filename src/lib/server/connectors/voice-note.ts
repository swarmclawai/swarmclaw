import fs from 'fs'
import path from 'path'
import { genId } from '@/lib/id'
import { loadAgent, UPLOAD_DIR } from '../storage'
import { synthesizeElevenLabsMp3 } from '../elevenlabs'
import { isAudioMime, mimeFromPath } from './media'

export function resolveConnectorVoiceId(params: {
  explicitVoiceId?: string | null
  sessionAgentId?: string | null
  contextAgentId?: string | null
  nestedContextAgentId?: string | null
  getAgent?: (id: string) => { elevenLabsVoiceId?: string | null } | null
}): string | undefined {
  const explicitVoiceId = typeof params.explicitVoiceId === 'string' ? params.explicitVoiceId.trim() : ''
  if (explicitVoiceId) return explicitVoiceId

  const agentId = [
    params.sessionAgentId,
    params.contextAgentId,
    params.nestedContextAgentId,
  ].find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim()
  if (!agentId) return undefined

  const getAgent = params.getAgent || ((id: string) => loadAgent(id) as { elevenLabsVoiceId?: string | null } | null)
  const agent = getAgent(agentId)
  const agentVoiceId = typeof agent?.elevenLabsVoiceId === 'string' ? agent.elevenLabsVoiceId.trim() : ''
  return agentVoiceId || undefined
}

export async function prepareConnectorVoiceNotePayload(params: {
  mediaPath?: string | null
  mimeType?: string | null
  voiceText?: string | null
  voiceId?: string | null
  sessionAgentId?: string | null
  contextAgentId?: string | null
  nestedContextAgentId?: string | null
  fileName?: string | null
}): Promise<{ mediaPath: string; mimeType: string; fileName: string; voiceId?: string }> {
  const mediaPath = typeof params.mediaPath === 'string' ? params.mediaPath.trim() : ''
  const requestedFileName = typeof params.fileName === 'string' ? params.fileName.trim() : ''
  const effectiveVoiceId = resolveConnectorVoiceId({
    explicitVoiceId: params.voiceId,
    sessionAgentId: params.sessionAgentId,
    contextAgentId: params.contextAgentId,
    nestedContextAgentId: params.nestedContextAgentId,
  })

  if (mediaPath) {
    const outboundMimeType = typeof params.mimeType === 'string' && params.mimeType.trim()
      ? params.mimeType.trim()
      : mimeFromPath(mediaPath)
    if (!isAudioMime(outboundMimeType)) {
      throw new Error(`send_voice_note mediaPath must point to an audio file. Resolved MIME type was "${outboundMimeType}".`)
    }
    return {
      mediaPath,
      mimeType: outboundMimeType,
      fileName: requestedFileName || path.basename(mediaPath) || 'voicenote.mp3',
      voiceId: effectiveVoiceId,
    }
  }

  const voiceText = typeof params.voiceText === 'string' ? params.voiceText.trim() : ''
  if (!voiceText) throw new Error('voiceText, message, or an audio mediaPath is required.')

  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  const audioBuffer = await synthesizeElevenLabsMp3({ text: voiceText, voiceId: effectiveVoiceId })
  const generatedFileName = `${Date.now()}-${genId()}-voicenote.mp3`
  const generatedPath = path.join(UPLOAD_DIR, generatedFileName)
  fs.writeFileSync(generatedPath, audioBuffer)

  return {
    mediaPath: generatedPath,
    mimeType: 'audio/mpeg',
    fileName: requestedFileName || 'voicenote.mp3',
    voiceId: effectiveVoiceId,
  }
}
