import { NextResponse } from 'next/server'
import { deleteSchedule, loadAgents, loadSchedules, loadSessions, upsertSchedules } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { notFound } from '@/lib/server/collection-helpers'
import { getScheduleClusterIds, prepareScheduleUpdate } from '@/lib/server/schedules/schedule-service'
import { errorMessage } from '@/lib/shared-utils'
import { notify } from '@/lib/server/ws-hub'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const schedules = loadSchedules()
  const current = schedules[id]
  if (!current) return notFound()
  const sessions = loadSessions()
  const agents = loadAgents()
  const sessionCwd = typeof current.createdInSessionId === 'string'
    ? sessions[current.createdInSessionId]?.cwd
    : null
  const prepared = prepareScheduleUpdate({
    id,
    current,
    patch: body as Record<string, unknown>,
    schedules,
    now: Date.now(),
    cwd: sessionCwd || WORKSPACE_DIR,
    agentExists: (agentId) => Boolean(agents[agentId]),
    propagateEquivalentStatuses: true,
    propagationSource: current,
  })
  if (!prepared.ok) {
    const message = errorMessage(prepared.error)
    return NextResponse.json({ error: message }, { status: 400 })
  }
  upsertSchedules(prepared.entries)
  notify('schedules')
  return NextResponse.json(
    prepared.affectedScheduleIds.length > 1
      ? { ...prepared.schedule, affectedScheduleIds: prepared.affectedScheduleIds }
      : prepared.schedule,
  )
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedules = loadSchedules()
  const current = schedules[id]
  if (!current) return notFound()
  const deleteIds = getScheduleClusterIds(schedules, current)
  for (const deleteId of deleteIds) {
    deleteSchedule(deleteId)
  }
  notify('schedules')
  return NextResponse.json({
    ok: true,
    deletedIds: deleteIds,
  })
}
