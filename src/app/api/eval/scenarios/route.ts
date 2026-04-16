import { NextResponse } from 'next/server'
import { EVAL_SCENARIOS, getSuiteScenarios } from '@/lib/server/eval/scenarios'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')
  const suite = searchParams.get('suite')

  let scenarios = EVAL_SCENARIOS
  if (suite) scenarios = getSuiteScenarios(suite)
  if (category) scenarios = scenarios.filter((s) => s.category === category)

  return NextResponse.json(
    scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      suite: s.suite ?? 'core',
      description: s.description,
      tools: s.tools,
      timeoutMs: s.timeoutMs,
      criteriaCount: s.scoringCriteria.length,
      maxScore: s.scoringCriteria.reduce((sum, c) => sum + c.weight, 0),
    })),
  )
}
