import fs from 'fs'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { MemorySaver } from '@langchain/langgraph'
import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/runtime/heartbeat-defaults'
import { buildSessionTools } from '@/lib/server/session-tools'
import { buildChatModel } from '@/lib/server/build-llm'
import { loadSettings, loadAgents } from '@/lib/server/storage'
import { getExtensionManager } from '@/lib/server/extensions'
import {
  collectCapabilityAgentContext,
  runCapabilityBeforePromptBuild,
  runCapabilityHook,
} from '@/lib/server/native-capabilities'
import { loadRuntimeSettings, getAgentLoopRecursionLimit } from '@/lib/server/runtime/runtime-settings'
import { truncateToolResultText } from '@/lib/server/chat-execution/tool-result-guard'
import {
  buildIdentitySection,
  buildThinkingSection,
  buildWorkspaceSection,
  buildAgentAwarenessSection,
  buildSituationalSection,
  buildProjectSection,
  buildExtensionAccessAuditSection,
  buildSuggestionsSection,
  buildProactiveMemorySection,
  buildCoordinatorSection,
  buildCredentialAwarenessSection,
} from '@/lib/server/chat-execution/prompt-sections'

import { logExecution } from '@/lib/server/execution-log'
import { buildCurrentDateTimePromptContext } from '@/lib/server/prompt-runtime-context'
import { expandExtensionIds } from '@/lib/server/tool-aliases'
import type { Session, Message } from '@/types'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { resolveActiveProjectContext } from '@/lib/server/project-context'
import { resolveImagePath } from '@/lib/server/resolve-image'
import { routeTaskIntent } from '@/lib/server/capability-router'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import { resolveSessionToolPolicy } from '@/lib/server/tool-capability-policy'
import { ToolLoopTracker } from '@/lib/server/tool-loop-detection'
import { isCurrentThreadRecallRequest } from '@/lib/server/memory/memory-policy'
import {
  resolveEffectiveSessionMemoryScopeMode,
} from '@/lib/server/memory/session-memory-scope'
import {
  resolveContinuationAssistantText,
  buildContinuationPrompt,
  getToolFrequencyHint,
} from '@/lib/server/chat-execution/stream-continuation'
import type { ContinuationType } from '@/lib/server/chat-execution/stream-continuation'
import { CONTEXT_OVERFLOW_RE } from '@/lib/providers/error-classification'
import { emergencyContextReduce } from '@/lib/server/context-manager'
import { errorMessage, sleep } from '@/lib/shared-utils'
import { perf } from '@/lib/server/runtime/perf'
import {
  getExplicitRequiredToolNames,
  pruneIncompleteToolEvents,
  resolveExclusiveMemoryWriteTerminalAllowance,
  shouldSkipToolSummaryForShortResponse,
} from '@/lib/server/chat-execution/chat-streaming-utils'
import { resolveRequestedToolPreflightResponse } from '@/lib/server/chat-execution/chat-turn-tool-routing'
import { LangGraphToolEventTracker } from '@/lib/server/chat-execution/tool-event-tracker'
import { canonicalizeExtensionId } from '@/lib/server/tool-aliases'

// Extracted modules
import { ChatTurnState } from '@/lib/server/chat-execution/chat-turn-state'
import { ContinuationLimits } from '@/lib/server/chat-execution/continuation-limits'
import {
  buildAgenticExecutionPolicy,
  buildToolAvailabilityLines,
  buildToolDisciplineLines,
  buildToolSection,
  buildExternalWalletExecutionBlock,
  buildForcedExternalServiceSummary,
  shouldForceAttachmentFollowthrough,
  joinPromptSegments,
  applyBeforePromptBuildResult,
} from '@/lib/server/chat-execution/prompt-builder'
import type { PromptMode } from '@/lib/server/chat-execution/prompt-mode'
import { resolvePromptMode } from '@/lib/server/chat-execution/prompt-mode'
import {
  applyPromptBudget,
  isOverWarningThreshold,
  DEFAULT_PROMPT_BUDGET,
  MINIMAL_PROMPT_BUDGET,
} from '@/lib/server/chat-execution/prompt-budget'
import { IterationTimers } from '@/lib/server/chat-execution/iteration-timers'
import { processIterationEvents } from '@/lib/server/chat-execution/iteration-event-handler'
import { evaluateContinuation } from '@/lib/server/chat-execution/continuation-evaluator'
import { evaluateResponseCompleteness } from '@/lib/server/chat-execution/response-completeness'
import { finalizeStreamResult } from '@/lib/server/chat-execution/post-stream-finalization'
import {
  classifyMessage,
  isDeliverableTask as classifiedIsDeliverableTask,
  hasTransactionalWalletIntent as classifiedHasTransactionalWalletIntent,
  isResearchSynthesis as classifiedIsResearchSynthesis,
  type MessageClassification,
} from '@/lib/server/chat-execution/message-classifier'

// LangGraph unhandledRejection handler has been moved to src/instrumentation.ts
// to avoid re-registration on every HMR reload.

// Re-export continuation functions so existing consumers don't need to change imports
export {
  getExplicitRequiredToolNames,
  pruneIncompleteToolEvents,
  resolveExclusiveMemoryWriteTerminalAllowance,
  shouldSkipToolSummaryForShortResponse,
  buildToolAvailabilityLines,
  buildToolDisciplineLines,
  buildToolSection,
  buildExternalWalletExecutionBlock,
  shouldForceAttachmentFollowthrough,
  buildForcedExternalServiceSummary,
}

// Re-exports from stream-continuation and chat-streaming-utils
export {
  looksLikeOpenEndedDeliverableTask,
  shouldForceExternalExecutionKickoffFollowthrough,
  shouldForceRecoverableToolErrorFollowthrough,
  shouldForceExternalExecutionFollowthrough,
  shouldForceDeliverableFollowthrough,
  resolveFinalStreamResponseText,
  resolveContinuationAssistantText,
} from '@/lib/server/chat-execution/stream-continuation'

