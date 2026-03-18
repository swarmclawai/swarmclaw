import { genId } from '@/lib/id'
import { logActivity } from '@/lib/server/activity/activity-log'
import {
  deleteConnector,
  loadConnector,
  loadConnectorHealth,
  loadConnectors,
  upsertConnector,
} from '@/lib/server/connectors/connector-repository'
import {
  buildConnectorAccessSnapshot,
  resolveConnectorOwnerSenderId,
} from '@/lib/server/connectors/access'
import {
  addAllowedSender,
  approvePairingCode,
  approvePendingSender,
  clearSenderAddressingOverride,
  normalizeSenderId,
  parseAllowFromCsv,
  parseDmAddressingMode,
  parsePairingPolicy,
  removeAllowedSender,
  rejectPendingSender,
  setSenderAddressingOverride,
  senderMatchesAnyEntry,
} from '@/lib/server/connectors/pairing'
import { ensureDaemonStarted } from '@/lib/server/runtime/daemon-state'
import { notify } from '@/lib/server/ws-hub'
import { errorMessage } from '@/lib/shared-utils'
import type {
  Connector,
  ConnectorAccessMutationAction,
  ConnectorAccessMutationResponse,
  ConnectorHealthEvent,
} from '@/types'

function cloneConnector<T extends Connector>(connector: T): T {
  return {
    ...connector,
    config: connector.config ? { ...connector.config } : {},
  }
}

function persistConnector(connector: Connector): void {
  connector.updatedAt = Date.now()
  upsertConnector(connector.id, connector)
}

function setConnectorSenderList(connector: Connector, key: string, values: string[]): void {
  if (!connector.config) connector.config = {}
  if (values.length === 0) {
    delete connector.config[key]
    return
  }
  connector.config[key] = values.join(',')
}

function addConnectorSenderListEntry(connector: Connector, key: string, senderId: string): boolean {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return false
  const current = parseAllowFromCsv(connector.config?.[key])
  if (senderMatchesAnyEntry(normalized, current)) return false
  setConnectorSenderList(connector, key, [...current, normalized])
  return true
}

function removeConnectorSenderListEntry(connector: Connector, key: string, senderId: string): boolean {
  const normalized = normalizeSenderId(senderId)
  if (!normalized) return false
  const current = parseAllowFromCsv(connector.config?.[key])
  const next = current.filter((entry) => !senderMatchesAnyEntry(normalized, [entry]))
  if (next.length === current.length) return false
  setConnectorSenderList(connector, key, next)
  return true
}

function requireSenderId(body: Record<string, unknown>): string {
  const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : ''
  if (!senderId) throw new Error('senderId is required for this action')
  return senderId
}

export async function listConnectorsWithRuntime(): Promise<Record<string, Connector>> {
  ensureDaemonStarted('api/connectors:get')
  const connectors = Object.fromEntries(
    Object.entries(loadConnectors()).map(([id, connector]) => [id, cloneConnector(connector)]),
  ) as Record<string, Connector>
  try {
    const {
      getConnectorStatus,
      isConnectorAuthenticated,
      hasConnectorCredentials,
      getConnectorQR,
      getReconnectState,
      getConnectorPresence,
    } = await import('@/lib/server/connectors/manager')
    for (const connector of Object.values(connectors)) {
      const runtimeStatus = getConnectorStatus(connector.id)
      connector.status = runtimeStatus === 'running'
        ? 'running'
        : connector.lastError
          ? 'error'
          : 'stopped'
      if (connector.platform === 'whatsapp') {
        connector.authenticated = isConnectorAuthenticated(connector.id)
        connector.hasCredentials = hasConnectorCredentials(connector.id)
        const qr = getConnectorQR(connector.id)
        if (qr) connector.qrDataUrl = qr
      }
      const reconnectState = getReconnectState(connector.id)
      if (reconnectState) {
        const ext = connector as unknown as Record<string, unknown>
        ext.reconnectAttempts = reconnectState.attempts
        ext.nextRetryAt = reconnectState.nextRetryAt
        ext.reconnectError = reconnectState.error
        ext.reconnectExhausted = reconnectState.exhausted
      }
      if (connector.status === 'running') {
        connector.presence = getConnectorPresence(connector.id)
      }
    }
  } catch (err: unknown) {
    console.warn('[connectors] Failed to load connector manager for runtime status:', errorMessage(err))
  }
  return connectors
}

