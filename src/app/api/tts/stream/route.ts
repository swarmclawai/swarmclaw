import { loadSettings } from '@/lib/server/storage'

export async function POST(req: Request) {
  const settings = loadSettings()
  const ELEVENLABS_KEY = settings.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY
  const ELEVENLABS_VOICE = settings.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE || 'JBFqnCBsd6RMkjVDRZzb'

  if (!ELEVENLABS_KEY) {
    return new Response('No ElevenLabs API key. Set one in Settings > Voice.', { status: 500 })
  }

  const { text } = await req.json()
  if (!text?.trim()) {
    return new Response('No text provided', { status: 400 })
  }

  const apiRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.slice(0, 2000),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        output_format: 'mp3_22050_32',
      }),
    },
  )

  if (!apiRes.ok) {
    const err = await apiRes.text()
    return new Response(err, { status: apiRes.status })
  }

  // Pipe the streaming response directly
  return new Response(apiRes.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  })
}
