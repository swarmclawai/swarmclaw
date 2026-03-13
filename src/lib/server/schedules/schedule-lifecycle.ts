import { CronExpressionParser } from 'cron-parser'

import { genId } from '@/lib/id'
import type { BoardTask, Schedule, ScheduleStatus, Session } from '@/types'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import { cancelSessionRuns } from '@/lib/server/runtime/session-run-manager'
import {
  deleteSchedule,
  loadQueue,
  loadSchedules,
  loadSessions,
  loadTasks,
  logActivity,
  saveQueue,
  saveSchedules,
  saveSessions,
  saveTasks,
} from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { getScheduleClusterIds } from '@/lib/server/schedules/schedule-service'

type RestorableScheduleStatus = Exclude<ScheduleStatus, 'archived'>

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'archived'])

export interface ScheduleLifecycleActor {
  actor: string
  actorId?: string
}

export interface ScheduleArchiveResult {
  ok: boolean
  archivedIds: string[]
  cancelledTaskIds: string[]
  removedQueuedTaskIds: string[]
  abortedRunSessionIds: string[]
  schedule: Schedule | null
}

export interface ScheduleRestoreResult {
  ok: boolean
  restoredIds: string[]
  schedule: Schedule | null
}

export interface SchedulePurgeResult {
  ok: boolean
  purgedIds: string[]
}

function computeNextRunAt(schedule: Pick<Schedule, 'scheduleType' | 'cron' | 'intervalMs' | 'runAt' | 'timezone' | 'staggerSec'>, now: number): number | undefined {
  const applyStagger = (timestamp: number): number => {
    if (!schedule.staggerSec || schedule.staggerSec <= 0) return timestamp
    return timestamp + Math.floor(Math.random() * schedule.staggerSec * 1000)
  }

  if (schedule.scheduleType === 'once') {
    return typeof schedule.runAt === 'number' && Number.isFinite(schedule.runAt)
      ? applyStagger(schedule.runAt)
      : undefined
  }
  if (schedule.scheduleType === 'interval') {
    return typeof schedule.intervalMs === 'number' && Number.isFinite(schedule.intervalMs)
      ? applyStagger(now + schedule.intervalMs)
      : undefined
  }
  if (schedule.scheduleType === 'cron' && typeof schedule.cron === 'string' && schedule.cron.trim()) {
    try {
      const interval = CronExpressionParser.parse(
        schedule.cron,
        schedule.timezone ? { tz: schedule.timezone } : undefined,
      )
      return applyStagger(interval.next().getTime())
    } catch {
      return undefined
    }
  }
  return undefined
}

function cloneSchedule(schedule: Schedule): Schedule {
  return { ...schedule }
}

function pickScheduleCluster(scheduleId: string): { current: Schedule | null; ids: string[]; schedules: Record<string, Schedule> } {
  const schedules = loadSchedules()
  const current = schedules[scheduleId] || null
  if (!current) return { current: null, ids: [], schedules }
  return {
    current,
    ids: getScheduleClusterIds(schedules, current),
    schedules,
  }
}

function disableSessionHeartbeatLocally(
  sessions: Record<string, Session>,
  sessionId: string | null | undefined,
  now: number,
): boolean {
  if (!sessionId) return false
  const session = sessions[sessionId]
  if (!session || session.heartbeatEnabled === false) return false
  session.heartbeatEnabled = false
  session.lastActiveAt = now
  return true
}

function markTaskCancelled(task: BoardTask, reason: string, now: number): void {
  task.status = 'cancelled'
  task.retryScheduledAt = null
  task.deadLetteredAt = null
  task.completedAt = null
  task.updatedAt = now
  task.error = reason.slice(0, 500)
  task.checkpoint = {
    ...(task.checkpoint || {}),
    note: reason,
    updatedAt: now,
  }
  if (!task.comments) task.comments = []
  task.comments.push({
    id: genId(),
    author: 'System',
    text: reason,
    createdAt: now,
  })
}

