import { genId } from '@/lib/id'
import {
  findDuplicateSchedule,
  findEquivalentSchedules,
  type ScheduleLike,
} from '@/lib/schedules/schedule-dedupe'
import { resolveScheduleName } from '@/lib/schedules/schedule-name'
import type { Schedule, ScheduleStatus } from '@/types'
import { dedup } from '@/lib/shared-utils'

import { normalizeSchedulePayload } from '@/lib/server/schedules/schedule-normalization'

export interface ScheduleCreatorScope {
  agentId?: string | null
  sessionId?: string | null
}

export function buildScheduleCreatorScope(schedule: Record<string, unknown> | null | undefined): ScheduleCreatorScope | null {
  if (!schedule || typeof schedule !== 'object') return null
  const agentId = typeof schedule.createdByAgentId === 'string' && schedule.createdByAgentId.trim()
    ? schedule.createdByAgentId.trim()
    : null
  const sessionId = typeof schedule.createdInSessionId === 'string' && schedule.createdInSessionId.trim()
    ? schedule.createdInSessionId.trim()
    : null
  if (!agentId && !sessionId) return null
  return { agentId, sessionId }
}

export function findRelatedScheduleIds(
  schedules: Record<string, ScheduleLike>,
  schedule: Record<string, unknown> | null | undefined,
  opts: { ignoreId?: string | null } = {},
): string[] {
  if (!schedule || typeof schedule !== 'object') return []
  const scope = buildScheduleCreatorScope(schedule)
  if (!scope?.sessionId) return []
  const matches = findEquivalentSchedules(schedules, {
    id: typeof schedule.id === 'string' ? schedule.id : null,
    agentId: typeof schedule.agentId === 'string' ? schedule.agentId : null,
    taskPrompt: typeof schedule.taskPrompt === 'string' ? schedule.taskPrompt : null,
    scheduleType: typeof schedule.scheduleType === 'string' ? schedule.scheduleType : null,
    cron: typeof schedule.cron === 'string' ? schedule.cron : null,
    intervalMs: typeof schedule.intervalMs === 'number' ? schedule.intervalMs : null,
    runAt: typeof schedule.runAt === 'number' ? schedule.runAt : null,
    createdByAgentId: scope.agentId,
    createdInSessionId: scope.sessionId,
  }, {
    ignoreId: opts.ignoreId || (typeof schedule.id === 'string' ? schedule.id : null),
    creatorScope: scope,
  })
  return dedup(matches
    .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
    .filter(Boolean))
}

export function getScheduleClusterIds(
  schedules: Record<string, ScheduleLike>,
  schedule: Record<string, unknown> | null | undefined,
  opts: { ignoreId?: string | null } = {},
): string[] {
  const id = typeof schedule?.id === 'string' ? schedule.id : ''
  const relatedIds = findRelatedScheduleIds(schedules, schedule, {
    ignoreId: opts.ignoreId || id || null,
  })
  const ids = [
    ...(!opts.ignoreId && id ? [id] : []),
    ...relatedIds,
  ]
  return dedup(ids.filter(Boolean))
}

function normalizeScheduleStatus(value: unknown): ScheduleStatus | '' {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().toLowerCase()
  return normalized === 'active'
    || normalized === 'paused'
    || normalized === 'completed'
    || normalized === 'failed'
    || normalized === 'archived'
    ? normalized
    : ''
}

export interface PrepareScheduleCreateOptions {
  input: Record<string, unknown>
  schedules: Record<string, ScheduleLike>
  now: number
  cwd?: string | null
  creatorScope?: ScheduleCreatorScope | null
  dedupeCreatorScope?: ScheduleCreatorScope | null
  followupTarget?: Partial<Schedule>
  createId?: () => string
}

export type PrepareScheduleCreateResult =
  | { ok: false; error: string }
  | {
      ok: true
      kind: 'duplicate'
      scheduleId: string
      schedule: ScheduleLike
      changed: boolean
      entries: Array<[string, ScheduleLike]>
    }
  | {
      ok: true
      kind: 'created'
      scheduleId: string
      schedule: Schedule
      entries: Array<[string, Schedule]>
    }

