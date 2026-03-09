import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadConnectors, upsertStoredItem } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { ensureDaemonStarted } from '@/lib/server/daemon-state'
import { ConnectorCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
import type { Connector } from '@/types'
export const dynamic = 'force-dynamic'


export async function GET() {
  ensureDaemonStarted('api/connectors:get')
  const connectors = loadConnectors()
  // Merge runtime status from manager
  try {
    const { getConnectorStatus, isConnectorAuthenticated, hasConnectorCredentials, getConnectorQR, getReconnectState } = await import('@/lib/server/connectors/manager')
    for (const c of Object.values(connectors) as Connector[]) {
      const runtimeStatus = getConnectorStatus(c.id)
      c.status = runtimeStatus === 'running'
        ? 'running'
        : c.lastError
          ? 'error'
          : 'stopped'
      if (c.platform === 'whatsapp') {
        c.authenticated = isConnectorAuthenticated(c.id)
        c.hasCredentials = hasConnectorCredentials(c.id)
        const qr = getConnectorQR(c.id)
        if (qr) c.qrDataUrl = qr
      }
      // Surface reconnect state if connector is in a recovery cycle
      const rState = getReconnectState(c.id)
      if (rState) {
        const ext = c as unknown as Record<string, unknown>
        ext.reconnectAttempts = rState.attempts
        ext.nextRetryAt = rState.nextRetryAt
        ext.reconnectError = rState.error
        ext.reconnectExhausted = rState.exhausted
      }
    }
  } catch { /* manager not loaded yet */ }
  return NextResponse.json(connectors)
}

export async function POST(req: Request) {
  ensureDaemonStarted('api/connectors:post')
  const raw = await req.json()
  const parsed = ConnectorCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = parsed.data
  const id = genId()

  const connector: Connector = {
    id,
    name: body.name || `${body.platform} Connector`,
    platform: body.platform,
    agentId: body.agentId || null,
    chatroomId: body.chatroomId || null,
    credentialId: body.credentialId || null,
    config: body.config || {},
    isEnabled: false,
    status: 'stopped',
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  upsertStoredItem('connectors', id, connector)
  notify('connectors')

  // Auto-start if connector has credentials (or is WhatsApp which uses QR)
  const hasCredentials = connector.platform === 'whatsapp'
    || connector.platform === 'openclaw'
    || (connector.platform === 'bluebubbles' && (!!connector.credentialId || !!connector.config.password))
    || !!connector.credentialId
  if (hasCredentials && body.autoStart !== false) {
    try {
      const { startConnector } = await import('@/lib/server/connectors/manager')
      await startConnector(id)
    } catch { /* auto-start is best-effort */ }
  }

  return NextResponse.json(loadConnectors()[id] || connector)
}
