import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadSchedules, saveSchedules } from '@/lib/server/storage'
import { resolveScheduleName } from '@/lib/schedule-name'
import { findDuplicateSchedule } from '@/lib/schedule-dedupe'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  return NextResponse.json(loadSchedules())
}

export async function POST(req: Request) {
  const body = await req.json()
  const now = Date.now()
  const schedules = loadSchedules()
  const scheduleType = body.scheduleType || 'cron'

  const duplicate = findDuplicateSchedule(schedules, {
    agentId: body.agentId || null,
    taskPrompt: body.taskPrompt || '',
    scheduleType,
    cron: body.cron,
    intervalMs: body.intervalMs,
    runAt: body.runAt,
  })
  if (duplicate) {
    const duplicateId = duplicate.id || ''
    let changed = false
    const nextName = resolveScheduleName({
      name: body.name ?? duplicate.name,
      taskPrompt: body.taskPrompt ?? duplicate.taskPrompt,
    })
    if (nextName && nextName !== duplicate.name) {
      duplicate.name = nextName
      changed = true
    }
    const normalizedStatus = typeof body.status === 'string' ? body.status.trim().toLowerCase() : ''
    if ((normalizedStatus === 'active' || normalizedStatus === 'paused') && duplicate.status !== normalizedStatus) {
      duplicate.status = normalizedStatus as 'active' | 'paused'
      changed = true
    }
    if (changed) {
      const mutableDuplicate = duplicate as Record<string, unknown>
      mutableDuplicate.updatedAt = now
      if (duplicateId) schedules[duplicateId] = duplicate
      saveSchedules(schedules)
      notify('schedules')
    }
    return NextResponse.json(duplicate)
  }

  const id = genId()

  let nextRunAt: number | undefined
  if (scheduleType === 'once' && body.runAt) {
    nextRunAt = body.runAt
  } else if (scheduleType === 'interval' && body.intervalMs) {
    nextRunAt = now + body.intervalMs
  } else if (scheduleType === 'cron') {
    // nextRunAt will be computed by the scheduler engine
    nextRunAt = undefined
  }

  schedules[id] = {
    id,
    name: resolveScheduleName({ name: body.name, taskPrompt: body.taskPrompt }),
    agentId: body.agentId,
    taskPrompt: body.taskPrompt || '',
    scheduleType,
    cron: body.cron,
    intervalMs: body.intervalMs,
    runAt: body.runAt,
    lastRunAt: undefined,
    nextRunAt,
    status: body.status || 'active',
    createdAt: now,
  }
  saveSchedules(schedules)
  notify('schedules')
  return NextResponse.json(schedules[id])
}