export function archiveScheduleCluster(
  scheduleId: string,
  opts: {
    now?: number
    actor?: ScheduleLifecycleActor | null
    reason?: string
  } = {},
): ScheduleArchiveResult {
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const { current, ids, schedules } = pickScheduleCluster(scheduleId)
  if (!current || ids.length === 0) {
    return {
      ok: false,
      archivedIds: [],
      cancelledTaskIds: [],
      removedQueuedTaskIds: [],
      abortedRunSessionIds: [],
      schedule: null,
    }
  }

  const tasks = loadTasks()
  const queue = loadQueue()
  const sessions = loadSessions()
  const queueSet = new Set(queue)
  const linkedTaskIds = new Set<string>()
  for (const id of ids) {
    const schedule = schedules[id]
    if (!schedule) continue
    if (typeof schedule.linkedTaskId === 'string' && schedule.linkedTaskId.trim()) {
      linkedTaskIds.add(schedule.linkedTaskId.trim())
    }
  }

  const cancelledTaskIds: string[] = []
  const removedQueuedTaskIds: string[] = []
  const abortedRunSessionIds: string[] = []
  let sessionsDirty = false
  let tasksDirty = false

  for (const task of Object.values(tasks) as BoardTask[]) {
    const sourceScheduleId = typeof task.sourceScheduleId === 'string' ? task.sourceScheduleId.trim() : ''
    const matchesSchedule = sourceScheduleId && ids.includes(sourceScheduleId)
    const matchesLinkedTask = linkedTaskIds.has(task.id)
    if (!matchesSchedule && !matchesLinkedTask) continue
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue

    const reason = opts.reason
      || `Schedule archived: "${current.name}" (${current.id}). In-flight work was cancelled.`
    markTaskCancelled(task, reason, now)
    cancelledTaskIds.push(task.id)
    tasksDirty = true

    if (queueSet.has(task.id)) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index] !== task.id) continue
        queue.splice(index, 1)
      }
      queueSet.delete(task.id)
      removedQueuedTaskIds.push(task.id)
    }

    const sessionId = typeof task.sessionId === 'string' ? task.sessionId.trim() : ''
    if (sessionId) {
      const cancelled = cancelSessionRuns(sessionId, reason)
      if (cancelled.cancelledRunning) {
        abortedRunSessionIds.push(sessionId)
      }
      sessionsDirty = disableSessionHeartbeatLocally(sessions, sessionId, now) || sessionsDirty
    }
  }

  for (const id of ids) {
    const schedule = schedules[id]
    if (!schedule) continue
    const previousStatus = schedule.status === 'archived'
      ? (schedule.archivedFromStatus || 'active')
      : schedule.status
    schedules[id] = {
      ...cloneSchedule(schedule),
      status: 'archived',
      archivedAt: schedule.archivedAt || now,
      archivedFromStatus: previousStatus as RestorableScheduleStatus,
      nextRunAt: undefined,
      updatedAt: now,
    }
  }

  if (tasksDirty) {
    saveTasks(tasks)
    notify('tasks')
    notify('runs')
  }
  if (removedQueuedTaskIds.length > 0) saveQueue(queue)
  if (sessionsDirty) saveSessions(sessions)
  saveSchedules(schedules)
  notify('schedules')

  const actor = opts.actor || null
  if (actor) {
    for (const id of ids) {
      const schedule = schedules[id]
      if (!schedule) continue
      logActivity({
        entityType: 'schedule',
        entityId: id,
        action: 'archived',
        actor: actor.actor,
        actorId: actor.actorId,
        summary: `Schedule archived: "${schedule.name}"${cancelledTaskIds.length ? ` (${cancelledTaskIds.length} task${cancelledTaskIds.length === 1 ? '' : 's'} cancelled)` : ''}`,
        detail: {
          archivedIds: ids,
          cancelledTaskIds,
          removedQueuedTaskIds,
          abortedRunSessionIds,
        },
      })
    }
  }

  pushMainLoopEventToMainSessions({
    type: 'schedule_archived',
    text: `Schedule archived: "${current.name}" (${current.id})${cancelledTaskIds.length ? ` — cancelled ${cancelledTaskIds.length} linked task${cancelledTaskIds.length === 1 ? '' : 's'}` : ''}.`,
  })

  return {
    ok: true,
    archivedIds: ids,
    cancelledTaskIds,
    removedQueuedTaskIds,
    abortedRunSessionIds,
    schedule: schedules[scheduleId] || schedules[ids[0]] || null,
  }
}

