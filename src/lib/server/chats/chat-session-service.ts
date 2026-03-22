import os from 'node:os'
import path from 'node:path'

import { genId } from '@/lib/id'
import { normalizeCapabilitySelection } from '@/lib/capability-selection'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { loadAgent } from '@/lib/server/agents/agent-repository'
import { clearMainLoopStateForSession } from '@/lib/server/agents/main-agent-loop'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { enrichSessionWithMissionSummary } from '@/lib/server/missions/mission-service'
import { cleanupSessionProcesses } from '@/lib/server/runtime/process-manager'
import { stopActiveSessionProcess } from '@/lib/server/runtime/runtime-state'
import {
  cancelQueuedRunById,
  cancelQueuedRunsForSession,
  enqueueSessionRun,
  getSessionQueueSnapshot,
  getSessionRunState,
} from '@/lib/server/runtime/session-run-manager'
import { deleteSession, getSession, listSessions, saveSession } from '@/lib/server/sessions/session-repository'
import {
  clearMessages,
  deleteSessionMessages,
  getMessages,
  truncateAfter,
} from '@/lib/server/messages/message-repository'
import { deleteSessionWorkingState } from '@/lib/server/working-state/service'
import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { serviceFail, serviceOk } from '@/lib/server/service-result'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { buildSessionListSummary } from '@/lib/chat/session-summary'
import type { Session } from '@/types'
import type { ServiceResult } from '@/lib/server/service-result'
import { notify } from '@/lib/server/ws-hub'

function normalizeCwd(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  if (raw === '~') return os.homedir()
  if (!raw) return WORKSPACE_DIR
  return raw
}

function emptyDelegateResumeIds() {
  return {
    claudeCode: null,
    codex: null,
    opencode: null,
    gemini: null,
  }
}

export function listChatsForApi(): Record<string, ReturnType<typeof buildSessionListSummary>> {
  const sessions = listSessions()
  for (const id of Object.keys(sessions)) {
    const run = getSessionRunState(id)
    const queue = getSessionQueueSnapshot(id)
    sessions[id].active = !!run.runningRunId
    sessions[id].queuedCount = queue.queueLength
    sessions[id].currentRunId = run.runningRunId || null
  }
  return Object.fromEntries(
    Object.entries(sessions).map(([id, session]) => [id, buildSessionListSummary(enrichSessionWithMissionSummary(session))]),
  )
}

export function getChatSessionForApi(sessionId: string): Session | null {
  const session = getSession(sessionId)
  if (!session) return null
  const run = getSessionRunState(sessionId)
  const queue = getSessionQueueSnapshot(sessionId)
  session.active = !!run.runningRunId
  session.queuedCount = queue.queueLength
  session.currentRunId = run.runningRunId || null
  return enrichSessionWithMissionSummary(session)
}

