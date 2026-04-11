import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { loadSchedule } from '@/lib/server/schedules/schedule-repository'
import {
  deleteScheduleFromRoute,
  updateScheduleFromRoute,
} from '@/lib/server/schedules/schedule-route-service'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedule = loadSchedule(id)
  if (!schedule) return notFound()
  return NextResponse.json(schedule)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const result = updateScheduleFromRoute(id, (body || {}) as Record<string, unknown>)
  if (!result.ok && result.status === 404) return notFound()
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const purge = searchParams.get('purge') === 'true'
  const result = deleteScheduleFromRoute(id, purge)
  if (!result.ok && result.status === 404) return notFound()
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}
