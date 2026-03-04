import { NextResponse } from 'next/server'
import { EVAL_SCENARIOS } from '@/lib/server/eval/scenarios'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')

  const scenarios = category
    ? EVAL_SCENARIOS.filter((s) => s.category === category)
    : EVAL_SCENARIOS

  return NextResponse.json(
    scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      description: s.description,
      tools: s.tools,
      timeoutMs: s.timeoutMs,
      criteriaCount: s.scoringCriteria.length,
      maxScore: s.scoringCriteria.reduce((sum, c) => sum + c.weight, 0),
    })),
  )
}