export async function getConnectorWithRuntime(id: string): Promise<Connector | null> {
  ensureDaemonStarted('api/connectors/[id]:get')
  const connector = loadConnector(id)
  if (!connector) return null
  const current = cloneConnector(connector)
  try {
    const {
      getConnectorStatus,
      getConnectorQR,
      isConnectorAuthenticated,
      hasConnectorCredentials,
      getConnectorPresence,
      getReconnectState,
    } = await import('@/lib/server/connectors/manager')
    const runtimeStatus = getConnectorStatus(id)
    current.status = runtimeStatus === 'running'
      ? 'running'
      : current.lastError
        ? 'error'
        : 'stopped'
    const reconnectState = getReconnectState(id)
    if (reconnectState) {
      const ext = current as unknown as Record<string, unknown>
      ext.reconnectAttempts = reconnectState.attempts
      ext.nextRetryAt = reconnectState.nextRetryAt
      ext.reconnectError = reconnectState.error
      ext.reconnectExhausted = reconnectState.exhausted
    }
    const qr = getConnectorQR(id)
    if (qr) current.qrDataUrl = qr
    current.authenticated = isConnectorAuthenticated(id)
    current.hasCredentials = hasConnectorCredentials(id)
    if (current.status === 'running') current.presence = getConnectorPresence(id)
  } catch (err: unknown) {
    console.warn(`[connectors] Failed to load connector manager for ${id}:`, errorMessage(err))
  }
  return current
}

