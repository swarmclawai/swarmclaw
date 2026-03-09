import { NextResponse } from 'next/server'
import { loadConnectors, logActivity, upsertStoredItem, deleteStoredItem } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import { ensureDaemonStarted } from '@/lib/server/daemon-state'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureDaemonStarted('api/connectors/[id]:get')
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return notFound()

  // Merge runtime status, QR code, and presence
  try {
    const { getConnectorStatus, getConnectorQR, isConnectorAuthenticated, hasConnectorCredentials, getConnectorPresence, getReconnectState } = await import('@/lib/server/connectors/manager')
    const runtimeStatus = getConnectorStatus(id)
    connector.status = runtimeStatus === 'running'
      ? 'running'
      : connector.lastError
        ? 'error'
        : 'stopped'
    const rState = getReconnectState(id)
    if (rState) {
      const ext = connector as unknown as Record<string, unknown>
      ext.reconnectAttempts = rState.attempts
      ext.nextRetryAt = rState.nextRetryAt
      ext.reconnectError = rState.error
      ext.reconnectExhausted = rState.exhausted
    }
    const qr = getConnectorQR(id)
    if (qr) connector.qrDataUrl = qr
    connector.authenticated = isConnectorAuthenticated(id)
    connector.hasCredentials = hasConnectorCredentials(id)
    if (connector.status === 'running') {
      connector.presence = getConnectorPresence(id)
    }
  } catch { /* ignore */ }

  return NextResponse.json(connector)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureDaemonStarted('api/connectors/[id]:put')
  const { id } = await params
  const body = await req.json()
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return notFound()

  // Handle start/stop/repair actions — these modify connector state internally,
  // so re-read from storage after to avoid overwriting with stale data
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
      // Re-read to get the error state saved by startConnector
      const fresh = loadConnectors()
      return NextResponse.json(fresh[id] || { error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
    // Re-read the connector after manager modified it
    const fresh = loadConnectors()
    notify('connectors')
    return NextResponse.json(fresh[id])
  }

  // Regular update
  if (body.name !== undefined) connector.name = body.name
  if (body.agentId !== undefined) connector.agentId = body.agentId
  if (body.chatroomId !== undefined) connector.chatroomId = body.chatroomId
  if (body.credentialId !== undefined) connector.credentialId = body.credentialId
  if (body.config !== undefined) connector.config = body.config
  if (body.isEnabled !== undefined) (connector as any).isEnabled = body.isEnabled
  (connector as any).updatedAt = Date.now()

  upsertStoredItem('connectors', id, connector)

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
  } catch {
    // Keep the saved connector update even if the runtime reload fails.
  }

  notify('connectors')
  return NextResponse.json(loadConnectors()[id] || connector)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  if (!connectors[id]) return notFound()

  // Stop if running
  try {
    const { stopConnector } = await import('@/lib/server/connectors/manager')
    await stopConnector(id)
  } catch { /* ignore */ }

  // Clear persisted pairing state when connector is deleted.
  try {
    const { clearConnectorPairingState } = await import('@/lib/server/connectors/pairing')
    clearConnectorPairingState(id)
  } catch { /* ignore */ }

  deleteStoredItem('connectors', id)
  notify('connectors')
  return NextResponse.json({ ok: true })
}
