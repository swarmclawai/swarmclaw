import { NextResponse } from 'next/server'
import { probeOpenClawHealth } from '@/lib/server/openclaw/health'
import { loadGatewayProfiles, saveGatewayProfiles } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { notify } from '@/lib/server/ws-hub'
import type { GatewayProfile } from '@/types'
import type { OpenClawHealthResult } from '@/lib/server/openclaw/health'
export const dynamic = 'force-dynamic'

export function persistGatewayHealthResult(
  id: string,
  result: OpenClawHealthResult,
  now = Date.now(),
): GatewayProfile | null {
  const gateways = loadGatewayProfiles()
  const gateway = gateways[id]
  if (!gateway) return null

  gateway.status = result.ok ? 'healthy' : (result.authProvided ? 'degraded' : 'offline')
  gateway.lastCheckedAt = now
  gateway.lastError = result.ok ? null : (result.error || result.hint || 'Gateway health check failed.')
  gateway.lastModelCount = Array.isArray(result.models) ? result.models.length : 0
  gateway.deployment = {
    ...(gateway.deployment || {}),
    lastVerifiedAt: now,
    lastVerifiedOk: result.ok,
    lastVerifiedMessage: result.ok
      ? result.message
      : (result.error || result.hint || 'Gateway health check failed.'),
  }
  gateway.updatedAt = now
  saveGatewayProfiles(gateways)
  notify('gateways')
  return gateway
}

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
