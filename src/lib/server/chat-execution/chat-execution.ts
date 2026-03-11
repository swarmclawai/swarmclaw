import fs from 'fs'
import os from 'os'
import { perf } from '@/lib/server/runtime/perf'
import {
  loadSessions,
  saveSessions,
  loadCredentials,
  decryptKey,
  getSessionMessages,
  loadAgents,
  loadSkills,
  loadSettings,
  appendUsage,
  active,
} from '@/lib/server/storage'
import { getProvider } from '@/lib/providers'
import { estimateCost, checkAgentBudgetLimits } from '@/lib/server/cost'
import { log } from '@/lib/server/logger'
import { logExecution } from '@/lib/server/execution-log'
import { buildToolAvailabilityLines, buildToolDisciplineLines, streamAgentChat } from '@/lib/server/chat-execution/stream-agent-chat'
import { runLinkUnderstanding } from '@/lib/server/link-understanding'
import type { Session } from '@/types'
import type { ApprovalCategory } from '@/types'
import { stripMainLoopMetaForPersistence } from '@/lib/server/agents/main-agent-loop'
import { getPluginManager } from '@/lib/server/plugins'
import { isLocalOpenClawEndpoint, normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { notify } from '@/lib/server/ws-hub'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { resolveSessionToolPolicy } from '@/lib/server/tool-capability-policy'
import { buildCurrentDateTimePromptContext } from '@/lib/server/prompt-runtime-context'
import { buildWorkspaceContext } from '@/lib/server/workspace-context'
import { resolveImagePath } from '@/lib/server/resolve-image'
import {
  applyContextClearBoundary,
  shouldApplySessionFreshnessReset,
  shouldAutoRouteHeartbeatAlerts,
  shouldPersistInboundUserMessage,
  translateRequestedToolInvocation,
  normalizeAssistantArtifactLinks,
  extractHeartbeatStatus,
  shouldReplaceRecentAssistantMessage,
  hasPersistableAssistantPayload,
  getPersistedAssistantText,
  getToolEventsSnapshotKey,
  requestedToolNamesFromMessage,
  hasDirectLocalCodingTools,
  parseUsdLimit,
  getTodaySpendUsd,
  classifyHeartbeatResponse,
  estimateConversationTone,
  pruneOldHeartbeatMessages,
} from '@/lib/server/chat-execution/chat-execution-utils'
import { runPostLlmToolRouting } from '@/lib/server/chat-execution/chat-turn-tool-routing'
import {
  getCachedLlmResponse,
  resolveLlmResponseCacheConfig,
  setCachedLlmResponse,
  type LlmResponseCacheKeyInput,
} from '@/lib/server/llm-response-cache'
import type { Message, MessageToolEvent, SSEEvent, UsageRecord } from '@/types'
import { markProviderFailure, markProviderSuccess } from '@/lib/server/provider-health'
import { isHeartbeatSource, isInternalHeartbeatRun } from '@/lib/server/runtime/heartbeat-source'
import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
import { buildIdentityContinuityContext, refreshSessionIdentityState } from '@/lib/server/identity-continuity'
import { syncSessionArchiveMemory } from '@/lib/server/memory/session-archive-memory'
import { evaluateSessionFreshness, resetSessionRuntime, resolveSessionResetPolicy } from '@/lib/server/session-reset-policy'
import { pruneStreamingAssistantArtifacts, upsertStreamingAssistantArtifact } from '@/lib/chat/chat-streaming-state'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { errorMessage as toErrorMessage } from '@/lib/shared-utils'
import { listUniversalToolAccessPluginIds } from '@/lib/server/universal-tool-access'

export {
  shouldApplySessionFreshnessReset,
  shouldAutoRouteHeartbeatAlerts,
  translateRequestedToolInvocation,
  normalizeAssistantArtifactLinks,
  requestedToolNamesFromMessage,
  hasDirectLocalCodingTools,
}

export function buildAgentRuntimeCapabilities(enabledPlugins: string[]): string[] {
  const capabilities = ['heartbeats', 'autonomous_loop', 'multi_agent_chat']
  if (enabledPlugins.length > 0) capabilities.unshift('tools')
  return capabilities
}

export function buildNoToolsGuidance(): string[] {
  return [
    '## Tool Availability',
    'No runtime tools are available in this chat after policy filtering.',
    'Do not imply that a normal read-only action is waiting on user permission when the real blocker is missing tool access.',
    'If browsing, web fetches, file edits, or other actions are unavailable, state that the capability is blocked by runtime policy in this session.',
    'Only mention confirmation or approval when a real runtime tool explicitly returned that boundary for a concrete action.',
  ]
}

export function buildEnabledToolsAutonomyGuidance(): string[] {
  return [
    '## Tool Autonomy',
    'Runtime tools are already available for normal use in this chat.',
    'Do not request that a tool be enabled or switched on before using it.',
    'Do not ask the user for permission before using enabled tools for ordinary read-only work, routine diagnostics, or reversible execution steps that are clearly part of the request.',
    'If the user asks you to use an enabled tool or to perform a task that clearly maps to an enabled tool, attempt that tool path before asking the user to do the work manually.',
    'If the task depends on current or external information and web tools are enabled, use them instead of answering from stale memory.',
    'If the task asks for a file, report, dashboard, JSON, or other workspace artifact to be saved, use file-writing or shell tools to actually create it and mention the resulting path.',
    'If the task asks you to inspect the local repository, runtime, or filesystem state, use shell or file tools instead of guessing.',
    'Treat capability policy blocks and explicit platform feature gates as the real boundaries. Do not invent an approval queue when none exists.',
  ]
}

interface SessionWithCredentials {
  credentialId?: string | null
}

interface ProviderApiKeyConfig {
  requiresApiKey?: boolean
  optionalApiKey?: boolean
}

export interface ExecuteChatTurnInput {
  sessionId: string
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  internal?: boolean
  source?: string
  runId?: string
  signal?: AbortSignal
  onEvent?: (event: SSEEvent) => void
  modelOverride?: string
  heartbeatConfig?: { ackMaxChars: number; showOk: boolean; showAlerts: boolean; target: string | null; lightContext?: boolean }
  replyToId?: string
}

export interface ExecuteChatTurnResult {
  runId?: string
  sessionId: string
  text: string
  persisted: boolean
  toolEvents: MessageToolEvent[]
  error?: string
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
}

function extractEventJson(line: string): SSEEvent | null {
  if (!line.startsWith('data: ')) return null
  try {
    return JSON.parse(line.slice(6).trim()) as SSEEvent
  } catch {
    return null
  }
}

export function collectToolEvent(ev: SSEEvent, bag: MessageToolEvent[]) {
  if (ev.t === 'tool_call') {
    const previous = bag[bag.length - 1]
    if (
      previous
      && previous.name === (ev.toolName || 'unknown')
      && previous.input === (ev.toolInput || '')
      && previous.toolCallId === (ev.toolCallId || previous.toolCallId)
      && !previous.output
    ) {
      return
    }
    bag.push({
      name: ev.toolName || 'unknown',
      input: ev.toolInput || '',
      toolCallId: ev.toolCallId,
    })
    return
  }
  if (ev.t === 'tool_result') {
    const idx = ev.toolCallId
      ? bag.findLastIndex((e) => e.toolCallId === ev.toolCallId && !e.output)
      : bag.findLastIndex((e) => e.name === (ev.toolName || 'unknown') && !e.output)
    if (idx === -1) return
    const output = ev.toolOutput || ''
    bag[idx] = {
      ...bag[idx],
      output,
      error: isLikelyToolErrorOutput(output) || undefined,
    }
  }
}

export function dedupeConsecutiveToolEvents(events: MessageToolEvent[]): MessageToolEvent[] {
  const sameEvent = (left: MessageToolEvent, right: MessageToolEvent): boolean => (
    left.name === right.name
    && left.input === right.input
    && (left.output || '') === (right.output || '')
    && (left.error === true) === (right.error === true)
  )
  const sameBlock = (startA: number, startB: number, size: number): boolean => {
    for (let offset = 0; offset < size; offset += 1) {
      if (!sameEvent(events[startA + offset], events[startB + offset])) return false
    }
    return true
  }

  const deduped: MessageToolEvent[] = []
  for (let index = 0; index < events.length;) {
    const remaining = events.length - index
    let collapsed = false
    for (let blockSize = Math.floor(remaining / 2); blockSize >= 1; blockSize -= 1) {
      if (!sameBlock(index, index + blockSize, blockSize)) continue
      for (let offset = 0; offset < blockSize; offset += 1) deduped.push(events[index + offset])
      const blockStart = index
      index += blockSize
      while (index + blockSize <= events.length && sameBlock(blockStart, index, blockSize)) {
        index += blockSize
      }
      collapsed = true
      break
    }
    if (collapsed) continue
    deduped.push(events[index])
    index += 1
  }
  return deduped
}

export function deriveTerminalRunError(params: {
  errorMessage?: string
  fullResponse: string
  streamErrors: string[]
  toolEvents: MessageToolEvent[]
  internal: boolean
}): string | undefined {
  if (params.errorMessage) return params.errorMessage

  if (params.streamErrors.length > 0 && !params.fullResponse.trim()) {
    return params.streamErrors[params.streamErrors.length - 1]
  }

  if (!params.internal && !params.fullResponse.trim() && params.toolEvents.length === 0) {
    return 'Run completed without any response text, tool calls, or explicit error details. Check the provider configuration and try again.'
  }

  return undefined
}

export function isLikelyToolErrorOutput(output: string): boolean {
  const trimmed = String(output || '').trim()
  if (!trimmed) return false
  if (/^(Error(?::|\s*\(exit\b[^)]*\):?)|error:)/i.test(trimmed)) return true
  if (/\b(MCP error|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION_REFUSED|ENOENT|EACCES)\b/i.test(trimmed)) return true
  if (/\binvalid_type\b/i.test(trimmed) && /\b(issue|issues|expected|required|received|zod)\b/i.test(trimmed)) return true
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const status = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : ''
    if (status === 'error' || status === 'failed') return true
    if (typeof parsed.error === 'string' && parsed.error.trim()) return true
  } catch {
    // Ignore non-JSON tool output.
  }
  return false
}

