import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { notFound } from '@/lib/server/collection-helpers'
import {
  buildConnectorAccessSnapshot,
} from '@/lib/server/connectors/access'
import { loadConnectors } from '@/lib/server/connectors/connector-repository'
import { ensureDaemonStarted } from '@/lib/server/runtime/daemon-state'
import { updateConnectorAccess } from '@/lib/server/connectors/connector-service'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureDaemonStarted('api/connectors/[id]/access:get')
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return notFound()

  const url = new URL(req.url)
  const senderId = url.searchParams.get('senderId')
  const senderIdAlt = url.searchParams.get('senderIdAlt')
  return NextResponse.json(buildConnectorAccessSnapshot({
    connector,
    senderId,
    senderIdAlt,
  }))
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connector = loadConnectors()[id]
  if (!connector) return notFound()
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const result = await updateConnectorAccess(id, body)
  if (!result.ok && result.status === 404) return notFound()
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}
