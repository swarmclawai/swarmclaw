import { NextResponse } from 'next/server'
import { buildConnectorDoctorPreview, buildConnectorDoctorReport, type ConnectorDoctorPreviewInput } from '@/lib/server/connectors/doctor'
import { loadConnectors } from '@/lib/server/storage'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as ConnectorDoctorPreviewInput
  const connectors = loadConnectors()
  const baseConnector = typeof body.id === 'string' ? connectors[body.id] : null
  const connector = buildConnectorDoctorPreview({ baseConnector, input: body })
  return NextResponse.json(buildConnectorDoctorReport(connector, body.sampleMsg, { baseConnector }))
}
