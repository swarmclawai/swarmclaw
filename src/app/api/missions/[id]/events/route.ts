import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { getMission, listMissionEvents } from '@/lib/server/missions/mission-repository'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = getMission(id)
  if (!mission) return notFound()
  const url = new URL(req.url)
  const sinceRaw = url.searchParams.get('sinceAt')
  const untilRaw = url.searchParams.get('untilAt')
  const sinceAt = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined
  const untilAt = untilRaw ? Number.parseInt(untilRaw, 10) : undefined
  const events = listMissionEvents(id, {
    sinceAt: Number.isFinite(sinceAt) ? sinceAt : undefined,
    untilAt: Number.isFinite(untilAt) ? untilAt : undefined,
  })
  return NextResponse.json(events)
}
