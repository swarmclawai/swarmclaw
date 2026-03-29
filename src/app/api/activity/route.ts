import { NextResponse } from 'next/server'
import { queryActivity } from '@/lib/server/activity/activity-log'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const entityType = searchParams.get('entityType') ?? undefined
  const entityId = searchParams.get('entityId') ?? undefined
  const actor = searchParams.get('actor') ?? undefined
  const action = searchParams.get('action') ?? undefined
  const sinceRaw = searchParams.get('since')
  const since = sinceRaw ? Number(sinceRaw) : undefined
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 50))
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)

  const entries = queryActivity({ entityType, entityId, actor, action, since, limit, offset })
  return NextResponse.json(entries)
}