export function pruneSuppressedHeartbeatStreamMessage(messages: Message[]): boolean {
  return pruneStreamingAssistantArtifacts(messages)
}

function parseToolJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function summarizeConnectorToolFailure(output: string): string {
  const trimmed = output.trim()
  const withoutPrefix = trimmed.replace(/^Error:\s*/i, '')
  const parsed = parseToolJsonObject(withoutPrefix) || parseToolJsonObject(trimmed)
  if (parsed) {
    const detail = parsed.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const detailRecord = detail as Record<string, unknown>
      const message = typeof detailRecord.message === 'string' ? detailRecord.message.trim() : ''
      if (message) return message
      const code = typeof detailRecord.code === 'string' ? detailRecord.code.trim() : ''
      const status = typeof detailRecord.status === 'string' ? detailRecord.status.trim() : ''
      if (code && status) return `${code}: ${status}`
      if (code) return code
      if (status) return status
    }
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
    if (message) return message
    const error = typeof parsed.error === 'string' ? parsed.error.trim() : ''
    if (error) return error
  }
  return withoutPrefix.replace(/\s+/g, ' ').trim() || 'Connector delivery failed.'
}

function connectorToolEventSucceeded(event: MessageToolEvent): boolean {
  if (!event.output) return false
  const parsed = parseToolJsonObject(event.output)
  const status = typeof parsed?.status === 'string' ? parsed.status.trim().toLowerCase() : ''
  return status === 'sent' || status === 'voice_sent' || status === 'scheduled'
}

