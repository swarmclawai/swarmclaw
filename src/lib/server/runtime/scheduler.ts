import { loadSchedules, loadAgents, loadTasks, upsertSchedule, upsertSchedules, upsertTask } from '@/lib/server/storage'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { CronExpressionParser } from 'cron-parser'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import { getScheduleSignatureKey } from '@/lib/schedules/schedule-dedupe'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { requestHeartbeatNow } from '@/lib/server/runtime/heartbeat-wake'
import { processDueWatchJobs } from '@/lib/server/runtime/watch-jobs'
import { isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { prepareScheduledTaskRun } from '@/lib/server/tasks/task-lifecycle'

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
  timezone?: string | null
  staggerSec?: number | null
  linkedTaskId?: string | null
  runNumber?: number
  createdInSessionId?: string | null
  createdByAgentId?: string | null
  followupConnectorId?: string | null
  followupChannelId?: string | null
  followupThreadId?: string | null
  followupSenderId?: string | null
  followupSenderName?: string | null
  taskMode?: 'task' | 'wake_only'
  message?: string
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
        const interval = CronExpressionParser.parse(
          schedule.cron,
          schedule.timezone ? { tz: schedule.timezone } : undefined,
        )
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

  const applyStagger = (ts: number, staggerSec: number | null | undefined): number => {
    if (!staggerSec || staggerSec <= 0) return ts
    return ts + Math.floor(Math.random() * staggerSec * 1000)
  }

  const advanceSchedule = (schedule: SchedulerScheduleLike): void => {
    if (schedule.scheduleType === 'cron' && schedule.cron) {
      try {
        const interval = CronExpressionParser.parse(
          schedule.cron,
          schedule.timezone ? { tz: schedule.timezone } : undefined,
        )
        schedule.nextRunAt = applyStagger(interval.next().getTime(), schedule.staggerSec)
      } catch {
        schedule.status = 'failed'
      }
    } else if (schedule.scheduleType === 'interval' && schedule.intervalMs) {
      schedule.nextRunAt = applyStagger(now + schedule.intervalMs, schedule.staggerSec)
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

    if (schedule.taskMode === 'wake_only') {
      // Wake-only: no board task, just heartbeat the agent
      upsertSchedule(schedule.id, schedule)

      const wakeMessage = schedule.message || `Schedule triggered: ${schedule.name}`
      pushMainLoopEventToMainSessions({
        type: 'schedule_fired',
        text: `Schedule fired (wake-only): "${schedule.name}" (${schedule.id}) run #${schedule.runNumber}`,
      })

      if (schedule.createdInSessionId) {
        enqueueSystemEvent(schedule.createdInSessionId, wakeMessage)
      }
      requestHeartbeatNow({
        agentId: schedule.agentId,
        eventId: `${schedule.id}:${schedule.runNumber}`,
        reason: 'schedule',
        source: `schedule:${schedule.id}`,
        resumeMessage: wakeMessage,
        detail: `Run #${schedule.runNumber} (wake-only).`,
      })
    } else {
      // Default task mode: create a board task
      const { taskId } = prepareScheduledTaskRun({
        schedule,
        tasks,
        now,
        scheduleSignature,
      })

      upsertTask(taskId, tasks[taskId])
      upsertSchedule(schedule.id, schedule)

      enqueueTask(taskId)
      if (scheduleSignature) inFlightScheduleKeys.add(scheduleSignature)
      pushMainLoopEventToMainSessions({
        type: 'schedule_fired',
        text: `Schedule fired: "${schedule.name}" (${schedule.id}) run #${schedule.runNumber} — task ${taskId}`,
      })

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
}