export function restoreArchivedScheduleCluster(
  scheduleId: string,
  opts: {
    now?: number
    actor?: ScheduleLifecycleActor | null
  } = {},
): ScheduleRestoreResult {
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const { current, ids, schedules } = pickScheduleCluster(scheduleId)
  if (!current || ids.length === 0) {
    return {
      ok: false,
      restoredIds: [],
      schedule: null,
    }
  }

  const restoredIds: string[] = []
  for (const id of ids) {
    const schedule = schedules[id]
    if (!schedule || schedule.status !== 'archived') continue
    const restoreStatus = (schedule.archivedFromStatus || 'active') as RestorableScheduleStatus
    const nextRunAt = restoreStatus === 'active'
      ? computeNextRunAt(schedule, now)
      : restoreStatus === 'completed' || restoreStatus === 'failed'
        ? undefined
        : schedule.nextRunAt
    schedules[id] = {
      ...cloneSchedule(schedule),
      status: restoreStatus,
      archivedAt: null,
      archivedFromStatus: null,
      nextRunAt,
      updatedAt: now,
    }
    restoredIds.push(id)
  }

  if (restoredIds.length === 0) {
    return {
      ok: false,
      restoredIds: [],
      schedule: null,
    }
  }

  saveSchedules(schedules)
  notify('schedules')

  const actor = opts.actor || null
  if (actor) {
    for (const id of restoredIds) {
      const schedule = schedules[id]
      if (!schedule) continue
      logActivity({
        entityType: 'schedule',
        entityId: id,
        action: 'restored',
        actor: actor.actor,
        actorId: actor.actorId,
        summary: `Schedule restored: "${schedule.name}"`,
        detail: {
          restoredIds,
          status: schedule.status,
        },
      })
    }
  }

  pushMainLoopEventToMainSessions({
    type: 'schedule_restored',
    text: `Schedule restored: "${current.name}" (${current.id}).`,
  })

  return {
    ok: true,
    restoredIds,
    schedule: schedules[scheduleId] || schedules[ids[0]] || null,
  }
}

export function purgeArchivedScheduleCluster(
  scheduleId: string,
  opts: {
    actor?: ScheduleLifecycleActor | null
  } = {},
): SchedulePurgeResult {
  const { current, ids, schedules } = pickScheduleCluster(scheduleId)
  if (!current || ids.length === 0 || current.status !== 'archived') {
    return {
      ok: false,
      purgedIds: [],
    }
  }

  for (const id of ids) {
    const schedule = schedules[id]
    if (!schedule || schedule.status !== 'archived') continue
    deleteSchedule(id)
  }
  notify('schedules')

  const actor = opts.actor || null
  if (actor) {
    for (const id of ids) {
      logActivity({
        entityType: 'schedule',
        entityId: id,
        action: 'deleted',
        actor: actor.actor,
        actorId: actor.actorId,
        summary: `Schedule purged: "${current.name}"`,
        detail: {
          purgedIds: ids,
        },
      })
    }
  }

  pushMainLoopEventToMainSessions({
    type: 'schedule_purged',
    text: `Archived schedule purged: "${current.name}" (${current.id}).`,
  })

  return {
    ok: true,
    purgedIds: ids,
  }
}
