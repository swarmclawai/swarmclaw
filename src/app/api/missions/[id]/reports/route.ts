import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import {
  getMission,
  listMissionReports,
  saveMissionReport,
} from '@/lib/server/missions/mission-repository'
import { buildMissionReport } from '@/lib/server/missions/mission-report-builder'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = getMission(id)
  if (!mission) return notFound()
  const url = new URL(req.url)
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Math.min(100, Math.max(1, Number.parseInt(limitRaw, 10) || 20)) : 20
  return NextResponse.json(listMissionReports(id, limit))
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const mission = getMission(id)
  if (!mission) return notFound()
  const from = mission.reportSchedule?.lastReportAt
    ?? mission.usage.startedAt
    ?? mission.createdAt
  const to = Date.now()
  const { report } = buildMissionReport(mission, { from, to }, { windowSource: 'on_demand' })
  saveMissionReport(report)
  return NextResponse.json(report)
}
