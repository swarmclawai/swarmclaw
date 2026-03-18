import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { perf } from '@/lib/server/runtime/perf'
import { ConnectorCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
import {
  autoStartConnectorIfNeeded,
  createConnector,
  listConnectorsWithRuntime,
} from '@/lib/server/connectors/connector-service'
import { loadConnector } from '@/lib/server/connectors/connector-repository'
export const dynamic = 'force-dynamic'

async function ensureDaemonIfNeeded(source: string) {
  const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
  ensureDaemonStarted(source)
}

export async function GET() {
  const endPerf = perf.start('api', 'GET /api/connectors')
  const connectors = await listConnectorsWithRuntime()
  endPerf({ count: Object.keys(connectors).length })
  return NextResponse.json(connectors)
}

export async function POST(req: Request) {
  await ensureDaemonIfNeeded('api/connectors:post')
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = ConnectorCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const connector = createConnector(parsed.data as unknown as Record<string, unknown>)
  await autoStartConnectorIfNeeded(connector, parsed.data as unknown as Record<string, unknown>)
  return NextResponse.json(loadConnector(connector.id) || connector)
}
