import { NextResponse } from 'next/server'

import { materializeSkillSuggestion, summarizeSuggestionError } from '@/lib/server/skills/skill-suggestions'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const result = materializeSkillSuggestion(id)
    return NextResponse.json(result)
  } catch (err: unknown) {
    return NextResponse.json({ error: summarizeSuggestionError(err) }, { status: 400 })
  }
}
