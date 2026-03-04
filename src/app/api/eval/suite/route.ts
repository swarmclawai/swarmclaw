import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runEvalSuite } from '@/lib/server/eval/runner'

const SuiteSchema = z.object({
  agentId: z.string().min(1),
  categories: z.array(z.string()).optional(),
})

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json()
    const parsed = SuiteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join(', ') },
        { status: 400 },
      )
    }

    const result = await runEvalSuite(parsed.data.agentId, parsed.data.categories)
    return NextResponse.json(result)
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
