import { genId } from '@/lib/id'
import { loadSchedules, loadAgents, loadTasks, upsertSchedule, upsertSchedules, upsertTask } from './storage'
import { enqueueTask } from './queue'
import { CronExpressionParser } from 'cron-parser'
import { pushMainLoopEventToMainSessions } from './main-agent-loop'
import { getScheduleSignatureKey } from '@/lib/schedule-dedupe'
import { enqueueSystemEvent } from './system-events'
import { requestHeartbeatNow } from './heartbeat-wake'
import { processDueWatchJobs } from './watch-jobs'
import { isAgentDisabled } from './agent-availability'

const TICK_INTERVAL = 60_000 // 60 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

interface ScheduleTaskLike {
  status?: string
  sourceScheduleKey?: string | null
}

interface SchedulerScheduleLike {
  id: string
  name: string
  agentId: string
  taskPrompt: string
  scheduleType: 'cron' | 'interval' | 'once'
  cron?: string
  intervalMs?: number
  runAt?: number
  lastRunAt?: number
  nextRunAt?: number
  status: 'active' | 'paused' | 'completed' | 'failed'
  linkedTaskId?: string | null
  runNumber?: number
  createdInSessionId?: string | null
  createdByAgentId?: string | null
  followupConnectorId?: string | null
  followupChannelId?: string | null
  followupThreadId?: string | null
  followupSenderId?: string | null
  followupSenderName?: string | null
}

export function startScheduler() {
  if (intervalId) return
  console.log('[scheduler] Starting scheduler engine (60s tick)')

  // Compute initial nextRunAt for cron schedules missing it
  computeNextRuns()

  intervalId = setInterval(tick, TICK_INTERVAL)
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    console.log('[scheduler] Stopped scheduler engine')
  }
}

function computeNextRuns() {
  const schedules = loadSchedules()
  const changedEntries: Array<[string, SchedulerScheduleLike]> = []
  for (const schedule of Object.values(schedules) as SchedulerScheduleLike[]) {
    if (schedule.status !== 'active') continue
    if (schedule.scheduleType === 'cron' && schedule.cron && !schedule.nextRunAt) {
      try {
        const interval = CronExpressionParser.parse(schedule.cron)
        schedule.nextRunAt = interval.next().getTime()
        changedEntries.push([schedule.id, schedule])
      } catch (err) {
        console.error(`[scheduler] Invalid cron for ${schedule.id}:`, err)
        schedule.status = 'failed'
        changedEntries.push([schedule.id, schedule])
      }
    }
  }
  if (changedEntries.length > 0) upsertSchedules(changedEntries)
}