export {
  isWalletSimulationResult,
  resolveSuccessfulTerminalToolBoundary,
  shouldForceExternalServiceSummary,
} from '@/lib/server/chat-execution/chat-streaming-utils'

export {
  shouldTerminateOnSuccessfulMemoryMutation,
} from '@/lib/server/chat-execution/memory-mutation-tools'

export {
  classifyMessage,
  type MessageClassification,
} from '@/lib/server/chat-execution/message-classifier'

const CONTEXT_WARNING_OVERHEAD_TOKENS = 192

/** Extract HTTP status code and Retry-After from provider error objects (OpenAI SDK, etc.) */
function extractProviderErrorInfo(err: unknown): { statusCode: number; retryAfterMs: number | null } {
  const errObj = err as Record<string, unknown>
  const statusCode = typeof errObj?.status === 'number' ? errObj.status : 0
  let retryAfterMs: number | null = null
  const headers = errObj?.headers
  if (headers && typeof (headers as Headers).get === 'function') {
    const ra = (headers as Headers).get('retry-after')
    if (ra) {
      const secs = Number(ra)
      retryAfterMs = Number.isFinite(secs) ? secs * 1000 : null
    }
  }
  return { statusCode, retryAfterMs }
}

/** Extract a breadcrumb title from notable tool completions (task/schedule/agent creation). */
interface StreamAgentChatOpts {
  session: Session
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  apiKey: string | null
  systemPrompt?: string
  extraSystemContext?: string[]
  write: (data: string) => void
  history: Message[]
  fallbackCredentialIds?: string[]
  signal?: AbortSignal
  promptMode?: PromptMode
}

export interface StreamAgentChatResult {
  /** All text accumulated across every LLM turn (for SSE / web UI history). */
  fullText: string
  /** Text from only the final LLM turn — after the last tool call completed.
   *  Use this for connector delivery so intermediate planning text isn't sent. */
  finalResponse: string
  /** Tool events emitted during the streamed run. */
  toolEvents: import('@/types').MessageToolEvent[]
}

type LangChainContentPart =
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }
  | { type: 'text'; text: string }

type StreamAgentChatHandler = (opts: StreamAgentChatOpts) => Promise<StreamAgentChatResult>

let streamAgentChatOverride: StreamAgentChatHandler | null = null

export function setStreamAgentChatForTest(handler: StreamAgentChatHandler | null): void {
  streamAgentChatOverride = handler
}

export async function streamAgentChat(opts: StreamAgentChatOpts): Promise<StreamAgentChatResult> {
  if (streamAgentChatOverride) return streamAgentChatOverride(opts)
  return streamAgentChatCore(opts)
}

