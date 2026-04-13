import { log } from '@/lib/server/logger'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { loadConnectors, saveConnectors } from '@/lib/server/connectors/connector-repository'
import { decryptKey, loadCredentials } from '@/lib/server/credentials/credential-repository'
import { loadQueue } from '@/lib/server/runtime/queue-repository'
import { pruneExpiredLocks, readRuntimeLock, releaseRuntimeLock, renewRuntimeLock, tryAcquireRuntimeLock } from '@/lib/server/runtime/runtime-lock-repository'
import { isOwnerProcessDead } from '@/lib/server/daemon/lease-owner'
import { loadSchedules } from '@/lib/server/schedules/schedule-repository'
import { loadSessions } from '@/lib/server/sessions/session-repository'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { pruneOldUsage } from '@/lib/server/usage/usage-repository'
import { appendWebhookLog, deleteWebhookRetry, loadWebhookRetryQueue, loadWebhooks, upsertWebhookRetry } from '@/lib/server/webhooks/webhook-repository'
import { notify } from '@/lib/server/ws-hub'
import { processNext, cleanupFinishedTaskSessions, validateCompletedTasksQueue, recoverStalledRunningTasks, resumeQueue, promoteDeferred } from '@/lib/server/runtime/queue'
import { startScheduler, stopScheduler } from '@/lib/server/runtime/scheduler'
import { sweepOrphanedBrowsers, getActiveBrowserCount } from '@/lib/server/session-tools'
import {
  autoStartConnectors,
  stopAllConnectors,
  startConnector,
  getConnectorStatus,
  checkConnectorHealth,
  createConnectorReconnectState,
  advanceConnectorReconnectState,
  clearReconnectState,
  getAllReconnectStates,
  getReconnectState,
  setReconnectState,
} from '@/lib/server/connectors/manager'
import { startConnectorOutboxWorker, stopConnectorOutboxWorker } from '@/lib/server/connectors/outbox'
import { pruneConnectorTrackingState } from '@/lib/server/connectors/runtime-state'
import { startHeartbeatService, stopHeartbeatService, getHeartbeatServiceStatus, pruneHeartbeatState, pruneOrchestratorState } from '@/lib/server/runtime/heartbeat-service'
import { hasOpenClawAgents, ensureGatewayConnected, disconnectAutoGateways, getGateway } from '@/lib/server/openclaw/gateway'
import { enqueueSessionRun, sweepStuckRuns } from '@/lib/server/runtime/session-run-manager'
import { pruneOldRuns } from '@/lib/server/runtime/run-ledger'
import { getEnabledCapabilitySelection } from '@/lib/capability-selection'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/runtime/heartbeat-defaults'
import { genId } from '@/lib/id'
import { isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import path from 'node:path'
import type { Connector, Session, WebhookRetryEntry } from '@/types'
import { createNotification } from '@/lib/server/create-notification'
import { pingProvider, OPENAI_COMPATIBLE_DEFAULTS, restoreProviderHealthState } from '@/lib/server/provider-health'
import { runIntegrityMonitor } from '@/lib/server/integrity-monitor'
import { notifyOrchestrators } from '@/lib/server/runtime/orchestrator-events'
import { recoverStaleDelegationJobs } from '@/lib/server/agents/delegation-jobs'
import { restoreSwarmRegistry } from '@/lib/server/agents/subagent-swarm'
import { cleanupFinishedSubagents } from '@/lib/server/agents/subagent-runtime'
import { pruneMainLoopState } from '@/lib/server/agents/main-agent-loop'
import { pruneSystemEventQueues, pruneOrchestratorEventQueues } from '@/lib/server/runtime/system-events'
import { checkSwarmTimeouts, ensureProtocolEngineRecovered } from '@/lib/server/protocols/protocol-service'
import { sweepManagedProcesses, reapOrphanedSandboxContainers } from '@/lib/server/runtime/process-manager'
import { drainIdleWindowCallbacks } from '@/lib/server/runtime/idle-window'
import {
  buildSessionHeartbeatHealthDedupKey,
  daemonAutostartEnvEnabled,
  isDaemonBackgroundServicesEnabled,
  parseCronToMs,
  parseHeartbeatIntervalSec,
  shouldNotifyProviderReachabilityIssue,
  shouldSuppressSessionHeartbeatHealthAlert,
  shouldSuppressSyntheticAgentHealthAlert,
} from '@/lib/server/runtime/daemon-policy'
import { loadEstopState } from '@/lib/server/runtime/estop'
import { classifyRuntimeFailure, recordSupervisorIncident } from '@/lib/server/autonomy/supervisor-reflection'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import { clearLogsByAge } from '@/lib/server/execution-log'

const TAG = 'daemon-state'

const QUEUE_CHECK_INTERVAL = 30_000 // 30 seconds
const BROWSER_SWEEP_INTERVAL = 60_000 // 60 seconds
const BROWSER_MAX_AGE = 10 * 60 * 1000 // 10 minutes idle = orphaned
const HEALTH_CHECK_INTERVAL = 120_000 // 2 minutes
const CONNECTOR_HEALTH_CHECK_INTERVAL = 15_000 // 15 seconds
const MEMORY_CONSOLIDATION_INTERVAL = 6 * 3600_000 // 6 hours
const MEMORY_CONSOLIDATION_INITIAL_DELAY = 60_000 // 1 minute after daemon start
const STALE_MULTIPLIER = 4 // session is stale after N × heartbeat interval
const STALE_MIN_MS = 4 * 60 * 1000 // minimum 4 minutes regardless of interval
const STALE_AUTO_DISABLE_MULTIPLIER = 16 // auto-disable after much longer sustained staleness
const STALE_AUTO_DISABLE_MIN_MS = 45 * 60 * 1000 // never auto-disable before 45 minutes
const CONNECTOR_RESTART_BASE_MS = 30_000
const CONNECTOR_RESTART_MAX_MS = 15 * 60 * 1000
const MAX_WAKE_ATTEMPTS = 3
const QUEUE_PROCESS_TIMEOUT = 10 * 60_000 // 10 minutes
const SHUTDOWN_TIMEOUT_MS = 15_000
const PROVIDER_PING_CB_THRESHOLD = 3 // trips after 3 consecutive failures
const PROVIDER_PING_CB_BASE_MS = 300_000 // 5 min initial cooldown
const PROVIDER_PING_CB_MAX_MS = 1_800_000 // 30 min max cooldown
const DAEMON_RUNTIME_LOCK_NAME = 'daemon-primary'
const DAEMON_RUNTIME_LOCK_TTL_MS = 120_000
const DAEMON_RUNTIME_LOCK_RENEW_MS = 30_000

export {
  buildSessionHeartbeatHealthDedupKey,
  isDaemonBackgroundServicesEnabled,
  shouldNotifyProviderReachabilityIssue,
  shouldSuppressSessionHeartbeatHealthAlert,
  shouldSuppressSyntheticAgentHealthAlert,
}

// Store daemon state on globalThis to survive HMR reloads
interface DaemonState {
  queueIntervalId: ReturnType<typeof setInterval> | null
  browserSweepId: ReturnType<typeof setInterval> | null
  healthIntervalId: ReturnType<typeof setInterval> | null
  connectorHealthIntervalId: ReturnType<typeof setInterval> | null
  memoryConsolidationTimeoutId: ReturnType<typeof setTimeout> | null
  memoryConsolidationIntervalId: ReturnType<typeof setInterval> | null
  evalSchedulerIntervalId: ReturnType<typeof setInterval> | null
  swarmTimeoutIntervalId: ReturnType<typeof setInterval> | null
  /** Session IDs we've already alerted as stale (alert-once semantics). */
  staleSessionIds: Set<string>
  /** OpenClaw gateway agent IDs currently considered down. */
  openclawDownAgentIds: Set<string>
  /** Per-agent auto-repair state for OpenClaw gateways. */
  openclawRepairState: Map<string, { attempts: number; lastAttemptAt: number; cooldownUntil: number }>
  lastIntegrityCheckAt: number | null
  lastIntegrityDriftCount: number
  manualStopRequested: boolean
  running: boolean
  lastProcessedAt: number | null
  healthCheckRunning: boolean
  connectorHealthCheckRunning: boolean
  shuttingDown: boolean
  providerPingCircuitBreaker: Map<string, { consecutiveFailures: number; skipUntil: number }>
  lockRenewIntervalId: ReturnType<typeof setInterval> | null
  leaseRetryTimeoutId: ReturnType<typeof setTimeout> | null
  primaryLeaseHeld: boolean
}

const ds: DaemonState = hmrSingleton<DaemonState>('__swarmclaw_daemon__', () => ({
  queueIntervalId: null,
  browserSweepId: null,
  healthIntervalId: null,
  connectorHealthIntervalId: null,
  memoryConsolidationTimeoutId: null,
  memoryConsolidationIntervalId: null,
  evalSchedulerIntervalId: null,
  swarmTimeoutIntervalId: null,
  staleSessionIds: new Set<string>(),
  openclawDownAgentIds: new Set<string>(),
  openclawRepairState: new Map<string, { attempts: number; lastAttemptAt: number; cooldownUntil: number }>(),
  lastIntegrityCheckAt: null,
  lastIntegrityDriftCount: 0,
  manualStopRequested: false,
  running: false,
  lastProcessedAt: null,
  healthCheckRunning: false,
  connectorHealthCheckRunning: false,
  shuttingDown: false,
  providerPingCircuitBreaker: new Map<string, { consecutiveFailures: number; skipUntil: number }>(),
  lockRenewIntervalId: null,
  leaseRetryTimeoutId: null,
  primaryLeaseHeld: false,
}))

const daemonLockOwner = hmrSingleton<string>(
  '__swarmclaw_daemon_lock_owner__',
  () => `pid:${process.pid}:${genId(8)}`,
)

// Backfill fields for hot-reloaded daemon state objects from older code versions.
if (!ds.staleSessionIds) ds.staleSessionIds = new Set<string>()
if (!ds.openclawDownAgentIds) ds.openclawDownAgentIds = new Set<string>()
if (!ds.openclawRepairState) ds.openclawRepairState = new Map<string, { attempts: number; lastAttemptAt: number; cooldownUntil: number }>()
if (ds.lastIntegrityCheckAt === undefined) ds.lastIntegrityCheckAt = null
if (ds.lastIntegrityDriftCount === undefined) ds.lastIntegrityDriftCount = 0
// Migrate from old issueLastAlertAt map if present (HMR across code versions)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((ds as any).issueLastAlertAt) delete (ds as any).issueLastAlertAt
if (ds.healthIntervalId === undefined) ds.healthIntervalId = null
if (ds.connectorHealthIntervalId === undefined) ds.connectorHealthIntervalId = null
if (ds.manualStopRequested === undefined) ds.manualStopRequested = false
if (ds.memoryConsolidationTimeoutId === undefined) ds.memoryConsolidationTimeoutId = null
if (ds.memoryConsolidationIntervalId === undefined) ds.memoryConsolidationIntervalId = null
if (ds.evalSchedulerIntervalId === undefined) ds.evalSchedulerIntervalId = null
if (ds.swarmTimeoutIntervalId === undefined) ds.swarmTimeoutIntervalId = null
if (ds.healthCheckRunning === undefined) ds.healthCheckRunning = false
if (ds.connectorHealthCheckRunning === undefined) ds.connectorHealthCheckRunning = false
if (ds.shuttingDown === undefined) ds.shuttingDown = false
if (!ds.providerPingCircuitBreaker) ds.providerPingCircuitBreaker = new Map<string, { consecutiveFailures: number; skipUntil: number }>()
if (ds.lockRenewIntervalId === undefined) ds.lockRenewIntervalId = null
if (ds.leaseRetryTimeoutId === undefined) ds.leaseRetryTimeoutId = null
if (ds.primaryLeaseHeld === undefined) ds.primaryLeaseHeld = false

function stopDaemonLeaseRenewal(opts?: { release?: boolean }) {
  if (ds.lockRenewIntervalId) {
    clearInterval(ds.lockRenewIntervalId)
    ds.lockRenewIntervalId = null
  }
  if (opts?.release !== false && ds.primaryLeaseHeld) {
    try {
      releaseRuntimeLock(DAEMON_RUNTIME_LOCK_NAME, daemonLockOwner)
    } catch {
      // Best effort during shutdown or HMR.
    }
  }
  if (opts?.release !== false) ds.primaryLeaseHeld = false
}

function startDaemonLeaseRenewal() {
  if (!ds.primaryLeaseHeld || ds.lockRenewIntervalId) return
  ds.lockRenewIntervalId = setInterval(() => {
    if (!ds.running || !ds.primaryLeaseHeld) return
    let renewed = false
    try {
      renewed = renewRuntimeLock(DAEMON_RUNTIME_LOCK_NAME, daemonLockOwner, DAEMON_RUNTIME_LOCK_TTL_MS)
    } catch (err: unknown) {
      log.warn(TAG, `[daemon] Failed to renew daemon lease: ${errorMessage(err)}`)
    }
    if (renewed) return
    ds.primaryLeaseHeld = false
    stopDaemonLeaseRenewal({ release: false })
    log.warn(TAG, '[daemon] Lost cross-process daemon lease; stopping local daemon instance')
    void stopDaemon({ source: 'lease-lost' })
  }, DAEMON_RUNTIME_LOCK_RENEW_MS)
}

function acquireDaemonLease(source: string): boolean {
  if (ds.primaryLeaseHeld) {
    startDaemonLeaseRenewal()
    return true
  }
  let acquired = false
  try {
    acquired = tryAcquireRuntimeLock(DAEMON_RUNTIME_LOCK_NAME, daemonLockOwner, DAEMON_RUNTIME_LOCK_TTL_MS)
  } catch (err: unknown) {
    log.warn(TAG, `[daemon] Failed to acquire daemon lease (source=${source}): ${errorMessage(err)}`)
    return false
  }
  if (!acquired) {
    let owner = 'another process'
    let expiresAt: number | null = null
    try {
      const lease = readRuntimeLock(DAEMON_RUNTIME_LOCK_NAME)
      if (lease) {
        owner = lease.owner || owner
        expiresAt = lease.expiresAt
      }
    } catch {
      // Best-effort diagnostics only.
    }

    // Stale-lease recovery: when a previous container / process crashed
    // without releasing the lease, the new instance would otherwise wait
    // up to the full TTL (DAEMON_RUNTIME_LOCK_TTL_MS) before being able
    // to start the daemon. If the recorded owner pid is local to this
    // host AND is no longer alive, reclaim the lease immediately and
    // retry. Conservative: any uncertainty (different host, malformed
    // owner, kill probe failed for an unexpected reason) skips the
    // reclaim path. Reported as issue #41 (Bug 2).
    if (isOwnerProcessDead(owner)) {
      try {
        releaseRuntimeLock(DAEMON_RUNTIME_LOCK_NAME, owner)
        log.info(TAG, `[daemon] Reclaimed stale daemon-primary lease from dead owner ${owner}`)
        let retried = false
        try {
          retried = tryAcquireRuntimeLock(DAEMON_RUNTIME_LOCK_NAME, daemonLockOwner, DAEMON_RUNTIME_LOCK_TTL_MS)
        } catch (err: unknown) {
          log.warn(TAG, `[daemon] Reclaim retry failed (source=${source}): ${errorMessage(err)}`)
        }
        if (retried) {
          ds.primaryLeaseHeld = true
          startDaemonLeaseRenewal()
          return true
        }
      } catch (err: unknown) {
        log.warn(TAG, `[daemon] Failed to release stale lease (source=${source}): ${errorMessage(err)}`)
      }
    }

    log.info(TAG, `[daemon] Skipping start (source=${source}); lease held by ${owner}`)

    // Schedule one deferred retry slightly past the lease's expiry so
    // the daemon comes up automatically once the prior owner's TTL has
    // elapsed, instead of waiting for the next API call to nudge it.
    if (expiresAt !== null) {
      const delayMs = Math.max(1_000, expiresAt - Date.now() + 1_000)
      if (ds.leaseRetryTimeoutId) clearTimeout(ds.leaseRetryTimeoutId)
      ds.leaseRetryTimeoutId = setTimeout(() => {
        ds.leaseRetryTimeoutId = null
        if (ds.running || ds.primaryLeaseHeld) return
        ensureDaemonStarted(`${source}:lease-retry`)
      }, delayMs)
      ds.leaseRetryTimeoutId.unref?.()
    }
    return false
  }
  ds.primaryLeaseHeld = true
  startDaemonLeaseRenewal()
  return true
}

export function ensureDaemonStarted(source = 'unknown'): boolean {
  if (ds.running) return false
  if (!daemonAutostartEnvEnabled()) return false
  if (ds.manualStopRequested) return false
  if (loadEstopState().level !== 'none') return false
  return startDaemon({ source, manualStart: false })
}

export function startDaemon(options?: { source?: string; manualStart?: boolean }): boolean {
  const source = options?.source || 'unknown'
  const manualStart = options?.manualStart === true
  if (manualStart) ds.manualStopRequested = false
  const estop = loadEstopState()
  if (estop.level !== 'none') {
    notify('daemon')
    log.warn(TAG, `[daemon] Start blocked by estop (level=${estop.level}, source=${source})`)
    return false
  }

  if (ds.running) {
    // In dev/HMR, daemon can already be flagged running while new interval types
    // (for example health monitor) were introduced in newer code.
    startDaemonLeaseRenewal()
    startQueueProcessor()
    startBrowserSweep()
    startHeartbeatService()
    startMemoryConsolidation()
    startSwarmTimeoutChecker()
    syncDaemonBackgroundServices({ runConnectorHealthCheckImmediately: false })
    return false
  }
  if (!acquireDaemonLease(source)) {
    notify('daemon')
    return false
  }
  ds.running = true
  notify('daemon')
  log.info(TAG, `[daemon] Starting daemon (source=${source}, scheduler + queue processor + heartbeat)`)

  try {
    validateCompletedTasksQueue()
    cleanupFinishedTaskSessions()
    recoverStaleDelegationJobs({ fullRestart: true })
    ensureProtocolEngineRecovered()
    restoreProviderHealthState()
    try {
      const lost = restoreSwarmRegistry()
      if (lost > 0) log.info(TAG, `[daemon] Marked ${lost} in-flight swarm(s) as lost after restart`)
    } catch { /* best-effort */ }
    resumeQueue()
    startScheduler()
    startQueueProcessor()
    startBrowserSweep()
    startHeartbeatService()
    startMemoryConsolidation()
    startSwarmTimeoutChecker()
    syncDaemonBackgroundServices({ runConnectorHealthCheckImmediately: false })
  } catch (err: unknown) {
    ds.running = false
    stopDaemonLeaseRenewal()
    notify('daemon')
    log.error(TAG, '[daemon] Failed to start:', errorMessage(err))
    throw err
  }

  if (isDaemonBackgroundServicesEnabled()) {
    // Auto-start enabled connectors only when the full background stack is enabled.
    autoStartConnectors().catch((err: unknown) => {
      log.error(TAG, '[daemon] Error auto-starting connectors:', errorMessage(err))
    })
  }
  return true
}

export async function stopDaemon(options?: { source?: string; manualStop?: boolean }) {
  const source = options?.source || 'unknown'
  if (options?.manualStop === true) ds.manualStopRequested = true
  if (!ds.running) {
    stopDaemonLeaseRenewal()
    return
  }
  ds.running = false
  ds.shuttingDown = true
  notify('daemon')
  log.info(TAG, `[daemon] Stopping daemon (source=${source})`)

  stopScheduler()
  stopQueueProcessor()
  stopBrowserSweep()
  stopHealthMonitor()
  stopConnectorHealthMonitor()
  stopConnectorOutboxWorker()
  stopHeartbeatService()
  stopMemoryConsolidation()
  stopSwarmTimeoutChecker()
  stopEvalScheduler()
  try {
    await Promise.race([
      stopAllConnectors({ disable: false }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Connector shutdown timed out')), SHUTDOWN_TIMEOUT_MS)
      ),
    ])
  } catch (err: unknown) {
    log.warn(TAG, `[daemon] Connector shutdown issue: ${errorMessage(err)}`)
  } finally {
    stopDaemonLeaseRenewal()
    ds.shuttingDown = false
  }
}

function startBrowserSweep() {
  if (ds.browserSweepId) return
  ds.browserSweepId = setInterval(() => {
    const count = getActiveBrowserCount()
    if (count > 0) {
      const cleaned = sweepOrphanedBrowsers(BROWSER_MAX_AGE)
      if (cleaned > 0) {
        log.info(TAG, `[daemon] Cleaned ${cleaned} orphaned browser(s), ${getActiveBrowserCount()} still active`)
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

export async function syncOpenClawGatewayLifecycle() {
  if (!hasOpenClawAgents()) {
    disconnectAutoGateways()
    return
  }
  if (!getGateway()?.connected) {
    await ensureGatewayConnected()
  }
}

function startQueueProcessor() {
  if (ds.queueIntervalId) return
  ds.queueIntervalId = setInterval(async () => {
    if (!ds.running) return
    const queue = loadQueue()
    if (queue.length > 0) {
      log.info(TAG, `[daemon] Processing ${queue.length} queued task(s)`)
      try {
        await Promise.race([
          processNext(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Queue processing timed out')), QUEUE_PROCESS_TIMEOUT)
          ),
        ])
      } catch (err: unknown) {
        log.error(TAG, `[daemon] Queue processing error/timeout: ${errorMessage(err)}`)
      }
      ds.lastProcessedAt = Date.now()
    }
    if (!isDaemonBackgroundServicesEnabled()) return
    // OpenClaw gateway lifecycle: lazy connect for active OpenClaw agents, stop auto-managed reconnects when none remain.
    try {
      await syncOpenClawGatewayLifecycle()
    } catch { /* gateway errors are non-fatal */ }
  }, QUEUE_CHECK_INTERVAL)
}

function stopQueueProcessor() {
  if (ds.queueIntervalId) {
    clearInterval(ds.queueIntervalId)
    ds.queueIntervalId = null
  }
}

async function sendHealthAlert(input: string | {
  text: string
  dedupKey?: string
  entityType?: string
  entityId?: string
}) {
  const payload = typeof input === 'string' ? { text: input } : input
  const text = payload.text
  log.warn(TAG, `[health] ${text}`)
  createNotification({
    type: 'warning',
    title: 'SwarmClaw health alert',
    message: text,
    dedupKey: payload.dedupKey || `health-alert:${text}`,
    entityType: payload.entityType,
    entityId: payload.entityId,
    dispatchExternally: false,
  })
}

async function runConnectorHealthChecks(now: number) {
  // First, collapse dead runtime instances into persisted error state so the
  // daemon can own the restart cadence and backoff policy.
  try {
    await checkConnectorHealth()
  } catch (err: unknown) {
    log.error(TAG, '[health] Connector isAlive check failed:', errorMessage(err))
  }

  const connectors = loadConnectors()
  for (const connector of Object.values(connectors) as Connector[]) {
    if (!connector?.id || typeof connector.id !== 'string') continue
    if (connector.isEnabled !== true) {
      clearReconnectState(connector.id)
      continue
    }

    const runtimeStatus = getConnectorStatus(connector.id)
    if (runtimeStatus === 'running') {
      clearReconnectState(connector.id)
      continue
    }

    const current = getReconnectState(connector.id)
      ?? createConnectorReconnectState(
        { error: typeof connector.lastError === 'string' ? connector.lastError : '' },
        { initialBackoffMs: CONNECTOR_RESTART_BASE_MS },
      )

    if (current.exhausted) {
      continue
    }

    if (current.nextRetryAt > now) continue

    // Notify on first detection of a down connector
    if (current.attempts === 0) {
      createNotification({
        type: 'warning',
        title: `Connector "${connector.name}" is down`,
        message: 'Auto-restart in progress.',
        dedupKey: `connector-down:${connector.id}`,
        entityType: 'connector',
        entityId: connector.id,
      })
    }

    try {
      await startConnector(connector.id)
      clearReconnectState(connector.id)
      await sendHealthAlert(`Connector "${connector.name}" (${connector.platform}) was down and has been auto-restarted.`)
    } catch (err: unknown) {
      const message = errorMessage(err)
      const next = advanceConnectorReconnectState(current, message, now, {
        initialBackoffMs: CONNECTOR_RESTART_BASE_MS,
        maxBackoffMs: CONNECTOR_RESTART_MAX_MS,
        maxAttempts: MAX_WAKE_ATTEMPTS,
      })
      setReconnectState(connector.id, next)
      if (next.exhausted) {
        log.warn(TAG, `[health] Connector "${connector.name}" exceeded ${MAX_WAKE_ATTEMPTS} auto-restart attempts — giving up until the server restarts or the user retries manually`)
        connector.status = 'error'
        connector.lastError = `Auto-restart gave up after ${MAX_WAKE_ATTEMPTS} attempts: ${message}`
        connector.updatedAt = Date.now()
        connectors[connector.id] = connector
        saveConnectors(connectors)
        notify('connectors')
        notifyOrchestrators(`Connector ${connector.name || connector.id} status: error — auto-restart exhausted after ${MAX_WAKE_ATTEMPTS} attempts`, `connector-status:${connector.id}`)
        createNotification({
          type: 'error',
          title: `Connector "${connector.name}" failed`,
          message: `Auto-restart gave up after ${MAX_WAKE_ATTEMPTS} attempts.`,
          dedupKey: `connector-gave-up:${connector.id}`,
          entityType: 'connector',
          entityId: connector.id,
        })
      } else {
        log.warn(TAG, `[health] Connector auto-restart failed for ${connector.name} (attempt ${next.attempts}/${MAX_WAKE_ATTEMPTS}): ${message}`)
      }
    }
  }

  // Purge restart state for connectors that no longer exist in storage
  for (const id of Object.keys(getAllReconnectStates())) {
    if (!connectors[id] || connectors[id]?.isEnabled !== true) clearReconnectState(id)
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
    const webhook = webhooks[entry.webhookId] as unknown as Record<string, unknown> | undefined
    if (!webhook) {
      // Webhook deleted — drop the retry
      deleteWebhookRetry(entry.id)
      continue
    }

    const agentId = typeof webhook.agentId === 'string' ? webhook.agentId : ''
    const agent = agentId ? (agents[agentId] as unknown as Record<string, unknown> | undefined) : null
    if (!agent) {
      entry.deadLettered = true
      upsertWebhookRetry(entry.id, entry)
      log.warn(TAG, `[webhook-retry] Dead-lettered ${entry.id}: agent not found for webhook ${entry.webhookId}`)
      continue
    }
    if (isAgentDisabled(agent)) {
      entry.deadLettered = true
      upsertWebhookRetry(entry.id, entry)
      log.warn(TAG, `[webhook-retry] Dead-lettered ${entry.id}: agent disabled for webhook ${entry.webhookId}`)
      continue
    }

    // Find or create a webhook session (same logic as the POST handler)
    const sessionName = `webhook:${entry.webhookId}`
    let session = Object.values(sessions).find(
      (s: unknown) => {
        const rec = s as Record<string, unknown>
        return rec.name === sessionName && rec.agentId === agent.id
      },
    ) as unknown as Record<string, unknown> | undefined

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
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: ts,
        lastActiveAt: ts,
        sessionType: 'human',
        agentId: agent.id,
        parentSessionId: null,
        ...getEnabledCapabilitySelection(agent),
        heartbeatEnabled: (agent.heartbeatEnabled as boolean | undefined) ?? false,
        heartbeatIntervalSec: (agent.heartbeatIntervalSec as number | null | undefined) ?? null,
      }
      const { upsertSession: upsert } = await import('@/lib/server/storage')
      upsert(session.id as string, session)
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
      log.info(TAG, `[webhook-retry] Successfully retried ${entry.id} for webhook ${entry.webhookId} (attempt ${entry.attempts})`)
    } catch (err: unknown) {
      const errorMsg = errorMessage(err)
      entry.attempts += 1

      if (entry.attempts >= entry.maxAttempts) {
        entry.deadLettered = true
        upsertWebhookRetry(entry.id, entry)
        log.warn(TAG, `[webhook-retry] Dead-lettered ${entry.id} after ${entry.attempts} attempts: ${errorMsg}`)
        const failure = classifyRuntimeFailure({ source: 'webhook', message: errorMsg })
        if (session?.id) {
          recordSupervisorIncident({
            runId: entry.id,
            sessionId: session.id as string,
            taskId: null,
            agentId: agentId || null,
            source: 'webhook',
            kind: 'runtime_failure',
            severity: failure.severity,
            summary: `Webhook delivery dead-lettered: ${errorMsg}`.slice(0, 320),
            details: errorMsg,
            failureFamily: failure.family,
            remediation: failure.remediation,
            repairPrompt: failure.repairPrompt,
            autoAction: null,
          })
        }

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
        log.warn(TAG, `[webhook-retry] Retry ${entry.id} failed (attempt ${entry.attempts}/${entry.maxAttempts}), next at ${new Date(entry.nextRetryAt).toISOString()}: ${errorMsg}`)
      }
    }
  }
}

async function runProviderHealthChecks() {
  const agents = loadAgents()
  const credentials = loadCredentials()

  // Build deduplicated set of { provider, credentialId, apiEndpoint } tuples
  const seen = new Set<string>()
  const tuples: { provider: string; credentialId: string; apiEndpoint: string; agentId: string; credentialName: string }[] = []

  for (const agent of Object.values(agents) as unknown as Record<string, unknown>[]) {
    if (!agent?.id || typeof agent.id !== 'string') continue
    if (shouldSuppressSyntheticAgentHealthAlert(agent.id)) continue
    const provider = typeof agent.provider === 'string' ? agent.provider : ''
    if (!provider || ['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'droid-cli', 'cursor-cli', 'qwen-code-cli', 'goose'].includes(provider)) continue

    const credentialId = typeof agent.credentialId === 'string' ? agent.credentialId : ''
    const apiEndpoint = typeof agent.apiEndpoint === 'string' ? agent.apiEndpoint : ''

    // For OpenClaw, scope per agent (each may have a different gateway)
    const key = provider === 'openclaw'
      ? `openclaw:${agent.id}`
      : `${provider}:${credentialId || 'no-cred'}:${apiEndpoint}`
    if (seen.has(key)) continue
    seen.add(key)

    const cred = credentialId ? (credentials[credentialId] as unknown as Record<string, unknown> | undefined) : undefined
    const credName = typeof cred?.name === 'string' ? cred.name : provider

    tuples.push({
      provider,
      credentialId,
      apiEndpoint,
      agentId: agent.id,
      credentialName: credName,
    })
  }

  for (const tuple of tuples) {
    // Circuit breaker: skip providers that have failed repeatedly
    const cbKey = `${tuple.provider}:${tuple.credentialId || 'no-cred'}:${tuple.apiEndpoint}`
    const cb = ds.providerPingCircuitBreaker.get(cbKey)
    const now = Date.now()
    if (cb && cb.skipUntil > now) continue

    let apiKey: string | undefined
    if (tuple.credentialId) {
      const cred = credentials[tuple.credentialId] as unknown as Record<string, unknown> | undefined
      if (cred?.encryptedKey && typeof cred.encryptedKey === 'string') {
        try { apiKey = decryptKey(cred.encryptedKey) } catch { /* skip undecryptable */ continue }
      }
    }

    const endpoint = tuple.apiEndpoint || OPENAI_COMPATIBLE_DEFAULTS[tuple.provider]?.defaultEndpoint || undefined
    const result = await pingProvider(tuple.provider, apiKey, endpoint)

    if (!result.ok) {
      // Update circuit breaker state
      const existing = ds.providerPingCircuitBreaker.get(cbKey) || { consecutiveFailures: 0, skipUntil: 0 }
      existing.consecutiveFailures += 1
      if (existing.consecutiveFailures >= PROVIDER_PING_CB_THRESHOLD) {
        const cooldown = Math.min(
          PROVIDER_PING_CB_BASE_MS * Math.pow(2, existing.consecutiveFailures - PROVIDER_PING_CB_THRESHOLD),
          PROVIDER_PING_CB_MAX_MS,
        )
        existing.skipUntil = now + cooldown
        log.info(TAG, `[health] Circuit breaker tripped for ${tuple.credentialName} — skipping pings for ${Math.round(cooldown / 60_000)}m`)
      }
      ds.providerPingCircuitBreaker.set(cbKey, existing)

      if (!shouldNotifyProviderReachabilityIssue(tuple.provider)) {
        continue
      }

      const dedupKey = `provider-down:${tuple.credentialId || tuple.provider}`

      const entityType = tuple.credentialId ? 'credential' : undefined
      const entityId = tuple.credentialId || undefined

      createNotification({
        type: 'warning',
        title: `Provider unreachable: ${tuple.credentialName}`,
        message: result.message,
        dedupKey,
        entityType,
        entityId,
      })
    } else {
      // Success — clear circuit breaker
      ds.providerPingCircuitBreaker.delete(cbKey)
    }
  }
}

const OPENCLAW_REPAIR_MAX_ATTEMPTS = 3
const OPENCLAW_REPAIR_COOLDOWN_MS = 300_000 // 5 minutes

async function runOpenClawGatewayHealthChecks() {
  const agents = loadAgents()
  const credentials = loadCredentials()

  // Build deduplicated OpenClaw agent tuples
  const seen = new Set<string>()
  const tuples: { agentId: string; endpoint: string; credentialId: string; credentialName: string }[] = []

  for (const agent of Object.values(agents) as unknown as Record<string, unknown>[]) {
    if (!agent?.id || typeof agent.id !== 'string') continue
    if (shouldSuppressSyntheticAgentHealthAlert(agent.id)) continue
    if (agent.provider !== 'openclaw') continue

    const key = `openclaw:${agent.id}`
    if (seen.has(key)) continue
    seen.add(key)

    const credentialId = typeof agent.credentialId === 'string' ? agent.credentialId : ''
    const endpoint = typeof agent.apiEndpoint === 'string' ? agent.apiEndpoint : ''
    const cred = credentialId ? (credentials[credentialId] as unknown as Record<string, unknown> | undefined) : undefined
    const credName = typeof cred?.name === 'string' ? cred.name : 'openclaw'

    tuples.push({ agentId: agent.id, endpoint, credentialId, credentialName: credName })
  }

  if (!tuples.length) return

  const { probeOpenClawHealth } = await import('@/lib/server/openclaw/health')

  for (const tuple of tuples) {
    let token: string | undefined
    if (tuple.credentialId) {
      const cred = credentials[tuple.credentialId] as unknown as Record<string, unknown> | undefined
      if (cred?.encryptedKey && typeof cred.encryptedKey === 'string') {
        try { token = decryptKey(cred.encryptedKey) } catch { continue }
      }
    }

    const result = await probeOpenClawHealth({
      endpoint: tuple.endpoint || undefined,
      token,
      timeoutMs: 10_000,
    })

    const now = Date.now()

    if (result.ok) {
      // Recovered
      if (ds.openclawDownAgentIds.has(tuple.agentId)) {
        ds.openclawDownAgentIds.delete(tuple.agentId)
        ds.openclawRepairState.delete(tuple.agentId)
        createNotification({
          type: 'success',
          title: 'OpenClaw gateway recovered',
          message: `Gateway for ${tuple.credentialName} is reachable again.`,
          dedupKey: `openclaw-gw-down:${tuple.agentId}`,
        })
      }
      continue
    }

    // Unhealthy
    const repair = ds.openclawRepairState.get(tuple.agentId) || { attempts: 0, lastAttemptAt: 0, cooldownUntil: 0 }

    // In cooldown — skip
    if (repair.cooldownUntil > now) continue

    // Cooldown expired — reset
    if (repair.cooldownUntil > 0 && repair.cooldownUntil <= now) {
      repair.attempts = 0
      repair.cooldownUntil = 0
    }

    ds.openclawDownAgentIds.add(tuple.agentId)

    if (repair.attempts < OPENCLAW_REPAIR_MAX_ATTEMPTS) {
      try {
        const { runOpenClawDoctor } = await import('@/lib/server/openclaw/doctor')
        await runOpenClawDoctor({ fix: true })
      } catch (err: unknown) {
        log.warn(TAG, '[daemon] openclaw doctor --fix failed:', errorMessage(err))
      }
      repair.attempts += 1
      repair.lastAttemptAt = now
    } else {
      repair.cooldownUntil = now + OPENCLAW_REPAIR_COOLDOWN_MS
    }

    ds.openclawRepairState.set(tuple.agentId, repair)

    createNotification({
      type: 'error',
      title: `OpenClaw gateway unreachable: ${tuple.credentialName}`,
      message: result.error || 'Health check failed',
      dedupKey: `openclaw-gw-down:${tuple.agentId}`,
    })
  }
}

/**
 * Prune orphaned entries from module-level Maps/Sets that reference
 * sessions, connectors, or agents that no longer exist in storage.
 * Runs every health-check cycle (2 minutes).
 */
function pruneOrphanedState(sessions: Record<string, unknown>): void {
  const liveSessionIds = new Set(Object.keys(sessions))

  // Main-loop state map (per-session autonomous state)
  pruneMainLoopState(liveSessionIds)

  // Heartbeat service tracking maps
  pruneHeartbeatState(liveSessionIds)

  // System event queues for dead sessions
  pruneSystemEventQueues(liveSessionIds)

  // Subagent lineage/handle registry — remove finished subagent state older than 30 min
  cleanupFinishedSubagents()

  // Process manager — sweep completed processes older than TTL
  sweepManagedProcesses()

  // Reap orphaned sandbox containers from prior crashes
  reapOrphanedSandboxContainers().catch((err) => {
    log.warn(TAG, '[daemon] Orphaned sandbox reap failed:', typeof err === 'object' && err !== null && 'message' in err ? (err as Error).message : String(err))
  })

  // Daemon-local: prune openclawRepairState for agents that no longer exist
  const agents = loadAgents()
  for (const agentId of ds.openclawRepairState.keys()) {
    if (!agents[agentId]) ds.openclawRepairState.delete(agentId)
  }
  for (const agentId of ds.openclawDownAgentIds) {
    if (!agents[agentId]) ds.openclawDownAgentIds.delete(agentId)
  }

  // Orchestrator event queues for dead agents
  const liveAgentIds = new Set(Object.keys(agents))
  pruneOrchestratorEventQueues(liveAgentIds)

  // Orchestrator wake/failure/dailyCycles Maps for deleted agents
  pruneOrchestratorState(liveAgentIds)

  // Connector tracking Maps for deleted connectors
  const connectors = loadConnectors()
  pruneConnectorTrackingState(new Set(Object.keys(connectors)))

  // Prune circuit breaker entries for providers that no longer have any agent referencing them
  const liveProviderKeys = new Set<string>()
  for (const agent of Object.values(agents) as unknown as Record<string, unknown>[]) {
    if (!agent?.id) continue
    const p = typeof agent.provider === 'string' ? agent.provider : ''
    const c = typeof agent.credentialId === 'string' ? agent.credentialId : ''
    const e = typeof agent.apiEndpoint === 'string' ? agent.apiEndpoint : ''
    if (p) liveProviderKeys.add(`${p}:${c || 'no-cred'}:${e}`)
  }
  for (const key of ds.providerPingCircuitBreaker.keys()) {
    if (!liveProviderKeys.has(key)) ds.providerPingCircuitBreaker.delete(key)
  }
}

async function runMemoryMaintenanceTick(): Promise<void> {
  try {
    const memDb = getMemoryDb()
    const result = memDb.maintain({ dedupe: true, pruneWorking: true, ttlHours: 24 })
    if (result.deduped > 0 || result.pruned > 0) {
      log.info(TAG, `[daemon] Memory maintenance: deduped=${result.deduped}, pruned=${result.pruned}`)
    }
  } catch (err: unknown) {
    log.warn(TAG, '[daemon] Memory maintenance tick failed:', err instanceof Error ? err.message : String(err))
  }
}

async function runHealthChecks() {
  // Continuously keep the completed queue honest.
  validateCompletedTasksQueue()
  recoverStalledRunningTasks()

  // Watchdog: abort runs stuck in running state beyond their timeout threshold.
  try {
    const stuck = sweepStuckRuns()
    if (stuck.aborted > 0) {
      log.info(TAG, `[daemon] Watchdog: aborted ${stuck.aborted} stuck run(s)`)
    }
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Stuck-run watchdog failed:', err instanceof Error ? err.message : String(err))
  }

  // Keep heartbeat state in sync with task terminal states even without daemon restarts.
  cleanupFinishedTaskSessions()

  // Re-queue deferred tasks whose agents have become available again.
  try { promoteDeferred() } catch {}

  const sessions = loadSessions()
  const now = Date.now()
  const currentlyStale = new Set<string>()
  const dirtySessionIds: string[] = []

  for (const session of Object.values(sessions) as unknown as Record<string, unknown>[]) {
    if (!session?.id || typeof session.id !== 'string') continue
    if (session.heartbeatEnabled !== true) continue

    const sessionId = session.id
    if (shouldSuppressSessionHeartbeatHealthAlert(session as Pick<Session, 'id' | 'name' | 'user' | 'shortcutForAgentId'>)) {
      ds.staleSessionIds.delete(sessionId)
      continue
    }

    const sessionLabel = String(session.name || sessionId)
    const intervalSec = parseHeartbeatIntervalSec(session.heartbeatIntervalSec, DEFAULT_HEARTBEAT_INTERVAL_SEC)
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
        dirtySessionIds.push(sessionId)
        ds.staleSessionIds.delete(sessionId)
        await sendHealthAlert({
          text: `Auto-disabled heartbeat for stale session "${sessionLabel}" after ${Math.round(staleForMs / 60_000)}m of inactivity.`,
          dedupKey: buildSessionHeartbeatHealthDedupKey(sessionId, 'auto-disabled'),
          entityType: 'session',
          entityId: sessionId,
        })
        continue
      }

      currentlyStale.add(sessionId)
      // Only alert on transition from healthy → stale (once per stale episode)
      if (!ds.staleSessionIds.has(sessionId)) {
        ds.staleSessionIds.add(sessionId)
        await sendHealthAlert({
          text: `Session "${sessionLabel}" heartbeat appears stale (last active ${(Math.round(staleForMs / 1000))}s ago, interval ${intervalSec}s).`,
          dedupKey: buildSessionHeartbeatHealthDedupKey(sessionId, 'stale'),
          entityType: 'session',
          entityId: sessionId,
        })
      }
    }
  }

  // Clear recovered sessions so they can re-alert if they go stale again later
  for (const id of ds.staleSessionIds) {
    if (!currentlyStale.has(id)) {
      ds.staleSessionIds.delete(id)
    }
  }

  for (const sid of dirtySessionIds) {
    const s = sessions[sid]
    if (s) {
      const { upsertSession: upsert } = await import('@/lib/server/storage')
      upsert(sid, s)
    }
  }

  // Provider reachability checks
  try {
    await runProviderHealthChecks()
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Provider health check failed:', errorMessage(err))
  }

  // OpenClaw gateway health checks + auto-repair
  try {
    await runOpenClawGatewayHealthChecks()
  } catch (err: unknown) {
    log.error(TAG, '[daemon] OpenClaw gateway health check failed:', errorMessage(err))
  }

  // Integrity drift monitoring for identity/config/extension files.
  try {
    const integrity = runIntegrityMonitor(loadSettings())
    ds.lastIntegrityCheckAt = integrity.checkedAt
    ds.lastIntegrityDriftCount = integrity.drifts.length
    if (integrity.drifts.length > 0) {
      for (const drift of integrity.drifts) {
        const rel = path.relative(process.cwd(), drift.filePath)
        const shortPath = rel && !rel.startsWith('..') ? rel : drift.filePath
        const action = drift.type === 'created'
          ? 'created'
          : drift.type === 'deleted'
            ? 'deleted'
            : 'modified'
        createNotification({
          type: drift.type === 'deleted' ? 'error' : 'warning',
          title: `Integrity drift detected (${drift.kind})`,
          message: `${shortPath} was ${action}.`,
          dedupKey: `integrity:${drift.id}:${drift.nextHash || 'missing'}`,
          entityType: 'session',
          entityId: drift.id,
        })
      }
      await sendHealthAlert(`Integrity monitor detected ${integrity.drifts.length} file drift event(s).`)
    }
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Integrity monitor check failed:', errorMessage(err))
  }

  // Process webhook retry queue
  try {
    await processWebhookRetries()
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Webhook retry processing failed:', errorMessage(err))
  }

  // Periodic memory hygiene: prune orphaned state for deleted sessions/connectors
  try {
    pruneOrphanedState(sessions)
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Memory hygiene sweep failed:', errorMessage(err))
  }

  // Prune old terminal runs and their events to prevent unbounded growth
  try {
    const pruned = pruneOldRuns()
    if (pruned.prunedRuns > 0 || pruned.prunedEvents > 0) {
      log.info(TAG, `[daemon] Pruned ${pruned.prunedRuns} old run(s) and ${pruned.prunedEvents} run event(s)`)
    }
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Run pruning failed:', err instanceof Error ? err.message : String(err))
  }

  // Prune expired runtime locks
  try {
    const locksRemoved = pruneExpiredLocks()
    if (locksRemoved > 0) {
      log.info(TAG, `[daemon] Pruned ${locksRemoved} expired lock(s)`)
    }
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Lock pruning failed:', err instanceof Error ? err.message : String(err))
  }

  // Prune old execution logs (30-day retention)
  try {
    const logsRemoved = clearLogsByAge(30 * 24 * 3600_000)
    if (logsRemoved > 0) {
      log.info(TAG, `[daemon] Pruned ${logsRemoved} old execution log(s)`)
    }
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Execution log pruning failed:', errorMessage(err))
  }

  // Prune old usage records (90-day retention)
  try {
    const usageRemoved = pruneOldUsage(90 * 24 * 3600_000)
    if (usageRemoved > 0) {
      log.info(TAG, `[daemon] Pruned ${usageRemoved} old usage record(s)`)
    }
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Usage pruning failed:', errorMessage(err))
  }

  // Periodic memory database maintenance (dedup + TTL pruning)
  try {
    await runMemoryMaintenanceTick()
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Memory maintenance failed:', err instanceof Error ? err.message : String(err))
  }

  // Drain idle-window callbacks when the system is quiet
  try {
    await drainIdleWindowCallbacks()
  } catch (err: unknown) {
    log.error(TAG, '[daemon] Idle-window drain failed:', err instanceof Error ? err.message : String(err))
  }
}

function startHealthMonitor() {
  if (ds.healthIntervalId) return
  ds.healthIntervalId = setInterval(() => {
    if (ds.healthCheckRunning || ds.shuttingDown) return
    ds.healthCheckRunning = true
    runHealthChecks()
      .catch((err) => {
        log.error(TAG, '[daemon] Health monitor tick failed:', err?.message || String(err))
      })
      .finally(() => { ds.healthCheckRunning = false })
  }, HEALTH_CHECK_INTERVAL)
}

function stopHealthMonitor() {
  if (ds.healthIntervalId) {
    clearInterval(ds.healthIntervalId)
    ds.healthIntervalId = null
  }
}

function syncDaemonBackgroundServices(options?: { runConnectorHealthCheckImmediately?: boolean }) {
  if (isDaemonBackgroundServicesEnabled()) {
    startHealthMonitor()
    startConnectorHealthMonitor({
      runImmediately: options?.runConnectorHealthCheckImmediately !== false,
    })
    startConnectorOutboxWorker()
    startEvalScheduler()
    return
  }
  stopHealthMonitor()
  stopConnectorHealthMonitor()
  stopConnectorOutboxWorker()
  stopEvalScheduler()
}

function startConnectorHealthMonitor(options?: { runImmediately?: boolean }) {
  if (ds.connectorHealthIntervalId) return

  const tick = () => {
    if (ds.connectorHealthCheckRunning || ds.shuttingDown) return
    ds.connectorHealthCheckRunning = true
    runConnectorHealthChecks(Date.now())
      .catch((err) => {
        log.error(TAG, '[daemon] Connector health tick failed:', errorMessage(err))
      })
      .finally(() => { ds.connectorHealthCheckRunning = false })
  }

  if (options?.runImmediately !== false) tick()
  ds.connectorHealthIntervalId = setInterval(tick, CONNECTOR_HEALTH_CHECK_INTERVAL)
}

function stopConnectorHealthMonitor() {
  if (ds.connectorHealthIntervalId) {
    clearInterval(ds.connectorHealthIntervalId)
    ds.connectorHealthIntervalId = null
  }
}

function runConsolidationTick() {
  import('@/lib/server/memory/memory-consolidation').then(({ runDailyConsolidation, registerConsolidationIdleCallback, registerCompactionIdleCallback }) => {
    // Wire idle-window callbacks so consolidation, compaction, and dreaming run during quiet periods
    registerConsolidationIdleCallback()
    registerCompactionIdleCallback()
    import('@/lib/server/memory/dream-idle-callback').then(({ registerDreamIdleCallback }) => {
      registerDreamIdleCallback()
    }).catch((err: unknown) => {
      log.error(TAG, '[daemon] Dream idle callback registration failed:', errorMessage(err))
    })

    return runDailyConsolidation().then((stats) => {
      if (stats.digests > 0 || stats.pruned > 0 || stats.deduped > 0) {
        log.info(TAG, `[daemon] Memory consolidation: ${stats.digests} digest(s), ${stats.pruned} pruned, ${stats.deduped} deduped`)
      }
      if (stats.errors.length > 0) {
        log.warn(TAG, `[daemon] Memory consolidation errors: ${stats.errors.join('; ')}`)
      }
    })
  }).catch((err: unknown) => {
    log.error(TAG, '[daemon] Memory consolidation failed:', errorMessage(err))
  })
}

function startMemoryConsolidation() {
  if (ds.memoryConsolidationTimeoutId || ds.memoryConsolidationIntervalId) return
  // Deferred first run, then repeat on interval
  ds.memoryConsolidationTimeoutId = setTimeout(() => {
    ds.memoryConsolidationTimeoutId = null
    runConsolidationTick()
    ds.memoryConsolidationIntervalId = setInterval(runConsolidationTick, MEMORY_CONSOLIDATION_INTERVAL)
  }, MEMORY_CONSOLIDATION_INITIAL_DELAY)
}

function stopMemoryConsolidation() {
  if (ds.memoryConsolidationTimeoutId) {
    clearTimeout(ds.memoryConsolidationTimeoutId)
    ds.memoryConsolidationTimeoutId = null
  }
  if (ds.memoryConsolidationIntervalId) {
    clearInterval(ds.memoryConsolidationIntervalId)
    ds.memoryConsolidationIntervalId = null
  }
}

// --- Eval scheduler ---

const EVAL_DEFAULT_INTERVAL_MS = 24 * 3600_000 // 24 hours

async function runEvalSchedulerTick() {
  try {
    const settings = loadSettings()
    if (!settings.autonomyEvalEnabled) return

    const { runEvalSuite } = await import('@/lib/server/eval/runner')
    const agents = loadAgents()
    const heartbeatAgentIds = Object.keys(agents).filter(
      (id) => agents[id].heartbeatEnabled === true,
    )

    for (const agentId of heartbeatAgentIds) {
      try {
        const result = await runEvalSuite(agentId)
        log.info(TAG,
          `[daemon:eval] Agent ${agents[agentId].name}: ${result.percentage}% (${result.totalScore}/${result.maxScore})`,
        )
        createNotification({
          title: `Eval: ${agents[agentId].name} scored ${result.percentage}%`,
          message: `${result.runs.length} scenarios, ${result.totalScore}/${result.maxScore} points`,
          type: result.percentage >= 60 ? 'info' : 'warning',
        })
      } catch (err: unknown) {
        log.error(TAG, `[daemon:eval] Failed for agent ${agentId}:`, errorMessage(err))
      }
    }
  } catch (err: unknown) {
    log.error(TAG, '[daemon:eval] Scheduler tick error:', errorMessage(err))
  }
}

function startEvalScheduler() {
  if (ds.evalSchedulerIntervalId) return
  try {
    const settings = loadSettings()
    if (!settings.autonomyEvalEnabled) return
    const intervalMs = parseCronToMs(settings.autonomyEvalCron, EVAL_DEFAULT_INTERVAL_MS) || EVAL_DEFAULT_INTERVAL_MS
    ds.evalSchedulerIntervalId = setInterval(runEvalSchedulerTick, intervalMs)
    log.info(TAG, `[daemon:eval] Eval scheduler started (interval=${Math.round(intervalMs / 3600_000)}h)`)
  } catch {
    // Eval scheduling is optional — don't block daemon start
  }
}

function stopEvalScheduler() {
  if (ds.evalSchedulerIntervalId) {
    clearInterval(ds.evalSchedulerIntervalId)
    ds.evalSchedulerIntervalId = null
  }
}

const SWARM_TIMEOUT_CHECK_INTERVAL = 30_000

function startSwarmTimeoutChecker() {
  if (ds.swarmTimeoutIntervalId) return
  ds.swarmTimeoutIntervalId = setInterval(() => {
    if (!ds.running || ds.shuttingDown) return
    try {
      checkSwarmTimeouts()
    } catch (err: unknown) {
      log.error(TAG, `[daemon] Swarm timeout check error: ${errorMessage(err)}`)
    }
  }, SWARM_TIMEOUT_CHECK_INTERVAL)
}

function stopSwarmTimeoutChecker() {
  if (ds.swarmTimeoutIntervalId) {
    clearInterval(ds.swarmTimeoutIntervalId)
    ds.swarmTimeoutIntervalId = null
  }
}

function refreshDaemonTimersForHotReload() {
  if (!ds.running) return

  if (ds.queueIntervalId) {
    clearInterval(ds.queueIntervalId)
    ds.queueIntervalId = null
    startQueueProcessor()
  }

  if (ds.browserSweepId) {
    clearInterval(ds.browserSweepId)
    ds.browserSweepId = null
    startBrowserSweep()
  }

  if (ds.healthIntervalId) {
    clearInterval(ds.healthIntervalId)
    ds.healthIntervalId = null
  }

  if (ds.connectorHealthIntervalId) {
    clearInterval(ds.connectorHealthIntervalId)
    ds.connectorHealthIntervalId = null
  }

  if (ds.memoryConsolidationTimeoutId || ds.memoryConsolidationIntervalId) {
    stopMemoryConsolidation()
    startMemoryConsolidation()
  }

  if (ds.evalSchedulerIntervalId) {
    stopEvalScheduler()
  }

  if (ds.swarmTimeoutIntervalId) {
    stopSwarmTimeoutChecker()
    startSwarmTimeoutChecker()
  }

  syncDaemonBackgroundServices()
}

// In dev/HMR, the daemon state survives on globalThis while interval callbacks keep
// the old module closure alive. Refresh long-lived timers so they always run the
// current module's logic instead of stale health-alert code paths.
refreshDaemonTimersForHotReload()

export async function runDaemonHealthCheckNow() {
  // Bypass circuit breaker for manual/forced checks
  ds.providerPingCircuitBreaker.clear()
  await Promise.all([
    runHealthChecks(),
    runConnectorHealthChecks(Date.now()),
  ])
}

export async function runConnectorHealthCheckNowForTest(now = Date.now()) {
  await runConnectorHealthChecks(now)
}

export function getDaemonStatus() {
  const estop = loadEstopState()
  const queue = loadQueue()
  const schedules = loadSchedules()
  const reconnectStates = Object.values(getAllReconnectStates())

  // Find next scheduled task
  let nextScheduled: number | null = null
  for (const s of Object.values(schedules) as unknown as Record<string, unknown>[]) {
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
    backgroundServicesEnabled: isDaemonBackgroundServicesEnabled(),
    reducedMode: !isDaemonBackgroundServicesEnabled(),
    manualStopRequested: ds.manualStopRequested,
    estop,
    queueLength: queue.length,
    lastProcessed: ds.lastProcessedAt,
    nextScheduled,
    heartbeat: getHeartbeatServiceStatus(),
    health: {
      monitorActive: !!ds.healthIntervalId,
      connectorMonitorActive: !!ds.connectorHealthIntervalId,
      staleSessions: ds.staleSessionIds.size,
      connectorsInBackoff: reconnectStates.filter((state) => !state.exhausted).length,
      connectorsExhausted: reconnectStates.filter((state) => state.exhausted).length,
      checkIntervalSec: Math.trunc(HEALTH_CHECK_INTERVAL / 1000),
      connectorCheckIntervalSec: Math.trunc(CONNECTOR_HEALTH_CHECK_INTERVAL / 1000),
      integrity: {
        enabled: loadSettings().integrityMonitorEnabled !== false,
        lastCheckedAt: ds.lastIntegrityCheckAt,
        lastDriftCount: ds.lastIntegrityDriftCount,
      },
    },
    webhookRetry: {
      pendingRetries,
      deadLettered,
    },
    guards: {
      healthCheckRunning: ds.healthCheckRunning,
      connectorHealthCheckRunning: ds.connectorHealthCheckRunning,
      shuttingDown: ds.shuttingDown,
      providerCircuitBreakers: ds.providerPingCircuitBreaker.size,
    },
  }
}

/**
 * Lightweight health summary safe for external consumption.
 * Reads cached state only — no probes or side effects.
 */
export function getDaemonHealthSummary(): {
  ok: boolean
  uptime: number
  components: {
    daemon: { status: 'healthy' | 'stopped' | 'degraded' }
    connectors: { healthy: number; errored: number; total: number }
    providers: { healthy: number; cooldown: number; total: number }
    gateways: { healthy: number; degraded: number; total: number }
  }
  estop: boolean
  nextScheduledTask: number | null
} {
  const estopState = loadEstopState()
  const estopActive = estopState.level !== 'none'

  // Daemon status
  const daemonStatus: 'healthy' | 'stopped' | 'degraded' = !ds.running
    ? 'stopped'
    : estopActive ? 'degraded' : 'healthy'

  // Connector summary
  const connectors = loadConnectors()
  const connectorEntries = Object.values(connectors) as unknown as Record<string, unknown>[]
  const enabledConnectors = connectorEntries.filter(c => c?.isEnabled === true)
  let healthyConnectors = 0
  let erroredConnectors = 0
  for (const c of enabledConnectors) {
    if (typeof c.id === 'string' && getConnectorStatus(c.id) === 'running') {
      healthyConnectors++
    } else {
      erroredConnectors++
    }
  }

  // Provider summary (based on circuit breaker state)
  const agents = loadAgents()
  const agentEntries = Object.values(agents) as unknown as Record<string, unknown>[]
  const providerKeys = new Set<string>()
  for (const agent of agentEntries) {
    if (!agent?.id || typeof agent.id !== 'string') continue
    const provider = typeof agent.provider === 'string' ? agent.provider : ''
    if (!provider || ['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'droid-cli', 'cursor-cli', 'qwen-code-cli', 'goose'].includes(provider)) continue
    const credentialId = typeof agent.credentialId === 'string' ? agent.credentialId : ''
    const apiEndpoint = typeof agent.apiEndpoint === 'string' ? agent.apiEndpoint : ''
    providerKeys.add(`${provider}:${credentialId || 'no-cred'}:${apiEndpoint}`)
  }
  const now = Date.now()
  let cooldownProviders = 0
  for (const key of providerKeys) {
    const cb = ds.providerPingCircuitBreaker.get(key)
    if (cb && cb.skipUntil > now) cooldownProviders++
  }

  // Gateway summary (OpenClaw gateways)
  const totalGateways = ds.openclawDownAgentIds.size
    + agentEntries.filter(a => a?.provider === 'openclaw' && !ds.openclawDownAgentIds.has(a.id as string)).length
  const degradedGateways = ds.openclawDownAgentIds.size

  // Next scheduled task
  const schedules = loadSchedules()
  let nextScheduled: number | null = null
  for (const s of Object.values(schedules) as unknown as Record<string, unknown>[]) {
    if (s.status === 'active' && s.nextRunAt) {
      if (!nextScheduled || (s.nextRunAt as number) < nextScheduled) {
        nextScheduled = s.nextRunAt as number
      }
    }
  }

  const allProvidersDown = providerKeys.size > 0 && cooldownProviders >= providerKeys.size
  const ok = ds.running && !estopActive && !allProvidersDown

  return {
    ok,
    uptime: Math.trunc(process.uptime()),
    components: {
      daemon: { status: daemonStatus },
      connectors: {
        healthy: healthyConnectors,
        errored: erroredConnectors,
        total: enabledConnectors.length,
      },
      providers: {
        healthy: providerKeys.size - cooldownProviders,
        cooldown: cooldownProviders,
        total: providerKeys.size,
      },
      gateways: {
        healthy: totalGateways - degradedGateways,
        degraded: degradedGateways,
        total: totalGateways,
      },
    },
    estop: estopActive,
    nextScheduledTask: nextScheduled,
  }
}
