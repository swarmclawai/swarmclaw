import { NextResponse } from 'next/server'
import { loadSession, upsertSession, deleteSession, active, loadAgents } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { resolvePrimaryAgentRoute } from '@/lib/server/agent-runtime-config'
import { getSessionRunState } from '@/lib/server/session-run-manager'
import type { Session } from '@/types'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = loadSession(id)
  if (!session) return notFound()

  const run = getSessionRunState(id)
  session.active = active.has(id) || !!run.runningRunId
  session.queuedCount = run.queueLength
  session.currentRunId = run.runningRunId || null

  return NextResponse.json(session)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const updates = await req.json()
  const session = loadSession(id) as Record<string, unknown> | null
  if (!session) return notFound()

  const agentIdUpdateProvided = updates.agentId !== undefined
  let nextAgentId = session.agentId
  if (agentIdUpdateProvided) {
    session.agentId = updates.agentId
    nextAgentId = updates.agentId
  }

  const linkedAgent = nextAgentId ? loadAgents()[nextAgentId as string] : null
  const routePreferredGatewayTags = updates.routePreferredGatewayTags !== undefined
    ? (Array.isArray(updates.routePreferredGatewayTags)
      ? updates.routePreferredGatewayTags.filter((tag: unknown): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : [])
    : ((session.routePreferredGatewayTags as string[]) || [])
  const routePreferredGatewayUseCase = updates.routePreferredGatewayUseCase !== undefined
    ? (typeof updates.routePreferredGatewayUseCase === 'string' && updates.routePreferredGatewayUseCase.trim()
      ? updates.routePreferredGatewayUseCase.trim()
      : null)
    : ((session.routePreferredGatewayUseCase as string | null) || null)
  const linkedRoute = linkedAgent ? resolvePrimaryAgentRoute(linkedAgent, undefined, {
    preferredGatewayTags: routePreferredGatewayTags,
    preferredGatewayUseCase: routePreferredGatewayUseCase,
  }) : null

  if (updates.name !== undefined) session.name = updates.name
  if (updates.cwd !== undefined) session.cwd = updates.cwd
  if (updates.provider !== undefined) session.provider = updates.provider
  else if (agentIdUpdateProvided && linkedAgent?.provider) session.provider = linkedAgent.provider

  if (updates.model !== undefined) session.model = updates.model
  else if (agentIdUpdateProvided && linkedRoute?.model) session.model = linkedRoute.model
  else if (agentIdUpdateProvided && linkedAgent?.model !== undefined) session.model = linkedAgent.model

  if (updates.credentialId !== undefined) session.credentialId = updates.credentialId
  else if (agentIdUpdateProvided && linkedRoute) session.credentialId = linkedRoute.credentialId ?? null
  else if (agentIdUpdateProvided && linkedAgent) session.credentialId = linkedAgent.credentialId ?? null

  if (updates.fallbackCredentialIds !== undefined) session.fallbackCredentialIds = updates.fallbackCredentialIds
  else if (agentIdUpdateProvided && linkedRoute) session.fallbackCredentialIds = [...linkedRoute.fallbackCredentialIds]

  if (updates.gatewayProfileId !== undefined) session.gatewayProfileId = updates.gatewayProfileId
  else if (agentIdUpdateProvided && linkedRoute) session.gatewayProfileId = linkedRoute.gatewayProfileId ?? null

  if (updates.routePreferredGatewayTags !== undefined) {
    session.routePreferredGatewayTags = routePreferredGatewayTags
  }
  if (updates.routePreferredGatewayUseCase !== undefined) {
    session.routePreferredGatewayUseCase = routePreferredGatewayUseCase
  }

  if (updates.plugins !== undefined) session.plugins = updates.plugins
  else if (agentIdUpdateProvided && linkedAgent) session.plugins = Array.isArray(linkedAgent.plugins) ? linkedAgent.plugins : []

  if (updates.apiEndpoint !== undefined) {
    session.apiEndpoint = normalizeProviderEndpoint(
      (updates.provider || session.provider) as string,
      updates.apiEndpoint,
    )
  } else if (agentIdUpdateProvided && linkedRoute) {
    session.apiEndpoint = linkedRoute.apiEndpoint ?? null
  } else if (agentIdUpdateProvided && linkedAgent) {
    session.apiEndpoint = normalizeProviderEndpoint(
      linkedAgent.provider,
      linkedAgent.apiEndpoint ?? null,
    )
  }
  if (updates.heartbeatEnabled !== undefined) session.heartbeatEnabled = updates.heartbeatEnabled
  if (updates.heartbeatIntervalSec !== undefined) session.heartbeatIntervalSec = updates.heartbeatIntervalSec
  if (updates.sessionResetMode !== undefined) session.sessionResetMode = updates.sessionResetMode
  if (updates.sessionIdleTimeoutSec !== undefined) session.sessionIdleTimeoutSec = updates.sessionIdleTimeoutSec
  if (updates.sessionMaxAgeSec !== undefined) session.sessionMaxAgeSec = updates.sessionMaxAgeSec
  if (updates.sessionDailyResetAt !== undefined) session.sessionDailyResetAt = updates.sessionDailyResetAt
  if (updates.sessionResetTimezone !== undefined) session.sessionResetTimezone = updates.sessionResetTimezone
  if (updates.thinkingLevel !== undefined) session.thinkingLevel = updates.thinkingLevel
  if (updates.connectorThinkLevel !== undefined) session.connectorThinkLevel = updates.connectorThinkLevel
  if (updates.connectorSessionScope !== undefined) session.connectorSessionScope = updates.connectorSessionScope
  if (updates.connectorReplyMode !== undefined) session.connectorReplyMode = updates.connectorReplyMode
  if (updates.connectorThreadBinding !== undefined) session.connectorThreadBinding = updates.connectorThreadBinding
  if (updates.connectorGroupPolicy !== undefined) session.connectorGroupPolicy = updates.connectorGroupPolicy
  if (updates.connectorIdleTimeoutSec !== undefined) session.connectorIdleTimeoutSec = updates.connectorIdleTimeoutSec
  if (updates.connectorMaxAgeSec !== undefined) session.connectorMaxAgeSec = updates.connectorMaxAgeSec
  if (updates.connectorContext !== undefined) session.connectorContext = updates.connectorContext
  if (updates.identityState !== undefined) session.identityState = updates.identityState
  if (updates.sessionArchiveState !== undefined) session.sessionArchiveState = updates.sessionArchiveState
  if (updates.lastSessionResetAt !== undefined) session.lastSessionResetAt = updates.lastSessionResetAt
  if (updates.lastSessionResetReason !== undefined) session.lastSessionResetReason = updates.lastSessionResetReason
  if (updates.pinned !== undefined) session.pinned = !!updates.pinned
  if (updates.claudeSessionId !== undefined) session.claudeSessionId = updates.claudeSessionId
  if (updates.codexThreadId !== undefined) session.codexThreadId = updates.codexThreadId
  if (updates.opencodeSessionId !== undefined) session.opencodeSessionId = updates.opencodeSessionId
  if (updates.delegateResumeIds !== undefined) session.delegateResumeIds = updates.delegateResumeIds
  if (!Array.isArray(session.messages)) session.messages = []

  upsertSession(id, session)
  return NextResponse.json(session)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!loadSession(id)) return notFound()
  if (active.has(id)) {
    try { active.get(id)?.kill() } catch {}
    active.delete(id)
  }
  deleteSession(id)
  return new NextResponse('OK')
}
