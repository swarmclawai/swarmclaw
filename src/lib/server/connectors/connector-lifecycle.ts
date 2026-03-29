import { log } from '@/lib/server/logger'
import { genId } from '@/lib/id'
import {
  loadConnectors, saveConnectors,
  loadCredentials, decryptKey,
  upsertConnectorHealthEvent,
  logActivity,
} from '../storage'
import type { ConnectorHealthEventType } from '@/types'
import { dedup, errorMessage, sleep } from '@/lib/shared-utils'
import { notify } from '../ws-hub'
import type { Connector } from '@/types'
import type { ConnectorInstance, InboundMessage } from './types'
import { notifyOrchestrators } from '@/lib/server/runtime/orchestrator-events'
import {
  clearReconnectState,
  connectorReconnectStateStore,
  createConnectorReconnectState,
  setReconnectState,
} from './reconnect-state'
import { connectorRuntimeState, runningConnectors } from './runtime-state'
import { ensureSwarmdockConnectorCredential } from './swarmdock-secret'

const TAG = 'connector-lifecycle'

const running = runningConnectors
const {
  lastInboundChannelByConnector,
  lastInboundTimeByConnector,
  locks,
  generationCounter,
  scheduledFollowups,
  pendingInboundDebounce,
  scheduledFollowupByDedupe,
} = connectorRuntimeState

/** Record a health event for a connector (persisted to connector_health collection) */
export function recordHealthEvent(connectorId: string, event: ConnectorHealthEventType, message?: string): void {
  const id = genId()
  upsertConnectorHealthEvent(id, {
    id,
    connectorId,
    event,
    message: message || undefined,
    timestamp: new Date().toISOString(),
  })
}

/** Get the current generation number for a connector (0 if never started) */
export function getConnectorGeneration(connectorId: string): number {
  return generationCounter.get(connectorId) ?? 0
}

/** Check whether a given generation is still the current one for a connector */
export function isCurrentGeneration(connectorId: string, gen: number): boolean {
  return generationCounter.get(connectorId) === gen
}

