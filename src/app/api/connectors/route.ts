import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadConnectors, saveConnectors } from '@/lib/server/storage'
import type { Connector } from '@/types'

export async function GET() {
  const connectors = loadConnectors()
  // Merge runtime status from manager
  try {
    const { getConnectorStatus, isConnectorAuthenticated, hasConnectorCredentials, getConnectorQR } = await import('@/lib/server/connectors/manager')
    for (const c of Object.values(connectors) as Connector[]) {
      c.status = getConnectorStatus(c.id)
      if (c.platform === 'whatsapp') {
        c.authenticated = isConnectorAuthenticated(c.id)
        c.hasCredentials = hasConnectorCredentials(c.id)
        const qr = getConnectorQR(c.id)
        if (qr) c.qrDataUrl = qr
      }
    }
  } catch { /* manager not loaded yet */ }
  return NextResponse.json(connectors)
}

export async function POST(req: Request) {
  const body = await req.json()
  const connectors = loadConnectors()
  const id = crypto.randomBytes(4).toString('hex')

  const connector: Connector = {
    id,
    name: body.name || `${body.platform} Connector`,
    platform: body.platform,
    agentId: body.agentId,
    credentialId: body.credentialId || null,
    config: body.config || {},
    isEnabled: false,
    status: 'stopped',
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  connectors[id] = connector
  saveConnectors(connectors)

  // Auto-start if connector has credentials (or is WhatsApp which uses QR)
  const hasCredentials = connector.platform === 'whatsapp' || connector.platform === 'openclaw' || !!connector.credentialId
  if (hasCredentials && body.autoStart !== false) {
    try {
      const { startConnector } = await import('@/lib/server/connectors/manager')
      await startConnector(id)
      connector.isEnabled = true
      connector.status = 'running'
      connectors[id] = connector
      saveConnectors(connectors)
    } catch { /* auto-start is best-effort */ }
  }

  return NextResponse.json(connector)
}
