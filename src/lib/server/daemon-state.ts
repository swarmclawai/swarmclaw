import { loadQueue, loadSchedules, loadSessions, saveSessions, loadConnectors } from './storage'
import { processNext, cleanupFinishedTaskSessions, validateCompletedTasksQueue } from './queue'
import { startScheduler, stopScheduler } from './scheduler'
import { sweepOrphanedBrowsers, getActiveBrowserCount } from './session-tools'
import {
  autoStartConnectors,
  stopAllConnectors,
  listRunningConnectors,
  sendConnectorMessage,
  startConnector,
  getConnectorStatus,
} from './connectors/manager'
import { startHeartbeatService, stopHeartbeatService, getHeartbeatServiceStatus } from './heartbeat-service'

const QUEUE_CHECK_INTERVAL = 30_000 // 30 seconds
const BROWSER_SWEEP_INTERVAL = 60_000 // 60 seconds
const BROWSER_MAX_AGE = 10 * 60 * 1000 // 10 minutes idle = orphaned
const HEALTH_CHECK_INTERVAL = 120_000 // 2 minutes
const STALE_MULTIPLIER = 4 // session is stale after N × heartbeat interval
const STALE_MIN_MS = 4 * 60 * 1000 // minimum 4 minutes regardless of interval
const STALE_AUTO_DISABLE_MULTIPLIER = 16 // auto-disable after much longer sustained staleness
const STALE_AUTO_DISABLE_MIN_MS = 45 * 60 * 1000 // never auto-disable before 45 minutes
const CONNECTOR_RESTART_BASE_MS = 30_000
const CONNECTOR_RESTART_MAX_MS = 15 * 60 * 1000

function parseHeartbeatIntervalSec(value: unknown, fallback = 120): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(3600, Math.trunc(parsed)))
}

function normalizeWhatsappTarget(raw?: string | null): string | null {
  const input = (raw || '').trim()
  if (!input) return null
  if (input.includes('@')) return input
  let digits = input.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  if (digits.startsWith('0') && digits.length >= 10) {
    digits = `44${digits.slice(1)}`
  }
  digits = digits.replace(/[^\d]/g, '')
  return digits ? `${digits}@s.whatsapp.net` : null
}

// Store daemon state on globalThis to survive HMR reloads
const gk = '__swarmclaw_daemon__' as const
const ds: {
  queueIntervalId: ReturnType<typeof setInterval> | null
  browserSweepId: ReturnType<typeof setInterval> | null
  healthIntervalId: ReturnType<typeof setInterval> | null
  /** Session IDs we've already alerted as stale (alert-once semantics). */
  staleSessionIds: Set<string>
  connectorRestartState: Map<string, { lastAttemptAt: number; failCount: number }>
  running: boolean
  lastProcessedAt: number | null
} = (globalThis as any)[gk] ?? ((globalThis as any)[gk] = {
  queueIntervalId: null,
  browserSweepId: null,
  healthIntervalId: null,
  staleSessionIds: new Set<string>(),
  connectorRestartState: new Map<string, { lastAttemptAt: number; failCount: number }>(),
  running: false,
  lastProcessedAt: null,
})

// Backfill fields for hot-reloaded daemon state objects from older code versions.
if (!ds.staleSessionIds) ds.staleSessionIds = new Set<string>()
if (!ds.connectorRestartState) ds.connectorRestartState = new Map<string, { lastAttemptAt: number; failCount: number }>()
// Migrate from old issueLastAlertAt map if present (HMR across code versions)
if ((ds as any).issueLastAlertAt) delete (ds as any).issueLastAlertAt
if (ds.healthIntervalId === undefined) ds.healthIntervalId = null

export function startDaemon() {
  if (ds.running) {
    // In dev/HMR, daemon can already be flagged running while new interval types
    // (for example health monitor) were introduced in newer code.
    startQueueProcessor()
    startBrowserSweep()
    startHealthMonitor()
    startHeartbeatService()
    return
  }
  ds.running = true
  console.log('[daemon] Starting daemon (scheduler + queue processor + heartbeat)')

  validateCompletedTasksQueue()
  cleanupFinishedTaskSessions()
  startScheduler()
  startQueueProcessor()
  startBrowserSweep()
  startHealthMonitor()
  startHeartbeatService()

  // Auto-start enabled connectors
  autoStartConnectors().catch((err) => {
    console.error('[daemon] Error auto-starting connectors:', err.message)
  })
}

export function stopDaemon() {
  if (!ds.running) return
  ds.running = false
  console.log('[daemon] Stopping daemon')

  stopScheduler()
  stopQueueProcessor()
  stopBrowserSweep()
  stopHealthMonitor()
  stopHeartbeatService()
  stopAllConnectors().catch(() => {})
}

function startBrowserSweep() {
  if (ds.browserSweepId) return
  ds.browserSweepId = setInterval(() => {
    const count = getActiveBrowserCount()
    if (count > 0) {
      const cleaned = sweepOrphanedBrowsers(BROWSER_MAX_AGE)
      if (cleaned > 0) {
        console.log(`[daemon] Cleaned ${cleaned} orphaned browser(s), ${getActiveBrowserCount()} still active`)
      }
    }
  }, BROWSER_SWEEP_INTERVAL)
}

function stopBrowserSweep() {
  if (ds.browserSweepId) {
    clearInterval(ds.browserSweepId)
    ds.browserSweepId = null
  }
  // Kill all remaining browsers on shutdown
  sweepOrphanedBrowsers(0)
}

function startQueueProcessor() {
  if (ds.queueIntervalId) return
  ds.queueIntervalId = setInterval(async () => {
    const queue = loadQueue()
    if (queue.length > 0) {
      console.log(`[daemon] Processing ${queue.length} queued task(s)`)
      await processNext()
      ds.lastProcessedAt = Date.now()
    }
  }, QUEUE_CHECK_INTERVAL)
}

