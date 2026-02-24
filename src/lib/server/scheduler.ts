import crypto from 'crypto'
import { loadSchedules, saveSchedules, loadAgents, loadTasks, saveTasks } from './storage'
import { enqueueTask } from './queue'
import { CronExpressionParser } from 'cron-parser'
import { pushMainLoopEventToMainSessions } from './main-agent-loop'
import { getScheduleSignatureKey } from '@/lib/schedule-dedupe'

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
  let changed = false
  for (const schedule of Object.values(schedules) as SchedulerScheduleLike[]) {
    if (schedule.status !== 'active') continue
    if (schedule.scheduleType === 'cron' && schedule.cron && !schedule.nextRunAt) {
      try {
        const interval = CronExpressionParser.parse(schedule.cron)
        schedule.nextRunAt = interval.next().getTime()
        changed = true
      } catch (err) {
        console.error(`[scheduler] Invalid cron for ${schedule.id}:`, err)
        schedule.status = 'failed'
        changed = true
      }
    }
  }
  if (changed) saveSchedules(schedules)
}

async function tick() {
  const now = Date.now()
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
      saveSchedules(schedules)
      continue
    }

    const agent = agents[schedule.agentId]
    if (!agent) {
      console.error(`[scheduler] Agent ${schedule.agentId} not found for schedule ${schedule.id}`)
      schedule.status = 'failed'
      saveSchedules(schedules)
      pushMainLoopEventToMainSessions({
        type: 'schedule_failed',
        text: `Schedule failed: "${schedule.name}" (${schedule.id}) — agent ${schedule.agentId} not found.`,
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
      existingTask.sessionId = null
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
      taskId = crypto.randomBytes(4).toString('hex')
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
        runNumber: schedule.runNumber,
      }
      schedule.linkedTaskId = taskId
    }

    saveTasks(tasks)
    saveSchedules(schedules)

    enqueueTask(taskId)
    if (scheduleSignature) inFlightScheduleKeys.add(scheduleSignature)
    pushMainLoopEventToMainSessions({
      type: 'schedule_fired',
      text: `Schedule fired: "${schedule.name}" (${schedule.id}) run #${schedule.runNumber} — task ${taskId}`,
    })
  }
}
