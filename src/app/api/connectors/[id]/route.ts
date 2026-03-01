import { NextResponse } from 'next/server'
import { loadConnectors, saveConnectors } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Merge runtime status and QR code
  try {
    const { getConnectorStatus, getConnectorQR, isConnectorAuthenticated, hasConnectorCredentials } = await import('@/lib/server/connectors/manager')
    connector.status = getConnectorStatus(id)
    const qr = getConnectorQR(id)
    if (qr) connector.qrDataUrl = qr
    connector.authenticated = isConnectorAuthenticated(id)
    connector.hasCredentials = hasConnectorCredentials(id)
  } catch { /* ignore */ }

  return NextResponse.json(connector)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Handle start/stop/repair actions — these modify connector state internally,
  // so re-read from storage after to avoid overwriting with stale data
  if (body.action === 'start' || body.action === 'stop' || body.action === 'repair') {
    try {
      const manager = await import('@/lib/server/connectors/manager')
      if (body.action === 'start') {
        await manager.startConnector(id)
      } else if (body.action === 'stop') {
        await manager.stopConnector(id)
      } else {
        await manager.repairConnector(id)
      }
    } catch (err: any) {
      // Re-read to get the error state saved by startConnector
      const fresh = loadConnectors()
      return NextResponse.json(fresh[id] || { error: err.message }, { status: 500 })
    }
    // Re-read the connector after manager modified it
    const fresh = loadConnectors()
    notify('connectors')
    return NextResponse.json(fresh[id])
  }

  // Regular update
  if (body.name !== undefined) connector.name = body.name
  if (body.agentId !== undefined) connector.agentId = body.agentId
  if (body.credentialId !== undefined) connector.credentialId = body.credentialId
  if (body.config !== undefined) connector.config = body.config
  if (body.isEnabled !== undefined) connector.isEnabled = body.isEnabled
  connector.updatedAt = Date.now()

  connectors[id] = connector
  saveConnectors(connectors)
  notify('connectors')
  return NextResponse.json(connector)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  if (!connectors[id]) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Stop if running
  try {
    const { stopConnector } = await import('@/lib/server/connectors/manager')
    await stopConnector(id)
  } catch { /* ignore */ }

  delete connectors[id]
  saveConnectors(connectors)
  notify('connectors')
  return NextResponse.json({ ok: true })
}
