import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadConnectors, saveConnectors } from '@/lib/server/storage'
import type { Connector } from '@/types'

export async function GET() {
  const connectors = loadConnectors()
  // Merge runtime status from manager
  try {
    const { getConnectorStatus } = await import('@/lib/server/connectors/manager')
    for (const c of Object.values(connectors) as Connector[]) {
      c.status = getConnectorStatus(c.id)
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
  return NextResponse.json(connector)
}
