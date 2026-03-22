import fs from 'fs'
import os from 'os'

import { getProvider } from '@/lib/providers'
import type { ExecutionBrief, Message, Session } from '@/types'
import {
  decryptKey,
  loadCredentials,
} from '@/lib/server/credentials/credential-repository'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { getSession, saveSession } from '@/lib/server/sessions/session-repository'
import { getMessages, getMessageCount, appendMessage } from '@/lib/server/messages/message-repository'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { loadSkills } from '@/lib/server/skills/skill-repository'
import { resolveImagePath } from '@/lib/server/resolve-image'
import { resolveSessionToolPolicy } from '@/lib/server/tool-capability-policy'
import { listUniversalToolAccessExtensionIds } from '@/lib/server/universal-tool-access'
import {
  buildAgentDisabledMessage,
  isAgentDisabled,
} from '@/lib/server/agents/agent-availability'
import { buildCurrentDateTimePromptContext } from '@/lib/server/prompt-runtime-context'
import { buildWorkspaceContext } from '@/lib/server/workspace-context'
import {
  buildRuntimeSkillPromptBlocks,
  resolveRuntimeSkills,
} from '@/lib/server/skills/runtime-skill-resolver'
import {
  applyResolvedRoute,
  resolvePrimaryAgentRoute,
} from '@/lib/server/agents/agent-runtime-config'
import {
  runCapabilityBeforeMessageWrite,
  runCapabilityBeforeModelResolve,
  runCapabilityHook,
  runCapabilityToolResultPersist,
  transformCapabilityText,
  collectCapabilityDescriptions,
  collectCapabilityOperatingGuidance,
} from '@/lib/server/native-capabilities'
import {
  getEnabledCapabilityIds,
  getEnabledCapabilitySelection,
  splitCapabilityIds,
} from '@/lib/capability-selection'
import { normalizeProviderEndpoint, isLocalOpenClawEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
import {
  resolveMissionForTurn,
} from '@/lib/server/missions/mission-service'
import {
  bridgeHumanReplyFromChat,
} from '@/lib/server/chatrooms/session-mailbox'
import { runLinkUnderstanding } from '@/lib/server/link-understanding'
import {
  guardUntrustedText,
  guardUntrustedToolEvents,
  getUntrustedContentGuardMode,
} from '@/lib/server/untrusted-content'
import {
  buildIdentityContinuityContext,
} from '@/lib/server/identity-continuity'
import {
  resolveEffectiveSessionMemoryScopeMode,
} from '@/lib/server/memory/session-memory-scope'
import { syncSessionArchiveMemory } from '@/lib/server/memory/session-archive-memory'
import {
  evaluateSessionFreshness,
  resetSessionRuntime,
  resolveSessionResetPolicy,
} from '@/lib/server/session-reset-policy'
import {
  buildExecutionBrief,
  buildExecutionBriefContextBlock,
} from '@/lib/server/execution-brief'
import { checkAgentBudgetLimits } from '@/lib/server/cost'
import {
  classifyMessage,
  toMessageSemanticsSummary,
} from '@/lib/server/chat-execution/message-classifier'
import {
  filterRuntimeCapabilityIds,
  getTodaySpendUsd,
  parseUsdLimit,
  shouldApplySessionFreshnessReset,
  shouldPersistInboundUserMessage,
} from '@/lib/server/chat-execution/chat-execution-utils'
import { loadEstopState } from '@/lib/server/runtime/estop'
import { buildToolSection, joinPromptSegments } from '@/lib/server/chat-execution/prompt-builder'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import type { ExecuteChatTurnInput } from '@/lib/server/chat-execution/chat-execution'

export function buildAgentRuntimeCapabilities(enabledExtensions: string[]): string[] {
  const capabilities = ['heartbeats', 'autonomous_loop', 'multi_agent_chat']
  if (enabledExtensions.length > 0) capabilities.unshift('tools')
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
    'When asked to create a file in a format you don\'t have a dedicated tool for (PDF, image, spreadsheet, etc.), check available skills first, then use shell tools to install and run a CLI tool that handles it.',
    'If no skill or tool exists for a task, write a script and run it with shell tools. Install packages with pip/npm/brew as needed.',
    'Never say "I can\'t do that" or "I don\'t have a tool for that" when shell tools are available. Attempt a code-based approach first. Only report inability after genuinely trying and failing.',
    'When you solve a novel task with code or shell, consider using the extension_creator tool to save the solution as a reusable extension.',
  ]
}

