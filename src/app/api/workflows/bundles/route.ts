import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { createWorkflowBundle } from '@/lib/server/workflows/workflow-service'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { data, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const result = createWorkflowBundle(data)
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}
