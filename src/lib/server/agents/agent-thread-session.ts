import { genId } from '@/lib/id'
import type { Agent, Session } from '@/types'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { loadAgent, loadAgents, upsertAgent } from '@/lib/server/agents/agent-repository'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { getEnabledCapabilitySelection } from '@/lib/capability-selection'
import { loadSession, loadSessions, upsertSession } from '@/lib/server/sessions/session-repository'

function buildEmptyDelegateResumeIds(): NonNullable<Session['delegateResumeIds']> {
  return {
    claudeCode: null,
    codex: null,
    opencode: null,
    gemini: null,
  }
}

function buildThreadSession(agent: Agent, sessionId: string, user: string, createdAt: number, existing?: Session): Session {
  const capabilitySelection = getEnabledCapabilitySelection({
    tools: agent.tools,
    extensions: agent.extensions,
  })
  const baseSession: Session = {
    id: sessionId,
    name: agent.name,
    openclawAgentId: agent.openclawAgentId || existing?.openclawAgentId || null,
    shortcutForAgentId: agent.id,
    cwd: existing?.cwd || WORKSPACE_DIR,
    user: existing?.user || user,
    provider: agent.provider,
    model: agent.model,
    ollamaMode: agent.ollamaMode ?? existing?.ollamaMode ?? null,
    credentialId: agent.credentialId || null,
    fallbackCredentialIds: agent.fallbackCredentialIds || [],
    apiEndpoint: agent.apiEndpoint || null,
    gatewayProfileId: agent.gatewayProfileId || null,
    routePreferredGatewayTags: existing?.routePreferredGatewayTags || [],
    routePreferredGatewayUseCase: existing?.routePreferredGatewayUseCase || null,
    claudeSessionId: existing?.claudeSessionId || null,
    codexThreadId: existing?.codexThreadId || null,
    opencodeSessionId: existing?.opencodeSessionId || null,
    delegateResumeIds: existing?.delegateResumeIds || buildEmptyDelegateResumeIds(),
    messages: Array.isArray(existing?.messages) ? existing.messages : [],
    createdAt: existing?.createdAt || createdAt,
    lastActiveAt: createdAt,
    active: existing?.active || false,
    sessionType: existing?.sessionType || 'human',
    agentId: agent.id,
    parentSessionId: existing?.parentSessionId || null,
    tools: capabilitySelection.tools,
    extensions: capabilitySelection.extensions,
    heartbeatEnabled: agent.heartbeatEnabled || false,
    heartbeatIntervalSec: agent.heartbeatIntervalSec || null,
    heartbeatTarget: existing?.heartbeatTarget || null,
    memoryScopeMode: agent.memoryScopeMode || null,
    memoryTierPreference: agent.memoryTierPreference || null,
    projectId: agent.projectId || existing?.projectId || null,
    sessionResetMode: existing?.sessionResetMode || null,
    sessionIdleTimeoutSec: existing?.sessionIdleTimeoutSec || null,
    sessionMaxAgeSec: existing?.sessionMaxAgeSec || null,
    sessionDailyResetAt: existing?.sessionDailyResetAt || null,
    sessionResetTimezone: existing?.sessionResetTimezone || null,
    thinkingLevel: existing?.thinkingLevel || null,
    browserProfileId: existing?.browserProfileId || null,
    connectorThinkLevel: existing?.connectorThinkLevel || null,
    connectorSessionScope: existing?.connectorSessionScope || null,
    connectorReplyMode: existing?.connectorReplyMode || null,
    connectorThreadBinding: existing?.connectorThreadBinding || null,
    connectorGroupPolicy: existing?.connectorGroupPolicy || null,
    connectorIdleTimeoutSec: existing?.connectorIdleTimeoutSec || null,
    connectorMaxAgeSec: existing?.connectorMaxAgeSec || null,
    mailbox: existing?.mailbox || null,
    connectorContext: undefined,
    lastAutoMemoryAt: existing?.lastAutoMemoryAt || null,
    lastHeartbeatText: existing?.lastHeartbeatText || null,
    lastHeartbeatSentAt: existing?.lastHeartbeatSentAt || null,
    lastSessionResetAt: existing?.lastSessionResetAt || null,
    lastSessionResetReason: existing?.lastSessionResetReason || null,
    identityState: existing?.identityState || null,
    sessionArchiveState: existing?.sessionArchiveState || null,
    pinned: existing?.pinned || false,
    file: existing?.file || null,
    queuedCount: existing?.queuedCount,
    currentRunId: existing?.currentRunId || null,
    conversationTone: existing?.conversationTone,
    emoji: existing?.emoji,
    creature: existing?.creature,
    vibe: existing?.vibe,
    theme: existing?.theme,
    avatar: existing?.avatar,
  }
  return applyResolvedRoute(
    baseSession,
    resolvePrimaryAgentRoute(agent, undefined, {
      preferredGatewayTags: baseSession.routePreferredGatewayTags || [],
      preferredGatewayUseCase: baseSession.routePreferredGatewayUseCase || null,
    }),
  )
}

function shouldHealAgentCredentialId(agent: Agent, session: Session): boolean {
  const currentCredentialId = typeof agent.credentialId === 'string' ? agent.credentialId.trim() : ''
  const resolvedCredentialId = typeof session.credentialId === 'string' ? session.credentialId.trim() : ''
  if (!currentCredentialId || !resolvedCredentialId || currentCredentialId === resolvedCredentialId) return false
  if (agent.gatewayProfileId) return false
  return session.provider === agent.provider
}

export function ensureAgentThreadSession(agentId: string, user = 'default', preloadedAgent?: Agent): Session | null {
  const agent = preloadedAgent ?? loadAgent(agentId) ?? (loadAgents()[agentId] as Agent | undefined)
  if (!agent) return null

  const now = Date.now()

  // Fast path: agent already has a threadSessionId — single-row lookup
  const existingId = typeof agent.threadSessionId === 'string' ? agent.threadSessionId : ''
  if (existingId) {
    const existing = loadSession(existingId)
    if (existing) {
      const session = buildThreadSession(agent, existingId, user, now, existing)
      if (shouldHealAgentCredentialId(agent, session)) {
        agent.credentialId = session.credentialId ?? null
        agent.updatedAt = now
        upsertAgent(agentId, agent)
      }
      upsertSession(existingId, session)
      return session
    }
    // Session was deleted — fall through to legacy search / creation
  }

  // Legacy search: full table scan only when threadSessionId is missing or stale
  const sessions = loadSessions()
  const disabled = isAgentDisabled(agent)

  const legacySession = Object.values(sessions).find((session) => (
    (session.shortcutForAgentId === agentId || session.name === `agent-thread:${agentId}`)
    && session.user === user
  )) as unknown as Session | undefined

  if (legacySession) {
    agent.threadSessionId = legacySession.id
    const session = buildThreadSession(agent, legacySession.id, user, now, legacySession)
    if (shouldHealAgentCredentialId(agent, session)) {
      agent.credentialId = session.credentialId ?? null
    }
    agent.updatedAt = now
    upsertAgent(agentId, agent)
    upsertSession(legacySession.id, session)
    return session
  }

  if (disabled) return null

  const sessionId = `agent-chat-${agentId}-${genId()}`
  const session = buildThreadSession(agent, sessionId, user, now)
  if (shouldHealAgentCredentialId(agent, session)) {
    agent.credentialId = session.credentialId ?? null
  }
  upsertSession(sessionId, session)

  agent.threadSessionId = sessionId
  agent.updatedAt = now
  upsertAgent(agentId, agent)
  return session
}
