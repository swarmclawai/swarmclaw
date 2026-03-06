import type { Agent } from '@/types'
import { normalizeOpenClawAgentId } from '@/lib/openclaw-agent-id'
import { ensureGatewayConnected, type OpenClawGateway } from './openclaw-gateway'
import { loadAgents } from './storage'

export interface OpenClawGatewayAgentSummary {
  id: string
  name?: string
  identity?: {
    name?: string
  } | null
}

interface OpenClawGatewayAgentsList {
  defaultId?: string
  agents?: OpenClawGatewayAgentSummary[]
}

function addTextCandidate(target: Set<string>, value: string | undefined | null) {
  const trimmed = (value ?? '').trim()
  if (trimmed) {
    target.add(trimmed.toLowerCase())
  }
}

function addNormalizedCandidate(target: Set<string>, value: string | undefined | null) {
  const trimmed = (value ?? '').trim()
  if (trimmed) {
    target.add(normalizeOpenClawAgentId(trimmed))
  }
}

export function resolveOpenClawGatewayAgentIdFromList(params: {
  agentRef: string
  gatewayAgents: OpenClawGatewayAgentSummary[]
  localAgent?: Agent | null
}): string | null {
  const rawRef = params.agentRef.trim()
  if (!rawRef) {
    return null
  }

  const exactTextCandidates = new Set<string>()
  const normalizedCandidates = new Set<string>()

  addTextCandidate(exactTextCandidates, rawRef)
  addNormalizedCandidate(normalizedCandidates, rawRef)

  if (params.localAgent) {
    addTextCandidate(exactTextCandidates, params.localAgent.id)
    addTextCandidate(exactTextCandidates, params.localAgent.name)
    addNormalizedCandidate(normalizedCandidates, params.localAgent.id)
    addNormalizedCandidate(normalizedCandidates, params.localAgent.name)
  }

  for (const gatewayAgent of params.gatewayAgents) {
    if (exactTextCandidates.has(gatewayAgent.id.trim().toLowerCase())) {
      return gatewayAgent.id
    }
  }

  for (const gatewayAgent of params.gatewayAgents) {
    if (normalizedCandidates.has(normalizeOpenClawAgentId(gatewayAgent.id))) {
      return gatewayAgent.id
    }
  }

  for (const gatewayAgent of params.gatewayAgents) {
    const labels = [gatewayAgent.name, gatewayAgent.identity?.name]
    for (const label of labels) {
      if (!label?.trim()) continue
      if (exactTextCandidates.has(label.trim().toLowerCase())) {
        return gatewayAgent.id
      }
    }
  }

  for (const gatewayAgent of params.gatewayAgents) {
    const labels = [gatewayAgent.name, gatewayAgent.identity?.name]
    for (const label of labels) {
      if (!label?.trim()) continue
      if (normalizedCandidates.has(normalizeOpenClawAgentId(label))) {
        return gatewayAgent.id
      }
    }
  }

  if (params.localAgent && params.gatewayAgents.length === 1) {
    return params.gatewayAgents[0].id
  }

  return null
}

export async function resolveOpenClawGatewayAgentId(
  agentRef: string,
  gatewayArg?: OpenClawGateway | null,
): Promise<string> {
  const trimmedRef = agentRef.trim()
  if (!trimmedRef) {
    throw new Error('Missing agentId')
  }

  const localAgents = loadAgents({ includeTrashed: true }) as Record<string, Agent>
  const localAgent = localAgents[trimmedRef] || null
  if (localAgent && localAgent.provider !== 'openclaw') {
    throw new Error(`Agent "${localAgent.name}" is not an OpenClaw agent`)
  }

  const gateway = gatewayArg ?? await ensureGatewayConnected()
  if (!gateway) {
    throw new Error('OpenClaw gateway not connected')
  }

  const result = await gateway.rpc('agents.list', {}) as OpenClawGatewayAgentsList | undefined
  const gatewayAgents = Array.isArray(result?.agents) ? result.agents : []
  const resolved = resolveOpenClawGatewayAgentIdFromList({
    agentRef: trimmedRef,
    gatewayAgents,
    localAgent,
  })
  if (resolved) {
    return resolved
  }

  const label = localAgent?.name?.trim() || trimmedRef
  throw new Error(`OpenClaw gateway agent not found for "${label}"`)
}
