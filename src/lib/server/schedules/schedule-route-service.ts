import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { loadSessions } from '@/lib/server/sessions/session-repository'
import { prepareScheduleUpdate, prepareScheduleCreate } from '@/lib/server/schedules/schedule-service'
import {
  archiveScheduleCluster,
  purgeArchivedScheduleCluster,
  restoreArchivedScheduleCluster,
} from '@/lib/server/schedules/schedule-lifecycle'
import { loadSchedule, loadSchedules, upsertSchedule, upsertSchedules } from '@/lib/server/schedules/schedule-repository'
import { errorMessage } from '@/lib/shared-utils'
import { getScheduleSignatureKey } from '@/lib/schedules/schedule-dedupe'
import { prepareScheduledTaskRun } from '@/lib/server/tasks/task-lifecycle'
import { loadTasks, saveTask } from '@/lib/server/tasks/task-repository'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { notify } from '@/lib/server/ws-hub'
import type { Schedule } from '@/types'

type InFlightTask = {
  status?: string
  sourceScheduleKey?: string | null
}

export function listSchedulesForApi(includeArchived: boolean) {
  const schedules = loadSchedules()
  if (includeArchived) return schedules
  const filtered: typeof schedules = {}
  for (const [id, schedule] of Object.entries(schedules)) {
    if (schedule.status === 'archived') continue
    filtered[id] = schedule
  }
  return filtered
}

export function createScheduleFromRoute(body: Record<string, unknown>) {
  const now = Date.now()
  const schedules = loadSchedules()
  const agents = loadAgents()
  const candidateAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const agent = agents[candidateAgentId]
  if (!agent) {
    return { ok: false as const, status: 400 as const, payload: { error: `Agent not found: ${String(body.agentId)}` } }
  }
  if (isAgentDisabled(agent)) {
    return { ok: false as const, status: 409 as const, payload: { error: buildAgentDisabledMessage(agent, 'take scheduled work') } }
  }
  const prepared = prepareScheduleCreate({
    input: body,
    schedules,
    now,
    cwd: WORKSPACE_DIR,
  })
  if (!prepared.ok) {
    return { ok: false as const, status: 400 as const, payload: { error: prepared.error } }
  }
  if (prepared.kind === 'duplicate') {
    if (prepared.entries.length === 1) upsertSchedule(prepared.scheduleId, prepared.schedule)
    else if (prepared.entries.length > 1) upsertSchedules(prepared.entries)
    if (prepared.entries.length > 0) notify('schedules')
    return { ok: true as const, payload: prepared.schedule }
  }
  upsertSchedule(prepared.scheduleId, prepared.schedule)
  logActivity({
    entityType: 'schedule',
    entityId: prepared.scheduleId,
    action: 'created',
    actor: 'user',
    summary: `Schedule created: "${prepared.schedule.name}"`,
  })
  notify('schedules')
  return { ok: true as const, payload: prepared.schedule }
}