async function streamAgentChatCore(opts: StreamAgentChatOpts): Promise<StreamAgentChatResult> {
  const startTs = Date.now()
  const { session, message, imagePath, imageUrl, attachedFiles, apiKey, systemPrompt, extraSystemContext, write, history, fallbackCredentialIds, signal } = opts
  const promptMode: PromptMode = opts.promptMode ?? resolvePromptMode(session)
  const isMinimalPrompt = promptMode === 'minimal'
  const isConnectorSession = isDirectConnectorSession(session)
  const rawExtensions = getEnabledCapabilityIds(session)
  const hasShellCapability = rawExtensions.some((toolId) => ['shell', 'execute_command'].includes(String(toolId)))
  const extensionManager = getExtensionManager()
  const sessionExtensions = expandExtensionIds([
    ...rawExtensions,
    ...(hasShellCapability ? ['process'] : []),
  ]).filter((id) => !extensionManager.isExplicitlyDisabled(id))

  // fallbackCredentialIds is intentionally accepted for compatibility with caller signatures.
  void fallbackCredentialIds

  // Resolve agent's thinking level for provider-native params
  let agentThinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | undefined
  if (session.thinkingLevel) {
    agentThinkingLevel = session.thinkingLevel
  } else if (session.agentId) {
    const agentsForThinking = loadAgents()
    agentThinkingLevel = agentsForThinking[session.agentId]?.thinkingLevel
  }

  const llm = buildChatModel({
    provider: session.provider,
    model: session.model,
    apiKey,
    apiEndpoint: session.apiEndpoint,
    thinkingLevel: agentThinkingLevel,
  })

  // Build agent prompt
  const settings = loadSettings()
  const requestedToolPreflightResponse = resolveRequestedToolPreflightResponse({
    message,
    enabledExtensions: sessionExtensions,
    toolPolicy: resolveSessionToolPolicy(sessionExtensions, settings),
    appSettings: settings,
    internal: false,
    source: 'chat',
    session,
  })
  if (requestedToolPreflightResponse) {
    write(`data: ${JSON.stringify({ t: 'd', text: requestedToolPreflightResponse })}\n\n`)
    return {
      fullText: requestedToolPreflightResponse,
      finalResponse: requestedToolPreflightResponse,
      toolEvents: [],
    }
  }
  const runtime = loadRuntimeSettings()
  const heartbeatPrompt = (typeof settings.heartbeatPrompt === 'string' && settings.heartbeatPrompt.trim())
    ? settings.heartbeatPrompt.trim()
    : 'SWARM_HEARTBEAT_CHECK'
  const heartbeatIntervalSec = (() => {
    const raw = settings.heartbeatIntervalSec
    const parsed = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : Number.NaN
    if (!Number.isFinite(parsed)) return DEFAULT_HEARTBEAT_INTERVAL_SEC
    return Math.max(0, Math.min(3600, Math.trunc(parsed)))
  })()

  // -------------------------------------------------------------------------
  // Start message classification in the background (LLM-based, ~200-800ms)
  // -------------------------------------------------------------------------
  const classificationPromise = classifyMessage({
    sessionId: session.id,
    agentId: session.agentId,
    message,
    history,
  }).catch(() => null as MessageClassification | null)

  // -------------------------------------------------------------------------
  // System prompt assembly (stays inline — many async calls + local state)
  // -------------------------------------------------------------------------
  const promptParts: string[] = []
  const hasProvidedSystemPrompt = typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
  const currentThreadRecallRequest = isCurrentThreadRecallRequest(message)
  const hasAttachmentContext = Boolean(
    imagePath
    || attachedFiles?.length
    || history.some((entry) => entry.imagePath || entry.imageUrl || (Array.isArray(entry.attachedFiles) && entry.attachedFiles.length > 0)),
  )

  if (hasProvidedSystemPrompt) {
    promptParts.push(systemPrompt!.trim())
  } else {
    if (typeof settings.userPrompt === 'string' && settings.userPrompt.trim()) promptParts.push(settings.userPrompt)
    promptParts.push(buildCurrentDateTimePromptContext())
  }

  // Load agent context when a full prompt was not already composed by the route layer.
  let isCoordinatorAgent = false
  let agentDelegationEnabled = false
  let agentDelegationTargetMode: 'all' | 'selected' = 'all'
  let agentDelegationTargetAgentIds: string[] | undefined
  let agentMcpServerIds: string[] | undefined
  let agentMcpDisabledTools: string[] | undefined
  let agentHeartbeatEnabled = false
  let agentMemoryScopeMode: 'auto' | 'all' | 'global' | 'agent' | 'session' | 'project' | null = null
  let agentResponseStyle: 'concise' | 'normal' | 'detailed' | null = null
  let agentResponseMaxChars: number | null = null
  const activeProjectContext = resolveActiveProjectContext(session)
  if (session.agentId) {
    const agents = loadAgents()
    const agent = agents[session.agentId]
    isCoordinatorAgent = agent?.role === 'coordinator'
    agentDelegationEnabled = agent?.delegationEnabled === true
    agentDelegationTargetMode = agent?.delegationTargetMode === 'selected' ? 'selected' : 'all'
    agentDelegationTargetAgentIds = Array.isArray(agent?.delegationTargetAgentIds) ? agent.delegationTargetAgentIds : undefined
    agentMcpServerIds = agent?.mcpServerIds
    agentMcpDisabledTools = agent?.mcpDisabledTools
    agentHeartbeatEnabled = agent?.heartbeatEnabled === true
    agentMemoryScopeMode = resolveEffectiveSessionMemoryScopeMode(session, agent?.memoryScopeMode || null)
    agentResponseStyle = agent?.responseStyle || null
    agentResponseMaxChars = agent?.responseMaxChars || null
    if (!hasProvidedSystemPrompt) {
      promptParts.push(...buildIdentitySection(agent, session, sessionExtensions, isMinimalPrompt))
    }
    // Coordinator prompt — lists available workers for delegation
    if (!isMinimalPrompt) {
      const coordinatorBlock = buildCoordinatorSection(agent, sessionExtensions)
      if (coordinatorBlock) promptParts.push(coordinatorBlock)
    }
  }

  // Composable prompt sections — each builder returns string | null (or string[])
  const thinkingBlock = buildThinkingSection(agentThinkingLevel, isMinimalPrompt)
  if (thinkingBlock) promptParts.push(thinkingBlock)

  // Async sections — run concurrently where possible
  const [workspaceBlock, awarenessBlock, situationalBlock, extensionAuditBlock] = await Promise.all([
    !hasProvidedSystemPrompt ? buildWorkspaceSection(session, isMinimalPrompt, agentHeartbeatEnabled) : null,
    buildAgentAwarenessSection(session, sessionExtensions, isMinimalPrompt),
    buildSituationalSection(session, isMinimalPrompt),
    buildExtensionAccessAuditSection(sessionExtensions, agentMcpDisabledTools, isMinimalPrompt),
  ])
  if (workspaceBlock) promptParts.push(workspaceBlock)
  if (awarenessBlock) promptParts.push(awarenessBlock)
  if (situationalBlock) promptParts.push(situationalBlock)

  // Extra system context — always included (caller-provided context is always relevant)
  if (Array.isArray(extraSystemContext)) {
    for (const block of extraSystemContext) {
      if (typeof block !== 'string') continue
      const trimmed = block.trim()
      if (!trimmed) continue
      promptParts.push(trimmed)
    }
  }

  // Capability agent context — always included (extensions need their context)
  try {
    const extensionContextParts = await collectCapabilityAgentContext(session, sessionExtensions, message, history)
    promptParts.push(...extensionContextParts)
  } catch (err: unknown) {
    console.error('[stream-agent-chat] Capability context injection failed:', err instanceof Error ? err.message : String(err))
  }

  // Project context — full mode only
  if (!hasProvidedSystemPrompt) {
    const projectBlock = buildProjectSection(activeProjectContext, isMinimalPrompt)
    if (projectBlock) promptParts.push(projectBlock)

    const credentialBlock = buildCredentialAwarenessSection(activeProjectContext, isMinimalPrompt)
    if (credentialBlock) promptParts.push(credentialBlock)
  }

  if (extensionAuditBlock) promptParts.push(extensionAuditBlock)

  const suggestionsBlock = buildSuggestionsSection(settings.suggestionsEnabled, isMinimalPrompt)
  if (suggestionsBlock) promptParts.push(suggestionsBlock)

  // Await classification before building the agentic execution policy
  const classification = await classificationPromise

  promptParts.push(
    buildAgenticExecutionPolicy({
      enabledExtensions: sessionExtensions,
      loopMode: runtime.loopMode,
      heartbeatPrompt,
      heartbeatIntervalSec,
      allowSilentReplies: isConnectorSession,
      isDirectConnectorSession: isConnectorSession,
      delegationEnabled: agentDelegationEnabled,
      agentId: session.agentId || null,
      userMessage: message,
      history,
      hasAttachmentContext,
      responseStyle: agentResponseStyle,
      responseMaxChars: agentResponseMaxChars,
      mode: promptMode,
      classification,
    }),
  )

  // Proactive memory recall — full mode only
  {
    const agents = loadAgents()
    const agentForMemory = session.agentId ? agents[session.agentId] : null
    const memoryBlock = await buildProactiveMemorySection(
      session, agentForMemory, message, activeProjectContext.projectRoot,
      isMinimalPrompt, currentThreadRecallRequest,
    )
    if (memoryBlock) promptParts.push(memoryBlock)
  }

  // Goal anchor — keeps the agent focused when context is long.
  // Added before budgeting so it's included in the budget calculation.
  if (history.length > 30) {
    promptParts.push(`## Goal Anchor\n[GOAL] Original request: "${message.slice(0, 300)}". Stay focused on completing the original request.`)
  }

  // Apply prompt budget
  // Save a snapshot so we can re-apply with a smaller budget on context overflow
  const rawPromptParts = [...promptParts]
  const budget = isMinimalPrompt ? MINIMAL_PROMPT_BUDGET : DEFAULT_PROMPT_BUDGET
  const budgetResult = applyPromptBudget(promptParts, budget)
  if (budgetResult.truncated) {
    console.warn(`[stream-agent-chat] Prompt truncated: ${budgetResult.originalChars} chars → ${budget.maxTotalChars} chars (mode=${promptMode})`)
  } else if (isOverWarningThreshold(budgetResult.originalChars, budget)) {
    console.warn(`[stream-agent-chat] Prompt near budget: ${budgetResult.originalChars}/${budget.maxTotalChars} chars (mode=${promptMode})`)
  }
  let prompt = budgetResult.prompt

  // -------------------------------------------------------------------------
  // Agent + tool setup
  // -------------------------------------------------------------------------
  const runId = `${session.id}:${startTs}`
  const loopTracker = new ToolLoopTracker({
    ...(typeof settings.toolLoopFrequencyWarn === 'number' && { toolFrequencyWarn: settings.toolLoopFrequencyWarn }),
    ...(typeof settings.toolLoopFrequencyCritical === 'number' && { toolFrequencyCritical: settings.toolLoopFrequencyCritical }),
    ...(typeof settings.toolLoopCircuitBreaker === 'number' && { circuitBreaker: settings.toolLoopCircuitBreaker }),
  })
  const emittedPreToolWarnings = new Set<string>()
  const recursionLimit = getAgentLoopRecursionLimit(runtime)

  // Build message history for context
  const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i
  const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|yml|yaml|toml|env|log|sh|sql|css|scss)$/i

  async function buildContentForFile(filePath: string): Promise<LangChainContentPart | string | null> {
    if (!fs.existsSync(filePath)) {
      console.log(`[stream-agent-chat] FILE NOT FOUND: ${filePath}`)
      return null
    }
    const name = filePath.split('/').pop() || 'file'
    if (IMAGE_EXTS.test(filePath)) {
      const buf = fs.readFileSync(filePath)
      if (buf.length === 0) {
        console.warn(`[stream-agent-chat] Image file is empty: ${filePath}`)
        return `[Attached image: ${name} — file is empty]`
      }
      const data = buf.toString('base64')
      const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
      let mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      if (buf[0] === 0xFF && buf[1] === 0xD8) mimeType = 'image/jpeg'
      else if (buf[0] === 0x89 && buf[1] === 0x50) mimeType = 'image/png'
      else if (buf[0] === 0x47 && buf[1] === 0x49) mimeType = 'image/gif'
      else if (buf[0] === 0x52 && buf[1] === 0x49) mimeType = 'image/webp'
      return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}`, detail: 'auto' } }
    }
    if (filePath.endsWith('.pdf')) {
      try {
        const pdfParseModule = await import(/* webpackIgnore: true */ 'pdf-parse') as unknown as {
          default: (input: Buffer) => Promise<{ text?: string; numpages: number }>
        }
        const pdfParse = pdfParseModule.default
        const buf = fs.readFileSync(filePath)
        const result = await pdfParse(buf)
        const pdfText = (result.text || '').trim()
        if (!pdfText) return `[Attached PDF: ${name} — no extractable text]`
        const maxChars = 100_000
        const truncated = pdfText.length > maxChars ? pdfText.slice(0, maxChars) + '\n\n[... truncated]' : pdfText
        return `[Attached PDF: ${name} (${result.numpages} pages)]\n\n${truncated}`
      } catch {
        return `[Attached PDF: ${name} — could not extract text]`
      }
    }
    if (TEXT_EXTS.test(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf-8')
        return `[Attached file: ${name}]\n\n${fileContent}`
      } catch { return `[Attached file: ${name} — read error]` }
    }
    return `[Attached file: ${name}]`
  }

  async function buildLangChainContent(
    text: string,
    filePath?: string,
    extraFiles?: string[],
  ): Promise<string | LangChainContentPart[]> {
    const filePaths: string[] = []
    if (filePath) filePaths.push(filePath)
    if (extraFiles?.length) {
      for (const f of extraFiles) {
        if (f && !filePaths.includes(f)) filePaths.push(f)
      }
    }
    if (!filePaths.length) return text

    const parts: LangChainContentPart[] = []
    const textParts: string[] = []
    for (const fp of filePaths) {
      const content = await buildContentForFile(fp)
      if (!content) continue
      if (typeof content === 'string') {
        textParts.push(content)
      } else {
        parts.push(content)
      }
    }

    const combinedText = textParts.length
      ? `${textParts.join('\n\n')}\n\n${text}`
      : text

    if (parts.length === 0) return combinedText
    parts.push({ type: 'text', text: combinedText })
    return parts
  }

  // Apply context-clear boundary
  let contextStart = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].kind === 'context-clear') {
      contextStart = i + 1
      break
    }
  }
  const postClearHistory = history.slice(contextStart)
  const recentHistory = postClearHistory.slice(-30)

  // Auto-compaction
  let effectiveHistory = recentHistory
  try {
    const {
      shouldAutoCompact,
      llmCompact,
      estimateTokens,
      estimateMessagesTokens,
      resolveCompactionReserveTokens,
    } = await import('@/lib/server/context-manager')
    const systemPromptTokens = estimateTokens(prompt)
    const pendingInputTokens = estimateTokens([
      message,
      imagePath || '',
      imageUrl || '',
      ...(attachedFiles || []),
    ].filter(Boolean).join('\n'))
    const reserveTokens = resolveCompactionReserveTokens(session.provider, session.model)
    const promptHistoryTokens = estimateMessagesTokens(recentHistory, { includeToolEvents: false })
    if (shouldAutoCompact(recentHistory, systemPromptTokens, session.provider, session.model, 80, {
      extraTokens: pendingInputTokens + CONTEXT_WARNING_OVERHEAD_TOKENS,
      reserveTokens,
      includeToolEvents: false,
    })) {
      const summarize = async (prompt: string): Promise<string> => {
        const response = await llm.invoke([new HumanMessage(prompt)])
        if (typeof response.content === 'string') return response.content
        if (Array.isArray(response.content)) {
          return response.content
            .map((b: Record<string, unknown>) => (typeof b.text === 'string' ? b.text : ''))
            .join('')
        }
        return ''
      }
      const result = await llmCompact({
        messages: recentHistory,
        provider: session.provider,
        model: session.model,
        agentId: session.agentId || null,
        sessionId: session.id,
        summarize,
      })
      effectiveHistory = result.messages
      console.log(
        `[stream-agent-chat] Auto-compacted ${session.id}: ${recentHistory.length} → ${effectiveHistory.length} msgs` +
        ` (prompt history ${promptHistoryTokens} tokens)` +
        (result.summaryAdded ? ' (LLM summary)' : ' (sliding window fallback)'),
      )
    }
  } catch { /* non-critical */ }

  // Truncate oversized assistant messages in history to prevent context blowout
  const HISTORY_MSG_MAX_CHARS = 8_000
  for (const m of effectiveHistory) {
    if (m.role === 'assistant' && m.text.length > HISTORY_MSG_MAX_CHARS) {
      m.text = truncateToolResultText(m.text, HISTORY_MSG_MAX_CHARS)
    }
  }

  // Context state awareness
  const droppedByWindow = postClearHistory.length - recentHistory.length
  const droppedByCompaction = recentHistory.length - effectiveHistory.length
  if (droppedByWindow > 0 || droppedByCompaction > 0) {
    const contextNote = [
      '## Context State',
      `This conversation has ${history.length} total messages. You can see the most recent ${effectiveHistory.length}.`,
    ]
    if (droppedByWindow > 0) {
      contextNote.push(`${droppedByWindow} older messages were dropped by the history window.`)
    }
    if (droppedByCompaction > 0) {
      contextNote.push(`${droppedByCompaction} messages were auto-compacted.`)
    }
    contextNote.push('Key decisions from dropped context may be missing. If uncertain, use memory tools to check.')
    prompt += '\n\n' + contextNote.join(' ')
  }

  const langchainMessages: Array<HumanMessage | AIMessage> = []
  for (const m of effectiveHistory) {
    if (m.role === 'user') {
      const resolvedImg = resolveImagePath(m.imagePath, m.imageUrl)
      langchainMessages.push(new HumanMessage({ content: await buildLangChainContent(m.text, resolvedImg ?? undefined, m.attachedFiles) }))
    } else {
      langchainMessages.push(new AIMessage({ content: m.text }))
    }
  }

  // Add current message
  const currentContent = await buildLangChainContent(message, imagePath, attachedFiles)
  langchainMessages.push(new HumanMessage({ content: currentContent }))

  const promptHookResult = await runCapabilityBeforePromptBuild(
    {
      session,
      prompt,
      message,
      history,
      messages: [
        ...effectiveHistory,
        {
          role: 'user',
          text: message,
          time: Date.now(),
          ...(imagePath ? { imagePath } : {}),
          ...(imageUrl ? { imageUrl } : {}),
          ...(attachedFiles?.length ? { attachedFiles } : {}),
        },
      ],
    },
    { enabledIds: sessionExtensions },
  )
  prompt = applyBeforePromptBuildResult(prompt, promptHookResult)

  // Context degradation warning
  try {
    const {
      getContextDegradationWarning,
      estimateTokens: estTokens,
      resolveCompactionReserveTokens,
    } = await import('@/lib/server/context-manager')
    const sysTokens = estTokens(prompt)
    const pendingInputTokens = estTokens([
      message,
      imagePath || '',
      imageUrl || '',
      ...(attachedFiles || []),
    ].filter(Boolean).join('\n'))
    const warning = getContextDegradationWarning(
      effectiveHistory,
      sysTokens,
      session.provider,
      session.model,
      {
        extraTokens: pendingInputTokens + CONTEXT_WARNING_OVERHEAD_TOKENS,
        reserveTokens: resolveCompactionReserveTokens(session.provider, session.model),
        includeToolEvents: false,
      },
    )
    if (warning) {
      prompt = joinPromptSegments(warning, prompt)
    }
  } catch { /* non-critical */ }

  await runCapabilityHook(
    'llmInput',
    {
      session,
      runId,
      provider: session.provider,
      model: session.model,
      systemPrompt: prompt,
      prompt: message,
      historyMessages: effectiveHistory,
      imagesCount: imagePath ? 1 : 0,
    },
    { enabledIds: sessionExtensions },
  )

  const endToolBuildPerf = perf.start('stream-agent-chat', 'buildSessionTools', { sessionId: session.id })
  const { tools, cleanup, toolToExtensionMap, abortSignalRef } = await buildSessionTools(session.cwd, sessionExtensions, {
    agentId: session.agentId,
    sessionId: session.id,
    runId,
    delegationEnabled: agentDelegationEnabled,
    delegationTargetMode: agentDelegationTargetMode,
    delegationTargetAgentIds: agentDelegationTargetAgentIds,
    mcpServerIds: agentMcpServerIds,
    mcpDisabledTools: agentMcpDisabledTools,
    projectId: activeProjectContext.projectId,
    projectRoot: activeProjectContext.projectRoot,
    projectName: activeProjectContext.project?.name || null,
    projectDescription: activeProjectContext.project?.description || null,
    memoryScopeMode: agentMemoryScopeMode,
    beforeToolCall: ({ toolName, input }) => {
      const preview = loopTracker.preview(toolName, input)
      if (!preview) return undefined
      const previewKey = `${preview.severity}:${preview.detector}:${toolName}`
      if (preview.severity === 'warning' && emittedPreToolWarnings.has(previewKey)) {
        return undefined
      }
      if (preview.severity === 'warning') emittedPreToolWarnings.add(previewKey)
      logExecution(session.id, 'loop_detection', preview.message, {
        agentId: session.agentId,
        detail: {
          detector: preview.detector,
          severity: preview.severity,
          toolName,
          phase: 'before_tool_call',
        },
      })
      if (preview.severity === 'critical') {
        if (preview.detector === 'tool_frequency') {
          state.toolFrequencyBlocked = toolName
        }
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            loopDetection: preview.detector,
            severity: 'critical',
            message: preview.message,
            phase: 'before_tool_call',
          }),
        })}\n\n`)
        return { blockReason: preview.message }
      }
      // Enhance tool_frequency warnings with batching hints
      if (preview.detector === 'tool_frequency' && preview.toolName) {
        const hint = getToolFrequencyHint(preview.toolName, sessionExtensions)
        return { warning: `${preview.message}\n${hint}` }
      }
      return { warning: preview.message }
    },
    onToolCallWarning: ({ toolName, message: warnMessage }) => {
      write(`data: ${JSON.stringify({
        t: 'status',
        text: JSON.stringify({
          toolWarning: toolName,
          severity: 'warning',
          message: warnMessage,
          phase: 'before_tool_call',
        }),
      })}\n\n`)
    },
  })
  endToolBuildPerf({ toolCount: tools.length })

  const checkpointer = new MemorySaver()
  let agent = createReactAgent({
    llm,
    tools,
    prompt,
    checkpointer,
  })
  let pendingGraphMessages = [...langchainMessages]

  // -------------------------------------------------------------------------
  // Init turn state and limits
  // -------------------------------------------------------------------------
  const state = new ChatTurnState()
  const limits = new ContinuationLimits(isConnectorSession)
  const routingDecision = routeTaskIntent(message, sessionExtensions, null)
  const explicitRequiredToolNames = getExplicitRequiredToolNames(message, sessionExtensions)

  const boundedExternalExecutionTask = classifiedHasTransactionalWalletIntent(classification, message)
  const likelyResearchSynthesisTask = classifiedIsResearchSynthesis(classification, routingDecision.intent)
  const shouldEnforceEarlyRequiredToolKickoff = explicitRequiredToolNames.length > 0
    && classifiedIsDeliverableTask(classification, message)

  await runCapabilityHook('beforeAgentStart', { session, message }, { enabledIds: sessionExtensions })

  const abortController = new AbortController()
  abortSignalRef.signal = abortController.signal
  const abortFromSignal = () => abortController.abort()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', abortFromSignal)
  }
  let timedOut = false
  const loopTimer = runtime.loopMode === 'ongoing' && runtime.ongoingLoopMaxRuntimeMs
    ? setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, runtime.ongoingLoopMaxRuntimeMs)
    : null

  // -------------------------------------------------------------------------
  // Main iteration loop
  // -------------------------------------------------------------------------
  try {
    const maxIterations = limits.maxIterations
    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let shouldContinue: ContinuationType = false
      let requiredToolReminderNames: string[] = []
      let frequencyLimitedToolName: string | undefined

      const iterationStartState = state.snapshot()

      // Fresh per-iteration controller
      const iterationController = new AbortController()
      const onParentAbort = () => iterationController.abort()
      if (abortController.signal.aborted) iterationController.abort()
      else abortController.signal.addEventListener('abort', onParentAbort)

      const timers = new IterationTimers(iterationController, {
        streamIdleStallMs: runtime.streamIdleStallMs,
        requiredToolKickoffMs: runtime.requiredToolKickoffMs,
        shouldEnforceEarlyRequiredToolKickoff,
      })

      const toolEventTracker = new LangGraphToolEventTracker()
      const iterationInputMessages = pendingGraphMessages
      const eventStream = agent.streamEvents(
        { messages: iterationInputMessages },
        {
          version: 'v2',
          recursionLimit,
          signal: iterationController.signal,
          configurable: {
            thread_id: `${session.id}:${startTs}:${iteration}`,
          },
        },
      )

      let outcome: Awaited<ReturnType<typeof processIterationEvents>> | null = null

      try {
        timers.armIdleWatchdog(false)
        timers.armRequiredToolKickoff({
          iteration,
          waitingForToolResult: false,
          hasToolCalls: state.hasToolCalls,
        })

        outcome = await processIterationEvents({
          eventStream,
          state,
          timers,
          loopTracker,
          toolEventTracker,
          session,
          message,
          write,
          sessionExtensions,
          boundedExternalExecutionTask,
          toolToExtensionMap,
          iterationController,
        })
      } catch (innerErr: unknown) {
        const errName = innerErr instanceof Error ? innerErr.constructor.name : ''
        const errMsg = timers.idleTimedOut
          ? `Model stream stalled without emitting text or tool results for ${Math.trunc(runtime.streamIdleStallMs / 1000)} seconds.`
          : timers.requiredToolKickoffTimedOut
            ? `The turn did not start the required workspace tool step within ${Math.trunc(runtime.requiredToolKickoffMs / 1000)} seconds.`
          : errorMessage(innerErr)
        const errStack = innerErr instanceof Error ? innerErr.stack?.slice(0, 500) : undefined

        const isRecursionError = errName === 'GraphRecursionError'
          || /recursion limit|maximum recursion/i.test(errMsg)
        const { statusCode, retryAfterMs: extractedRetryAfterMs } = extractProviderErrorInfo(innerErr)
        const isTransientProviderError = !isRecursionError && (
          [429, 500, 502, 503, 504].includes(statusCode)
          || /^(InternalServerError|RateLimitError|APIConnectionError|APIConnectionTimeoutError)$/i.test(errName)
          || /internal server error|too many requests|rate limit|service unavailable|bad gateway|gateway timeout|overloaded/i.test(errMsg)
        )
        const isContextOverflow = !isRecursionError && statusCode === 400
          && CONTEXT_OVERFLOW_RE.test(errMsg)
        const isTransientAbort = (!isRecursionError && timers.idleTimedOut)
          || (!isRecursionError
          && /abort|timed?\s*out|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(errMsg)
          && !abortController.signal.aborted)
          || (isTransientProviderError && !abortController.signal.aborted)

        const logLevel = abortController.signal.aborted ? 'warn' : 'error'
        console[logLevel](`[stream-agent-chat] Error in streamEvents iteration=${iteration}`, {
          errName, errMsg, errStack,
          statusCode, retryAfterMs: extractedRetryAfterMs,
          isRecursionError, isContextOverflow, isTransientAbort,
          hasToolCalls: state.hasToolCalls, fullTextLen: state.fullText.length,
          parentAborted: abortController.signal.aborted,
        })

        if (timers.requiredToolKickoffTimedOut && limits.canContinue('required_tool') && !abortController.signal.aborted) {
          const hadPartialOutput = state.fullText.length > iterationStartState.fullText.length || state.streamedToolEvents.length > iterationStartState.toolEventCount
          state.restore(iterationStartState)
          requiredToolReminderNames = explicitRequiredToolNames.filter((toolName) => {
            const canonical = canonicalizeExtensionId(toolName) || toolName
            return !state.usedToolNames.has(toolName) && !state.usedToolNames.has(canonical)
          })
          if (requiredToolReminderNames.length === 0) requiredToolReminderNames = [...explicitRequiredToolNames]
          shouldContinue = 'required_tool'
          limits.increment('required_tool')
          const { count, max } = limits.getStatus('required_tool')
          logExecution(session.id, 'decision', `Required tool kickoff timed out, forcing tool reminder (${count}/${max})`, {
            agentId: session.agentId,
            detail: { errName, errMsg, hadPartialOutput, requiredTools: requiredToolReminderNames },
          })
          if (hadPartialOutput) {
            write(`data: ${JSON.stringify({ t: 'reset', text: iterationStartState.fullText })}\n\n`)
          }
          write(`data: ${JSON.stringify({
            t: 'status',
            text: JSON.stringify({
              requiredToolsPending: requiredToolReminderNames,
              reminderCount: count,
              maxReminders: max,
              reason: 'tool_kickoff_timeout',
            }),
          })}\n\n`)
        } else if (isRecursionError && limits.canContinue('recursion') && !abortController.signal.aborted) {
          shouldContinue = 'recursion'
          const count = limits.increment('recursion')
          const { max } = limits.getStatus('recursion')
          logExecution(session.id, 'decision', `Recursion limit hit, auto-continuing (${count}/${max})`, {
            agentId: session.agentId,
            detail: { errName, errMsg },
          })
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ autoContinue: count, maxContinues: max }) })}\n\n`)
        } else if (isTransientAbort && limits.canContinue('transient') && !abortController.signal.aborted) {
          const hadPartialOutput = state.fullText.length > iterationStartState.fullText.length || state.streamedToolEvents.length > iterationStartState.toolEventCount
          state.restore(iterationStartState)
          shouldContinue = 'transient'
          const count = limits.increment('transient')
          const { max } = limits.getStatus('transient')
          logExecution(session.id, 'decision', `Transient error, retrying (${count}/${max}): ${errMsg}`, {
            agentId: session.agentId,
            detail: { errName, errMsg, statusCode, retryAfterMs: extractedRetryAfterMs, hadPartialOutput },
          })
          if (hadPartialOutput) {
            write(`data: ${JSON.stringify({ t: 'reset', text: iterationStartState.fullText })}\n\n`)
          }
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ transientRetry: count, maxRetries: max, error: errMsg }) })}\n\n`)
        } else if (isContextOverflow && limits.canContinue('context_overflow') && !abortController.signal.aborted) {
          // Context overflow: emergency-reduce history and retry with a smaller prompt budget
          state.restore(iterationStartState)
          shouldContinue = 'context_overflow'
          const count = limits.increment('context_overflow')
          const { max } = limits.getStatus('context_overflow')

          // Emergency-reduce history
          effectiveHistory = emergencyContextReduce(effectiveHistory, count)

          // Rebuild langchainMessages from reduced history
          langchainMessages.length = 0
          for (const m of effectiveHistory) {
            if (m.role === 'user') {
              langchainMessages.push(new HumanMessage({ content: m.text }))
            } else {
              langchainMessages.push(new AIMessage({ content: m.text }))
            }
          }
          langchainMessages.push(new HumanMessage({ content: currentContent }))
          pendingGraphMessages = [...langchainMessages]

          // Reduce system prompt budget
          const reducedBudget = count === 1 ? MINIMAL_PROMPT_BUDGET.maxTotalChars : 12_000
          const reducedBudgetResult = applyPromptBudget(rawPromptParts, { maxTotalChars: reducedBudget, warnThresholdRatio: 0.95 })
          prompt = reducedBudgetResult.prompt

          // Recreate agent with reduced prompt
          agent = createReactAgent({ llm, tools, prompt, checkpointer })

          const hadPartialOutput = state.fullText.length > iterationStartState.fullText.length
          if (hadPartialOutput) {
            write(`data: ${JSON.stringify({ t: 'reset', text: iterationStartState.fullText })}\n\n`)
          }
          logExecution(session.id, 'decision', `Context overflow detected, emergency reduction attempt (${count}/${max})`, {
            agentId: session.agentId,
            detail: { errMsg, reducedMessages: effectiveHistory.length, reducedBudget },
          })
          write(`data: ${JSON.stringify({
            t: 'status',
            text: JSON.stringify({
              contextOverflow: true,
              attempt: count,
              maxAttempts: max,
              reducedMessages: effectiveHistory.length,
            }),
          })}\n\n`)
        } else {
          throw innerErr
        }
      } finally {
        timers.clearAll()
        abortController.signal.removeEventListener('abort', onParentAbort)
      }

      if (outcome?.reachedExecutionBoundary) break

      if (state.terminalToolBoundary) {
        const completedToolEvents = pruneIncompleteToolEvents(state.streamedToolEvents)
        state.streamedToolEvents.length = 0
        state.streamedToolEvents.push(...completedToolEvents)
        break
      }

      // Evaluate continuation (only if error handling didn't already set shouldContinue)
      if (!shouldContinue && outcome) {
        const decision = evaluateContinuation({
          state,
          limits,
          toolEventTracker,
          message,
          sessionExtensions,
          isConnectorSession,
          isCoordinatorAgent,
          history,
          session,
          write,
          explicitRequiredToolNames,
          hasAttachmentContext,
          executionFollowthroughReason: outcome.executionFollowthroughReason,
          likelyResearchSynthesisTask,
          abortControllerAborted: abortController.signal.aborted,
          classification,
        })
        shouldContinue = decision.type
        if (decision.requiredToolReminderNames.length > 0) {
          requiredToolReminderNames = decision.requiredToolReminderNames
        }
        frequencyLimitedToolName = decision.frequencyLimitedToolName
        // Upgrade tool_summary to coordinator_synthesis for coordinator agents
        // so they get a delegation-aware synthesis prompt
        if (shouldContinue === 'tool_summary' && isCoordinatorAgent) {
          shouldContinue = 'coordinator_synthesis'
        }
      }

      // Async LLM-based incomplete-action check: catches "I'll run the deployment:" with no tool calls
      if (!shouldContinue && outcome && !state.hasToolCalls && state.fullText.trim().length > 0 && state.fullText.trim().length < 500) {
        const completeness = await evaluateResponseCompleteness({
          sessionId: session.id,
          agentId: session.agentId,
          message,
          response: state.fullText,
          toolCallCount: state.streamedToolEvents.length,
        })
        if (completeness?.isIncomplete && completeness.confidence >= 0.7 && limits.canContinue('deliverable_followthrough')) {
          limits.increment('deliverable_followthrough')
          shouldContinue = 'deliverable_followthrough'
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ incompleteActionContinuation: true }) })}\n\n`)
        }
      }

      if (!shouldContinue) break

      // Reset tool loop tracker on loop_recovery so the agent gets a fresh frequency budget
      if (shouldContinue === 'loop_recovery') {
        loopTracker.reset()
      }

      const continuationAssistantText = shouldContinue === 'memory_write_followthrough'
        ? ''
        : resolveContinuationAssistantText({
            iterationText: outcome?.iterationText ?? '',
            lastSegment: state.lastSegment,
          })

      const continuationPrompt = buildContinuationPrompt({
        type: shouldContinue,
        message,
        fullText: state.fullText,
        toolEvents: state.streamedToolEvents,
        requiredToolReminderNames,
        cwd: session.cwd,
        frequencyLimitedToolName,
        sessionExtensions,
      })

      if (continuationPrompt) {
        const continuationMessages: Array<HumanMessage | AIMessage> = []
        if (continuationAssistantText) {
          const assistantMessage = new AIMessage({ content: continuationAssistantText })
          langchainMessages.push(assistantMessage)
          continuationMessages.push(assistantMessage)
        }
        state.settleSegment()
        const promptMessage = new HumanMessage({ content: continuationPrompt })
        langchainMessages.push(promptMessage)
        continuationMessages.push(promptMessage)
        pendingGraphMessages = [...langchainMessages]
      } else if (shouldContinue === 'transient') {
        const { count } = limits.getStatus('transient')
        const backoffMs = Math.min(3000 * Math.pow(2, count - 1) + Math.random() * 2000, 30_000)
        await sleep(backoffMs)
      } else if (shouldContinue === 'context_overflow') {
        // No backoff needed — context already reduced, retry immediately
      }
    }
  } catch (err: unknown) {
    const errMsg = timedOut
      ? 'Ongoing loop stopped after reaching the configured runtime limit.'
      : errorMessage(err)
    const heartbeatEligible = runtime.loopMode === 'ongoing' || session.heartbeatEnabled === true || agentHeartbeatEnabled
    const budgetLimited = timedOut || /recursion limit|maximum recursion/i.test(errMsg)
    if (heartbeatEligible && budgetLimited) {
      enqueueSystemEvent(
        session.id,
        '[Loop Budget Reached] The previous autonomous run stopped after hitting its loop budget. On the next heartbeat, resume carefully from the current state, verify completed work before repeating it, and focus only on the remaining objective.',
        'loop_budget_reached',
      )
      logExecution(session.id, 'decision', 'Queued a deferred resume cue for the next heartbeat after loop budget exhaustion.', {
        agentId: session.agentId,
        detail: { timedOut, heartbeatEligible },
      })
    }
    logExecution(session.id, 'error', errMsg, { agentId: session.agentId, detail: { timedOut } })
    write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
  } finally {
    if (loopTimer) clearTimeout(loopTimer)
    if (signal) signal.removeEventListener('abort', abortFromSignal)
  }

  // -------------------------------------------------------------------------
  // Finalization
  // -------------------------------------------------------------------------
  return finalizeStreamResult({
    state,
    session,
    message,
    write,
    llm,
    prompt,
    tools,
    toolToExtensionMap,
    history,
    sessionExtensions,
    startTs,
    signal,
    cleanup,
    runId,
    classification,
  })
}