export type PersistPhase = 'user' | 'system' | 'assistant_partial' | 'assistant_final' | 'heartbeat'

export async function applyMessageLifecycleHooks(params: {
  session: Session
  message: Message
  enabledIds: string[]
  phase: PersistPhase
  runId?: string
  isSynthetic?: boolean
}): Promise<Message | null> {
  let currentMessage = params.message
  const guardMode = getUntrustedContentGuardMode(loadSettings())
  if (Array.isArray(currentMessage.toolEvents) && currentMessage.toolEvents.length > 0) {
    currentMessage = {
      ...currentMessage,
      toolEvents: guardUntrustedToolEvents({
        toolEvents: currentMessage.toolEvents,
        mode: guardMode,
      }),
    }
  }
  const toolEvents = Array.isArray(currentMessage.toolEvents)
    ? currentMessage.toolEvents.filter((event) => typeof event.output === 'string' || event.error === true)
    : []

  for (const event of toolEvents) {
    currentMessage = await runCapabilityToolResultPersist(
      {
        session: params.session,
        message: currentMessage,
        toolName: event.name,
        toolCallId: event.toolCallId,
        isSynthetic: params.isSynthetic,
      },
      { enabledIds: params.enabledIds },
    )
  }

  const writeResult = await runCapabilityBeforeMessageWrite(
    {
      session: params.session,
      message: currentMessage,
      phase: params.phase,
      runId: params.runId,
    },
    { enabledIds: params.enabledIds },
  )

  if (writeResult.block) return null
  return writeResult.message
}

interface SessionWithCredentials {
  credentialId?: string | null
}

interface ProviderApiKeyConfig {
  requiresApiKey?: boolean
  optionalApiKey?: boolean
}

function joinSystemPromptBlocks(...blocks: Array<string | null | undefined>): string | undefined {
  const joined = joinPromptSegments(...blocks)
  return joined || undefined
}

