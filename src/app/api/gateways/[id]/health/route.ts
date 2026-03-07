import { NextResponse } from 'next/server'
import { probeOpenClawHealth } from '@/lib/server/openclaw-health'
import { loadGatewayProfiles, saveGatewayProfiles } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { notify } from '@/lib/server/ws-hub'
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

  gateway.status = result.ok ? 'healthy' : (result.authProvided ? 'degraded' : 'offline')
  gateway.lastCheckedAt = Date.now()
  gateway.lastError = result.ok ? null : (result.error || result.hint || 'Gateway health check failed.')
  gateway.lastModelCount = Array.isArray(result.models) ? result.models.length : 0
  gateway.deployment = {
    ...(gateway.deployment || {}),
    lastVerifiedAt: Date.now(),
    lastVerifiedOk: result.ok,
    lastVerifiedMessage: result.ok
      ? `Verified ${Array.isArray(result.models) ? result.models.length : 0} model${result.models?.length === 1 ? '' : 's'}`
      : (result.error || result.hint || 'Gateway health check failed.'),
  }
  gateway.updatedAt = Date.now()
  saveGatewayProfiles(gateways)
  notify('gateways')

  return NextResponse.json(result)
}
