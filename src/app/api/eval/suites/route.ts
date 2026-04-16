import { NextResponse } from 'next/server'
import { EVAL_SCENARIOS, getSuiteScenarios, listSuites } from '@/lib/server/eval/scenarios'

export async function GET() {
  const suites = listSuites()
  const summary = suites.map((name) => {
    const scenarios = name === 'core' ? EVAL_SCENARIOS.filter(s => !s.suite || s.suite === 'core') : getSuiteScenarios(name)
    return {
      name,
      count: scenarios.length,
      maxScore: scenarios.reduce(
        (sum, s) => sum + s.scoringCriteria.reduce((a, c) => a + c.weight, 0),
        0,
      ),
      categories: Array.from(new Set(scenarios.map(s => s.category))),
    }
  })
  return NextResponse.json(summary)
}
