const DEFAULT_MODEL = 'speech-2.8-hd'
const DEFAULT_ENDPOINT = 'https://api.minimax.io/v1/t2a_v2'

export async function synthesizeMiniMaxMp3(params: {
  text: string
  model?: string
  endpoint?: string
  apiKey?: string
  voiceId?: string | null
}): Promise<Buffer> {
  const apiKey = params.apiKey || process.env.MINIMAX_API_KEY
  if (!apiKey) throw new Error('No MiniMax API key configured.')
  const response = await fetch(params.endpoint || process.env.MINIMAX_TTS_ENDPOINT || DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model || process.env.MINIMAX_TTS_MODEL || DEFAULT_MODEL,
      text: params.text.trim(),
      stream: false,
      ...(params.voiceId ? { voice_setting: { voice_id: params.voiceId } } : {}),
      audio_setting: { format: 'mp3' },
    }),
  })
  if (!response.ok) throw new Error(`MiniMax TTS request failed (${response.status})`)
  const payload = await response.json() as { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string } }
  if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
    throw new Error(payload.base_resp.status_msg || 'MiniMax TTS request failed')
  }
  if (!payload.data?.audio) throw new Error('MiniMax TTS response did not include audio data.')
  return Buffer.from(payload.data.audio, 'hex')
}
