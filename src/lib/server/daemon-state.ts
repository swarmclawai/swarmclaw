import { loadQueue, loadSchedules, loadSessions, loadConnectors, saveConnectors, loadWebhookRetryQueue, upsertWebhookRetry, deleteWebhookRetry, loadWebhooks, loadAgents, loadSettings, appendWebhookLog, loadCredentials, decryptKey } from './storage'
import { notify } from './ws-hub'
import { processNext, cleanupFinishedTaskSessions, validateCompletedTasksQueue, recoverStalledRunningTasks, resumeQueue } from './queue'
import { startScheduler, stopScheduler } from './scheduler'
import { sweepOrphanedBrowsers, getActiveBrowserCount } from './session-tools'
import {
  autoStartConnectors,
  listRunningConnectors,
  sendConnectorMessage,
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
} from './connectors/manager'
import { startConnectorOutboxWorker, stopConnectorOutboxWorker } from './connectors/outbox'
import { startHeartbeatService, stopHeartbeatService, getHeartbeatServiceStatus } from './heartbeat-service'
import { hasOpenClawAgents, ensureGatewayConnected, disconnectGateway, getGateway } from './openclaw-gateway'
import { enqueueSessionRun } from './session-run-manager'
import { WORKSPACE_DIR } from './data-dir'
import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/heartbeat-defaults'
import { genId } from '@/lib/id'
import path from 'node:path'
import type { Session, WebhookRetryEntry } from '@/types'
import { createNotification } from '@/lib/server/create-notification'
import { pingProvider, OPENAI_COMPATIBLE_DEFAULTS } from '@/lib/server/provider-health'
import { runIntegrityMonitor } from '@/lib/server/integrity-monitor'
import { recoverStaleDelegationJobs } from './delegation-jobs'
import {
  listPendingApprovalsNeedingConnectorNotification,
  markApprovalConnectorNotificationAttempt,
  markApprovalConnectorNotificationSent,
} from './approvals'
import {
  buildSessionHeartbeatHealthDedupKey,
  daemonAutostartEnvEnabled,
  isDaemonBackgroundServicesEnabled,
  parseCronToMs,
  parseHeartbeatIntervalSec,
  shouldNotifyProviderReachabilityIssue,
  shouldSuppressSessionHeartbeatHealthAlert,
  shouldSuppressSyntheticAgentHealthAlert,
} from './daemon-policy'

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

export {
  buildSessionHeartbeatHealthDedupKey,
  isDaemonBackgroundServicesEnabled,
  shouldNotifyProviderReachabilityIssue,
  shouldSuppressSessionHeartbeatHealthAlert,
  shouldSuppressSyntheticAgentHealthAlert,
}

// Store daemon state on globalThis to survive HMR reloads
const gk = '__swarmclaw_daemon__' as const
const ds: {
  queueIntervalId: ReturnType<typeof setInterval> | null
  browserSweepId: ReturnType<typeof setInterval> | null
  healthIntervalId: ReturnType<typeof setInterval> | null
  connectorHealthIntervalId: ReturnType<typeof setInterval> | null
  memoryConsolidationTimeoutId: ReturnType<typeof setTimeout> | null
  memoryConsolidationIntervalId: ReturnType<typeof setInterval> | null
  evalSchedulerIntervalId: ReturnType<typeof setInterval> | null
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} = (globalThis as any)[gk] ?? ((globalThis as any)[gk] = {
  queueIntervalId: null,
  browserSweepId: null,
  healthIntervalId: null,
  connectorHealthIntervalId: null,
  memoryConsolidationTimeoutId: null,
  memoryConsolidationIntervalId: null,
  evalSchedulerIntervalId: null,
  staleSessionIds: new Set<string>(),
  openclawDownAgentIds: new Set<string>(),
  openclawRepairState: new Map<string, { attempts: number; lastAttemptAt: number; cooldownUntil: number }>(),
  lastIntegrityCheckAt: null,
  lastIntegrityDriftCount: 0,
  manualStopRequested: false,
  running: false,
  lastProcessedAt: null,
})

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
    startHeartbeatService()
    startMemoryConsolidation()
    syncDaemonBackgroundServices({ runConnectorHealthCheckImmediately: false })
    return
  }
  ds.running = true
  notify('daemon')
  console.log(`[daemon] Starting daemon (source=${source}, scheduler + queue processor + heartbeat)`)

  try {
    validateCompletedTasksQueue()
    cleanupFinishedTaskSessions()
    recoverStaleDelegationJobs()
    resumeQueue()
    startScheduler()
    startQueueProcessor()
    startBrowserSweep()
    startHeartbeatService()
    startMemoryConsolidation()
    syncDaemonBackgroundServices({ runConnectorHealthCheckImmediately: false })
  } catch (err: unknown) {
    ds.running = false
    notify('daemon')
    console.error('[daemon] Failed to start:', err instanceof Error ? err.message : String(err))
    throw err
  }

  if (isDaemonBackgroundServicesEnabled()) {
    // Auto-start enabled connectors only when the full background stack is enabled.
    autoStartConnectors().catch((err: unknown) => {
      console.error('[daemon] Error auto-starting connectors:', err instanceof Error ? err.message : String(err))
    })
  }
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
  stopConnectorHealthMonitor()
  stopConnectorOutboxWorker()
  stopHeartbeatService()
  stopMemoryConsolidation()
  stopEvalScheduler()
  stopAllConnectors({ disable: false }).catch(() => {})
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
    if (!isDaemonBackgroundServicesEnabled()) return
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

