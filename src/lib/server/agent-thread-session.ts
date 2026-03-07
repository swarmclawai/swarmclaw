import { genId } from '@/lib/id'
import type { Agent, Session } from '@/types'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from './agent-runtime-config'
import { WORKSPACE_DIR } from './data-dir'
import { loadAgents, loadSessions, saveAgents, saveSessions } from './storage'

function buildEmptyDelegateResumeIds(): NonNullable<Session['delegateResumeIds']> {
  return {
    claudeCode: null,
    codex: null,
    opencode: null,
    gemini: null,
  }
}

function buildThreadSession(agent: Agent, sessionId: string, user: string, createdAt: number, existing?: Session): Session {
  const baseSession: Session = {
    id: sessionId,
    name: agent.name,
    shortcutForAgentId: agent.id,
    cwd: existing?.cwd || WORKSPACE_DIR,
    user: existing?.user || user,
    provider: agent.provider,
    model: agent.model,
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
    plugins: agent.plugins || agent.tools || [],
    tools: agent.plugins || agent.tools || [],
    heartbeatEnabled: agent.heartbeatEnabled || false,
    heartbeatIntervalSec: agent.heartbeatIntervalSec || null,
    heartbeatTarget: existing?.heartbeatTarget || null,
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
    connectorContext: existing?.connectorContext || undefined,
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
    canvasContent: existing?.canvasContent || null,
  }
  return applyResolvedRoute(
    baseSession,
    resolvePrimaryAgentRoute(agent, undefined, {
      preferredGatewayTags: baseSession.routePreferredGatewayTags || [],
      preferredGatewayUseCase: baseSession.routePreferredGatewayUseCase || null,
    }),
  )
}

export function ensureAgentThreadSession(agentId: string, user = 'default'): Session | null {
  const agents = loadAgents()
  const agent = agents[agentId] as Agent | undefined
  if (!agent) return null

  const sessions = loadSessions()
  const now = Date.now()

  const existingId = typeof agent.threadSessionId === 'string' ? agent.threadSessionId : ''
  if (existingId && sessions[existingId]) {
    const session = buildThreadSession(agent, existingId, user, now, sessions[existingId] as Session)
    sessions[existingId] = session
    saveSessions(sessions)
    return session
  }

  const legacySession = Object.values(sessions).find((session) => (
    (session.shortcutForAgentId === agentId || session.name === `agent-thread:${agentId}`)
    && session.user === user
  )) as Session | undefined

  if (legacySession) {
    agent.threadSessionId = legacySession.id
    agent.updatedAt = now
    saveAgents(agents)
    const session = buildThreadSession(agent, legacySession.id, user, now, legacySession)
    sessions[legacySession.id] = session
    saveSessions(sessions)
    return session
  }

  const sessionId = `agent-chat-${agentId}-${genId()}`
  const session = buildThreadSession(agent, sessionId, user, now)
  sessions[sessionId] = session
  saveSessions(sessions)

  agent.threadSessionId = sessionId
  agent.updatedAt = now
  saveAgents(agents)
  return session
}
