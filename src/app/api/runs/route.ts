import { NextResponse } from 'next/server'
import { listRuns, type SessionRunStatus } from '@/lib/server/runtime/session-run-manager'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sessionId = searchParams.get('sessionId') || undefined
  const status = (searchParams.get('status') || undefined) as SessionRunStatus | undefined
  const limitRaw = searchParams.get('limit')
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined

  const runs = listRuns({ sessionId, status, limit })
  return NextResponse.json(runs)
}
