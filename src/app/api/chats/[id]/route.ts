import { NextResponse } from 'next/server'
import { loadSessions, saveSessions, deleteSession, active, loadAgents } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { resolvePrimaryAgentRoute } from '@/lib/server/agent-runtime-config'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const updates = await req.json()
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()

  const agentIdUpdateProvided = updates.agentId !== undefined
  let nextAgentId = sessions[id].agentId
  if (agentIdUpdateProvided) {
    sessions[id].agentId = updates.agentId
    nextAgentId = updates.agentId
  }

  const linkedAgent = nextAgentId ? loadAgents()[nextAgentId] : null
  const routePreferredGatewayTags = updates.routePreferredGatewayTags !== undefined
    ? (Array.isArray(updates.routePreferredGatewayTags)
      ? updates.routePreferredGatewayTags.filter((tag: unknown): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : [])
    : (sessions[id].routePreferredGatewayTags || [])
  const routePreferredGatewayUseCase = updates.routePreferredGatewayUseCase !== undefined
    ? (typeof updates.routePreferredGatewayUseCase === 'string' && updates.routePreferredGatewayUseCase.trim()
      ? updates.routePreferredGatewayUseCase.trim()
      : null)
    : (sessions[id].routePreferredGatewayUseCase || null)
  const linkedRoute = linkedAgent ? resolvePrimaryAgentRoute(linkedAgent, undefined, {
    preferredGatewayTags: routePreferredGatewayTags,
    preferredGatewayUseCase: routePreferredGatewayUseCase,
  }) : null

  if (updates.name !== undefined) sessions[id].name = updates.name
  if (updates.cwd !== undefined) sessions[id].cwd = updates.cwd
  if (updates.provider !== undefined) sessions[id].provider = updates.provider
  else if (agentIdUpdateProvided && linkedAgent?.provider) sessions[id].provider = linkedAgent.provider

  if (updates.model !== undefined) sessions[id].model = updates.model
  else if (agentIdUpdateProvided && linkedRoute?.model) sessions[id].model = linkedRoute.model
  else if (agentIdUpdateProvided && linkedAgent?.model !== undefined) sessions[id].model = linkedAgent.model

  if (updates.credentialId !== undefined) sessions[id].credentialId = updates.credentialId
  else if (agentIdUpdateProvided && linkedRoute) sessions[id].credentialId = linkedRoute.credentialId ?? null
  else if (agentIdUpdateProvided && linkedAgent) sessions[id].credentialId = linkedAgent.credentialId ?? null

  if (updates.fallbackCredentialIds !== undefined) sessions[id].fallbackCredentialIds = updates.fallbackCredentialIds
  else if (agentIdUpdateProvided && linkedRoute) sessions[id].fallbackCredentialIds = [...linkedRoute.fallbackCredentialIds]

  if (updates.gatewayProfileId !== undefined) sessions[id].gatewayProfileId = updates.gatewayProfileId
  else if (agentIdUpdateProvided && linkedRoute) sessions[id].gatewayProfileId = linkedRoute.gatewayProfileId ?? null

  if (updates.routePreferredGatewayTags !== undefined) {
    sessions[id].routePreferredGatewayTags = routePreferredGatewayTags
  }
  if (updates.routePreferredGatewayUseCase !== undefined) {
    sessions[id].routePreferredGatewayUseCase = routePreferredGatewayUseCase
  }

  if (updates.plugins !== undefined) sessions[id].plugins = updates.plugins
  else if (agentIdUpdateProvided && linkedAgent) sessions[id].plugins = Array.isArray(linkedAgent.plugins) ? linkedAgent.plugins : []

  if (updates.apiEndpoint !== undefined) {
    sessions[id].apiEndpoint = normalizeProviderEndpoint(
      updates.provider || sessions[id].provider,
      updates.apiEndpoint,
    )
  } else if (agentIdUpdateProvided && linkedRoute) {
    sessions[id].apiEndpoint = linkedRoute.apiEndpoint ?? null
  } else if (agentIdUpdateProvided && linkedAgent) {
    sessions[id].apiEndpoint = normalizeProviderEndpoint(
      linkedAgent.provider,
      linkedAgent.apiEndpoint ?? null,
    )
  }
  if (updates.heartbeatEnabled !== undefined) sessions[id].heartbeatEnabled = updates.heartbeatEnabled
  if (updates.heartbeatIntervalSec !== undefined) sessions[id].heartbeatIntervalSec = updates.heartbeatIntervalSec
  if (updates.sessionResetMode !== undefined) sessions[id].sessionResetMode = updates.sessionResetMode
  if (updates.sessionIdleTimeoutSec !== undefined) sessions[id].sessionIdleTimeoutSec = updates.sessionIdleTimeoutSec
  if (updates.sessionMaxAgeSec !== undefined) sessions[id].sessionMaxAgeSec = updates.sessionMaxAgeSec
  if (updates.sessionDailyResetAt !== undefined) sessions[id].sessionDailyResetAt = updates.sessionDailyResetAt
  if (updates.sessionResetTimezone !== undefined) sessions[id].sessionResetTimezone = updates.sessionResetTimezone
  if (updates.thinkingLevel !== undefined) sessions[id].thinkingLevel = updates.thinkingLevel
  if (updates.connectorThinkLevel !== undefined) sessions[id].connectorThinkLevel = updates.connectorThinkLevel
  if (updates.connectorSessionScope !== undefined) sessions[id].connectorSessionScope = updates.connectorSessionScope
  if (updates.connectorReplyMode !== undefined) sessions[id].connectorReplyMode = updates.connectorReplyMode
  if (updates.connectorThreadBinding !== undefined) sessions[id].connectorThreadBinding = updates.connectorThreadBinding
  if (updates.connectorGroupPolicy !== undefined) sessions[id].connectorGroupPolicy = updates.connectorGroupPolicy
  if (updates.connectorIdleTimeoutSec !== undefined) sessions[id].connectorIdleTimeoutSec = updates.connectorIdleTimeoutSec
  if (updates.connectorMaxAgeSec !== undefined) sessions[id].connectorMaxAgeSec = updates.connectorMaxAgeSec
  if (updates.connectorContext !== undefined) sessions[id].connectorContext = updates.connectorContext
  if (updates.identityState !== undefined) sessions[id].identityState = updates.identityState
  if (updates.sessionArchiveState !== undefined) sessions[id].sessionArchiveState = updates.sessionArchiveState
  if (updates.lastSessionResetAt !== undefined) sessions[id].lastSessionResetAt = updates.lastSessionResetAt
  if (updates.lastSessionResetReason !== undefined) sessions[id].lastSessionResetReason = updates.lastSessionResetReason
  if (updates.pinned !== undefined) sessions[id].pinned = !!updates.pinned
  if (updates.claudeSessionId !== undefined) sessions[id].claudeSessionId = updates.claudeSessionId
  if (updates.codexThreadId !== undefined) sessions[id].codexThreadId = updates.codexThreadId
  if (updates.opencodeSessionId !== undefined) sessions[id].opencodeSessionId = updates.opencodeSessionId
  if (updates.delegateResumeIds !== undefined) sessions[id].delegateResumeIds = updates.delegateResumeIds
  if (!Array.isArray(sessions[id].messages)) sessions[id].messages = []

  saveSessions(sessions)
  return NextResponse.json(sessions[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()
  if (active.has(id)) {
    try { active.get(id).kill() } catch {}
    active.delete(id)
  }
  deleteSession(id)
  return new NextResponse('OK')
}
