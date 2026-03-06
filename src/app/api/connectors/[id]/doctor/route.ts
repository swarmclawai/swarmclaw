import { NextResponse } from 'next/server'
import { loadConnectors } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { buildConnectorDoctorPreview, buildConnectorDoctorReport, type ConnectorDoctorPreviewInput } from '@/lib/server/connectors/doctor'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return notFound()

  return NextResponse.json(buildConnectorDoctorReport(connector, null, { baseConnector: connector }))
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  const baseConnector = connectors[id]
  if (!baseConnector) return notFound()

  const body = await req.json().catch(() => ({})) as ConnectorDoctorPreviewInput
  const connector = buildConnectorDoctorPreview({ baseConnector, input: body, fallbackId: id })
  return NextResponse.json(buildConnectorDoctorReport(connector, body.sampleMsg, { baseConnector }))
}
