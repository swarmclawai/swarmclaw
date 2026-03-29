import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { perf } from '@/lib/server/runtime/perf'
import { ConnectorCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
import {
  autoStartConnectorIfNeeded,
  createConnector,
  getConnectorWithRuntime,
  listConnectorsWithRuntime,
} from '@/lib/server/connectors/connector-service'
import { ensureDaemonProcessRunning } from '@/lib/server/daemon/controller'
export const dynamic = 'force-dynamic'

export async function GET() {
  const endPerf = perf.start('api', 'GET /api/connectors')
  const connectors = await listConnectorsWithRuntime()
  endPerf({ count: Object.keys(connectors).length })
  return NextResponse.json(connectors)
}

export async function POST(req: Request) {
  await ensureDaemonProcessRunning('api/connectors:post')
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = ConnectorCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const connector = createConnector(parsed.data as unknown as Record<string, unknown>)
  await autoStartConnectorIfNeeded(connector, parsed.data as unknown as Record<string, unknown>)
  return NextResponse.json(await getConnectorWithRuntime(connector.id) || connector)
}
