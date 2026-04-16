import { NextResponse } from 'next/server'
import { z } from 'zod'

import { explainElevenLabsError, requestElevenLabsMp3Stream } from '@/lib/server/elevenlabs'
import { safeParseBody } from '@/lib/server/safe-parse-body'

const TtsStreamRequestSchema = z.object({
  text: z.string().trim().min(1, 'No text provided'),
  voiceId: z.string().nullable().optional(),
})

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req, TtsStreamRequestSchema)
  if (error) return error

  try {
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
