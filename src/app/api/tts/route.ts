import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY
  const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE || 'JBFqnCBsd6RMkjVDRZzb'

  if (!ELEVENLABS_KEY) {
    return new NextResponse('No ElevenLabs API key', { status: 500 })
  }

  const { text } = await req.json()
  const apiRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
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