function stopQueueProcessor() {
  if (ds.queueIntervalId) {
    clearInterval(ds.queueIntervalId)
    ds.queueIntervalId = null
  }
}

async function sendHealthAlert(text: string) {
  console.warn(`[health] ${text}`)
  try {
    const running = listRunningConnectors('whatsapp')
    if (!running.length) return
    const candidate = running[0]
    const target = candidate.recentChannelId
      || normalizeWhatsappTarget(candidate.configuredTargets[0] || null)
    if (!target) return
    await sendConnectorMessage({
      connectorId: candidate.id,
      channelId: target,
      text: `⚠️ SwarmClaw health alert: ${text}`,
    })
  } catch {
    // alerts are best effort; log-only fallback is acceptable
  }
}

async function runConnectorHealthChecks(now: number) {
  const connectors = loadConnectors()
  for (const connector of Object.values(connectors) as any[]) {
    if (!connector?.id) continue
    if (connector.isEnabled !== true) {
      ds.connectorRestartState.delete(connector.id)
      continue
    }

    const runtimeStatus = getConnectorStatus(connector.id)
    if (runtimeStatus === 'running') {
      ds.connectorRestartState.delete(connector.id)
      continue
    }

    const current = ds.connectorRestartState.get(connector.id) || { lastAttemptAt: 0, failCount: 0 }
    const backoffMs = Math.min(
      CONNECTOR_RESTART_MAX_MS,
      CONNECTOR_RESTART_BASE_MS * (2 ** Math.min(6, current.failCount)),
    )
    if ((now - current.lastAttemptAt) < backoffMs) continue

    current.lastAttemptAt = now
    ds.connectorRestartState.set(connector.id, current)
    try {
      await startConnector(connector.id)
      ds.connectorRestartState.delete(connector.id)
      await sendHealthAlert(`Connector "${connector.name}" (${connector.platform}) was down and has been auto-restarted.`)
    } catch (err: any) {
      current.failCount += 1
      ds.connectorRestartState.set(connector.id, current)
      console.warn(`[health] Connector auto-restart failed for ${connector.name}: ${err?.message || String(err)}`)
    }
  }
}

async function runHealthChecks() {
  // Continuously keep the completed queue honest.
  validateCompletedTasksQueue()

  // Keep heartbeat state in sync with task terminal states even without daemon restarts.
  cleanupFinishedTaskSessions()

  const sessions = loadSessions()
  const now = Date.now()
  const currentlyStale = new Set<string>()
  let sessionsDirty = false

  for (const session of Object.values(sessions) as any[]) {
    if (!session?.id) continue
    if (session.heartbeatEnabled !== true) continue

    const intervalSec = parseHeartbeatIntervalSec(session.heartbeatIntervalSec, 120)
    if (intervalSec <= 0) continue
    const staleAfter = Math.max(intervalSec * STALE_MULTIPLIER * 1000, STALE_MIN_MS)
    const lastActive = typeof session.lastActiveAt === 'number' ? session.lastActiveAt : 0
    if (lastActive <= 0) continue

    const staleForMs = now - lastActive
    if (staleForMs > staleAfter) {
      const autoDisableAfter = Math.max(intervalSec * STALE_AUTO_DISABLE_MULTIPLIER * 1000, STALE_AUTO_DISABLE_MIN_MS)
      if (staleForMs > autoDisableAfter) {
        session.heartbeatEnabled = false
        session.lastActiveAt = now
        sessionsDirty = true
        ds.staleSessionIds.delete(session.id)
        await sendHealthAlert(
          `Auto-disabled heartbeat for stale session "${session.name || session.id}" after ${Math.round(staleForMs / 60_000)}m of inactivity.`,
        )
        continue
      }

      currentlyStale.add(session.id)
      // Only alert on transition from healthy → stale (once per stale episode)
      if (!ds.staleSessionIds.has(session.id)) {
        ds.staleSessionIds.add(session.id)
        await sendHealthAlert(
          `Session "${session.name || session.id}" heartbeat appears stale (last active ${(Math.round(staleForMs / 1000))}s ago, interval ${intervalSec}s).`,
        )
      }
    }
  }

  // Clear recovered sessions so they can re-alert if they go stale again later
  for (const id of ds.staleSessionIds) {
    if (!currentlyStale.has(id)) {
      ds.staleSessionIds.delete(id)
    }
  }

  if (sessionsDirty) saveSessions(sessions)

  await runConnectorHealthChecks(now)
}

function startHealthMonitor() {
  if (ds.healthIntervalId) return
  ds.healthIntervalId = setInterval(() => {
    runHealthChecks().catch((err) => {
      console.error('[daemon] Health monitor tick failed:', err?.message || String(err))
    })
  }, HEALTH_CHECK_INTERVAL)
}

function stopHealthMonitor() {
  if (ds.healthIntervalId) {
    clearInterval(ds.healthIntervalId)
    ds.healthIntervalId = null
  }
}

export async function runDaemonHealthCheckNow() {
  await runHealthChecks()
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
    running: ds.running,
    schedulerActive: ds.running,
    queueLength: queue.length,
    lastProcessed: ds.lastProcessedAt,
    nextScheduled,
    heartbeat: getHeartbeatServiceStatus(),
    health: {
      monitorActive: !!ds.healthIntervalId,
      staleSessions: ds.staleSessionIds.size,
      connectorsInBackoff: ds.connectorRestartState.size,
      checkIntervalSec: Math.trunc(HEALTH_CHECK_INTERVAL / 1000),
    },
  }
}

// Auto-start daemon on import (starts scheduler, queue processor, and enabled connectors)
startDaemon()
