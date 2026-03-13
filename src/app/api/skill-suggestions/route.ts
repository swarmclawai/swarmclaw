import { NextResponse } from 'next/server'

import { createSkillSuggestionFromSession, listSkillSuggestions, summarizeSuggestionError } from '@/lib/server/skills/skill-suggestions'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listSkillSuggestions())
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required.' }, { status: 400 })
    }
    const suggestion = await createSkillSuggestionFromSession(sessionId)
    return NextResponse.json(suggestion)
  } catch (err: unknown) {
    return NextResponse.json({ error: summarizeSuggestionError(err) }, { status: 400 })
  }
}