export function updateScheduleFromRoute(id: string, body: Record<string, unknown>) {
  const schedules = loadSchedules()
  const current = schedules[id]
  if (!current) return { ok: false as const, status: 404 as const }

  if (body.restore === true) {
    const restored = restoreArchivedScheduleCluster(id, {
      actor: { actor: 'user' },
    })
    if (!restored.ok || !restored.schedule) {
      return { ok: false as const, status: 409 as const, payload: { error: 'Schedule is not archived.' } }
    }
    return {
      ok: true as const,
      payload: {
        ...restored.schedule,
        restoredIds: restored.restoredIds,
      },
    }
  }

  if (body.status === 'archived') {
    const archived = archiveScheduleCluster(id, {
      actor: { actor: 'user' },
    })
    if (!archived.ok || !archived.schedule) {
      return { ok: false as const, status: 500 as const, payload: { error: 'Failed to archive schedule.' } }
    }
    return {
      ok: true as const,
      payload: {
        ...archived.schedule,
        archivedIds: archived.archivedIds,
        cancelledTaskIds: archived.cancelledTaskIds,
        abortedRunSessionIds: archived.abortedRunSessionIds,
      },
    }
  }

  const sessions = loadSessions()
  const agents = loadAgents()
  const sessionCwd = typeof current.createdInSessionId === 'string'
    ? sessions[current.createdInSessionId]?.cwd
    : null
  const prepared = prepareScheduleUpdate({
    id,
    current,
    patch: body,
    schedules,
    now: Date.now(),
    cwd: sessionCwd || WORKSPACE_DIR,
    agentExists: (agentId) => Boolean(agents[agentId]),
    propagateEquivalentStatuses: true,
    propagationSource: current as unknown as Record<string, unknown>,
  })
  if (!prepared.ok) {
    return { ok: false as const, status: 400 as const, payload: { error: errorMessage(prepared.error) } }
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
  return {
    ok: true as const,
    payload: prepared.affectedScheduleIds.length > 1
      ? { ...prepared.schedule, affectedScheduleIds: prepared.affectedScheduleIds }
      : prepared.schedule,
  }
}

export function deleteScheduleFromRoute(id: string, purge: boolean) {
  const current = loadSchedule(id)
  if (!current) return { ok: false as const, status: 404 as const }
  if (purge) {
    const purged = purgeArchivedScheduleCluster(id, {
      actor: { actor: 'user' },
    })
    if (!purged.ok) {
      return { ok: false as const, status: 409 as const, payload: { error: 'Only archived schedules can be purged.' } }
    }
    return { ok: true as const, payload: { ok: true, purgedIds: purged.purgedIds } }
  }
  const archived = archiveScheduleCluster(id, {
    actor: { actor: 'user' },
  })
  if (!archived.ok || !archived.schedule) {
    return { ok: false as const, status: 500 as const, payload: { error: 'Failed to archive schedule.' } }
  }
  return {
    ok: true as const,
    payload: {
      ok: true,
      archivedIds: archived.archivedIds,
      cancelledTaskIds: archived.cancelledTaskIds,
      removedQueuedTaskIds: archived.removedQueuedTaskIds,
      abortedRunSessionIds: archived.abortedRunSessionIds,
      schedule: archived.schedule,
    },
  }
}

export function runScheduleNow(id: string) {
  const schedule = loadSchedule(id) as Schedule | null
  if (!schedule) return { ok: false as const, status: 404 as const }
  if (schedule.status === 'archived') {
    return { ok: false as const, status: 409 as const, payload: { error: 'Archived schedules must be restored before they can run.' } }
  }

  const agents = loadAgents()
  const agent = agents[schedule.agentId]
  if (!agent) return { ok: false as const, status: 400 as const, payload: { error: 'Agent not found' } }
  if (isAgentDisabled(agent)) {
    return { ok: false as const, status: 409 as const, payload: { error: buildAgentDisabledMessage(agent, 'run schedules') } }
  }

  const tasks = loadTasks()
  const scheduleSignature = getScheduleSignatureKey(schedule)
  if (scheduleSignature) {
    const inFlight = Object.values(tasks as Record<string, InFlightTask>).some((task) =>
      task
      && (task.status === 'queued' || task.status === 'running')
      && task.sourceScheduleKey === scheduleSignature
    )
    if (inFlight) {
      return { ok: true as const, payload: { ok: true, queued: false, reason: 'in_flight' } }
    }
  }

  const now = Date.now()
  schedule.runNumber = (schedule.runNumber || 0) + 1
  const { taskId } = prepareScheduledTaskRun({
    schedule,
    tasks,
    now,
    scheduleSignature,
  })
  saveTask(taskId, tasks[taskId])
  enqueueTask(taskId)
  pushMainLoopEventToMainSessions({
    type: 'schedule_fired',
    text: `Schedule fired manually: "${schedule.name}" (${schedule.id}) run #${schedule.runNumber} — task ${taskId}`,
  })
  schedule.lastRunAt = now
  upsertSchedule(schedule.id, schedule)
  logActivity({
    entityType: 'schedule',
    entityId: schedule.id,
    action: 'started',
    actor: 'user',
    summary: `Schedule run started: "${schedule.name}"`,
    detail: { taskId, runNumber: schedule.runNumber },
  })

  return { ok: true as const, payload: { ok: true, queued: true, taskId, runNumber: schedule.runNumber } }
}