const POSITIVE_CONNECTOR_DELIVERY_RE = /\b(?:i(?:'ve| have)?(?: successfully)? sent|i sent|successfully sent|sent to your|voice note (?:has been|was) sent|message (?:has been|was) sent)\b/i

export function reconcileConnectorDeliveryText(text: string, events: MessageToolEvent[]): string {
  const trimmed = text.trim()
  if (!trimmed || !POSITIVE_CONNECTOR_DELIVERY_RE.test(trimmed)) return text

  const connectorEvents = dedupeConsecutiveToolEvents(events).filter((event) => event.name === 'connector_message_tool')
  if (connectorEvents.length === 0) return text
  if (connectorEvents.some((event) => connectorToolEventSucceeded(event))) return text

  const latestFailure = [...connectorEvents]
    .reverse()
    .find((event) => event.error === true && typeof event.output === 'string' && event.output.trim())

  const failureSummary = latestFailure?.output
    ? summarizeConnectorToolFailure(latestFailure.output)
    : 'I could not confirm that the connector actually sent anything.'

  return `I couldn't send that through the configured connector. ${failureSummary}`.trim()
}

function syncSessionFromAgent(sessionId: string): void {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session?.agentId) return
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent) return

  let changed = false
  const route = resolvePrimaryAgentRoute(agent, undefined, {
    preferredGatewayTags: session.routePreferredGatewayTags || [],
    preferredGatewayUseCase: session.routePreferredGatewayUseCase || null,
  })
  if (!session.provider && agent.provider) { session.provider = agent.provider; changed = true }
  if ((session.model === undefined || session.model === null || session.model === '') && agent.model !== undefined) {
    session.model = agent.model
    changed = true
  }
  if (route) {
    const resolved = applyResolvedRoute({ ...session }, route)
    if (session.provider !== resolved.provider) { session.provider = resolved.provider; changed = true }
    if (session.model !== resolved.model) { session.model = resolved.model; changed = true }
    if ((session.credentialId || null) !== (resolved.credentialId || null)) {
      session.credentialId = resolved.credentialId ?? null
      changed = true
    }
    if (JSON.stringify(session.fallbackCredentialIds || []) !== JSON.stringify(resolved.fallbackCredentialIds || [])) {
      session.fallbackCredentialIds = [...resolved.fallbackCredentialIds]
      changed = true
    }
    if ((session.apiEndpoint || null) !== (resolved.apiEndpoint || null)) {
      session.apiEndpoint = resolved.apiEndpoint ?? null
      changed = true
    }
    if ((session.gatewayProfileId || null) !== (resolved.gatewayProfileId || null)) {
      session.gatewayProfileId = resolved.gatewayProfileId ?? null
      changed = true
    }
  } else {
    if (session.credentialId === undefined && agent.credentialId !== undefined) {
      session.credentialId = agent.credentialId ?? null
      changed = true
    }
    if ((session.apiEndpoint === undefined || session.apiEndpoint === null) && agent.apiEndpoint !== undefined) {
      const normalized = normalizeProviderEndpoint(agent.provider, agent.apiEndpoint ?? null)
      if (normalized !== session.apiEndpoint) { session.apiEndpoint = normalized; changed = true }
    }
  }
  if (!Array.isArray(session.plugins)) {
    session.plugins = Array.isArray(agent.plugins) ? [...agent.plugins] : []
    changed = true
  }
  const isShortcutChat = session.shortcutForAgentId === agent.id || agent.threadSessionId === sessionId
  if (isShortcutChat) {
    const desiredPlugins = Array.isArray(agent.plugins) ? [...agent.plugins] : []
    const currentPlugins = Array.isArray(session.plugins) ? [...session.plugins] : []
    if (JSON.stringify(currentPlugins) !== JSON.stringify(desiredPlugins)) {
      session.plugins = desiredPlugins
      changed = true
    }
    if (session.shortcutForAgentId !== agent.id) { session.shortcutForAgentId = agent.id; changed = true }
    if (session.name !== agent.name) { session.name = agent.name; changed = true }
    const desiredHeartbeatEnabled = agent.heartbeatEnabled ?? false
    if ((session.heartbeatEnabled ?? false) !== desiredHeartbeatEnabled) {
      session.heartbeatEnabled = desiredHeartbeatEnabled
      changed = true
    }
    const desiredHeartbeatIntervalSec = agent.heartbeatIntervalSec ?? null
    if ((session.heartbeatIntervalSec ?? null) !== desiredHeartbeatIntervalSec) {
      session.heartbeatIntervalSec = desiredHeartbeatIntervalSec
      changed = true
    }
    const desiredMemoryScopeMode = agent.memoryScopeMode ?? null
    if ((((session as unknown as Record<string, unknown>).memoryScopeMode as string | null | undefined) ?? null) !== desiredMemoryScopeMode) {
      ;(session as unknown as Record<string, unknown>).memoryScopeMode = desiredMemoryScopeMode
      changed = true
    }
    const desiredMemoryTierPreference = agent.memoryTierPreference ?? null
    if ((((session as unknown as Record<string, unknown>).memoryTierPreference as string | null | undefined) ?? null) !== desiredMemoryTierPreference) {
      ;(session as unknown as Record<string, unknown>).memoryTierPreference = desiredMemoryTierPreference
      changed = true
    }
    const desiredProjectId = agent.projectId ?? null
    if ((session.projectId ?? null) !== desiredProjectId) {
      session.projectId = desiredProjectId
      changed = true
    }
    const desiredOpenClawAgentId = agent.openclawAgentId ?? null
    if ((session.openclawAgentId ?? null) !== desiredOpenClawAgentId) {
      session.openclawAgentId = desiredOpenClawAgentId
      changed = true
    }
  }

  if (changed) {
    sessions[sessionId] = session
    saveSessions(sessions)
  }
}

/**
 * Build a minimal system prompt for lightweight heartbeat context.
 * Strips conversation history, skills, tool discipline, and workspace context.
 * Keeps identity, datetime, and heartbeat guidance for correct routing.
 */
function buildLightHeartbeatSystemPrompt(session: Session): string | undefined {
  if (!session.agentId) return undefined
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent) return undefined

  const parts: string[] = []
  parts.push(`## Identity\nName: ${agent.name}`)
  if (agent.description) parts.push(`Description: ${agent.description}`)
  parts.push(buildCurrentDateTimePromptContext())
  if (agent.soul) parts.push(`## Soul\n${agent.soul.slice(0, 300)}`)
  parts.push([
    '## Heartbeats',
    'You run on an autonomous heartbeat. If you receive a heartbeat poll and nothing needs attention, reply exactly: HEARTBEAT_OK',
  ].join('\n'))
  return parts.join('\n\n')
}

function buildAgentSystemPrompt(session: Session): string | undefined {
  if (!session.agentId) return undefined
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent) return undefined

  const settings = loadSettings()
  const parts: string[] = []
  const enabledPlugins = listUniversalToolAccessPluginIds(
    Array.isArray(session.plugins) ? session.plugins : (Array.isArray(agent.plugins) ? agent.plugins : []),
  )

  // 1. Identity & Persona
  const identityLines = [`## My Identity`]
  identityLines.push(`Name: ${agent.name}`)
  if (agent.emoji) identityLines.push(`Emoji: ${agent.emoji}`)
  if (agent.creature) identityLines.push(`Creature: ${agent.creature}`)
  if (agent.vibe) identityLines.push(`Vibe: ${agent.vibe}`)
  if (agent.theme) identityLines.push(`Theme: ${agent.theme}`)
  if (agent.description) identityLines.push(`Description: ${agent.description}`)
  identityLines.push('I should always embody this identity. I am not just an "Assistant" — I am a persistent companion with my own soul and presence.')
  parts.push(identityLines.join('\n'))
  const continuityBlock = buildIdentityContinuityContext(session, agent)
  if (continuityBlock) parts.push(continuityBlock)

  // 2. Runtime & Capabilities
  const runtimeLines = [
    '## Runtime',
    `os=${process.platform} | host=${os.hostname()} | agent=${agent.id} | provider=${agent.provider} | model=${agent.model}`,
    `capabilities=${buildAgentRuntimeCapabilities(enabledPlugins).join(',')}`,
    'tool_access=universal',
  ]
  parts.push(runtimeLines.join('\n'))

  // 3. User & DateTime Context
  if (settings.userPrompt) parts.push(`## User Instructions\n${settings.userPrompt}`)
  parts.push(buildCurrentDateTimePromptContext())

  // 4. Soul & Core Instructions
  if (agent.soul) parts.push(`## Soul\n${agent.soul}`)
  if (agent.systemPrompt) parts.push(`## System Prompt\n${agent.systemPrompt}`)

  // 5. Skills (SwarmClaw Core)
  if (agent.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of agent.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) parts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }

  // 5b. Workspace context files (HEARTBEAT.md, IDENTITY.md, AGENTS.md, etc.)
  try {
    const wsCtx = buildWorkspaceContext({ cwd: session.cwd })
    if (wsCtx.block) parts.push(wsCtx.block)
  } catch {
    // Workspace context is non-critical
  }

  // 6. Thinking & Output Format
  const thinkingHint = [
    '## Output Format',
    'If your model supports internal reasoning/thinking, put all internal analysis inside <think>...</think> tags.',
    'Your final response to the user should be clear and concise.',
    'When you have nothing to say, respond with ONLY: NO_MESSAGE',
  ]
  parts.push(thinkingHint.join('\n'))

  if (enabledPlugins.length === 0) {
    parts.push(buildNoToolsGuidance().join('\n'))
  } else {
    parts.push(buildEnabledToolsAutonomyGuidance().join('\n'))
  }
  const toolAvailabilityLines = buildToolAvailabilityLines(enabledPlugins)
  if (toolAvailabilityLines.length > 0) parts.push(['## Tool Availability', ...toolAvailabilityLines].join('\n'))
  const toolDisciplineLines = buildToolDisciplineLines(enabledPlugins)
  if (toolDisciplineLines.length > 0) parts.push(['## Tool Discipline', ...toolDisciplineLines].join('\n'))
  const operatingGuidance = getPluginManager().collectOperatingGuidance(enabledPlugins)
  if (operatingGuidance.length > 0) parts.push(['## Tool Guidance', ...operatingGuidance].join('\n'))
  const capabilityLines = getPluginManager().collectCapabilityDescriptions(enabledPlugins)
  if (capabilityLines.length > 0) parts.push(['## Tool Capabilities', ...capabilityLines].join('\n'))

  // 7. Heartbeat Guidance
  parts.push([
    '## Heartbeats',
    'You run on an autonomous heartbeat. If you receive a heartbeat poll and nothing needs attention, reply exactly: HEARTBEAT_OK',
  ].join('\n'))

  return parts.join('\n\n')
}