function syncSessionFromAgent(sessionId: string): void {
  const session = getSession(sessionId)
  if (!session?.agentId) return
  const agent = getAgent(session.agentId)
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
      session.fallbackCredentialIds = [...(resolved.fallbackCredentialIds || [])]
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
  const agentSelection = getEnabledCapabilitySelection(agent)
  if (!session.parentSessionId) {
    const currentSelection = getEnabledCapabilitySelection(session)
    if (
      JSON.stringify(currentSelection.tools) !== JSON.stringify(agentSelection.tools)
      || JSON.stringify(currentSelection.extensions) !== JSON.stringify(agentSelection.extensions)
    ) {
      session.tools = agentSelection.tools
      session.extensions = agentSelection.extensions
      changed = true
    }
  }
  const desiredMemoryScopeMode = resolveEffectiveSessionMemoryScopeMode(session, agent.memoryScopeMode ?? null)
  if ((((session as unknown as Record<string, unknown>).memoryScopeMode as string | null | undefined) ?? null) !== desiredMemoryScopeMode) {
    ;(session as unknown as Record<string, unknown>).memoryScopeMode = desiredMemoryScopeMode
    changed = true
  }
  const isShortcutChat = session.shortcutForAgentId === agent.id || agent.threadSessionId === sessionId
  if (isShortcutChat) {
    const desiredSelection = agentSelection
    const currentShortcutSelection = getEnabledCapabilitySelection(session)
    if (
      JSON.stringify(currentShortcutSelection.tools) !== JSON.stringify(desiredSelection.tools)
      || JSON.stringify(currentShortcutSelection.extensions) !== JSON.stringify(desiredSelection.extensions)
    ) {
      session.tools = desiredSelection.tools
      session.extensions = desiredSelection.extensions
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
    if (session.connectorContext) {
      session.connectorContext = undefined
      changed = true
    }
  }

  if (changed) {
    saveSession(sessionId, session)
  }
}

function buildLightHeartbeatSystemPrompt(session: Session): string | undefined {
  if (!session.agentId) return undefined
  const agent = getAgent(session.agentId)
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
  const agent = getAgent(session.agentId)
  if (!agent) return undefined

  const settings = loadSettings()
  const allowSilentReplies = isDirectConnectorSession(session)
  const parts: string[] = []
  const enabledExtensions = listUniversalToolAccessExtensionIds(
    getEnabledCapabilityIds(session).length > 0 ? getEnabledCapabilityIds(session) : getEnabledCapabilityIds(agent),
  )

  const identityLines = ['## My Identity']
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

  const runtimeLines = [
    '## Runtime',
    `os=${process.platform} | host=${os.hostname()} | agent=${agent.id} | provider=${session.provider} | model=${session.model}`,
    `capabilities=${buildAgentRuntimeCapabilities(enabledExtensions).join(',')}`,
    'tool_access=universal',
  ]
  parts.push(runtimeLines.join('\n'))

  if (typeof settings.userPrompt === 'string' && settings.userPrompt.trim()) parts.push(`## User Instructions\n${settings.userPrompt}`)
  parts.push(buildCurrentDateTimePromptContext())

  if (agent.soul) parts.push(`## Soul\n${agent.soul}`)
  if (agent.systemPrompt) parts.push(`## System Prompt\n${agent.systemPrompt}`)

  try {
    const runtimeSkills = resolveRuntimeSkills({
      cwd: session.cwd,
      enabledExtensions,
      agentId: agent.id,
      sessionId: session.id,
      userId: session.user,
      agentSkillIds: agent.skillIds || [],
      storedSkills: loadSkills(),
      selectedSkillId: session.skillRuntimeState?.selectedSkillId || null,
    })
    parts.push(...buildRuntimeSkillPromptBlocks(runtimeSkills))
  } catch {
    // Runtime skills are non-critical during prompt assembly.
  }

  try {
    const wsCtx = buildWorkspaceContext({ cwd: session.cwd })
    if (wsCtx.block) parts.push(wsCtx.block)
  } catch {
    // Workspace context is non-critical.
  }

  const thinkingHint = [
    '## Output Format',
    'If your model supports internal reasoning/thinking, put all internal analysis inside <think>...</think> tags.',
    'Your final response to the user should be clear and concise.',
    allowSilentReplies
      ? 'When you truly have nothing to say, respond with ONLY: NO_MESSAGE'
      : 'For direct user chats, always send a visible reply. Never answer with NO_MESSAGE or HEARTBEAT_OK unless this is an explicit heartbeat poll.',
  ]
  parts.push(thinkingHint.join('\n'))

  if (enabledExtensions.length === 0) {
    parts.push(buildNoToolsGuidance().join('\n'))
  } else {
    parts.push(buildEnabledToolsAutonomyGuidance().join('\n'))
  }
  const toolSectionLines = buildToolSection(enabledExtensions)
  if (toolSectionLines.length > 0) parts.push(['## Tool Discipline', ...toolSectionLines].join('\n'))
  const operatingGuidance = collectCapabilityOperatingGuidance(enabledExtensions)
  if (operatingGuidance.length > 0) parts.push(['## Tool Guidance', ...operatingGuidance].join('\n'))
  const capabilityLines = collectCapabilityDescriptions(enabledExtensions)
  if (capabilityLines.length > 0) parts.push(['## Tool Capabilities', ...capabilityLines].join('\n'))

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
    if (!cred?.encryptedKey) throw new Error('API key not found. Please add one in Settings.')
    return decryptKey(cred.encryptedKey)
  }
  if (provider.optionalApiKey && session.credentialId) {
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (cred?.encryptedKey) {
      try { return decryptKey(cred.encryptedKey) } catch { return null }
    }
  }
  return null
}

export interface PreparedBlockedChatTurn {
  kind: 'blocked'
  sessionId: string
  session: Session
  lifecycleRunId: string
  blockedMessage: string
  internal: boolean
  runId?: string
  syntheticEnabledIds: string[]
}

