import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { normalizeOpenClawEndpoint } from '@/lib/openclaw-endpoint'
import { getGatewayProfiles } from '@/lib/server/agent-runtime-config'
import { loadGatewayProfiles, saveGatewayProfiles } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { OpenClawDeploymentConfig, OpenClawGatewayStats } from '@/types'
export const dynamic = 'force-dynamic'

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeDeployment(value: unknown): OpenClawDeploymentConfig | null {
  if (!value || typeof value !== 'object') return null
  const deployment = value as Record<string, unknown>
  return {
    method: normalizeText(deployment.method) as OpenClawDeploymentConfig['method'],
    provider: normalizeText(deployment.provider) as OpenClawDeploymentConfig['provider'],
    remoteTarget: normalizeText(deployment.remoteTarget) as OpenClawDeploymentConfig['remoteTarget'],
    useCase: normalizeText(deployment.useCase) as OpenClawDeploymentConfig['useCase'],
    exposure: normalizeText(deployment.exposure) as OpenClawDeploymentConfig['exposure'],
    managedBy: normalizeText(deployment.managedBy) as OpenClawDeploymentConfig['managedBy'],
    targetHost: normalizeText(deployment.targetHost),
    sshHost: normalizeText(deployment.sshHost),
    sshUser: normalizeText(deployment.sshUser),
    sshPort: normalizeNullableNumber(deployment.sshPort),
    sshKeyPath: normalizeText(deployment.sshKeyPath),
    sshTargetDir: normalizeText(deployment.sshTargetDir),
    image: normalizeText(deployment.image),
    version: normalizeText(deployment.version),
    lastDeployAt: normalizeNullableNumber(deployment.lastDeployAt),
    lastDeployAction: normalizeText(deployment.lastDeployAction),
    lastDeployProcessId: normalizeText(deployment.lastDeployProcessId),
    lastDeploySummary: normalizeText(deployment.lastDeploySummary),
    lastVerifiedAt: normalizeNullableNumber(deployment.lastVerifiedAt),
    lastVerifiedOk: typeof deployment.lastVerifiedOk === 'boolean' ? deployment.lastVerifiedOk : null,
    lastVerifiedMessage: normalizeText(deployment.lastVerifiedMessage),
    lastBackupPath: normalizeText(deployment.lastBackupPath),
  }
}

function normalizeStats(value: unknown): OpenClawGatewayStats | null {
  if (!value || typeof value !== 'object') return null
  const stats = value as Record<string, unknown>
  return {
    nodeCount: normalizeNullableNumber(stats.nodeCount) ?? undefined,
    connectedNodeCount: normalizeNullableNumber(stats.connectedNodeCount) ?? undefined,
    pendingNodePairings: normalizeNullableNumber(stats.pendingNodePairings) ?? undefined,
    pairedDeviceCount: normalizeNullableNumber(stats.pairedDeviceCount) ?? undefined,
    pendingDevicePairings: normalizeNullableNumber(stats.pendingDevicePairings) ?? undefined,
    externalRuntimeCount: normalizeNullableNumber(stats.externalRuntimeCount) ?? undefined,
  }
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
    deployment: normalizeDeployment(body.deployment),
    stats: normalizeStats(body.stats),
    isDefault,
    createdAt: now,
    updatedAt: now,
  }

  saveGatewayProfiles(gateways)
  notify('gateways')
  return NextResponse.json(gateways[id])
}
