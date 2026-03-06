import { NextResponse } from 'next/server'
import { loadAgents, loadSchedules, loadSessions, saveSchedules, deleteSchedule } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { resolveScheduleName } from '@/lib/schedule-name'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import { normalizeSchedulePayload } from '@/lib/server/schedule-normalization'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadSchedules, save: saveSchedules, deleteFn: deleteSchedule, topic: 'schedules' }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const sessions = loadSessions()
  const agents = loadAgents()
  let result = null
  try {
    result = mutateItem(ops, id, (schedule) => {
      const sessionCwd = typeof schedule.createdInSessionId === 'string'
        ? sessions[schedule.createdInSessionId]?.cwd
        : null
      const normalized = normalizeSchedulePayload({
        ...schedule,
        ...(body as Record<string, unknown>),
        id,
      }, {
        cwd: sessionCwd || WORKSPACE_DIR,
        now: Date.now(),
      })
      if (!normalized.ok) throw new Error(normalized.error)
      const nextSchedule = {
        ...schedule,
        ...normalized.value,
        id,
        updatedAt: Date.now(),
      }
      if (!agents[String(nextSchedule.agentId)]) {
        throw new Error(`Agent not found: ${String(nextSchedule.agentId)}`)
      }
      nextSchedule.name = resolveScheduleName({
        name: nextSchedule.name,
        taskPrompt: nextSchedule.taskPrompt,
      })
      return nextSchedule
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 400 })
  }
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ ok: true })
}
