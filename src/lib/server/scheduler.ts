import crypto from 'crypto'
import { loadSchedules, saveSchedules, loadAgents, loadTasks, saveTasks } from './storage'
import { enqueueTask } from './queue'
import { CronExpressionParser } from 'cron-parser'

const TICK_INTERVAL = 60_000 // 60 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

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
  for (const schedule of Object.values(schedules) as any[]) {
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

  for (const schedule of Object.values(schedules) as any[]) {
    if (schedule.status !== 'active') continue
    if (!schedule.nextRunAt || schedule.nextRunAt > now) continue

    const agent = agents[schedule.agentId]
    if (!agent) {
      console.error(`[scheduler] Agent ${schedule.agentId} not found for schedule ${schedule.id}`)
      schedule.status = 'failed'
      saveSchedules(schedules)
      continue
    }

    console.log(`[scheduler] Firing schedule "${schedule.name}" (${schedule.id})`)
    schedule.lastRunAt = now

    // Compute next run
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

    saveSchedules(schedules)

    // Create a board task and enqueue it
    const taskId = crypto.randomBytes(4).toString('hex')
    const tasks = loadTasks()
    tasks[taskId] = {
      id: taskId,
      title: `[Sched] ${schedule.name}: ${schedule.taskPrompt.slice(0, 40)}`,
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
    }
    saveTasks(tasks)
    enqueueTask(taskId)
  }
}
