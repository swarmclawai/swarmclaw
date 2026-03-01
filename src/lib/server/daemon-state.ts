import { loadQueue, loadSchedules, loadSessions, saveSessions, loadConnectors, saveConnectors, loadWebhookRetryQueue, upsertWebhookRetry, deleteWebhookRetry, loadWebhooks, loadAgents, appendWebhookLog } from './storage'
import { notify } from './ws-hub'
import { processNext, cleanupFinishedTaskSessions, validateCompletedTasksQueue, recoverStalledRunningTasks } from './queue'
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
import { hasOpenClawAgents, ensureGatewayConnected, disconnectGateway, getGateway } from './openclaw-gateway'
import { enqueueSessionRun } from './session-run-manager'
import { WORKSPACE_DIR } from './data-dir'
import { genId } from '@/lib/id'
import type { WebhookRetryEntry } from '@/types'

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
const MAX_WAKE_ATTEMPTS = 3

function parseBoolish(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function daemonAutostartEnvEnabled(): boolean {
  return parseBoolish(process.env.SWARMCLAW_DAEMON_AUTOSTART, true)
}

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
  connectorRestartState: Map<string, { lastAttemptAt: number; failCount: number; wakeAttempts: number }>
  manualStopRequested: boolean
  running: boolean
  lastProcessedAt: number | null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} = (globalThis as any)[gk] ?? ((globalThis as any)[gk] = {
  queueIntervalId: null,
  browserSweepId: null,
  healthIntervalId: null,
  staleSessionIds: new Set<string>(),
  connectorRestartState: new Map<string, { lastAttemptAt: number; failCount: number; wakeAttempts: number }>(),
  manualStopRequested: false,
  running: false,
  lastProcessedAt: null,
})

// Backfill fields for hot-reloaded daemon state objects from older code versions.
if (!ds.staleSessionIds) ds.staleSessionIds = new Set<string>()
if (!ds.connectorRestartState) ds.connectorRestartState = new Map<string, { lastAttemptAt: number; failCount: number; wakeAttempts: number }>()
// Migrate from old issueLastAlertAt map if present (HMR across code versions)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((ds as any).issueLastAlertAt) delete (ds as any).issueLastAlertAt
if (ds.healthIntervalId === undefined) ds.healthIntervalId = null
if (ds.manualStopRequested === undefined) ds.manualStopRequested = false

export function ensureDaemonStarted(source = 'unknown'): boolean {
  if (ds.running) return false
  if (!daemonAutostartEnvEnabled()) return false
  if (ds.manualStopRequested) return false
  startDaemon({ source, manualStart: false })
  return true
}

