import { loadQueue, loadSchedules } from './storage'
import { processNext } from './queue'
import { startScheduler, stopScheduler } from './scheduler'

const QUEUE_CHECK_INTERVAL = 30_000 // 30 seconds
let queueIntervalId: ReturnType<typeof setInterval> | null = null
let running = false
let lastProcessedAt: number | null = null

export function startDaemon() {
  if (running) return
  running = true
  console.log('[daemon] Starting daemon (scheduler + queue processor)')

  startScheduler()
  startQueueProcessor()
}

export function stopDaemon() {
  if (!running) return
  running = false
  console.log('[daemon] Stopping daemon')

  stopScheduler()
  stopQueueProcessor()
}

function startQueueProcessor() {
  if (queueIntervalId) return
  queueIntervalId = setInterval(async () => {
    const queue = loadQueue()
    if (queue.length > 0) {
      console.log(`[daemon] Processing ${queue.length} queued task(s)`)
      await processNext()
      lastProcessedAt = Date.now()
    }
  }, QUEUE_CHECK_INTERVAL)
}

function stopQueueProcessor() {
  if (queueIntervalId) {
    clearInterval(queueIntervalId)
    queueIntervalId = null
  }
}

export function getDaemonStatus() {
  const queue = loadQueue()
  const schedules = loadSchedules()

  // Find next scheduled task
  let nextScheduled: number | null = null
  for (const s of Object.values(schedules) as any[]) {
    if (s.status === 'active' && s.nextRunAt) {
      if (!nextScheduled || s.nextRunAt < nextScheduled) {
        nextScheduled = s.nextRunAt
      }
    }
  }

  return {
    running,
    schedulerActive: running,
    queueLength: queue.length,
    lastProcessed: lastProcessedAt,
    nextScheduled,
  }
}

// Auto-start daemon on import if there are queued tasks
const queue = loadQueue()
if (queue.length > 0) {
  console.log('[daemon] Auto-starting daemon — found queued tasks')
  startDaemon()
}
