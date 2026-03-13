import { NextResponse } from 'next/server'
import { loadAgents, loadSchedules, loadSessions, logActivity, upsertSchedules } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { notFound } from '@/lib/server/collection-helpers'
import { prepareScheduleUpdate } from '@/lib/server/schedules/schedule-service'
import {
  archiveScheduleCluster,
  purgeArchivedScheduleCluster,
  restoreArchivedScheduleCluster,
} from '@/lib/server/schedules/schedule-lifecycle'
import { errorMessage } from '@/lib/shared-utils'
import { notify } from '@/lib/server/ws-hub'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const schedules = loadSchedules()
  const current = schedules[id]
  if (!current) return notFound()

  if (body?.restore === true) {
    const restored = restoreArchivedScheduleCluster(id, {
      actor: { actor: 'user' },
    })
    if (!restored.ok || !restored.schedule) {
      return NextResponse.json({ error: 'Schedule is not archived.' }, { status: 409 })
    }
    return NextResponse.json({
      ...restored.schedule,
      restoredIds: restored.restoredIds,
    })
  }

  if (body?.status === 'archived') {
    const archived = archiveScheduleCluster(id, {
      actor: { actor: 'user' },
    })
    if (!archived.ok || !archived.schedule) {
      return NextResponse.json({ error: 'Failed to archive schedule.' }, { status: 500 })
    }
    return NextResponse.json({
      ...archived.schedule,
      archivedIds: archived.archivedIds,
      cancelledTaskIds: archived.cancelledTaskIds,
      abortedRunSessionIds: archived.abortedRunSessionIds,
    })
  }

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
  logActivity({
    entityType: 'schedule',
    entityId: id,
    action: 'updated',
    actor: 'user',
    summary: `Schedule updated: "${prepared.schedule.name}"`,
    detail: prepared.affectedScheduleIds.length > 1 ? { affectedScheduleIds: prepared.affectedScheduleIds } : undefined,
  })
  notify('schedules')
  return NextResponse.json(
    prepared.affectedScheduleIds.length > 1
      ? { ...prepared.schedule, affectedScheduleIds: prepared.affectedScheduleIds }
      : prepared.schedule,
  )
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const schedules = loadSchedules()
  const current = schedules[id]
  if (!current) return notFound()

  const { searchParams } = new URL(req.url)
  const purge = searchParams.get('purge') === 'true'
  if (purge) {
    const purged = purgeArchivedScheduleCluster(id, {
      actor: { actor: 'user' },
    })
    if (!purged.ok) {
      return NextResponse.json({ error: 'Only archived schedules can be purged.' }, { status: 409 })
    }
    return NextResponse.json({
      ok: true,
      purgedIds: purged.purgedIds,
    })
  }

  const archived = archiveScheduleCluster(id, {
    actor: { actor: 'user' },
  })
  if (!archived.ok || !archived.schedule) {
    return NextResponse.json({ error: 'Failed to archive schedule.' }, { status: 500 })
  }
  return NextResponse.json({
    ok: true,
    archivedIds: archived.archivedIds,
    cancelledTaskIds: archived.cancelledTaskIds,
    removedQueuedTaskIds: archived.removedQueuedTaskIds,
    abortedRunSessionIds: archived.abortedRunSessionIds,
    schedule: archived.schedule,
  })
}
