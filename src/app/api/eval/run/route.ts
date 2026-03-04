import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runEvalScenario } from '@/lib/server/eval/runner'
import { listEvalRuns } from '@/lib/server/eval/store'

const RunSchema = z.object({
  scenarioId: z.string().min(1),
  agentId: z.string().min(1),
})

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json()
    const parsed = RunSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join(', ') },
        { status: 400 },
      )
    }

    const result = await runEvalScenario(parsed.data.scenarioId, parsed.data.agentId)
    return NextResponse.json(result)
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)
  const runs = listEvalRuns(limit)
  return NextResponse.json(runs)
}
