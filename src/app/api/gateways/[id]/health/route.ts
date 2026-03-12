import { NextResponse } from 'next/server'
import { probeOpenClawHealth, persistGatewayHealthResult } from '@/lib/server/openclaw/health'
import { loadGatewayProfiles } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gateways = loadGatewayProfiles()
  const gateway = gateways[id]
  if (!gateway) return notFound()

  const result = await probeOpenClawHealth({
    endpoint: gateway.endpoint,
    credentialId: gateway.credentialId || null,
  })

  persistGatewayHealthResult(id, result)

  return NextResponse.json(result)
}