/** Get platform implementation lazily */
export async function getPlatform(platform: string) {
  // 1. Check Built-ins
  switch (platform) {
    case 'discord':  return (await import('./discord')).default
    case 'telegram': return (await import('./telegram')).default
    case 'slack':    return (await import('./slack')).default
    case 'whatsapp': return (await import('./whatsapp')).default
    case 'openclaw': return (await import('./openclaw')).default
    case 'bluebubbles': return (await import('./bluebubbles')).default
    case 'signal':    return (await import('./signal')).default
    case 'teams':     return (await import('./teams')).default
    case 'googlechat': return (await import('./googlechat')).default
    case 'matrix':    return (await import('./matrix')).default
    case 'email':     return (await import('./email')).default
    case 'swarmdock': return (await import('./swarmdock')).default
  }

  // 2. Check Extension-provided connectors
  try {
    const { getExtensionManager } = await import('../extensions')
    const manager = getExtensionManager()
    const extensionConnectors = manager.getConnectors()
    const found = extensionConnectors.find(c => c.id === platform)

    if (found) {
      return {
        start: async (connector: Connector, _token: string, onMessage: (msg: InboundMessage) => Promise<string>) => {
          const stop = found.startListener ? await found.startListener(onMessage) : () => {}
          return {
            connector,
            stop: async () => { if (stop) await stop() },
            sendMessage: found.sendMessage,
            supportsBinaryMedia: found.supportsBinaryMedia,
            authenticated: true,
          }
        }
      }
    }
  } catch (err: unknown) {
    log.warn(TAG, `Failed to check extensions for platform "${platform}":`, errorMessage(err))
  }

  throw new Error(`Unknown platform: ${platform}`)
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Start a connector (serialized per ID to prevent concurrent start/stop races) */
export async function startConnector(connectorId: string): Promise<void> {
  // Wait for any pending operation on this connector to finish (with timeout)
  const pending = locks.get(connectorId)
  if (pending) {
    await Promise.race([pending, sleep(15_000)]).catch(() => {})
    if (locks.get(connectorId) === pending) locks.delete(connectorId)
  }

  const op = withTimeout(_startConnectorImpl(connectorId), 30_000, 'Connector start timed out')
  locks.set(connectorId, op)
  try { await op } finally {
    if (locks.get(connectorId) === op) locks.delete(connectorId)
  }
}

async function _startConnectorImpl(connectorId: string): Promise<void> {
  // If already running, stop it first (handles stale entries)
  if (running.has(connectorId)) {
    try {
      const existing = running.get(connectorId)
      await existing?.stop()
    } catch { /* ignore cleanup errors */ }
    running.delete(connectorId)
  }

  const connectors = loadConnectors()
  const storedConnector = connectors[connectorId] as Connector | undefined
  if (!storedConnector) throw new Error('Connector not found')
  let connector: Connector = storedConnector

  // Starting a connector expresses durable intent: keep it enabled across
  // transient failures so daemon recovery and server restarts can retry it.
  if (connector.isEnabled !== true) {
    connector.isEnabled = true
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
  }

  try {
    let swarmdockFallbackPrivateKey: string | null = null
    if (connector.platform === 'swarmdock') {
      const prepared = ensureSwarmdockConnectorCredential(connector, {
        allowMigrationFailureFallback: true,
      })
      connector = prepared.connector
      connectors[connectorId] = connector
      swarmdockFallbackPrivateKey = prepared.fallbackPrivateKey
    }

    // Resolve bot token from credential
    let botToken = ''
    if (connector.credentialId) {
      const creds = loadCredentials()
      const cred = creds[connector.credentialId]
      if (cred?.encryptedKey) {
        try { botToken = decryptKey(cred.encryptedKey) } catch { /* ignore */ }
      }
    }
    // Also check config for inline token (some platforms)
    if (!botToken && connector.config.botToken) {
      botToken = connector.config.botToken
    }
    if (!botToken && connector.platform === 'bluebubbles' && connector.config.password) {
      botToken = connector.config.password
    }
    if (!botToken && swarmdockFallbackPrivateKey) {
      botToken = swarmdockFallbackPrivateKey
    }

    if (!botToken && connector.platform !== 'whatsapp' && connector.platform !== 'openclaw' && connector.platform !== 'signal' && connector.platform !== 'email' && connector.platform !== 'swarmdock') {
      throw new Error('No bot token configured')
    }

    const platform = await getPlatform(connector.platform)

    // Bump generation counter so stale events from previous instances are ignored
    generationCounter.set(connectorId, (generationCounter.get(connectorId) ?? 0) + 1)

    // Use lazy import for dispatchInboundConnectorMessage to avoid circular deps
    const { dispatchInboundConnectorMessage } = await import('./connector-inbound')

    const instance = await platform.start(
      connector,
      botToken,
      (msg) => dispatchInboundConnectorMessage(connectorId, connector, msg),
    )

    // Wire up onCrash callback for immediate stale-entry removal
    const typedInstance = instance as ConnectorInstance
    if (!typedInstance.onCrash) {
      typedInstance.onCrash = (error: string) => {
        log.warn(TAG, `onCrash fired for "${connector.name}" (${connectorId}): ${error}`)
        running.delete(connectorId)
        recordHealthEvent(connectorId, 'disconnected', `Crash callback: ${error}`)

        const freshConnectors = loadConnectors()
        const freshConnector = freshConnectors[connectorId] as Connector | undefined
        if (freshConnector) {
          freshConnector.status = 'error'
          freshConnector.lastError = error
          freshConnector.updatedAt = Date.now()
          freshConnectors[connectorId] = freshConnector
          saveConnectors(freshConnectors)
          notify('connectors')
        }

        if (!connectorReconnectStateStore.has(connectorId)) {
          setReconnectState(connectorId, createConnectorReconnectState({ error }))
        }
      }
    }

    running.set(connectorId, instance)

    // Update status in storage
    connector.status = 'running'
    connector.isEnabled = true
    connector.lastError = null
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    clearReconnectState(connectorId)
    notify('connectors')

    log.info(TAG, `Started ${connector.platform} connector: ${connector.name}`)
    logActivity({ entityType: 'connector', entityId: connectorId, action: 'started', actor: 'system', summary: `Connector "${connector.name}" (${connector.platform}) started` })
    recordHealthEvent(connectorId, 'started', `${connector.platform} connector "${connector.name}" started`)
  } catch (err: unknown) {
    const errMsg = errorMessage(err)
    connector.status = 'error'
    connector.isEnabled = true
    connector.lastError = errMsg
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
    recordHealthEvent(connectorId, 'error', errMsg)
    notifyOrchestrators(`Connector ${connector.name || connectorId} status: error`, `connector-status:${connectorId}`)
    throw err
  }
}

/** Stop a connector */
export async function stopConnector(
  connectorId: string,
  options?: { disable?: boolean },
): Promise<void> {
  const disable = options?.disable !== false
  const instance = running.get(connectorId)
  if (instance) {
    await instance.stop()
    running.delete(connectorId)
  }
  clearReconnectState(connectorId)

  for (const [debounceKey, entry] of pendingInboundDebounce.entries()) {
    if (entry.connector.id !== connectorId) continue
    clearTimeout(entry.timer)
    pendingInboundDebounce.delete(debounceKey)
  }

  for (const [followupId, followup] of scheduledFollowups.entries()) {
    if (followup.connectorId !== connectorId) continue
    clearTimeout(followup.timer)
    scheduledFollowups.delete(followupId)
  }
  for (const [key, entry] of scheduledFollowupByDedupe.entries()) {
    if (!scheduledFollowups.has(entry.id)) {
      scheduledFollowupByDedupe.delete(key)
    }
  }

  const connectors = loadConnectors()
  const connector = connectors[connectorId]
  if (connector) {
    connector.status = 'stopped'
    connector.isEnabled = disable ? false : connector.isEnabled === true
    connector.lastError = null
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
  }

  log.info(TAG, `Stopped connector: ${connectorId}`)
  logActivity({ entityType: 'connector', entityId: connectorId, action: 'stopped', actor: 'system', summary: `Connector stopped` })
  recordHealthEvent(connectorId, 'stopped', `Connector stopped`)
}

/** Get the runtime status of a connector */
export function getConnectorStatus(connectorId: string): 'running' | 'stopped' {
  return running.has(connectorId) ? 'running' : 'stopped'
}

/** Get the QR code data URL for a WhatsApp connector (null if not available) */
export function getConnectorQR(connectorId: string): string | null {
  const instance = running.get(connectorId)
  return instance?.qrDataUrl ?? null
}

/** Check if a WhatsApp connector has authenticated (paired) */
export function isConnectorAuthenticated(connectorId: string): boolean {
  const instance = running.get(connectorId)
  if (!instance) return false
  return instance.authenticated === true
}

/** Check if a WhatsApp connector has stored credentials */
export function hasConnectorCredentials(connectorId: string): boolean {
  const instance = running.get(connectorId)
  if (!instance) return false
  return instance.hasCredentials === true
}

/** Clear WhatsApp auth state and restart connector for fresh QR pairing */
export async function repairConnector(connectorId: string): Promise<void> {
  // Stop existing instance
  const instance = running.get(connectorId)
  if (instance) {
    await instance.stop()
    running.delete(connectorId)
  }
  clearReconnectState(connectorId)

  // Clear auth directory
  const { clearAuthDir } = await import('./whatsapp')
  clearAuthDir(connectorId)

  logActivity({ entityType: 'connector', entityId: connectorId, action: 'repaired', actor: 'system', summary: `Connector repaired (auth cleared, restarting)` })

  // Restart the connector — will get fresh QR
  await startConnector(connectorId)
}

/** Stop all running connectors (for cleanup) */
export async function stopAllConnectors(options?: { disable?: boolean }): Promise<void> {
  for (const [id] of running) {
    await stopConnector(id, options)
  }
}

/** Auto-start connectors that are marked as enabled (skips already-running ones) */
export async function autoStartConnectors(): Promise<void> {
  const connectors = loadConnectors()
  for (const connector of Object.values(connectors) as Connector[]) {
    if (connector.isEnabled && !running.has(connector.id)) {
      try {
        log.info(TAG, `Auto-starting ${connector.platform} connector: ${connector.name}`)
        await startConnector(connector.id)
      } catch (err: unknown) {
        log.error(TAG, `Failed to auto-start ${connector.name}:`, err instanceof Error ? err.message : err)
      }
    }
  }
}

/** List connector IDs that are currently running (optionally by platform) */
export function listRunningConnectors(platform?: string): Array<{
  id: string
  name: string
  platform: string
  agentId: string | null
  supportsSend: boolean
  configuredTargets: string[]
  recentChannelId: string | null
}> {
  const connectors = loadConnectors()
  const out: Array<{
    id: string
    name: string
    platform: string
    agentId: string | null
    supportsSend: boolean
    configuredTargets: string[]
    recentChannelId: string | null
  }> = []

  for (const [id, instance] of running.entries()) {
    const connector = connectors[id] as Connector | undefined
    if (!connector) continue
    if (platform && connector.platform !== platform) continue
    const configuredTargets: string[] = []
    if (connector.platform === 'whatsapp') {
      const outboundJid = connector.config?.outboundJid?.trim()
      if (outboundJid) configuredTargets.push(outboundJid)
      const allowed = connector.config?.allowedJids?.split(',').map((s: string) => s.trim()).filter(Boolean) || []
      configuredTargets.push(...allowed)
    } else if (connector.platform === 'bluebubbles') {
      const outbound = connector.config?.outboundTarget?.trim()
      if (outbound) configuredTargets.push(outbound)
      const allowed = connector.config?.allowFrom?.split(',').map((s: string) => s.trim()).filter(Boolean) || []
      configuredTargets.push(...allowed)
    }
    out.push({
      id,
      name: connector.name,
      platform: connector.platform,
      agentId: connector.agentId || null,
      supportsSend: typeof instance.sendMessage === 'function',
      configuredTargets: dedup(configuredTargets),
      recentChannelId: lastInboundChannelByConnector.get(id) || null,
    })
  }

  return out
}

/** Get the most recent inbound channel id seen for a connector */
export function getConnectorRecentChannelId(connectorId: string): string | null {
  return lastInboundChannelByConnector.get(connectorId) || null
}

/** Get presence info for a connector */
export function getConnectorPresence(connectorId: string): { lastMessageAt: number | null; channelId: string | null } {
  return {
    lastMessageAt: lastInboundTimeByConnector.get(connectorId) ?? null,
    channelId: lastInboundChannelByConnector.get(connectorId) ?? null,
  }
}

/** Get a running connector instance (internal use for rich messaging). */
export function getRunningInstance(connectorId: string): ConnectorInstance | undefined {
  return running.get(connectorId)
}

/**
 * Check health of all running connectors via `isAlive()`.
 * Dead connectors that are still enabled get automatic reconnection with exponential backoff.
 * After RECONNECT_MAX_ATTEMPTS, the connector is marked as error and retries stop.
 */
export async function checkConnectorHealth(): Promise<void> {
  const connectors = loadConnectors()
  let connectorsDirty = false

  for (const [id, instance] of running.entries()) {
    // If the instance has no isAlive method, skip (e.g. OpenClaw, BlueBubbles)
    if (typeof instance.isAlive !== 'function') continue

    if (instance.isAlive()) {
      // Connector is healthy — clear any reconnect state
      if (connectorReconnectStateStore.has(id)) {
        log.info(TAG, `Connector "${instance.connector.name}" recovered`)
        clearReconnectState(id)
      }
      continue
    }

    // Connector is dead but still in the running Map
    log.warn(TAG, `Connector "${instance.connector.name}" (${id}) isAlive=false — removing from running`)
    recordHealthEvent(id, 'disconnected', `Connector "${instance.connector.name}" detected as dead (isAlive=false)`)
    notifyOrchestrators(`Connector ${instance.connector.name || id} status: disconnected`, `connector-status:${id}`)

    // Clean up the dead instance
    try { await instance.stop() } catch { /* ignore */ }
    running.delete(id)

    const connector = connectors[id] as Connector | undefined
    if (!connector) continue

    // If the connector is not enabled, don't attempt reconnect
    if (!connector.isEnabled) {
      clearReconnectState(id)
      continue
    }

    connector.status = 'error'
    connector.lastError = connector.lastError || 'Connection lost'
    connector.updatedAt = Date.now()
    connectors[id] = connector
    connectorsDirty = true
    if (!connectorReconnectStateStore.has(id)) {
      setReconnectState(id, createConnectorReconnectState({
        error: connector.lastError || 'Connection lost',
      }))
    }
  }

  if (connectorsDirty) {
    saveConnectors(connectors)
    notify('connectors')
  }

  // Purge reconnect state for connectors that no longer exist
  for (const id of connectorReconnectStateStore.keys()) {
    if (!connectors[id] || connectors[id]?.isEnabled !== true || running.has(id)) clearReconnectState(id)
  }
}