export function createConnector(body: Record<string, unknown>): Connector {
  const id = genId()
  const connector: Connector = {
    id,
    name: (body.name as string) || `${String(body.platform || '')} Connector`,
    platform: body.platform as Connector['platform'],
    agentId: (body.agentId as string | null | undefined) || null,
    chatroomId: (body.chatroomId as string | null | undefined) || null,
    credentialId: (body.credentialId as string | null | undefined) || null,
    config: body.config && typeof body.config === 'object' && !Array.isArray(body.config)
      ? body.config as Record<string, string>
      : {},
    isEnabled: false,
    status: 'stopped',
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  upsertConnector(id, connector)
  notify('connectors')
  return connector
}

export async function autoStartConnectorIfNeeded(connector: Connector, body: Record<string, unknown>): Promise<void> {
  const hasCredentials = connector.platform === 'whatsapp'
    || connector.platform === 'openclaw'
    || (connector.platform === 'bluebubbles' && (!!connector.credentialId || !!connector.config.password))
    || !!connector.credentialId
  if (!hasCredentials || body.autoStart === false) return
  try {
    const { startConnector } = await import('@/lib/server/connectors/manager')
    await startConnector(connector.id)
  } catch (err: unknown) {
    console.warn(`[connectors] Auto-start failed for connector ${connector.id}:`, errorMessage(err))
  }
}

export async function updateConnectorFromRoute(id: string, body: Record<string, unknown>) {
  ensureDaemonStarted('api/connectors/[id]:put')
  const connector = loadConnector(id)
  if (!connector) return { ok: false as const, status: 404 as const }

  if (body.action === 'start' || body.action === 'stop' || body.action === 'repair') {
    try {
      const manager = await import('@/lib/server/connectors/manager')
      if (body.action === 'start') {
        manager.clearReconnectState(id)
        await manager.startConnector(id)
        logActivity({ entityType: 'connector', entityId: id, action: 'started', actor: 'user', summary: `Connector started: "${connector.name}"` })
      } else if (body.action === 'stop') {
        await manager.stopConnector(id)
        logActivity({ entityType: 'connector', entityId: id, action: 'stopped', actor: 'user', summary: `Connector stopped: "${connector.name}"` })
      } else {
        manager.clearReconnectState(id)
        await manager.repairConnector(id)
        logActivity({ entityType: 'connector', entityId: id, action: 'started', actor: 'user', summary: `Connector repaired: "${connector.name}"` })
      }
    } catch (err: unknown) {
      console.error(`[connectors] Action failed for connector ${id}:`, errorMessage(err))
      const fresh = loadConnector(id)
      return {
        ok: false as const,
        status: 500 as const,
        payload: fresh || { error: 'Connector action failed' },
      }
    }
    notify('connectors')
    return { ok: true as const, payload: loadConnector(id) }
  }

  const next = cloneConnector(connector)
  if (body.name !== undefined) next.name = typeof body.name === 'string' ? body.name : next.name
  if (body.agentId !== undefined) next.agentId = typeof body.agentId === 'string' || body.agentId === null ? body.agentId : next.agentId
  if (body.chatroomId !== undefined) next.chatroomId = typeof body.chatroomId === 'string' || body.chatroomId === null ? body.chatroomId : next.chatroomId
  if (body.credentialId !== undefined) next.credentialId = typeof body.credentialId === 'string' || body.credentialId === null ? body.credentialId : next.credentialId
  if (body.config !== undefined) next.config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config as Record<string, string> : next.config
  if (body.isEnabled !== undefined) next.isEnabled = typeof body.isEnabled === 'boolean' ? body.isEnabled : next.isEnabled
  persistConnector(next)

  try {
    const manager = await import('@/lib/server/connectors/manager')
    const wasRunning = manager.getConnectorStatus(id) === 'running'
    const shouldStop = body.isEnabled === false
    const shouldReload = wasRunning && (
      body.name !== undefined
      || body.agentId !== undefined
      || body.chatroomId !== undefined
      || body.credentialId !== undefined
      || body.config !== undefined
      || body.isEnabled !== undefined
    )
    const shouldStart = body.isEnabled === true && !wasRunning
    if (shouldStop) {
      await manager.stopConnector(id)
    } else if (shouldReload || shouldStart) {
      manager.clearReconnectState(id)
      await manager.startConnector(id)
    }
  } catch (err: unknown) {
    console.warn(`[connectors] Failed to reload connector ${id} after update:`, errorMessage(err))
  }

  notify('connectors')
  return { ok: true as const, payload: loadConnector(id) || next }
}

export async function deleteConnectorFromRoute(id: string) {
  const connector = loadConnector(id)
  if (!connector) return { ok: false as const }
  try {
    const { stopConnector } = await import('@/lib/server/connectors/manager')
    await stopConnector(id)
  } catch (err: unknown) {
    console.warn(`[connectors] Failed to stop connector ${id} during delete:`, errorMessage(err))
  }
  try {
    const { clearConnectorPairingState } = await import('@/lib/server/connectors/pairing')
    clearConnectorPairingState(id)
  } catch (err: unknown) {
    console.warn(`[connectors] Failed to clear pairing state for ${id}:`, errorMessage(err))
  }
  deleteConnector(id)
  notify('connectors')
  return { ok: true as const, payload: { ok: true } }
}

export function getConnectorHealthForApi(id: string): { events: ConnectorHealthEvent[]; uptimePercent: number } | null {
  const connector = loadConnector(id)
  if (!connector) return null
  const allHealth = loadConnectorHealth()
  const events: ConnectorHealthEvent[] = []
  for (const raw of Object.values(allHealth)) {
    const entry = raw as ConnectorHealthEvent
    if (entry.connectorId !== id) continue
    events.push(entry)
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return { events, uptimePercent: computeUptime(events) }
}

function computeUptime(events: ConnectorHealthEvent[]): number {
  if (events.length === 0) return 0
  const firstTime = new Date(events[0].timestamp).getTime()
  const now = Date.now()
  const totalMs = now - firstTime
  if (totalMs <= 0) return 100
  let uptimeMs = 0
  let lastUpAt: number | null = null
  for (const event of events) {
    const time = new Date(event.timestamp).getTime()
    if (event.event === 'started' || event.event === 'reconnected') {
      if (lastUpAt === null) lastUpAt = time
    } else if (event.event === 'stopped' || event.event === 'error' || event.event === 'disconnected') {
      if (lastUpAt !== null) {
        uptimeMs += time - lastUpAt
        lastUpAt = null
      }
    }
  }
  if (lastUpAt !== null) uptimeMs += now - lastUpAt
  return Math.round((uptimeMs / totalMs) * 10000) / 100
}

export async function updateConnectorAccess(
  connectorId: string,
  body: Record<string, unknown>,
): Promise<{ ok: false; status: 404 | 400; payload?: Record<string, unknown> } | { ok: true; payload: ConnectorAccessMutationResponse }> {
  ensureDaemonStarted('api/connectors/[id]/access:put')
  const connector = loadConnector(connectorId)
  if (!connector) return { ok: false, status: 404 }
  const current = cloneConnector(connector)

  try {
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() as ConnectorAccessMutationAction : null
    if (!action) {
      return { ok: false, status: 400, payload: { error: 'Missing access action' } }
    }
    let connectorChanged = false
    let responseSenderId = typeof body.senderId === 'string' ? body.senderId.trim() : ''
    const responseSenderIdAlt = typeof body.senderIdAlt === 'string' ? body.senderIdAlt.trim() : ''
    let summary = `Updated access controls for "${current.name}".`

    switch (action) {
      case 'set_policy': {
        const rawPolicy = typeof body.dmPolicy === 'string' ? body.dmPolicy.trim() : ''
        if (!rawPolicy) delete current.config.dmPolicy
        else current.config.dmPolicy = parsePairingPolicy(rawPolicy, 'open')
        connectorChanged = true
        summary = `Updated DM policy for "${current.name}".`
        break
      }
      case 'set_dm_addressing_mode': {
        const rawMode = typeof body.dmAddressingMode === 'string' ? body.dmAddressingMode.trim() : ''
        const nextMode = parseDmAddressingMode(rawMode || 'open', 'open')
        if (nextMode === 'open') delete current.config.dmAddressingMode
        else current.config.dmAddressingMode = nextMode
        connectorChanged = true
        summary = `Updated DM addressing mode for "${current.name}" to ${nextMode}.`
        break
      }
      case 'allow_sender': {
        const senderId = requireSenderId(body)
        addAllowedSender(current.id, senderId)
        connectorChanged = removeConnectorSenderListEntry(current, 'denyFrom', senderId) || connectorChanged
        summary = `Allowed sender ${normalizeSenderId(senderId)} on "${current.name}".`
        break
      }
      case 'remove_allowed_sender': {
        const senderId = requireSenderId(body)
        removeAllowedSender(current.id, senderId)
        connectorChanged = removeConnectorSenderListEntry(current, 'allowFrom', senderId) || connectorChanged
        summary = `Removed connector-managed access for ${normalizeSenderId(senderId)} on "${current.name}".`
        break
      }
      case 'block_sender': {
        const senderId = requireSenderId(body)
        connectorChanged = addConnectorSenderListEntry(current, 'denyFrom', senderId) || connectorChanged
        connectorChanged = removeConnectorSenderListEntry(current, 'allowFrom', senderId) || connectorChanged
        removeAllowedSender(current.id, senderId)
        rejectPendingSender(current.id, senderId)
        const ownerSenderId = resolveConnectorOwnerSenderId(current)
        if (ownerSenderId && senderMatchesAnyEntry(senderId, [ownerSenderId])) {
          delete current.config.ownerSenderId
          connectorChanged = true
        }
        summary = `Blocked sender ${normalizeSenderId(senderId)} on "${current.name}".`
        break
      }
      case 'unblock_sender': {
        const senderId = requireSenderId(body)
        connectorChanged = removeConnectorSenderListEntry(current, 'denyFrom', senderId) || connectorChanged
        summary = `Removed sender ${normalizeSenderId(senderId)} from the deny list on "${current.name}".`
        break
      }
      case 'approve_pairing': {
        if (typeof body.code === 'string' && body.code.trim()) {
          const approved = approvePairingCode(current.id, body.code)
          if (!approved.ok) {
            return { ok: false, status: 400, payload: { error: approved.reason || 'Pairing approval failed.' } }
          }
          if (approved.senderId) {
            responseSenderId = approved.senderId
            connectorChanged = removeConnectorSenderListEntry(current, 'denyFrom', approved.senderId) || connectorChanged
          }
          summary = `Approved pairing on "${current.name}".`
        } else {
          const senderId = requireSenderId(body)
          const approved = approvePendingSender(current.id, senderId)
          if (!approved.ok) {
            return { ok: false, status: 400, payload: { error: approved.reason || 'Pairing approval failed.' } }
          }
          connectorChanged = removeConnectorSenderListEntry(current, 'denyFrom', senderId) || connectorChanged
          summary = `Approved pairing for ${normalizeSenderId(senderId)} on "${current.name}".`
        }
        break
      }
      case 'reject_pairing': {
        const senderId = requireSenderId(body)
        rejectPendingSender(current.id, senderId)
        summary = `Rejected pairing for ${normalizeSenderId(senderId)} on "${current.name}".`
        break
      }
      case 'set_owner': {
        const senderId = requireSenderId(body)
        const normalized = normalizeSenderId(senderId)
        if (!normalized) return { ok: false, status: 400, payload: { error: 'Could not normalize owner sender ID' } }
        current.config.ownerSenderId = normalized
        connectorChanged = true
        connectorChanged = removeConnectorSenderListEntry(current, 'denyFrom', normalized) || connectorChanged
        summary = `Set connector owner for "${current.name}" to ${normalized}.`
        break
      }
      case 'clear_owner': {
        if (current.config?.ownerSenderId) {
          delete current.config.ownerSenderId
          connectorChanged = true
        }
        summary = `Cleared connector owner override for "${current.name}".`
        break
      }
      case 'set_sender_dm_addressing': {
        const senderId = requireSenderId(body)
        const rawMode = typeof body.dmAddressingMode === 'string' ? body.dmAddressingMode.trim() : ''
        const nextMode = parseDmAddressingMode(rawMode || 'open', 'open')
        setSenderAddressingOverride(current.id, senderId, nextMode)
        summary = `Updated DM addressing override for ${normalizeSenderId(senderId)} on "${current.name}" to ${nextMode}.`
        break
      }
      case 'clear_sender_dm_addressing': {
        const senderId = requireSenderId(body)
        clearSenderAddressingOverride(current.id, senderId)
        summary = `Cleared DM addressing override for ${normalizeSenderId(senderId)} on "${current.name}".`
        break
      }
      default:
        return { ok: false, status: 400, payload: { error: `Unsupported access action: ${action}` } }
    }

    if (connectorChanged) persistConnector(current)
    logActivity({
      entityType: 'connector',
      entityId: current.id,
      action: 'access-updated',
      actor: 'user',
      summary,
      detail: { action },
    })
    notify('connectors')
    return {
      ok: true,
      payload: {
        ok: true,
        snapshot: buildConnectorAccessSnapshot({
          connector: current,
          senderId: responseSenderId || null,
          senderIdAlt: responseSenderIdAlt || null,
        }),
      },
    }
  } catch (err: unknown) {
    return { ok: false, status: 400, payload: { error: errorMessage(err) } }
  }
}
