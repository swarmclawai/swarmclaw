import { NextResponse } from 'next/server'

import { rejectSkillSuggestion, summarizeSuggestionError } from '@/lib/server/skills/skill-suggestions'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const suggestion = rejectSkillSuggestion(id)
    return NextResponse.json(suggestion)
  } catch (err: unknown) {
    return NextResponse.json({ error: summarizeSuggestionError(err) }, { status: 400 })
  }
}
