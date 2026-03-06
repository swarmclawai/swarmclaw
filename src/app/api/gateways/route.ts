import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { normalizeOpenClawEndpoint } from '@/lib/openclaw-endpoint'
import { getGatewayProfiles } from '@/lib/server/agent-runtime-config'
import { loadGatewayProfiles, saveGatewayProfiles } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
}

export async function GET() {
  return NextResponse.json(getGatewayProfiles('openclaw'))
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const endpoint = normalizeOpenClawEndpoint(body.endpoint || undefined)
  const now = Date.now()
  const gateways = loadGatewayProfiles()
  const id = body.id || `gateway-${genId()}`
  const isDefault = body.isDefault === true

  if (isDefault) {
    for (const gateway of Object.values(gateways) as Array<Record<string, unknown>>) {
      gateway.isDefault = false
    }
  }

  gateways[id] = {
    id,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'OpenClaw Gateway',
    provider: 'openclaw',
    endpoint,
    wsUrl: body.wsUrl || null,
    credentialId: body.credentialId || null,
    status: body.status || 'unknown',
    notes: typeof body.notes === 'string' ? body.notes : null,
    tags: normalizeTags(body.tags),
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: typeof body.discoveredHost === 'string' ? body.discoveredHost : null,
    discoveredPort: typeof body.discoveredPort === 'number' ? body.discoveredPort : null,
    isDefault,
    createdAt: now,
    updatedAt: now,
  }

  saveGatewayProfiles(gateways)
  notify('gateways')
  return NextResponse.json(gateways[id])
}