async function tick() {
  const now = Date.now()
  await processDueWatchJobs(now)
  const schedules = loadSchedules()
  const agents = loadAgents()
  const tasks = loadTasks()
  const inFlightScheduleKeys = new Set<string>(
    Object.values(tasks as Record<string, ScheduleTaskLike>)
      .filter((task) => task && (task.status === 'queued' || task.status === 'running'))
      .map((task) => (typeof task.sourceScheduleKey === 'string' ? task.sourceScheduleKey : ''))
      .filter((value: string) => value.length > 0),
  )

  const advanceSchedule = (schedule: SchedulerScheduleLike): void => {
    if (schedule.scheduleType === 'cron' && schedule.cron) {
      try {
        const interval = CronExpressionParser.parse(schedule.cron)
        schedule.nextRunAt = interval.next().getTime()
      } catch {
        schedule.status = 'failed'
      }
    } else if (schedule.scheduleType === 'interval' && schedule.intervalMs) {
      schedule.nextRunAt = now + schedule.intervalMs
    } else if (schedule.scheduleType === 'once') {
      schedule.status = 'completed'
      schedule.nextRunAt = undefined
    }
  }

  for (const schedule of Object.values(schedules) as SchedulerScheduleLike[]) {
    if (schedule.status !== 'active') continue
    if (!schedule.nextRunAt || schedule.nextRunAt > now) continue

    const scheduleSignature = getScheduleSignatureKey(schedule)
    if (scheduleSignature && inFlightScheduleKeys.has(scheduleSignature)) {
      advanceSchedule(schedule)
      upsertSchedule(schedule.id, schedule)
      continue
    }

    const agent = agents[schedule.agentId]
    if (!agent) {
      console.error(`[scheduler] Agent ${schedule.agentId} not found for schedule ${schedule.id}`)
      schedule.status = 'failed'
      upsertSchedule(schedule.id, schedule)
      pushMainLoopEventToMainSessions({
        type: 'schedule_failed',
        text: `Schedule failed: "${schedule.name}" (${schedule.id}) — agent ${schedule.agentId} not found.`,
      })
      continue
    }
    if (isAgentDisabled(agent)) {
      console.warn(`[scheduler] Skipping schedule "${schedule.name}" (${schedule.id}) because agent ${schedule.agentId} is disabled`)
      advanceSchedule(schedule)
      upsertSchedule(schedule.id, schedule)
      pushMainLoopEventToMainSessions({
        type: 'schedule_skipped',
        text: `Schedule skipped: "${schedule.name}" (${schedule.id}) — agent ${schedule.agentId} is disabled.`,
      })
      continue
    }

    console.log(`[scheduler] Firing schedule "${schedule.name}" (${schedule.id})`)
    schedule.lastRunAt = now
    schedule.runNumber = (schedule.runNumber || 0) + 1

    // Compute next run
    advanceSchedule(schedule)

    // Reuse linked task if it exists and is not currently in-flight
    let taskId = ''
    const existingTaskId = typeof schedule.linkedTaskId === 'string' ? schedule.linkedTaskId : ''
    const existingTask = existingTaskId ? tasks[existingTaskId] : null
    if (existingTask && existingTask.status !== 'queued' && existingTask.status !== 'running') {
      // Accumulate stats from the previous run before resetting
      taskId = existingTaskId
      const prev = existingTask as any
      prev.totalRuns = (prev.totalRuns || 0) + 1
      if (existingTask.status === 'completed') prev.totalCompleted = (prev.totalCompleted || 0) + 1
      if (existingTask.status === 'failed') prev.totalFailed = (prev.totalFailed || 0) + 1

      // Reset for the new run
      existingTask.status = 'backlog'
      existingTask.title = `[Sched] ${schedule.name} (run #${schedule.runNumber})`
      existingTask.result = null
      existingTask.error = null
      existingTask.outputFiles = []
      existingTask.artifacts = []
      existingTask.sessionId = null
      existingTask.completionReportPath = null
      existingTask.updatedAt = now
      existingTask.queuedAt = null
      existingTask.startedAt = null
      existingTask.completedAt = null
      existingTask.archivedAt = null
      existingTask.attempts = 0
      existingTask.retryScheduledAt = null
      existingTask.deadLetteredAt = null
      existingTask.validation = null
      prev.runNumber = schedule.runNumber
    } else {
      // Create a new linked task (first run or previous task still in-flight)
      taskId = genId()
      tasks[taskId] = {
        id: taskId,
        title: `[Sched] ${schedule.name} (run #${schedule.runNumber})`,
        description: schedule.taskPrompt,
        status: 'backlog',
        agentId: schedule.agentId,
        sessionId: null,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
        sourceType: 'schedule',
        sourceScheduleId: schedule.id,
        sourceScheduleName: schedule.name,
        sourceScheduleKey: scheduleSignature || null,
        createdInSessionId: schedule.createdInSessionId || null,
        createdByAgentId: schedule.createdByAgentId || null,
        followupConnectorId: schedule.followupConnectorId || null,
        followupChannelId: schedule.followupChannelId || null,
        followupThreadId: schedule.followupThreadId || null,
        followupSenderId: schedule.followupSenderId || null,
        followupSenderName: schedule.followupSenderName || null,
        runNumber: schedule.runNumber,
      }
      schedule.linkedTaskId = taskId
    }

    upsertTask(taskId, tasks[taskId])
    upsertSchedule(schedule.id, schedule)

    enqueueTask(taskId)
    if (scheduleSignature) inFlightScheduleKeys.add(scheduleSignature)
    pushMainLoopEventToMainSessions({
      type: 'schedule_fired',
      text: `Schedule fired: "${schedule.name}" (${schedule.id}) run #${schedule.runNumber} — task ${taskId}`,
    })

    // Enqueue system event + heartbeat wake for the schedule's agent
    if (schedule.createdInSessionId) {
      enqueueSystemEvent(schedule.createdInSessionId, `Schedule triggered: ${schedule.name}`)
    }
    requestHeartbeatNow({
      agentId: schedule.agentId,
      eventId: `${schedule.id}:${schedule.runNumber}`,
      reason: 'schedule',
      source: `schedule:${schedule.id}`,
      resumeMessage: `Schedule triggered: ${schedule.name}`,
      detail: `Run #${schedule.runNumber} queued task ${taskId}.`,
    })
  }
}
