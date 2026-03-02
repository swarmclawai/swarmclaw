import { NextResponse } from 'next/server'
import { loadSettings } from '@/lib/server/storage'

export async function POST(req: Request) {
  const settings = loadSettings()
  const ELEVENLABS_KEY = settings.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY
  const ELEVENLABS_VOICE = settings.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE || 'JBFqnCBsd6RMkjVDRZzb'

  if (!ELEVENLABS_KEY) {
    return new NextResponse('No ElevenLabs API key. Set one in Settings > Voice.', { status: 500 })
  }

  const { text, voiceId } = await req.json()
  const voice = voiceId || ELEVENLABS_VOICE
  const apiRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })

  if (!apiRes.ok) {
    const err = await apiRes.text()
    return new NextResponse(err, { status: apiRes.status })
  }

  const audioBuffer = await apiRes.arrayBuffer()
  return new NextResponse(audioBuffer, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
    },
  })
}
