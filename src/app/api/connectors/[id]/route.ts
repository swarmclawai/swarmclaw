import { NextResponse } from 'next/server'
import { loadConnectors, saveConnectors } from '@/lib/server/storage'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Merge runtime status and QR code
  try {
    const { getConnectorStatus, getConnectorQR } = await import('@/lib/server/connectors/manager')
    connector.status = getConnectorStatus(id)
    const qr = getConnectorQR(id)
    if (qr) connector.qrDataUrl = qr
  } catch { /* ignore */ }

  return NextResponse.json(connector)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Handle start/stop actions
  if (body.action === 'start') {
    try {
      const { startConnector } = await import('@/lib/server/connectors/manager')
      await startConnector(id)
      connector.isEnabled = true
      connector.status = 'running'
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
  } else if (body.action === 'stop') {
    try {
      const { stopConnector } = await import('@/lib/server/connectors/manager')
      await stopConnector(id)
      connector.isEnabled = false
      connector.status = 'stopped'
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
  } else {
    // Regular update
    if (body.name !== undefined) connector.name = body.name
    if (body.agentId !== undefined) connector.agentId = body.agentId
    if (body.credentialId !== undefined) connector.credentialId = body.credentialId
    if (body.config !== undefined) connector.config = body.config
    if (body.isEnabled !== undefined) connector.isEnabled = body.isEnabled
    connector.updatedAt = Date.now()
  }

  connectors[id] = connector
  saveConnectors(connectors)
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
  return NextResponse.json({ ok: true })
}
