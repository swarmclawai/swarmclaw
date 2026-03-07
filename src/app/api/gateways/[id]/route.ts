import { NextResponse } from 'next/server'
import { normalizeOpenClawEndpoint } from '@/lib/openclaw-endpoint'
import { loadAgents, loadGatewayProfiles, saveAgents, saveGatewayProfiles } from '@/lib/server/storage'
import { mutateItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import type { Agent, AgentRoutingTarget, GatewayProfile, OpenClawDeploymentConfig, OpenClawGatewayStats } from '@/types'

const ops: CollectionOps<GatewayProfile> = {
  load: loadGatewayProfiles,
  save: saveGatewayProfiles,
  topic: 'gateways',
}

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

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const result = mutateItem(ops, id, (gateway, all) => {
    if (body.isDefault === true) {
      for (const [candidateId, candidate] of Object.entries(all)) {
        if (candidateId === id || !candidate || typeof candidate !== 'object') continue
        candidate.isDefault = false
      }
    }
    if (body.name !== undefined) gateway.name = String(body.name || '').trim() || gateway.name
    if (body.endpoint !== undefined) gateway.endpoint = normalizeOpenClawEndpoint(body.endpoint || undefined)
    if (body.wsUrl !== undefined) gateway.wsUrl = body.wsUrl || null
    if (body.credentialId !== undefined) gateway.credentialId = body.credentialId || null
    if (body.status !== undefined) gateway.status = body.status || 'unknown'
    if (body.notes !== undefined) gateway.notes = body.notes || null
    if (body.tags !== undefined) gateway.tags = normalizeTags(body.tags)
    if (body.lastError !== undefined) gateway.lastError = body.lastError || null
    if (body.lastCheckedAt !== undefined) gateway.lastCheckedAt = body.lastCheckedAt || null
    if (body.lastModelCount !== undefined) gateway.lastModelCount = body.lastModelCount || null
    if (body.discoveredHost !== undefined) gateway.discoveredHost = body.discoveredHost || null
    if (body.discoveredPort !== undefined) gateway.discoveredPort = body.discoveredPort || null
    if (body.deployment !== undefined) gateway.deployment = { ...(gateway.deployment || {}), ...(normalizeDeployment(body.deployment) || {}) }
    if (body.stats !== undefined) gateway.stats = { ...(gateway.stats || {}), ...(normalizeStats(body.stats) || {}) }
    if (body.isDefault !== undefined) gateway.isDefault = body.isDefault === true
    gateway.updatedAt = Date.now()
    return gateway
  })
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const gateways = loadGatewayProfiles()
  if (!gateways[id]) return notFound()
  delete gateways[id]
  saveGatewayProfiles(gateways)

  const agents = loadAgents({ includeTrashed: true })
  let agentChanged = false
  for (const agent of Object.values(agents) as Agent[]) {
    if (agent.gatewayProfileId === id) {
      agent.gatewayProfileId = null
      agentChanged = true
    }
    if (Array.isArray(agent.routingTargets)) {
      const nextTargets = agent.routingTargets.map((target: AgentRoutingTarget) => (
        target.gatewayProfileId === id
          ? { ...target, gatewayProfileId: null }
          : target
      ))
      if (JSON.stringify(nextTargets) !== JSON.stringify(agent.routingTargets)) {
        agent.routingTargets = nextTargets
        agentChanged = true
      }
    }
  }
  if (agentChanged) saveAgents(agents)

  return NextResponse.json({ ok: true })
}