function resolveApiKeyForSession(session: SessionWithCredentials, provider: ProviderApiKeyConfig): string | null {
  if (provider.requiresApiKey) {
    if (!session.credentialId) throw new Error('No API key configured for this session')
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (!cred) throw new Error('API key not found. Please add one in Settings.')
    return decryptKey(cred.encryptedKey)
  }
  if (provider.optionalApiKey && session.credentialId) {
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (cred) {
      try { return decryptKey(cred.encryptedKey) } catch { return null }
    }
  }
  return null
}


export async function executeSessionChatTurn(input: ExecuteChatTurnInput): Promise<ExecuteChatTurnResult> {
  const { message } = input
  const {
    sessionId,
    imagePath,
    imageUrl,
    attachedFiles,
    internal = false,
    runId,
    source = 'chat',
    onEvent,
    signal,
  } = input

  // Resolve image path early: if the filesystem path is gone, fall back to
  // the upload URL which resolveImagePath maps back to the uploads directory.
  const resolvedImagePath = resolveImagePath(imagePath, imageUrl) ?? undefined

  const endTurnPerf = perf.start('chat-execution', 'executeSessionChatTurn', { sessionId, source })

  syncSessionFromAgent(sessionId)

  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  session.messages = Array.isArray(session.messages) ? session.messages : []
  const runStartedAt = Date.now()
  const runMessageStartIndex = session.messages.length

  const appSettings = loadSettings()
  const agentForSession = session.agentId ? loadAgents()[session.agentId] : null
  if (isAgentDisabled(agentForSession)) {
    const disabledError = buildAgentDisabledMessage(agentForSession, 'run chats')
    onEvent?.({ t: 'err', text: disabledError })

    let persisted = false
    if (!internal) {
      session.messages.push({
        role: 'assistant',
        text: disabledError,
        time: Date.now(),
      })
      session.lastActiveAt = Date.now()
      saveSessions(sessions)
      persisted = true
    }

    return {
      runId,
      sessionId,
      text: disabledError,
      persisted,
      toolEvents: [],
      error: disabledError,
    }
  }
  const toolPolicy = resolveSessionToolPolicy(
    listUniversalToolAccessPluginIds(session.plugins),
    appSettings,
  )
  const isHeartbeatRun = isInternalHeartbeatRun(internal, source)
  const isAutonomousInternalRun = internal && source !== 'chat'
  const heartbeatLightContext = isHeartbeatRun && !!input.heartbeatConfig?.lightContext
  const isAutoRunNoHistory = isHeartbeatRun
  const heartbeatStatusOnly = false
  if (shouldApplySessionFreshnessReset(source)) {
    const freshness = evaluateSessionFreshness({
      session,
      policy: resolveSessionResetPolicy({
        session,
        agent: agentForSession,
        settings: appSettings,
      }),
    })
    if (!freshness.fresh) {
      try { syncSessionArchiveMemory(session, { agent: agentForSession }) } catch { /* archive sync is best-effort */ }
      resetSessionRuntime(session, freshness.reason || 'session_reset')
      onEvent?.({ t: 'status', text: JSON.stringify({ sessionReset: freshness.reason || 'session_reset' }) })
      sessions[sessionId] = session
      saveSessions(sessions)
    }
  }
  if (isAutonomousInternalRun) {
    try { syncSessionArchiveMemory(session, { agent: agentForSession }) } catch { /* archive sync is best-effort */ }
  }
  const pluginsForRun = heartbeatStatusOnly ? [] : toolPolicy.enabledPlugins
  let sessionForRun = pluginsForRun === session.plugins
    ? session
    : { ...session, plugins: pluginsForRun }
  if (agentForSession) {
    const preferredRoute = resolvePrimaryAgentRoute(agentForSession, undefined, {
      preferredGatewayTags: session.routePreferredGatewayTags || [],
      preferredGatewayUseCase: session.routePreferredGatewayUseCase || null,
    })
    if (preferredRoute) {
      sessionForRun = applyResolvedRoute({ ...sessionForRun }, preferredRoute)
    }
  }
  let effectiveMessage = message

  if (pluginsForRun.length > 0) {
    try {
      effectiveMessage = await getPluginManager().transformText(
        'transformInboundMessage',
        { session: sessionForRun, text: message },
        { enabledIds: pluginsForRun },
      )
    } catch {
      effectiveMessage = message
    }
  }

  // Apply model override for heartbeat runs (cheaper model)
  if (isHeartbeatRun && input.modelOverride) {
    sessionForRun = { ...sessionForRun, model: input.modelOverride }
  }

  if (!heartbeatStatusOnly && toolPolicy.blockedPlugins.length > 0) {
    const blockedSummary = toolPolicy.blockedPlugins
      .map((entry) => `${entry.tool} (${entry.reason})`)
      .join(', ')
    onEvent?.({ t: 'err', text: `Capability policy blocked plugins for this run: ${blockedSummary}` })
  }

  // --- Agent spend-limit enforcement (hourly/daily/monthly) ---
  if (session.agentId) {
    const agentsMap = loadAgents()
    const agent = agentsMap[session.agentId]
    if (agent) {
      const budgetCheck = checkAgentBudgetLimits(agent)
      const action = agent.budgetAction || 'warn'

      if (budgetCheck.exceeded.length > 0) {
        const budgetError = budgetCheck.exceeded.map((entry) => entry.message).join(' ')
        if (action === 'block') {
          onEvent?.({ t: 'err', text: budgetError })

          let persisted = false
          if (!internal) {
            session.messages.push({
              role: 'assistant',
              text: budgetError,
              time: Date.now(),
            })
            session.lastActiveAt = Date.now()
            saveSessions(sessions)
            persisted = true
          }

          return {
            runId,
            sessionId,
            text: budgetError,
            persisted,
            toolEvents: [],
            error: budgetError,
          }
        }
        // budgetAction === 'warn': emit a warning but continue
        onEvent?.({ t: 'status', text: JSON.stringify({ budgetWarning: budgetError }) })
      } else if (budgetCheck.warnings.length > 0) {
        const warningText = budgetCheck.warnings.map((entry) => entry.message).join(' ')
        onEvent?.({ t: 'status', text: JSON.stringify({ budgetWarning: warningText }) })
      }
    }
  }

  const dailySpendLimitUsd = parseUsdLimit(appSettings.safetyMaxDailySpendUsd)
  if (dailySpendLimitUsd !== null) {
    const todaySpendUsd = getTodaySpendUsd()
    if (todaySpendUsd >= dailySpendLimitUsd) {
      const spendError = `Safety budget reached: today's spend is $${todaySpendUsd.toFixed(4)} (limit $${dailySpendLimitUsd.toFixed(4)}). Increase safetyMaxDailySpendUsd to continue autonomous runs.`
      onEvent?.({ t: 'err', text: spendError })

      let persisted = false
      if (!internal) {
        session.messages.push({
          role: 'assistant',
          text: spendError,
          time: Date.now(),
        })
        session.lastActiveAt = Date.now()
        saveSessions(sessions)
        persisted = true
      }

      return {
        runId,
        sessionId,
        text: spendError,
        persisted,
        toolEvents: [],
        error: spendError,
      }
    }
  }

  // Log the trigger
  logExecution(sessionId, 'trigger', `${source} message received`, {
    runId,
    agentId: session.agentId,
    detail: {
      source,
      internal,
      provider: sessionForRun.provider,
      model: sessionForRun.model,
      messagePreview: effectiveMessage.slice(0, 200),
      hasImage: !!(imagePath || imageUrl),
    },
  })

  const providerType = sessionForRun.provider || 'claude-cli'
  const provider = getProvider(providerType)
  if (!provider) throw new Error(`Unknown provider: ${providerType}`)

  if (providerType === 'claude-cli' && !fs.existsSync(session.cwd)) {
    throw new Error(`Directory not found: ${session.cwd}`)
  }

  const apiKey = resolveApiKeyForSession(sessionForRun, provider)

  const shouldPersistUserMessage = shouldPersistInboundUserMessage(internal, source)
  if (shouldPersistUserMessage) {
    const linkAnalysis = !internal ? await runLinkUnderstanding(message) : []
    const nextUserMessage: Message = {
      role: 'user',
      text: message,
      time: Date.now(),
      imagePath: imagePath || undefined,
      imageUrl: imageUrl || undefined,
      attachedFiles: attachedFiles?.length ? attachedFiles : undefined,
      replyToId: input.replyToId || undefined,
    }
    session.messages.push(nextUserMessage)
    if (linkAnalysis.length > 0) {
      session.messages.push({
        role: 'assistant',
        kind: 'system',
        text: `[Automated Link Analysis]\n${linkAnalysis.join('\n\n')}`,
        time: Date.now(),
      })
    }
    session.lastActiveAt = Date.now()
    saveSessions(sessions)
    if (!internal) {
      try {
        await getPluginManager().runHook('onMessage', { session, message: nextUserMessage }, { enabledIds: pluginsForRun })
      } catch { /* onMessage hooks are non-critical */ }
    }
  }

  // Determine plugin/LangGraph path early so we can skip the redundant system prompt.
  // Dependencies: providerType (line 750), sessionForRun (line 625), isLocalOpenClawEndpoint (import).
  const useLocalOpenClawNativeRuntime = providerType === 'openclaw' && isLocalOpenClawEndpoint(sessionForRun.apiEndpoint)
  const enabledSessionPlugins = Array.isArray(sessionForRun.plugins)
    ? sessionForRun.plugins
    : (Array.isArray(sessionForRun.tools) ? sessionForRun.tools : [])
  const hasPlugins = enabledSessionPlugins.length > 0
    && !NON_LANGGRAPH_PROVIDER_IDS.has(providerType)
    && !useLocalOpenClawNativeRuntime

  // When using LangGraph (hasPlugins), streamAgentChatCore builds the full prompt
  // including identity, soul, skills, tool discipline, and execution policy.
  // Only build the standalone system prompt for the direct-provider (no LangGraph) path
  // to avoid duplicating tool discipline, operating guidance, and capability sections.
  // lightContext mode uses a minimal prompt for both paths to reduce token cost.
  const systemPrompt = heartbeatLightContext
    ? buildLightHeartbeatSystemPrompt(session)
    : (hasPlugins ? undefined : buildAgentSystemPrompt(session))
  const toolEvents: MessageToolEvent[] = []
  const streamErrors: string[] = []
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }

  let thinkingText = ''
  let streamingPartialText = ''
  let lastPartialSaveAt = 0
  let lastPartialSnapshotKey = ''
  let partialSaveTimeout: ReturnType<typeof setTimeout> | null = null
  let partialPersistenceClosed = false

  const stopPartialAssistantPersistence = () => {
    partialPersistenceClosed = true
    if (partialSaveTimeout) {
      clearTimeout(partialSaveTimeout)
      partialSaveTimeout = null
    }
  }

  const persistStreamingAssistantArtifact = () => {
    partialSaveTimeout = null
    if (partialPersistenceClosed) return
    const persistedToolEvents = toolEvents.length ? dedupeConsecutiveToolEvents([...toolEvents]) : []
    if (!hasPersistableAssistantPayload(streamingPartialText, thinkingText, persistedToolEvents)) return

    const snapshotKey = JSON.stringify([
      streamingPartialText,
      thinkingText,
      getToolEventsSnapshotKey(persistedToolEvents),
    ])
    if (snapshotKey === lastPartialSnapshotKey) return

    lastPartialSnapshotKey = snapshotKey
    lastPartialSaveAt = Date.now()

    try {
      const fresh = loadSessions()
      const current = fresh[sessionId]
      if (!current) return
      current.messages = Array.isArray(current.messages) ? current.messages : []
      const partialMsg: Message = {
        role: 'assistant',
        text: streamingPartialText,
        time: Date.now(),
        streaming: true,
        thinking: thinkingText || undefined,
        toolEvents: persistedToolEvents.length ? persistedToolEvents : undefined,
      }
      upsertStreamingAssistantArtifact(current.messages, partialMsg, {
        minIndex: runMessageStartIndex,
        minTime: runStartedAt,
      })
      fresh[sessionId] = current
      saveSessions(fresh)
      notify(`messages:${sessionId}`)
    } catch { /* partial save is best-effort */ }
  }

  const queuePartialAssistantPersist = (immediate = false) => {
    if (partialPersistenceClosed) return
    const now = Date.now()
    const minIntervalMs = 400
    if (immediate || now - lastPartialSaveAt >= minIntervalMs) {
      if (partialSaveTimeout) {
        clearTimeout(partialSaveTimeout)
        partialSaveTimeout = null
      }
      persistStreamingAssistantArtifact()
      return
    }
    if (partialSaveTimeout) return
    partialSaveTimeout = setTimeout(() => {
      persistStreamingAssistantArtifact()
    }, minIntervalMs - (now - lastPartialSaveAt))
  }

  const emit = (ev: SSEEvent) => {
    let shouldPersistPartial = false
    let immediatePartialPersist = false
    if (ev.t === 'd' && typeof ev.text === 'string') {
      streamingPartialText += ev.text
      shouldPersistPartial = true
      immediatePartialPersist = streamingPartialText.length === ev.text.length
    }
    if (ev.t === 'err' && typeof ev.text === 'string') {
      const trimmed = ev.text.trim()
      if (trimmed) {
        streamErrors.push(trimmed)
        if (streamErrors.length > 8) streamErrors.shift()
      }
    }
    if (ev.t === 'thinking' && ev.text) {
      thinkingText += ev.text
      shouldPersistPartial = true
    }
    if (ev.t === 'md' && ev.text) {
      try {
        const mdPayload = JSON.parse(ev.text) as Record<string, unknown>
        const usage = mdPayload.usage as { inputTokens?: number; outputTokens?: number; estimatedCost?: number } | undefined
        if (usage) {
          if (typeof usage.inputTokens === 'number') accumulatedUsage.inputTokens += usage.inputTokens
          if (typeof usage.outputTokens === 'number') accumulatedUsage.outputTokens += usage.outputTokens
          if (typeof usage.estimatedCost === 'number') accumulatedUsage.estimatedCost += usage.estimatedCost
        }
      } catch { /* ignore non-JSON md events */ }
    }
    collectToolEvent(ev, toolEvents)
    if (ev.t === 'tool_call' || ev.t === 'tool_result') {
      shouldPersistPartial = true
      immediatePartialPersist = true
    }
    if (shouldPersistPartial) queuePartialAssistantPersist(immediatePartialPersist)
    onEvent?.(ev)
  }

  // Periodic partial save so a browser refresh doesn't lose the in-flight response.
  const PARTIAL_SAVE_INTERVAL_MS = 3500
  const partialSaveTimer = setInterval(() => {
    persistStreamingAssistantArtifact()
  }, PARTIAL_SAVE_INTERVAL_MS)

  const parseAndEmit = (raw: string) => {
    const lines = raw.split('\n').filter(Boolean)
    for (const line of lines) {
      const ev = extractEventJson(line)
      if (ev) emit(ev)
    }
  }

  let fullResponse = ''
  let errorMessage: string | undefined

  const abortController = new AbortController()
  const abortFromOutside = () => abortController.abort()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', abortFromOutside)
  }

  active.set(sessionId, {
    runId: runId || null,
    source,
    kill: () => abortController.abort(),
  })

  // Capture provider-reported usage for the direct (non-tools) path.
  // Uses a mutable object because TS can't track callback mutations on plain variables.
  const directUsage = { inputTokens: 0, outputTokens: 0, received: false }
  const responseCacheConfig = resolveLlmResponseCacheConfig(appSettings)
  let responseCacheHit = false
  let responseCacheInput: LlmResponseCacheKeyInput | null = null
  let durationMs = 0
  const startTs = Date.now()
  const endLlmPerf = perf.start('chat-execution', 'llm-round-trip', {
    sessionId,
    provider: providerType,
    hasPlugins,
    pluginCount: enabledSessionPlugins.length,
  })
  try {
    // Heartbeat runs get a small tail of recent messages so the agent can see
    // prior findings and avoid repeating the same searches. Full history is
    // skipped to avoid blowing the context window on long-lived sessions.
    // lightContext mode skips history entirely for maximum token savings.
    const heartbeatHistory = isAutoRunNoHistory
      ? (heartbeatLightContext ? [] : getSessionMessages(sessionId).slice(-6))
      : undefined

    console.log(`[chat-execution] provider=${providerType}, hasPlugins=${hasPlugins}, localOpenClawNative=${useLocalOpenClawNativeRuntime}, imagePath=${resolvedImagePath || 'none'}, attachedFiles=${attachedFiles?.length || 0}, plugins=${enabledSessionPlugins.length}`)
    if (hasPlugins) {
      const result = await streamAgentChat({
        session: sessionForRun,
        message: effectiveMessage,
        imagePath: resolvedImagePath,
        imageUrl,
        attachedFiles,
        apiKey,
        systemPrompt,
        write: (raw) => parseAndEmit(raw),
        history: heartbeatHistory ?? applyContextClearBoundary(getSessionMessages(sessionId)),
        signal: abortController.signal,
      })
      fullResponse = result.finalResponse || result.fullText
    } else {
      const directHistorySnapshot = isAutoRunNoHistory
        ? (heartbeatLightContext ? [] : getSessionMessages(sessionId).slice(-6))
        : applyContextClearBoundary(getSessionMessages(sessionId))
      responseCacheInput = {
        provider: providerType,
        model: sessionForRun.model,
        apiEndpoint: sessionForRun.apiEndpoint || '',
        systemPrompt,
        message: effectiveMessage,
        imagePath,
        imageUrl,
        attachedFiles,
        history: directHistorySnapshot,
      }
      const canUseResponseCache = !internal && responseCacheConfig.enabled
      const cached = canUseResponseCache
        ? getCachedLlmResponse(responseCacheInput, responseCacheConfig)
        : null
      if (cached) {
        responseCacheHit = true
        fullResponse = cached.text
        emit({
          t: 'md',
          text: JSON.stringify({
            cache: {
              hit: true,
              ageMs: cached.ageMs,
              provider: cached.provider,
              model: cached.model,
            },
          }),
        })
        emit({ t: 'd', text: cached.text })
      } else {
        fullResponse = await provider.handler.streamChat({
          session: sessionForRun,
          message: effectiveMessage,
          imagePath: resolvedImagePath,
          apiKey,
          systemPrompt,
          write: (raw: string) => parseAndEmit(raw),
          active,
          loadHistory: (sid: string) => {
            if (sid === sessionId) return directHistorySnapshot
            return isAutoRunNoHistory
              ? getSessionMessages(sid).slice(-6)
              : applyContextClearBoundary(getSessionMessages(sid))
          },
          onUsage: (u) => { directUsage.inputTokens = u.inputTokens; directUsage.outputTokens = u.outputTokens; directUsage.received = true },
          signal: abortController.signal,
        })
        if (canUseResponseCache && responseCacheInput && fullResponse) {
          setCachedLlmResponse(responseCacheInput, fullResponse, responseCacheConfig)
        }
      }
    }
    durationMs = Date.now() - startTs
    endLlmPerf({ durationMs, cacheHit: responseCacheHit })
  } catch (err: unknown) {
    endLlmPerf({ error: true })
    errorMessage = toErrorMessage(err)
    const failureText = errorMessage || 'Run failed.'
    markProviderFailure(providerType, failureText)
    emit({ t: 'err', text: failureText })
    log.error('chat-run', `Run failed for session ${sessionId}`, {
      runId,
      source,
      internal,
      error: failureText,
    })
  } finally {
    clearInterval(partialSaveTimer)
    stopPartialAssistantPersistence()
    active.delete(sessionId)
    notify('sessions')
    if (signal) signal.removeEventListener('abort', abortFromOutside)
  }

  if (!errorMessage) {
    markProviderSuccess(providerType)
  }

  // Record usage for the direct (non-tools) streamChat path.
  // streamAgentChat already calls appendUsage internally for the tools path.
  if (!hasPlugins && fullResponse && !errorMessage && !responseCacheHit) {
    const inputTokens = directUsage.received ? directUsage.inputTokens : Math.ceil(message.length / 4)
    const outputTokens = directUsage.received ? directUsage.outputTokens : Math.ceil(fullResponse.length / 4)
    const totalTokens = inputTokens + outputTokens
    if (totalTokens > 0) {
      const cost = estimateCost(sessionForRun.model, inputTokens, outputTokens)
      const history = getSessionMessages(sessionId)
      const usageRecord: UsageRecord = {
        sessionId,
        messageIndex: history.length,
        model: sessionForRun.model,
        provider: providerType,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost: cost,
        timestamp: Date.now(),
        durationMs,
      }
      appendUsage(sessionId, usageRecord)
      emit({
        t: 'md',
        text: JSON.stringify({ usage: { inputTokens, outputTokens, totalTokens, estimatedCost: cost } }),
      })
    }
  }

  const endPostProcessPerf = perf.start('chat-execution', 'post-process', { sessionId })
  const toolRoutingResult = await runPostLlmToolRouting({
    session: sessionForRun,
    sessionId,
    message,
    effectiveMessage,
    enabledPlugins: pluginsForRun,
    toolPolicy,
    appSettings,
    internal,
    source,
    toolEvents,
    emit,
  }, fullResponse, errorMessage)

  fullResponse = toolRoutingResult.fullResponse
  errorMessage = toolRoutingResult.errorMessage

  if (toolRoutingResult.missedRequestedTools.length > 0) {
    const notice = `Tool execution notice: requested tool(s) ${toolRoutingResult.missedRequestedTools.join(', ')} were not actually invoked in this run.`
    emit({ t: 'err', text: notice })
    if (!fullResponse.includes('Tool execution notice:')) {
      const trimmedResponse = (fullResponse || '').trim()
      fullResponse = trimmedResponse
        ? `${trimmedResponse}\n\n${notice}`
        : notice
    }
  }

  const terminalError = deriveTerminalRunError({
    errorMessage,
    fullResponse: fullResponse || '',
    streamErrors,
    toolEvents,
    internal,
  })
  if (terminalError && terminalError !== errorMessage) {
    if (!errorMessage) {
      log.warn('chat-run', `Run ended without a visible response for session ${sessionId}`, {
        runId,
        source,
        internal,
        provider: providerType,
        messagePreview: effectiveMessage.slice(0, 200),
        inferredError: terminalError,
      })
    }
    errorMessage = terminalError
  }

  const persistedToolEvents = dedupeConsecutiveToolEvents(toolEvents)
  let finalText = (fullResponse || '').trim() || (!internal && errorMessage ? `Error: ${errorMessage}` : '')
  if (pluginsForRun.length > 0 && finalText && !isHeartbeatRun) {
    try {
      finalText = await getPluginManager().transformText(
        'transformOutboundMessage',
        { session: sessionForRun, text: finalText },
        { enabledIds: pluginsForRun },
      )
    } catch { /* outbound transforms are non-critical */ }
  }
  finalText = reconcileConnectorDeliveryText(finalText, persistedToolEvents)
  finalText = normalizeAssistantArtifactLinks(finalText, session.cwd)
  const rawTextForPersistence = stripMainLoopMetaForPersistence(finalText)
  const hiddenControlOnly = shouldSuppressHiddenControlText(rawTextForPersistence)
  const textForPersistence = stripHiddenControlTokens(rawTextForPersistence)
  const persistedText = getPersistedAssistantText(textForPersistence, persistedToolEvents)

  if (isHeartbeatRun && rawTextForPersistence) {
    const heartbeatStatus = extractHeartbeatStatus(rawTextForPersistence)
    if (heartbeatStatus) emit({ t: 'status', text: JSON.stringify(heartbeatStatus) })
  }

  // HEARTBEAT_OK suppression
  const heartbeatConfig = input.heartbeatConfig
  let heartbeatClassification: 'suppress' | 'strip' | 'keep' | null = null
  if (isHeartbeatRun && rawTextForPersistence.length > 0) {
    heartbeatClassification = classifyHeartbeatResponse(rawTextForPersistence, heartbeatConfig?.ackMaxChars ?? 300, toolEvents.length > 0)

    // Deduplication logic (nagging prevention)
    // If the model repeats itself exactly within 24h, suppress the heartbeat alert.
    if (heartbeatClassification !== 'suppress' && !toolEvents.length) {
      const prevText = session.lastHeartbeatText || ''
      const prevSentAt = session.lastHeartbeatSentAt || 0
      const isDuplicate = prevText.trim() === persistedText.trim()
        && (Date.now() - prevSentAt) < 24 * 60 * 60 * 1000
      if (isDuplicate) {
        heartbeatClassification = 'suppress'
        log.info('heartbeat', `Duplicate heartbeat suppressed for session ${sessionId} (same text within 24h)`)
      }
    }
  }

  // Emit WS notification for every heartbeat completion so UI can show pulse
  if (isHeartbeatRun && session.agentId) {
    notify(`heartbeat:agent:${session.agentId}`)
  }

  const shouldPersistAssistant = !hiddenControlOnly
    && hasPersistableAssistantPayload(persistedText, thinkingText, persistedToolEvents)
    && heartbeatClassification !== 'suppress'

  const normalizeResumeId = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null

  const fresh = loadSessions()
  const current = fresh[sessionId]
  if (current) {
    current.messages = Array.isArray(current.messages) ? current.messages : []
    const currentAgent = current.agentId ? loadAgents()[current.agentId] : null
    pruneStreamingAssistantArtifacts(current.messages, {
      minIndex: runMessageStartIndex,
      minTime: runStartedAt,
    })
    const persistField = (key: string, value: unknown) => {
      const normalized = normalizeResumeId(value)
      if ((current as Record<string, unknown>)[key] !== normalized) {
        ;(current as Record<string, unknown>)[key] = normalized
      }
    }

    persistField('claudeSessionId', session.claudeSessionId)
    persistField('codexThreadId', session.codexThreadId)
    persistField('opencodeSessionId', session.opencodeSessionId)

    const sourceResume = session.delegateResumeIds
    if (sourceResume && typeof sourceResume === 'object') {
      const currentResume = (current.delegateResumeIds && typeof current.delegateResumeIds === 'object')
        ? current.delegateResumeIds
        : {}
      const sr = sourceResume as Record<string, unknown>
      const cr = currentResume as Record<string, unknown>
      const nextResume = {
        claudeCode: normalizeResumeId(sr.claudeCode ?? cr.claudeCode),
        codex: normalizeResumeId(sr.codex ?? cr.codex),
        opencode: normalizeResumeId(sr.opencode ?? cr.opencode),
        gemini: normalizeResumeId(sr.gemini ?? cr.gemini),
      }
      if (JSON.stringify(currentResume) !== JSON.stringify(nextResume)) {
        current.delegateResumeIds = nextResume
      }
    }

    if (shouldPersistAssistant) {
      const persistedKind = isHeartbeatRun ? 'heartbeat' : 'chat'
      const nowTs = Date.now()
      const nextAssistantMessage: Message = {
        role: 'assistant',
        text: persistedText,
        time: nowTs,
        thinking: thinkingText || undefined,
        toolEvents: persistedToolEvents.length ? persistedToolEvents : undefined,
        kind: persistedKind,
      }
      const previous = current.messages.at(-1)
      if (previous?.streaming || shouldReplaceRecentAssistantMessage({
        previous,
        nextToolEvents: persistedToolEvents,
        nextKind: persistedKind,
        now: nowTs,
      })) {
        current.messages[current.messages.length - 1] = nextAssistantMessage
      } else {
        current.messages.push(nextAssistantMessage)
      }
      if (isHeartbeatRun) {
        current.lastHeartbeatText = persistedText
        current.lastHeartbeatSentAt = nowTs
      }
      try {
        await getPluginManager().runHook('onMessage', { session: current, message: nextAssistantMessage }, { enabledIds: pluginsForRun })
      } catch { /* onMessage hooks are non-critical */ }

      // Conversation tone detection
      if (!internal) {
        const tone = estimateConversationTone(persistedText)
        if (tone !== current.conversationTone) {
          current.conversationTone = tone
        }
      }

      // Target routing for non-suppressed heartbeat alerts
      if (isHeartbeatRun && heartbeatConfig?.target && heartbeatConfig.target !== 'none' && heartbeatConfig.showAlerts !== false) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { listRunningConnectors, sendConnectorMessage } = require('../connectors/manager')
          let connectorId: string | undefined
          let channelId: string | undefined
          if (heartbeatConfig.target === 'last') {
            const running = listRunningConnectors()
            const first = running.find((c: { recentChannelId?: string }) => c.recentChannelId)
            if (first) {
              connectorId = first.id
              channelId = first.recentChannelId
            }
          } else if (heartbeatConfig.target.includes(':')) {
            const [cId, chId] = heartbeatConfig.target.split(':', 2)
            connectorId = cId
            channelId = chId
          } else {
            channelId = heartbeatConfig.target
          }
          if (channelId) {
            sendConnectorMessage({ connectorId, channelId, text: persistedText }).catch(() => {})
          }
        } catch {
          // Best effort — connector manager may not be loaded
        }
      }

      // Auto-discover connectors linked to this agent when no explicit target is set
      // Skip if a real inbound message was handled recently — the agent just responded to it
      if (isHeartbeatRun && !heartbeatConfig?.target && heartbeatConfig?.showAlerts !== false && session.agentId) {
        const recentInbound = session.connectorContext?.lastInboundAt
          && (Date.now() - session.connectorContext.lastInboundAt) < 60_000
        if (!recentInbound) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { listRunningConnectors: listRunning, sendConnectorMessage: sendMsg } = require('../connectors/manager')
            const agentConnectors = listRunning().filter((c: { agentId: string | null; recentChannelId: string | null; supportsSend: boolean }) =>
              c.agentId === session.agentId && c.recentChannelId && c.supportsSend
            )
            for (const conn of agentConnectors) {
              sendMsg({ connectorId: conn.id, channelId: conn.recentChannelId, text: persistedText }).catch(() => {})
            }
          } catch {
            // Best effort — connector manager may not be loaded
          }
        }
      }
    }
    if (isHeartbeatRun && heartbeatClassification === 'suppress') {
      pruneSuppressedHeartbeatStreamMessage(current.messages)
    }

    // P1: Prune old heartbeat messages to prevent context bloat.
    // Long-running agents accumulate ~48 no-op messages/day; keep only the most recent 2.
    if (isHeartbeatRun) {
      const pruned = pruneOldHeartbeatMessages(current.messages)
      if (pruned > 0) {
        log.info('heartbeat', `Pruned ${pruned} old heartbeat message(s) from session ${sessionId}`)
      }
    }

    // Fire afterChatTurn hook for all enabled plugins (memory auto-save, logging, etc.)
    try {
      await getPluginManager().runHook('afterChatTurn', {
        session: current,
        message,
        response: textForPersistence,
        source,
        internal,
        toolEvents: persistedToolEvents,
      }, { enabledIds: pluginsForRun })
    } catch { /* afterChatTurn hooks are non-critical */ }

    // Don't extend idle timeout for heartbeat runs — only user-initiated activity counts
    if (!isHeartbeatSource(source)) {
      current.lastActiveAt = Date.now()
    }

    refreshSessionIdentityState(current, currentAgent)
    try {
      syncSessionArchiveMemory(current, { agent: currentAgent })
    } catch { /* archive sync is best-effort */ }
    fresh[sessionId] = current
    saveSessions(fresh)
    notify(`messages:${sessionId}`)
  }

  endPostProcessPerf({ toolEventCount: persistedToolEvents.length })
  endTurnPerf({
    durationMs,
    toolEventCount: persistedToolEvents.length,
    inputTokens: accumulatedUsage.inputTokens || 0,
    outputTokens: accumulatedUsage.outputTokens || 0,
    error: !!errorMessage,
  })

  return {
    runId,
    sessionId,
    text: hiddenControlOnly ? '' : textForPersistence,
    persisted: shouldPersistAssistant,
    toolEvents: persistedToolEvents,
    error: errorMessage,
    inputTokens: accumulatedUsage.inputTokens || undefined,
    outputTokens: accumulatedUsage.outputTokens || undefined,
    estimatedCost: accumulatedUsage.estimatedCost || undefined,
  }
}
