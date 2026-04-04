import { NextResponse } from 'next/server'
import { z } from 'zod'

import { explainElevenLabsError, resolveElevenLabsConfig, synthesizeElevenLabsMp3 } from '@/lib/server/elevenlabs'
import { safeParseBody } from '@/lib/server/safe-parse-body'

const TtsRequestSchema = z.object({
  text: z.string().trim().min(1, 'No text provided'),
  voiceId: z.string().nullable().optional(),
})

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req, TtsRequestSchema)
  if (error) return error

  try {
    resolveElevenLabsConfig(body.voiceId)
    const audioBuffer = await synthesizeElevenLabsMp3({ text: body.text, voiceId: body.voiceId })
    return new NextResponse(new Uint8Array(audioBuffer), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err: unknown) {
    return new NextResponse(explainElevenLabsError(err), { status: 500 })
  }
}