export function createChatSession(input: Record<string, unknown>): ServiceResult<Session> {
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : genId()
  const sessions = listSessions()
  if (typeof input.id === 'string' && sessions[id]) {
    return serviceOk(sessions[id])
  }
  const agent = typeof input.agentId === 'string' ? loadAgent(input.agentId) : null
  if (isAgentDisabled(agent)) {
    return serviceFail(409, buildAgentDisabledMessage(agent, 'start chats'))
  }
  const explicitOllamaMode = input.ollamaMode === 'cloud' ? 'cloud' : input.ollamaMode === 'local' ? 'local' : null
  const routePreferredGatewayTags = Array.isArray(input.routePreferredGatewayTags)
    ? input.routePreferredGatewayTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : []
  const routePreferredGatewayUseCase = typeof input.routePreferredGatewayUseCase === 'string' && input.routePreferredGatewayUseCase.trim()
    ? input.routePreferredGatewayUseCase.trim()
    : null
  const resolvedRoute = agent ? resolvePrimaryAgentRoute(agent, undefined, {
    preferredGatewayTags: routePreferredGatewayTags,
    preferredGatewayUseCase: routePreferredGatewayUseCase,
  }) : null
  const resolvedCapabilities = normalizeCapabilitySelection({
    tools: Array.isArray(input.tools) ? input.tools : agent?.tools,
    extensions: Array.isArray(input.extensions) ? input.extensions : agent?.extensions,
  })
  const provider = (
    typeof input.provider === 'string' && input.provider.trim()
      ? input.provider.trim()
      : agent?.provider || 'claude-cli'
  ) as Session['provider']
  const now = Date.now()
  const baseSession: Session = {
    id,
    name: (input.name as string) || 'New Chat',
    cwd: normalizeCwd(input.cwd),
    user: (input.user as string) || 'user',
    provider,
    model: (input.model as string) || agent?.model || '',
    ollamaMode: explicitOllamaMode ?? agent?.ollamaMode ?? (provider === 'ollama' ? 'local' : null),
    credentialId: (input.credentialId as string | null | undefined) || agent?.credentialId || null,
    fallbackCredentialIds: Array.isArray(input.fallbackCredentialIds) ? input.fallbackCredentialIds : agent?.fallbackCredentialIds || [],
    apiEndpoint: normalizeProviderEndpoint(
      provider,
      (input.apiEndpoint as string | null | undefined) || agent?.apiEndpoint || null,
    ),
    routePreferredGatewayTags,
    routePreferredGatewayUseCase,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: emptyDelegateResumeIds(),
    messages: Array.isArray(input.messages) ? input.messages : [],
    createdAt: now,
    lastActiveAt: now,
    sessionType: (input.sessionType as Session['sessionType']) || 'human',
    agentId: (input.agentId as string | null | undefined) || null,
    parentSessionId: (input.parentSessionId as string | null | undefined) || null,
    tools: resolvedCapabilities.tools,
    extensions: resolvedCapabilities.extensions,
    heartbeatEnabled: (input.heartbeatEnabled as boolean | null | undefined) ?? null,
    heartbeatIntervalSec: (input.heartbeatIntervalSec as number | null | undefined) ?? null,
    sessionResetMode: (input.sessionResetMode as Session['sessionResetMode']) ?? agent?.sessionResetMode ?? null,
    sessionIdleTimeoutSec: (input.sessionIdleTimeoutSec as number | null | undefined) ?? agent?.sessionIdleTimeoutSec ?? null,
    sessionMaxAgeSec: (input.sessionMaxAgeSec as number | null | undefined) ?? agent?.sessionMaxAgeSec ?? null,
    sessionDailyResetAt: (input.sessionDailyResetAt as string | null | undefined) ?? agent?.sessionDailyResetAt ?? null,
    sessionResetTimezone: (input.sessionResetTimezone as string | null | undefined) ?? agent?.sessionResetTimezone ?? null,
    thinkingLevel: (input.thinkingLevel as Session['thinkingLevel']) ?? null,
    connectorThinkLevel: (input.connectorThinkLevel as Session['connectorThinkLevel']) ?? null,
    connectorSessionScope: (input.connectorSessionScope as Session['connectorSessionScope']) ?? null,
    connectorReplyMode: (input.connectorReplyMode as Session['connectorReplyMode']) ?? null,
    connectorThreadBinding: (input.connectorThreadBinding as Session['connectorThreadBinding']) ?? null,
    connectorGroupPolicy: (input.connectorGroupPolicy as Session['connectorGroupPolicy']) ?? null,
    connectorIdleTimeoutSec: (input.connectorIdleTimeoutSec as number | null | undefined) ?? null,
    connectorMaxAgeSec: (input.connectorMaxAgeSec as number | null | undefined) ?? null,
    connectorContext: input.connectorContext === null
      ? undefined
      : (input.connectorContext as Session['connectorContext']),
    identityState: (input.identityState as Session['identityState']) ?? agent?.identityState ?? null,
    sessionArchiveState: (input.sessionArchiveState as Session['sessionArchiveState']) ?? null,
  }
  const session: Session = (input.provider || input.model || input.credentialId || input.apiEndpoint)
    ? baseSession
    : applyResolvedRoute(baseSession, resolvedRoute)
  saveSession(id, session)
  notify('sessions')
  return serviceOk(session)
}

export function deleteChats(ids: string[]): { deleted: number; requested: number } {
  let deleted = 0
  const sessions = listSessions()
  for (const id of ids) {
    if (!sessions[id]) continue
    stopActiveSessionProcess(id)
    deleteSessionWorkingState(id)
    clearMainLoopStateForSession(id)
    deleteSessionMessages(id)
    deleteSession(id)
    deleted += 1
  }
  if (deleted > 0) notify('sessions')
  return { deleted, requested: ids.length }
}

