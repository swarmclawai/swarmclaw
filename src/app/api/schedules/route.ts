import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadAgents, loadSchedules, saveSchedules } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { normalizeSchedulePayload } from '@/lib/server/schedule-normalization'
import { resolveScheduleName } from '@/lib/schedule-name'
import { findDuplicateSchedule } from '@/lib/schedule-dedupe'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asPositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  const intValue = Math.trunc(parsed)
  return intValue > 0 ? intValue : null
}

function asScheduleType(value: unknown): 'cron' | 'interval' | 'once' {
  return value === 'cron' || value === 'interval' || value === 'once' ? value : 'cron'
}

export async function GET(_req: Request) {
  return NextResponse.json(loadSchedules())
}

export async function POST(req: Request) {
  const body = await req.json()
  const now = Date.now()
  const schedules = loadSchedules()
  const normalizedSchedule = normalizeSchedulePayload(body as Record<string, unknown>, {
    cwd: WORKSPACE_DIR,
    now,
  })
  if (!normalizedSchedule.ok) {
    return NextResponse.json({ error: normalizedSchedule.error }, { status: 400 })
  }

  const candidate = normalizedSchedule.value
  const agents = loadAgents()
  if (!agents[String(candidate.agentId)]) {
    return NextResponse.json({ error: `Agent not found: ${String(candidate.agentId)}` }, { status: 400 })
  }
  const scheduleType = asScheduleType(candidate.scheduleType)
  const candidateAgentId = asString(candidate.agentId) || null
  const candidateTaskPrompt = asString(candidate.taskPrompt)
  const candidateCron = asString(candidate.cron) || null
  const candidateIntervalMs = asPositiveInt(candidate.intervalMs)
  const candidateRunAt = asPositiveInt(candidate.runAt)

  const duplicate = findDuplicateSchedule(schedules, {
    agentId: candidateAgentId,
    taskPrompt: candidateTaskPrompt,
    scheduleType,
    cron: candidateCron,
    intervalMs: candidateIntervalMs,
    runAt: candidateRunAt,
  })
  if (duplicate) {
    const duplicateId = duplicate.id || ''
    let changed = false
    const nextName = resolveScheduleName({
      name: candidate.name ?? duplicate.name,
      taskPrompt: candidate.taskPrompt ?? duplicate.taskPrompt,
    })
    if (nextName && nextName !== duplicate.name) {
      duplicate.name = nextName
      changed = true
    }
    const normalizedStatus = typeof candidate.status === 'string' ? candidate.status.trim().toLowerCase() : ''
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

  schedules[id] = {
    id,
    ...candidate,
    name: resolveScheduleName({ name: candidate.name, taskPrompt: candidate.taskPrompt }),
    scheduleType,
    lastRunAt: undefined,
    createdAt: now,
    updatedAt: now,
  }
  saveSchedules(schedules)
  notify('schedules')
  return NextResponse.json(schedules[id])
}