export function startDaemon(options?: { source?: string; manualStart?: boolean }) {
  const source = options?.source || 'unknown'
  const manualStart = options?.manualStart === true
  if (manualStart) ds.manualStopRequested = false

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
  notify('daemon')
  console.log(`[daemon] Starting daemon (source=${source}, scheduler + queue processor + heartbeat)`)

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

export function stopDaemon(options?: { source?: string; manualStop?: boolean }) {
  const source = options?.source || 'unknown'
  if (options?.manualStop === true) ds.manualStopRequested = true
  if (!ds.running) return
  ds.running = false
  notify('daemon')
  console.log(`[daemon] Stopping daemon (source=${source})`)

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
    // OpenClaw gateway lifecycle: lazy connect when openclaw agents exist, disconnect when none remain
    try {
      if (hasOpenClawAgents()) {
        if (!getGateway()?.connected) {
          await ensureGatewayConnected()
        }
      } else if (getGateway()?.connected) {
        disconnectGateway()
      }
    } catch { /* gateway errors are non-fatal */ }
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
  for (const connector of Object.values(connectors) as Record<string, unknown>[]) {
    if (!connector?.id || typeof connector.id !== 'string') continue
    if (connector.isEnabled !== true) {
      ds.connectorRestartState.delete(connector.id)
      continue
    }

    const runtimeStatus = getConnectorStatus(connector.id)
    if (runtimeStatus === 'running') {
      ds.connectorRestartState.delete(connector.id)
      continue
    }

    const current = ds.connectorRestartState.get(connector.id) || { lastAttemptAt: 0, failCount: 0, wakeAttempts: 0 }
    // Backfill wakeAttempts for state objects created before this field existed
    if (typeof current.wakeAttempts !== 'number') current.wakeAttempts = 0

    // Cap wake attempts — stop retrying after MAX_WAKE_ATTEMPTS consecutive failures
    if (current.wakeAttempts >= MAX_WAKE_ATTEMPTS) {
      console.warn(`[health] Connector "${connector.name}" exceeded ${MAX_WAKE_ATTEMPTS} wake attempts — giving up`)
      connector.status = 'error'
      connector.lastError = `Auto-restart gave up after ${MAX_WAKE_ATTEMPTS} consecutive failures`
      connector.updatedAt = Date.now()
      connectors[connector.id] = connector
      saveConnectors(connectors)
      ds.connectorRestartState.delete(connector.id)
      continue
    }

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
    } catch (err: unknown) {
      current.failCount += 1
      current.wakeAttempts += 1
      ds.connectorRestartState.set(connector.id, current)
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[health] Connector auto-restart failed for ${connector.name} (attempt ${current.wakeAttempts}/${MAX_WAKE_ATTEMPTS}): ${message}`)
    }
  }
}

async function processWebhookRetries() {
  const retryQueue = loadWebhookRetryQueue()
  const now = Date.now()
  const dueEntries: WebhookRetryEntry[] = []

  for (const raw of Object.values(retryQueue)) {
    const entry = raw as WebhookRetryEntry
    if (entry.deadLettered) continue
    if (entry.nextRetryAt > now) continue
    dueEntries.push(entry)
  }

  if (dueEntries.length === 0) return

  const webhooks = loadWebhooks()
  const agents = loadAgents()
  const sessions = loadSessions()

  for (const entry of dueEntries) {
    const webhook = webhooks[entry.webhookId] as Record<string, unknown> | undefined
    if (!webhook) {
      // Webhook deleted — drop the retry
      deleteWebhookRetry(entry.id)
      continue
    }

    const agentId = typeof webhook.agentId === 'string' ? webhook.agentId : ''
    const agent = agentId ? (agents[agentId] as Record<string, unknown> | undefined) : null
    if (!agent) {
      entry.deadLettered = true
      upsertWebhookRetry(entry.id, entry)
      console.warn(`[webhook-retry] Dead-lettered ${entry.id}: agent not found for webhook ${entry.webhookId}`)
      continue
    }

    // Find or create a webhook session (same logic as the POST handler)
    const sessionName = `webhook:${entry.webhookId}`
    let session = Object.values(sessions).find(
      (s: unknown) => {
        const rec = s as Record<string, unknown>
        return rec.name === sessionName && rec.agentId === agent.id
      },
    ) as Record<string, unknown> | undefined

    if (!session) {
      const sessionId = genId()
      const ts = Date.now()
      session = {
        id: sessionId,
        name: sessionName,
        cwd: WORKSPACE_DIR,
        user: 'system',
        provider: agent.provider || 'claude-cli',
        model: agent.model || '',
        credentialId: agent.credentialId || null,
        apiEndpoint: agent.apiEndpoint || null,
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null },
        messages: [],
        createdAt: ts,
        lastActiveAt: ts,
        sessionType: 'orchestrated',
        agentId: agent.id,
        parentSessionId: null,
        tools: agent.tools || [],
        heartbeatEnabled: (agent.heartbeatEnabled as boolean | undefined) ?? true,
        heartbeatIntervalSec: (agent.heartbeatIntervalSec as number | null | undefined) ?? null,
      }
      sessions[session.id as string] = session
      const { saveSessions: save } = await import('./storage')
      save(sessions)
    }

    const payloadPreview = (entry.payload || '').slice(0, 12_000)
    const prompt = [
      'Webhook event received (retry).',
      `Webhook ID: ${entry.webhookId}`,
      `Webhook Name: ${(webhook.name as string) || entry.webhookId}`,
      `Source: ${(webhook.source as string) || 'custom'}`,
      `Event: ${entry.event}`,
      `Retry attempt: ${entry.attempts}`,
      `Original received at: ${new Date(entry.createdAt).toISOString()}`,
      '',
      'Payload:',
      payloadPreview || '(empty payload)',
      '',
      'Handle this event now. If this requires notifying the user, use configured connector tools.',
    ].join('\n')

    try {
      const run = enqueueSessionRun({
        sessionId: session.id as string,
        message: prompt,
        source: 'webhook',
        internal: false,
        mode: 'followup',
      })

      appendWebhookLog(genId(8), {
        id: genId(8),
        webhookId: entry.webhookId,
        event: entry.event,
        payload: (entry.payload || '').slice(0, 2000),
        status: 'success',
        sessionId: session.id,
        runId: run.runId,
        timestamp: Date.now(),
      })

      deleteWebhookRetry(entry.id)
      console.log(`[webhook-retry] Successfully retried ${entry.id} for webhook ${entry.webhookId} (attempt ${entry.attempts})`)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      entry.attempts += 1

      if (entry.attempts >= entry.maxAttempts) {
        entry.deadLettered = true
        upsertWebhookRetry(entry.id, entry)
        console.warn(`[webhook-retry] Dead-lettered ${entry.id} after ${entry.attempts} attempts: ${errorMsg}`)

        appendWebhookLog(genId(8), {
          id: genId(8),
          webhookId: entry.webhookId,
          event: entry.event,
          payload: (entry.payload || '').slice(0, 2000),
          status: 'error',
          error: `Dead-lettered after ${entry.attempts} attempts: ${errorMsg}`,
          timestamp: Date.now(),
        })
      } else {
        // Exponential backoff: 30s * 2^attempt + random jitter (0-5000ms)
        const jitter = Math.floor(Math.random() * 5000)
        entry.nextRetryAt = Date.now() + (30_000 * Math.pow(2, entry.attempts)) + jitter
        upsertWebhookRetry(entry.id, entry)
        console.warn(`[webhook-retry] Retry ${entry.id} failed (attempt ${entry.attempts}/${entry.maxAttempts}), next at ${new Date(entry.nextRetryAt).toISOString()}: ${errorMsg}`)
      }
    }
  }
}

async function runHealthChecks() {
  // Continuously keep the completed queue honest.
  validateCompletedTasksQueue()
  recoverStalledRunningTasks()

  // Keep heartbeat state in sync with task terminal states even without daemon restarts.
  cleanupFinishedTaskSessions()

  const sessions = loadSessions()
  const now = Date.now()
  const currentlyStale = new Set<string>()
  let sessionsDirty = false

  for (const session of Object.values(sessions) as Record<string, unknown>[]) {
    if (!session?.id || typeof session.id !== 'string') continue
    if (session.heartbeatEnabled !== true) continue

    const sessionId = session.id
    const sessionLabel = String(session.name || sessionId)
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
        ds.staleSessionIds.delete(sessionId)
        await sendHealthAlert(
          `Auto-disabled heartbeat for stale session "${sessionLabel}" after ${Math.round(staleForMs / 60_000)}m of inactivity.`,
        )
        continue
      }

      currentlyStale.add(sessionId)
      // Only alert on transition from healthy → stale (once per stale episode)
      if (!ds.staleSessionIds.has(sessionId)) {
        ds.staleSessionIds.add(sessionId)
        await sendHealthAlert(
          `Session "${sessionLabel}" heartbeat appears stale (last active ${(Math.round(staleForMs / 1000))}s ago, interval ${intervalSec}s).`,
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

  // Process webhook retry queue
  try {
    await processWebhookRetries()
  } catch (err: unknown) {
    console.error('[daemon] Webhook retry processing failed:', err instanceof Error ? err.message : String(err))
  }
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
  for (const s of Object.values(schedules) as Record<string, unknown>[]) {
    if (s.status === 'active' && s.nextRunAt) {
      if (!nextScheduled || (s.nextRunAt as number) < nextScheduled) {
        nextScheduled = s.nextRunAt as number
      }
    }
  }

  // Webhook retry queue stats
  const retryQueue = loadWebhookRetryQueue()
  const retryEntries = Object.values(retryQueue) as WebhookRetryEntry[]
  const pendingRetries = retryEntries.filter(e => !e.deadLettered).length
  const deadLettered = retryEntries.filter(e => e.deadLettered).length

  return {
    running: ds.running,
    schedulerActive: ds.running,
    autostartEnabled: daemonAutostartEnvEnabled(),
    manualStopRequested: ds.manualStopRequested,
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
    webhookRetry: {
      pendingRetries,
      deadLettered,
    },
  }
}
