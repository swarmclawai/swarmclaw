import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { continueWorkflowRun } from '@/lib/server/workflows/workflow-service'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const result = continueWorkflowRun(id, data)
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}