async function sendHealthAlert(input: string | {
  text: string
  dedupKey?: string
  entityType?: string
  entityId?: string
}) {
  const payload = typeof input === 'string' ? { text: input } : input
  const text = payload.text
  console.warn(`[health] ${text}`)
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
    console.error('[health] Connector isAlive check failed:', err instanceof Error ? err.message : String(err))
  }

  const connectors = loadConnectors()
  for (const connector of Object.values(connectors) as Record<string, unknown>[]) {
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
      const message = err instanceof Error ? err.message : String(err)
      const next = advanceConnectorReconnectState(current, message, now, {
        initialBackoffMs: CONNECTOR_RESTART_BASE_MS,
        maxBackoffMs: CONNECTOR_RESTART_MAX_MS,
        maxAttempts: MAX_WAKE_ATTEMPTS,
      })
      setReconnectState(connector.id, next)
      if (next.exhausted) {
        console.warn(`[health] Connector "${connector.name}" exceeded ${MAX_WAKE_ATTEMPTS} auto-restart attempts — giving up until the server restarts or the user retries manually`)
        connector.status = 'error'
        connector.lastError = `Auto-restart gave up after ${MAX_WAKE_ATTEMPTS} attempts: ${message}`
        connector.updatedAt = Date.now()
        connectors[connector.id] = connector
        saveConnectors(connectors)
        notify('connectors')
        createNotification({
          type: 'error',
          title: `Connector "${connector.name}" failed`,
          message: `Auto-restart gave up after ${MAX_WAKE_ATTEMPTS} attempts.`,
          dedupKey: `connector-gave-up:${connector.id}`,
          entityType: 'connector',
          entityId: connector.id,
        })
      } else {
        console.warn(`[health] Connector auto-restart failed for ${connector.name} (attempt ${next.attempts}/${MAX_WAKE_ATTEMPTS}): ${message}`)
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
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
        messages: [],
        createdAt: ts,
        lastActiveAt: ts,
        sessionType: 'human',
        agentId: agent.id,
        parentSessionId: null,
        plugins: agent.plugins || agent.tools || [],
        heartbeatEnabled: (agent.heartbeatEnabled as boolean | undefined) ?? false,
        heartbeatIntervalSec: (agent.heartbeatIntervalSec as number | null | undefined) ?? null,
      }
      const { upsertSession: upsert } = await import('./storage')
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

async function runProviderHealthChecks() {
  const agents = loadAgents()
  const credentials = loadCredentials()

  // Build deduplicated set of { provider, credentialId, apiEndpoint } tuples
  const seen = new Set<string>()
  const tuples: { provider: string; credentialId: string; apiEndpoint: string; agentId: string; credentialName: string }[] = []

  for (const agent of Object.values(agents) as Record<string, unknown>[]) {
    if (!agent?.id || typeof agent.id !== 'string') continue
    if (shouldSuppressSyntheticAgentHealthAlert(agent.id)) continue
    const provider = typeof agent.provider === 'string' ? agent.provider : ''
    if (!provider || ['claude-cli', 'codex-cli', 'opencode-cli'].includes(provider)) continue

    const credentialId = typeof agent.credentialId === 'string' ? agent.credentialId : ''
    const apiEndpoint = typeof agent.apiEndpoint === 'string' ? agent.apiEndpoint : ''

    // For OpenClaw, scope per agent (each may have a different gateway)
    const key = provider === 'openclaw'
      ? `openclaw:${agent.id}`
      : `${provider}:${credentialId || 'no-cred'}:${apiEndpoint}`
    if (seen.has(key)) continue
    seen.add(key)

    const cred = credentialId ? (credentials[credentialId] as Record<string, unknown> | undefined) : undefined
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
    let apiKey: string | undefined
    if (tuple.credentialId) {
      const cred = credentials[tuple.credentialId] as Record<string, unknown> | undefined
      if (cred?.encryptedKey && typeof cred.encryptedKey === 'string') {
        try { apiKey = decryptKey(cred.encryptedKey) } catch { /* skip undecryptable */ continue }
      }
    }

    const endpoint = tuple.apiEndpoint || OPENAI_COMPATIBLE_DEFAULTS[tuple.provider]?.defaultEndpoint || undefined
    const result = await pingProvider(tuple.provider, apiKey, endpoint)

    if (!result.ok) {
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

  for (const agent of Object.values(agents) as Record<string, unknown>[]) {
    if (!agent?.id || typeof agent.id !== 'string') continue
    if (shouldSuppressSyntheticAgentHealthAlert(agent.id)) continue
    if (agent.provider !== 'openclaw') continue

    const key = `openclaw:${agent.id}`
    if (seen.has(key)) continue
    seen.add(key)

    const credentialId = typeof agent.credentialId === 'string' ? agent.credentialId : ''
    const endpoint = typeof agent.apiEndpoint === 'string' ? agent.apiEndpoint : ''
    const cred = credentialId ? (credentials[credentialId] as Record<string, unknown> | undefined) : undefined
    const credName = typeof cred?.name === 'string' ? cred.name : 'openclaw'

    tuples.push({ agentId: agent.id, endpoint, credentialId, credentialName: credName })
  }

  if (!tuples.length) return

  const { probeOpenClawHealth } = await import('./openclaw-health')

  for (const tuple of tuples) {
    let token: string | undefined
    if (tuple.credentialId) {
      const cred = credentials[tuple.credentialId] as Record<string, unknown> | undefined
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
        const { runOpenClawDoctor } = await import('./openclaw-doctor')
        await runOpenClawDoctor({ fix: true })
      } catch (err: unknown) {
        console.warn('[daemon] openclaw doctor --fix failed:', err instanceof Error ? err.message : String(err))
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

async function runPendingApprovalConnectorNotifications(now: number) {
  const running = listRunningConnectors()
  const pending = listPendingApprovalsNeedingConnectorNotification({
    now,
    runningConnectors: running,
  })
  if (!pending.length) return

  for (const reminder of pending) {
    try {
      const result = await sendConnectorMessage({
        connectorId: reminder.connectorId,
        channelId: reminder.channelId,
        text: reminder.text,
        threadId: reminder.threadId || undefined,
      })
      markApprovalConnectorNotificationSent(reminder.approvalId, {
        at: now,
        connectorId: result.connectorId,
        channelId: result.channelId,
        threadId: reminder.threadId || null,
        messageId: result.messageId || null,
      })
      createNotification({
        type: 'info',
        title: 'Approval reminder sent',
        message: 'A pending approval reminder was delivered over an active connector.',
        dedupKey: `approval-connector-reminder:${reminder.approvalId}`,
        entityType: 'approval',
        entityId: reminder.approvalId,
      })
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      markApprovalConnectorNotificationAttempt(reminder.approvalId, {
        at: now,
        connectorId: reminder.connectorId,
        channelId: reminder.channelId,
        threadId: reminder.threadId || null,
        lastError: errorMsg,
      })
      console.warn(`[daemon] Approval connector reminder failed for ${reminder.approvalId}: ${errorMsg}`)
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
  const dirtySessionIds: string[] = []

  for (const session of Object.values(sessions) as Record<string, unknown>[]) {
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
      const { upsertSession: upsert } = await import('./storage')
      upsert(sid, s)
    }
  }

  // Provider reachability checks
  try {
    await runProviderHealthChecks()
  } catch (err: unknown) {
    console.error('[daemon] Provider health check failed:', err instanceof Error ? err.message : String(err))
  }

  // OpenClaw gateway health checks + auto-repair
  try {
    await runOpenClawGatewayHealthChecks()
  } catch (err: unknown) {
    console.error('[daemon] OpenClaw gateway health check failed:', err instanceof Error ? err.message : String(err))
  }

  try {
    await runPendingApprovalConnectorNotifications(now)
  } catch (err: unknown) {
    console.error('[daemon] Approval connector reminder check failed:', err instanceof Error ? err.message : String(err))
  }

  // Integrity drift monitoring for identity/config/plugin files.
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
    console.error('[daemon] Integrity monitor check failed:', err instanceof Error ? err.message : String(err))
  }

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
    runConnectorHealthChecks(Date.now()).catch((err) => {
      console.error('[daemon] Connector health tick failed:', err instanceof Error ? err.message : String(err))
    })
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
  import('./memory-consolidation').then(({ runDailyConsolidation }) =>
    runDailyConsolidation().then((stats) => {
      if (stats.digests > 0 || stats.pruned > 0 || stats.deduped > 0) {
        console.log(`[daemon] Memory consolidation: ${stats.digests} digest(s), ${stats.pruned} pruned, ${stats.deduped} deduped`)
      }
      if (stats.errors.length > 0) {
        console.warn(`[daemon] Memory consolidation errors: ${stats.errors.join('; ')}`)
      }
    }),
  ).catch((err: unknown) => {
    console.error('[daemon] Memory consolidation failed:', err instanceof Error ? err.message : String(err))
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

    const { runEvalSuite } = await import('./eval/runner')
    const agents = loadAgents()
    const heartbeatAgentIds = Object.keys(agents).filter(
      (id) => agents[id].heartbeatEnabled === true,
    )

    for (const agentId of heartbeatAgentIds) {
      try {
        const result = await runEvalSuite(agentId)
        console.log(
          `[daemon:eval] Agent ${agents[agentId].name}: ${result.percentage}% (${result.totalScore}/${result.maxScore})`,
        )
        createNotification({
          title: `Eval: ${agents[agentId].name} scored ${result.percentage}%`,
          message: `${result.runs.length} scenarios, ${result.totalScore}/${result.maxScore} points`,
          type: result.percentage >= 60 ? 'info' : 'warning',
        })
      } catch (err: unknown) {
        console.error(`[daemon:eval] Failed for agent ${agentId}:`, err instanceof Error ? err.message : String(err))
      }
    }
  } catch (err: unknown) {
    console.error('[daemon:eval] Scheduler tick error:', err instanceof Error ? err.message : String(err))
  }
}

function startEvalScheduler() {
  if (ds.evalSchedulerIntervalId) return
  try {
    const settings = loadSettings()
    if (!settings.autonomyEvalEnabled) return
    const intervalMs = parseCronToMs(settings.autonomyEvalCron, EVAL_DEFAULT_INTERVAL_MS) || EVAL_DEFAULT_INTERVAL_MS
    ds.evalSchedulerIntervalId = setInterval(runEvalSchedulerTick, intervalMs)
    console.log(`[daemon:eval] Eval scheduler started (interval=${Math.round(intervalMs / 3600_000)}h)`)
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

  syncDaemonBackgroundServices()
}

// In dev/HMR, the daemon state survives on globalThis while interval callbacks keep
// the old module closure alive. Refresh long-lived timers so they always run the
// current module's logic instead of stale health-alert code paths.
refreshDaemonTimersForHotReload()

export async function runDaemonHealthCheckNow() {
  await Promise.all([
    runHealthChecks(),
    runConnectorHealthChecks(Date.now()),
  ])
}

export async function runConnectorHealthCheckNowForTest(now = Date.now()) {
  await runConnectorHealthChecks(now)
}

export function getDaemonStatus() {
  const queue = loadQueue()
  const schedules = loadSchedules()
  const reconnectStates = Object.values(getAllReconnectStates())

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
    backgroundServicesEnabled: isDaemonBackgroundServicesEnabled(),
    reducedMode: !isDaemonBackgroundServicesEnabled(),
    manualStopRequested: ds.manualStopRequested,
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
  }
}
