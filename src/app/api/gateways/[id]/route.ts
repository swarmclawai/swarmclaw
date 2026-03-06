import { NextResponse } from 'next/server'
import { normalizeOpenClawEndpoint } from '@/lib/openclaw-endpoint'
import { loadAgents, loadGatewayProfiles, saveAgents, saveGatewayProfiles } from '@/lib/server/storage'
import { mutateItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import type { Agent, AgentRoutingTarget, GatewayProfile } from '@/types'

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
