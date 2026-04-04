import { NextResponse } from 'next/server'
import { z } from 'zod'

import { notFound } from '@/lib/server/collection-helpers'
import { buildConnectorDoctorPreview, buildConnectorDoctorReport, type ConnectorDoctorPreviewInput } from '@/lib/server/connectors/doctor'
import { loadConnectors } from '@/lib/server/connectors/connector-repository'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export const dynamic = 'force-dynamic'

const ConnectorDoctorPreviewSchema: z.ZodType<ConnectorDoctorPreviewInput> = z.object({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  platform: z.unknown().optional(),
  agentId: z.unknown().optional(),
  chatroomId: z.unknown().optional(),
  credentialId: z.unknown().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  sampleMsg: z.object({
    channelId: z.string().optional(),
    channelName: z.string().optional(),
    senderId: z.string().optional(),
    senderName: z.string().optional(),
    text: z.string().optional(),
    isGroup: z.boolean().optional(),
    messageId: z.string().optional(),
    replyToMessageId: z.string().optional(),
    threadId: z.string().optional(),
  }).passthrough().nullable().optional(),
}).passthrough()

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

  const { data: body, error } = await safeParseBody(req, ConnectorDoctorPreviewSchema)
  if (error) return error
  const connector = buildConnectorDoctorPreview({ baseConnector, input: body, fallbackId: id })
  return NextResponse.json(buildConnectorDoctorReport(connector, body.sampleMsg, { baseConnector }))
}