export interface PreparedExecutableChatTurn {
  kind: 'ready'
  sessionId: string
  message: string
  internal: boolean
  source: string
  runId?: string
  session: Session
  sessionForRun: Session
  appSettings: ReturnType<typeof loadSettings>
  lifecycleRunId: string
  agentForSession: ReturnType<typeof getAgent>
  mission: Awaited<ReturnType<typeof resolveMissionForTurn>>
  executionBrief: ExecutionBrief
  executionBriefContextBlock?: string
  extensionsForRun: string[]
  effectiveMessage: string
  providerType: string
  provider: NonNullable<ReturnType<typeof getProvider>>
  apiKey: string | null
  hideAssistantTranscript: boolean
  isHeartbeatRun: boolean
  heartbeatLightContext: boolean
  isAutoRunNoHistory: boolean
  hasExtensions: boolean
  systemPrompt?: string
  resolvedImagePath?: string
  runStartedAt: number
  runMessageStartIndex: number
  toolPolicy: ReturnType<typeof resolveSessionToolPolicy>
}

export type PreparedChatTurn = PreparedBlockedChatTurn | PreparedExecutableChatTurn

export async function prepareChatTurn(input: ExecuteChatTurnInput): Promise<PreparedChatTurn> {
  const estop = loadEstopState()
  if (estop.level === 'all') {
    throw new Error(estop.reason
      ? `Execution is blocked because all estop is engaged: ${estop.reason}`
      : 'Execution is blocked because all estop is engaged.')
  }

  const { message } = input
  const {
    sessionId,
    imagePath,
    imageUrl,
    attachedFiles,
    missionId: explicitMissionId,
    internal = false,
    runId,
    source = 'chat',
    onEvent,
  } = input

  const resolvedImagePath = resolveImagePath(imagePath, imageUrl) ?? undefined

  syncSessionFromAgent(sessionId)

  const session = getSession(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  const runStartedAt = Date.now()
  const runMessageStartIndex = getMessageCount(sessionId)

  const appSettings = loadSettings()
  const lifecycleRunId = runId || `${sessionId}:${runStartedAt}`
  const agentForSession = session.agentId ? getAgent(session.agentId) : null
  if (isAgentDisabled(agentForSession)) {
    const blockedMessage = buildAgentDisabledMessage(agentForSession, 'run chats')
    onEvent?.({ t: 'err', text: blockedMessage })
    return {
      kind: 'blocked',
      sessionId,
      session,
      lifecycleRunId,
      blockedMessage,
      internal,
      runId,
      syntheticEnabledIds: getEnabledCapabilityIds(session),
    }
  }

  const runtimeCapabilityIds = filterRuntimeCapabilityIds(getEnabledCapabilityIds(session), {
    delegationEnabled: agentForSession?.delegationEnabled === true,
  })
  const requestedCapabilityIds = runtimeCapabilityIds.length > 0
    ? listUniversalToolAccessExtensionIds(runtimeCapabilityIds)
    : []
  const toolPolicy = resolveSessionToolPolicy(requestedCapabilityIds, appSettings)
  const isHeartbeatRun = input.internal === true && source === 'heartbeat'
  const isAutonomousInternalRun = internal && source !== 'chat'
  const heartbeatLightContext = isHeartbeatRun && !!input.heartbeatConfig?.lightContext
  const isAutoRunNoHistory = isHeartbeatRun

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
      try { syncSessionArchiveMemory(session, { agent: agentForSession }) } catch { /* best-effort */ }
      await runCapabilityHook(
        'sessionEnd',
        {
          sessionId: session.id,
          session,
          messageCount: getMessageCount(sessionId),
          durationMs: Date.now() - (session.createdAt || runStartedAt),
          reason: freshness.reason || 'session_reset',
        },
        { enabledIds: runtimeCapabilityIds },
      )
      resetSessionRuntime(session, freshness.reason || 'session_reset')
      onEvent?.({ t: 'status', text: JSON.stringify({ sessionReset: freshness.reason || 'session_reset' }) })
      saveSession(sessionId, session)
    }
  }
  if (isAutonomousInternalRun) {
    try { syncSessionArchiveMemory(session, { agent: agentForSession }) } catch { /* best-effort */ }
  }

  const mission = await resolveMissionForTurn({
    session,
    message,
    source,
    internal,
    runId: lifecycleRunId,
    explicitMissionId: explicitMissionId || null,
  })
  if (mission?.id) {
    session.missionId = mission.id
  }
  const extensionsForRun = toolPolicy.enabledExtensions
  if (runMessageStartIndex === 0) {
    await runCapabilityHook(
      'sessionStart',
      {
        session,
        resumedFrom: session.parentSessionId || null,
      },
      { enabledIds: extensionsForRun },
    )
  }
  const sessionForRunSelection = splitCapabilityIds(extensionsForRun)
  let sessionForRun = JSON.stringify(runtimeCapabilityIds) === JSON.stringify(extensionsForRun)
    ? session
    : { ...session, tools: sessionForRunSelection.tools, extensions: sessionForRunSelection.extensions }
  if (mission?.id) {
    sessionForRun = {
      ...sessionForRun,
      missionId: mission.id,
    }
  }
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

  if (extensionsForRun.length > 0) {
    try {
      effectiveMessage = await transformCapabilityText(
        'transformInboundMessage',
        { session: sessionForRun, text: message },
        { enabledIds: extensionsForRun },
      )
    } catch {
      effectiveMessage = message
    }
  }

  if (isHeartbeatRun && input.modelOverride) {
    sessionForRun = { ...sessionForRun, model: input.modelOverride }
  }
  const executionBrief = buildExecutionBrief({
    session: sessionForRun,
    mission,
  })
  const executionBriefContextBlock = buildExecutionBriefContextBlock(executionBrief)

  if (extensionsForRun.length > 0) {
    const modelResolvePrompt = heartbeatLightContext
      ? (joinSystemPromptBlocks(buildLightHeartbeatSystemPrompt(sessionForRun), executionBriefContextBlock) || '')
      : (joinSystemPromptBlocks(buildAgentSystemPrompt(sessionForRun), executionBriefContextBlock) || '')
    const modelResolve = await runCapabilityBeforeModelResolve(
      {
        session: sessionForRun,
        prompt: modelResolvePrompt,
        message: effectiveMessage,
        provider: sessionForRun.provider,
        model: sessionForRun.model,
        apiEndpoint: sessionForRun.apiEndpoint || null,
      },
      { enabledIds: extensionsForRun },
    )
    if (modelResolve) {
      sessionForRun = {
        ...sessionForRun,
        provider: modelResolve.providerOverride ?? sessionForRun.provider,
        model: modelResolve.modelOverride ?? sessionForRun.model,
        ...(modelResolve.apiEndpointOverride !== undefined ? { apiEndpoint: modelResolve.apiEndpointOverride } : {}),
      }
    }
  }

  if (toolPolicy.blockedExtensions.length > 0) {
    const blockedSummary = toolPolicy.blockedExtensions
      .map((entry) => `${entry.tool} (${entry.reason})`)
      .join(', ')
    onEvent?.({ t: 'err', text: `Capability policy blocked extensions for this run: ${blockedSummary}` })
  }

  if (session.agentId) {
    const agent = getAgent(session.agentId)
    if (agent) {
      const budgetCheck = checkAgentBudgetLimits(agent)
      const action = agent.budgetAction || 'warn'

      if (budgetCheck.exceeded.length > 0) {
        const blockedMessage = budgetCheck.exceeded.map((entry) => entry.message).join(' ')
        if (action === 'block') {
          onEvent?.({ t: 'err', text: blockedMessage })
          return {
            kind: 'blocked',
            sessionId,
            session,
            lifecycleRunId,
            blockedMessage,
            internal,
            runId,
            syntheticEnabledIds: getEnabledCapabilityIds(session),
          }
        }
        onEvent?.({ t: 'status', text: JSON.stringify({ budgetWarning: blockedMessage }) })
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
      const blockedMessage = `Safety budget reached: today's spend is $${todaySpendUsd.toFixed(4)} (limit $${dailySpendLimitUsd.toFixed(4)}). Increase safetyMaxDailySpendUsd to continue autonomous runs.`
      onEvent?.({ t: 'err', text: blockedMessage })
      return {
        kind: 'blocked',
        sessionId,
        session,
        lifecycleRunId,
        blockedMessage,
        internal,
        runId,
        syntheticEnabledIds: getEnabledCapabilityIds(session),
      }
    }
  }

  const providerType = sessionForRun.provider || 'claude-cli'
  const provider = getProvider(providerType)
  if (!provider) throw new Error(`Unknown provider: ${providerType}`)

  if (providerType === 'claude-cli' && !fs.existsSync(session.cwd)) {
    throw new Error(`Directory not found: ${session.cwd}`)
  }

  const apiKey = resolveApiKeyForSession(sessionForRun, provider)
  const hideAssistantTranscript = internal && source === 'main-loop-followup'

  const shouldPersistUserMessage = shouldPersistInboundUserMessage(internal, source)
  if (shouldPersistUserMessage) {
    const [linkAnalysis, semantics] = await Promise.all([
      !internal ? runLinkUnderstanding(message) : Promise.resolve([]),
      classifyMessage({
        sessionId,
        agentId: session.agentId || null,
        message,
        history: getMessages(sessionId),
      })
        .then((classification) => toMessageSemanticsSummary(classification))
        .catch(() => undefined),
    ])
    const guardedUserText = guardUntrustedText({
      text: message,
      source,
      mode: getUntrustedContentGuardMode(appSettings),
      trusted: (source === 'chat' && !internal) || internal,
    }).text
    const nextUserMessage = await applyMessageLifecycleHooks({
      session,
      message: {
        role: 'user',
        text: guardedUserText,
        time: Date.now(),
        imagePath: imagePath || undefined,
        imageUrl: imageUrl || undefined,
        attachedFiles: attachedFiles?.length ? attachedFiles : undefined,
        replyToId: input.replyToId || undefined,
        ...(semantics ? { semantics } : {}),
      },
      enabledIds: extensionsForRun,
      phase: 'user',
      runId: lifecycleRunId,
    })
    if (nextUserMessage) {
      appendMessage(sessionId, nextUserMessage)
      if (linkAnalysis.length > 0) {
        const linkAnalysisMessage = await applyMessageLifecycleHooks({
          session,
          message: {
            role: 'assistant',
            kind: 'system',
            text: `[Automated Link Analysis]\n${linkAnalysis.join('\n\n')}`,
            time: Date.now(),
          },
          enabledIds: extensionsForRun,
          phase: 'system',
          runId: lifecycleRunId,
          isSynthetic: true,
        })
        if (linkAnalysisMessage) {
          appendMessage(sessionId, linkAnalysisMessage)
        }
      }
      session.lastActiveAt = Date.now()
      saveSession(sessionId, session)
      if (!internal && source === 'chat') {
        try {
          bridgeHumanReplyFromChat({
            sessionId,
            payload: nextUserMessage.text,
          })
        } catch {
          // Best-effort mailbox bridge only.
        }
      }
      if (!internal) {
        try {
          await runCapabilityHook('onMessage', { session, message: nextUserMessage }, { enabledIds: extensionsForRun })
        } catch {
          // onMessage hooks are non-critical.
        }
      }
    }
  }

  const useLocalOpenClawNativeRuntime = providerType === 'openclaw' && isLocalOpenClawEndpoint(sessionForRun.apiEndpoint)
  const enabledSessionExtensions = getEnabledCapabilityIds(sessionForRun)
  const hasExtensions = enabledSessionExtensions.length > 0
    && !NON_LANGGRAPH_PROVIDER_IDS.has(providerType)
    && !useLocalOpenClawNativeRuntime

  const systemPrompt = heartbeatLightContext
    ? joinSystemPromptBlocks(buildLightHeartbeatSystemPrompt(sessionForRun), executionBriefContextBlock)
    : (hasExtensions ? undefined : joinSystemPromptBlocks(buildAgentSystemPrompt(sessionForRun), executionBriefContextBlock))

  return {
    kind: 'ready',
    sessionId,
    message,
    internal,
    source,
    runId,
    session,
    sessionForRun,
    appSettings,
    lifecycleRunId,
    agentForSession,
    mission,
    executionBrief,
    executionBriefContextBlock: executionBriefContextBlock || undefined,
    extensionsForRun,
    effectiveMessage,
    providerType,
    provider,
    apiKey,
    hideAssistantTranscript,
    isHeartbeatRun,
    heartbeatLightContext,
    isAutoRunNoHistory,
    hasExtensions,
    systemPrompt,
    resolvedImagePath,
    runStartedAt,
    runMessageStartIndex,
    toolPolicy,
  }
}