export function updateChatSession(sessionId: string, updates: Record<string, unknown>): Session | null {
  const original = getSession(sessionId)
  if (!original) return null
  const session = original as unknown as Record<string, unknown>

  if (updates.resetMainLoopState === true) {
    clearMainLoopStateForSession(sessionId)
    deleteSessionWorkingState(sessionId)
  }

  const agentIdUpdateProvided = updates.agentId !== undefined
  let nextAgentId = session.agentId
  if (agentIdUpdateProvided) {
    session.agentId = updates.agentId
    nextAgentId = updates.agentId
  }

  const linkedAgent = nextAgentId ? loadAgent(String(nextAgentId)) : null
  const routePreferredGatewayTags = updates.routePreferredGatewayTags !== undefined
    ? (Array.isArray(updates.routePreferredGatewayTags)
      ? updates.routePreferredGatewayTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
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
  if (updates.cwd !== undefined) session.cwd = normalizeCwd(updates.cwd)
  if (updates.provider !== undefined) session.provider = updates.provider
  else if (agentIdUpdateProvided && linkedAgent?.provider) session.provider = linkedAgent.provider
  if (updates.model !== undefined) session.model = updates.model
  else if (agentIdUpdateProvided && linkedRoute?.model) session.model = linkedRoute.model
  else if (agentIdUpdateProvided && linkedAgent?.model !== undefined) session.model = linkedAgent.model
  if (updates.ollamaMode !== undefined) session.ollamaMode = updates.ollamaMode
  else if (updates.provider !== undefined && updates.provider !== 'ollama') session.ollamaMode = null
  else if (agentIdUpdateProvided && linkedRoute) session.ollamaMode = linkedRoute.ollamaMode ?? null
  else if (agentIdUpdateProvided && linkedAgent) session.ollamaMode = linkedAgent.ollamaMode ?? null
  if (updates.credentialId !== undefined) session.credentialId = updates.credentialId
  else if (agentIdUpdateProvided && linkedRoute) session.credentialId = linkedRoute.credentialId ?? null
  else if (agentIdUpdateProvided && linkedAgent) session.credentialId = linkedAgent.credentialId ?? null
  if (updates.fallbackCredentialIds !== undefined) session.fallbackCredentialIds = updates.fallbackCredentialIds
  else if (agentIdUpdateProvided && linkedRoute) session.fallbackCredentialIds = [...linkedRoute.fallbackCredentialIds]
  if (updates.gatewayProfileId !== undefined) session.gatewayProfileId = updates.gatewayProfileId
  else if (agentIdUpdateProvided && linkedRoute) session.gatewayProfileId = linkedRoute.gatewayProfileId ?? null
  if (updates.routePreferredGatewayTags !== undefined) session.routePreferredGatewayTags = routePreferredGatewayTags
  if (updates.routePreferredGatewayUseCase !== undefined) session.routePreferredGatewayUseCase = routePreferredGatewayUseCase

  if (updates.tools !== undefined || updates.extensions !== undefined || (agentIdUpdateProvided && linkedAgent)) {
    const nextSelection = normalizeCapabilitySelection({
      tools: Array.isArray(updates.tools)
        ? updates.tools
        : (agentIdUpdateProvided && linkedAgent ? linkedAgent.tools : session.tools as string[] | undefined),
      extensions: Array.isArray(updates.extensions)
        ? updates.extensions
        : (agentIdUpdateProvided && linkedAgent ? linkedAgent.extensions : session.extensions as string[] | undefined),
    })
    session.tools = nextSelection.tools
    session.extensions = nextSelection.extensions
  }

  if (updates.apiEndpoint !== undefined) {
    session.apiEndpoint = normalizeProviderEndpoint(
      (updates.provider || session.provider) as string,
      updates.apiEndpoint as string | null | undefined,
    )
  } else if (agentIdUpdateProvided && linkedRoute) {
    session.apiEndpoint = linkedRoute.apiEndpoint ?? null
  } else if (agentIdUpdateProvided && linkedAgent) {
    session.apiEndpoint = normalizeProviderEndpoint(linkedAgent.provider, linkedAgent.apiEndpoint ?? null)
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

  saveSession(sessionId, original)
  notify('sessions')
  return enrichSessionWithMissionSummary(original)
}

export function deleteChatSession(sessionId: string): boolean {
  if (!getSession(sessionId)) return false
  stopActiveSessionProcess(sessionId)
  cleanupSessionProcesses(sessionId)
  deleteSessionMessages(sessionId)
  deleteSession(sessionId)
  notify('sessions')
  return true
}

export function getQueueSnapshot(sessionId: string) {
  const session = getSession(sessionId)
  if (!session) return null
  return getSessionQueueSnapshot(sessionId)
}

export function queueChatMessage(sessionId: string, body: Record<string, unknown>): ServiceResult<Record<string, unknown>> {
  const session = getSession(sessionId)
  if (!session) return serviceFail(404, 'Not found')
  const message = typeof body.message === 'string' ? body.message : ''
  const imagePath = typeof body.imagePath === 'string' ? body.imagePath : undefined
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : undefined
  const attachedFiles = Array.isArray(body.attachedFiles)
    ? body.attachedFiles.filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
    : undefined
  const replyToId = typeof body.replyToId === 'string' ? body.replyToId : undefined
  const hasFiles = !!(imagePath || imageUrl || attachedFiles?.length)
  if (!message.trim() && !hasFiles) {
    return serviceFail(400, 'message or file is required')
  }
  const queued = enqueueSessionRun({
    sessionId,
    missionId: session.missionId || null,
    message,
    imagePath,
    imageUrl,
    attachedFiles,
    source: 'chat',
    mode: 'followup',
    replyToId,
  })
  return serviceOk({
    queued: {
      runId: queued.runId,
      position: queued.position,
    },
    snapshot: getSessionQueueSnapshot(sessionId),
  })
}

export function cancelQueuedChatMessages(sessionId: string, runId?: string): ServiceResult<Record<string, unknown>> | null {
  const session = getSession(sessionId)
  if (!session) return null
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : ''
  if (normalizedRunId) {
    const snapshot = getSessionQueueSnapshot(sessionId)
    if (!snapshot.items.some((item) => item.runId === normalizedRunId)) {
      return serviceFail(404, 'Queued run not found')
    }
    cancelQueuedRunById(normalizedRunId, 'Removed from queue')
    return serviceOk({ cancelled: 1, snapshot: getSessionQueueSnapshot(sessionId) })
  }
  const cancelled = cancelQueuedRunsForSession(sessionId, 'Cleared queued messages')
  return serviceOk({ cancelled, snapshot: getSessionQueueSnapshot(sessionId) })
}

export function clearChatMessages(sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session) return false
  clearMessages(sessionId)
  session.messages = []
  session.claudeSessionId = null
  session.codexThreadId = null
  session.opencodeSessionId = null
  session.delegateResumeIds = emptyDelegateResumeIds()
  saveSession(sessionId, session)
  notify('sessions')
  return true
}

export function retryChatTurn(sessionId: string): ServiceResult<{ message: string; imagePath: string | null }> {
  const session = getSession(sessionId)
  if (!session) return serviceFail(404, 'Session not found')
  const msgs = getMessages(sessionId)
  // Remove trailing assistant messages
  while (msgs.length && msgs[msgs.length - 1].role === 'assistant') {
    msgs.pop()
  }
  if (!msgs.length) {
    clearMessages(sessionId)
    return serviceOk({ message: '', imagePath: null })
  }
  const lastUser = msgs[msgs.length - 1]
  const message = lastUser.text
  const imagePath = lastUser.imagePath || null
  msgs.pop()
  // Truncate to the new length (keep seq 0..msgs.length-1)
  if (msgs.length === 0) {
    clearMessages(sessionId)
  } else {
    truncateAfter(sessionId, msgs.length - 1)
  }
  return serviceOk({ message, imagePath })
}

export function editAndResendChatTurn(sessionId: string, messageIndex: number, newText: string): ServiceResult<{ message: string }> {
  const session = getSession(sessionId)
  if (!session) return serviceFail(404, 'Not found')
  const msgCount = getMessages(sessionId).length
  if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= msgCount) {
    return serviceFail(400, 'Invalid message index')
  }
  // Keep messages up to but not including messageIndex
  if (messageIndex === 0) {
    clearMessages(sessionId)
  } else {
    truncateAfter(sessionId, messageIndex - 1)
  }
  return serviceOk({ message: newText })
}
