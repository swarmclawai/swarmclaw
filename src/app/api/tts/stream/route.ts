import { NextResponse } from 'next/server'
import { z } from 'zod'

import { explainElevenLabsError, requestElevenLabsMp3Stream } from '@/lib/server/elevenlabs'
import { synthesizeMiniMaxMp3 } from '@/lib/server/minimax-tts'
import { safeParseBody } from '@/lib/server/safe-parse-body'

const TtsStreamRequestSchema = z.object({
  text: z.string().trim().min(1, 'No text provided'),
  voiceId: z.string().nullable().optional(),
})

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req, TtsStreamRequestSchema)
  if (error) return error

  try {
    if (process.env.MINIMAX_API_KEY) {
      const audio = await synthesizeMiniMaxMp3({ text: body.text, voiceId: body.voiceId })
      return new Response(new Uint8Array(audio), {
        headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' },
      })
    }
    const apiRes = await requestElevenLabsMp3Stream({ text: body.text, voiceId: body.voiceId })
    return new Response(apiRes.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: explainElevenLabsError(err) },
      { status: 500 },
    )
  }
}