export function prepareScheduleCreate(options: PrepareScheduleCreateOptions): PrepareScheduleCreateResult {
  const normalized = normalizeSchedulePayload(options.input, {
    cwd: options.cwd,
    now: options.now,
  })
  if (!normalized.ok) return { ok: false, error: normalized.error }

  const candidate = normalized.value
  const dedupeScope = options.dedupeCreatorScope || null
  const duplicate = findDuplicateSchedule(options.schedules, {
    agentId: typeof candidate.agentId === 'string' ? candidate.agentId : null,
    taskPrompt: typeof candidate.taskPrompt === 'string' ? candidate.taskPrompt : '',
    scheduleType: typeof candidate.scheduleType === 'string' ? candidate.scheduleType : 'interval',
    cron: typeof candidate.cron === 'string' ? candidate.cron : null,
    intervalMs: typeof candidate.intervalMs === 'number' ? candidate.intervalMs : null,
    runAt: typeof candidate.runAt === 'number' ? candidate.runAt : null,
    createdByAgentId: dedupeScope?.agentId || null,
    createdInSessionId: dedupeScope?.sessionId || null,
  }, dedupeScope
    ? { creatorScope: dedupeScope }
    : undefined)

  if (duplicate) {
    const duplicateId = typeof duplicate.id === 'string' ? duplicate.id : ''
    const nextSchedule = { ...duplicate }
    let changed = false
    const nextName = resolveScheduleName({
      name: candidate.name ?? nextSchedule.name,
      taskPrompt: candidate.taskPrompt ?? nextSchedule.taskPrompt,
    })
    if (nextName && nextName !== nextSchedule.name) {
      nextSchedule.name = nextName
      changed = true
    }
    const nextStatus = normalizeScheduleStatus(candidate.status)
    if ((nextStatus === 'active' || nextStatus === 'paused') && nextSchedule.status !== nextStatus) {
      nextSchedule.status = nextStatus
      changed = true
    }
    if (changed) nextSchedule.updatedAt = options.now
    return {
      ok: true,
      kind: 'duplicate',
      scheduleId: duplicateId,
      schedule: nextSchedule,
      changed,
      entries: changed && duplicateId ? [[duplicateId, nextSchedule]] : [],
    }
  }

  const id = options.createId ? options.createId() : genId()
  const creatorFields = options.creatorScope
    ? {
        createdByAgentId: options.creatorScope.agentId || null,
        createdInSessionId: options.creatorScope.sessionId || null,
      }
    : {}
  const schedule = {
    id,
    ...candidate,
    ...creatorFields,
    ...(options.followupTarget || {}),
    name: resolveScheduleName({ name: candidate.name, taskPrompt: candidate.taskPrompt }),
    scheduleType: candidate.scheduleType === 'cron' || candidate.scheduleType === 'once' ? candidate.scheduleType : 'interval',
    lastRunAt: undefined,
    createdAt: options.now,
    updatedAt: options.now,
  } as Schedule

  return {
    ok: true,
    kind: 'created',
    scheduleId: id,
    schedule,
    entries: [[id, schedule]],
  }
}

export interface PrepareScheduleUpdateOptions {
  id: string
  current: ScheduleLike
  patch: Record<string, unknown>
  schedules: Record<string, ScheduleLike>
  now: number
  cwd?: string | null
  agentExists?: (agentId: string) => boolean
  propagateEquivalentStatuses?: boolean
  propagationSource?: Record<string, unknown> | null
}

export type PrepareScheduleUpdateResult =
  | { ok: false; error: string }
  | {
      ok: true
      schedule: ScheduleLike
      entries: Array<[string, ScheduleLike]>
      affectedScheduleIds: string[]
    }

export function prepareScheduleUpdate(options: PrepareScheduleUpdateOptions): PrepareScheduleUpdateResult {
  const normalized = normalizeSchedulePayload({
    ...options.current,
    ...options.patch,
    id: options.id,
  }, {
    cwd: options.cwd,
    now: options.now,
  })
  if (!normalized.ok) return { ok: false, error: normalized.error }

  const nextSchedule = {
    ...options.current,
    ...normalized.value,
    id: options.id,
    updatedAt: options.now,
  }
  const agentId = typeof nextSchedule.agentId === 'string' ? nextSchedule.agentId : ''
  if (options.agentExists && (!agentId || !options.agentExists(agentId))) {
    return { ok: false, error: `Agent not found: ${String(nextSchedule.agentId)}` }
  }
  nextSchedule.name = resolveScheduleName({
    name: nextSchedule.name,
    taskPrompt: nextSchedule.taskPrompt,
  })

  const entries: Array<[string, ScheduleLike]> = [[options.id, nextSchedule]]
  const nextStatus = normalizeScheduleStatus(nextSchedule.status)
  if (options.propagateEquivalentStatuses && (nextStatus === 'paused' || nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'archived')) {
    const relatedIds = findRelatedScheduleIds(
      options.schedules,
      options.propagationSource || options.current,
      { ignoreId: options.id },
    )
    for (const relatedId of relatedIds) {
      const related = options.schedules[relatedId]
      if (!related) continue
      entries.push([relatedId, {
        ...related,
        status: nextStatus,
        updatedAt: options.now,
      }])
    }
  }

  return {
    ok: true,
    schedule: nextSchedule,
    entries,
    affectedScheduleIds: dedup(entries.map(([id]) => id)),
  }
}
