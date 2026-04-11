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
  try {
    const endPerf = perf.start('api', 'GET /api/connectors')
    const connectors = await listConnectorsWithRuntime()
    endPerf({ count: Object.keys(connectors).length })
    return NextResponse.json(connectors)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    await ensureDaemonProcessRunning('api/connectors:post')
    const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
    if (error) return error
    const parsed = ConnectorCreateSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
    }
    const connector = createConnector(parsed.data as unknown as Record<string, unknown>)
    try {
      await autoStartConnectorIfNeeded(connector, parsed.data as unknown as Record<string, unknown>)
    } catch {
      // Auto-start failure is non-fatal — the connector is still saved.
    }
    return NextResponse.json(await getConnectorWithRuntime(connector.id) || connector)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
