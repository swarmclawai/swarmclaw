import { NextResponse } from 'next/server'
import { getWorkflowLedger } from '@/lib/server/workflows/workflow-service'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = getWorkflowLedger(id)
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}
