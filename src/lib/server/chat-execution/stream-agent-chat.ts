import fs from 'fs'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { MemorySaver } from '@langchain/langgraph'
import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/runtime/heartbeat-defaults'
import { buildSessionTools } from '@/lib/server/session-tools'
import { buildChatModel } from '@/lib/server/build-llm'
import { loadSettings, loadAgents, loadSkills, appendUsage } from '@/lib/server/storage'
import { estimateCost, buildPluginDefinitionCosts } from '@/lib/server/cost'
import { getPluginManager } from '@/lib/server/plugins'
import {
  collectCapabilityAgentContext,
  collectCapabilityDescriptions,
  collectCapabilityOperatingGuidance,
  listNativeCapabilities,
  runCapabilityBeforePromptBuild,
  runCapabilityHook,
} from '@/lib/server/native-capabilities'
import { loadRuntimeSettings, getAgentLoopRecursionLimit } from '@/lib/server/runtime/runtime-settings'
import { buildRuntimeSkillPromptBlocks, resolveRuntimeSkills } from '@/lib/server/skills/runtime-skill-resolver'

import { logExecution } from '@/lib/server/execution-log'
import { buildCurrentDateTimePromptContext } from '@/lib/server/prompt-runtime-context'
import { canonicalizePluginId, expandPluginIds, pluginIdMatches } from '@/lib/server/tool-aliases'
import type { Session, Message, UsageRecord, PluginInvocationRecord, MessageToolEvent, PluginPromptBuildResult } from '@/types'
import { extractSuggestions } from '@/lib/server/suggestions'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'
import { buildIdentityContinuityContext } from '@/lib/server/identity-continuity'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { resolveActiveProjectContext } from '@/lib/server/project-context'
import { resolveImagePath } from '@/lib/server/resolve-image'
import { routeTaskIntent } from '@/lib/server/capability-router'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import {
  getEnabledToolPlanningView,
  getFirstToolForCapability,
  getToolsForCapability,
  TOOL_CAPABILITY,
} from '@/lib/server/tool-planning'
import { ToolLoopTracker } from '@/lib/server/tool-loop-detection'
import { truncateToolResultText, calculateMaxToolResultChars } from '@/lib/server/chat-execution/tool-result-guard'
import type { LoopDetectionResult } from '@/lib/server/tool-loop-detection'
import { isCurrentThreadRecallRequest } from '@/lib/server/memory/memory-policy'
import {
  buildSessionMemoryScopeFilter,
  resolveEffectiveSessionMemoryScopeMode,
} from '@/lib/server/memory/session-memory-scope'
import {
  isBroadGoal,
  looksLikeExternalWalletTask,
  looksLikeBoundedExternalExecutionTask,
  looksLikeOpenEndedDeliverableTask,
  shouldForceRecoverableToolErrorFollowthrough,
  shouldForceExternalExecutionKickoffFollowthrough,
  shouldForceExternalExecutionFollowthrough,
  shouldForceDeliverableFollowthrough,
  hasStateChangingWalletEvidence,
  countExternalExecutionResearchSteps,
  countDistinctExternalResearchHosts,
  hasIncompleteDelegationWait,
  renderToolEvidence,
  resolveFinalStreamResponseText,
  resolveContinuationAssistantText,
  buildContinuationPrompt,
} from '@/lib/server/chat-execution/stream-continuation'
import type { ContinuationType } from '@/lib/server/chat-execution/stream-continuation'
import { dedup, errorMessage, sleep } from '@/lib/shared-utils'
import { perf } from '@/lib/server/runtime/perf'
import {
  compactThreadRecallText,
  getExplicitRequiredToolNames,
  getWalletApprovalBoundaryAction,
  isWalletSimulationResult,
  pruneIncompleteToolEvents,
  resolveSuccessfulTerminalToolBoundary,
  shouldForceExternalServiceSummary,
  updateStreamedToolEvents,
} from '@/lib/server/chat-execution/chat-streaming-utils'
import {
  hasOnlySuccessfulMemoryMutationToolEvents,
  resolveToolAction,
  shouldTerminateOnSuccessfulMemoryMutation,
} from '@/lib/server/chat-execution/memory-mutation-tools'
import { LangGraphToolEventTracker } from '@/lib/server/chat-execution/tool-event-tracker'

// LangGraph's streamEvents leaves dangling internal promises when the for-await
// loop exits early (break on tool loop detection, execution boundary, etc.).
// These promises may later reject with GraphRecursionError or AbortError.
// Register a permanent handler to prevent process crashes from these expected
// background rejections.  Only LangGraph-specific errors (identified by
// pregelTaskId or lc_error_code) are suppressed; all other rejections propagate
// normally.
process.on('unhandledRejection', (err: unknown) => {
  if (
    err && typeof err === 'object'
    && ('pregelTaskId' in err
      || (err instanceof Error && (err.name === 'AbortError' || err.name === 'GraphRecursionError'))
      || (err as Record<string, unknown>).lc_error_code === 'GRAPH_RECURSION_LIMIT')
  ) {
    // Silently suppress — expected background rejection from LangGraph
    return
  }
})

// Re-export continuation functions so existing consumers don't need to change imports
export {
  getExplicitRequiredToolNames,
  isWalletSimulationResult,
  looksLikeOpenEndedDeliverableTask,
  pruneIncompleteToolEvents,
  shouldForceExternalExecutionKickoffFollowthrough,
  shouldForceRecoverableToolErrorFollowthrough,
  shouldForceExternalExecutionFollowthrough,
  shouldForceDeliverableFollowthrough,
  shouldForceExternalServiceSummary,
  resolveSuccessfulTerminalToolBoundary,
  shouldTerminateOnSuccessfulMemoryMutation,
  resolveFinalStreamResponseText,
  resolveContinuationAssistantText,
}

const TOOL_SUMMARY_SHORT_RESPONSE_EXEMPT_TOOLS = new Set([
  'use_skill',
])

export function shouldSkipToolSummaryForShortResponse(params: {
  fullText: string
  toolEvents: MessageToolEvent[]
  isConnectorSession?: boolean
}): boolean {
  if (params.isConnectorSession) return false
  if (!params.fullText.trim()) return false
  if (!Array.isArray(params.toolEvents) || params.toolEvents.length === 0) return false
  const toolNames = Array.from(new Set(
    params.toolEvents
      .map((event) => canonicalizePluginId(event.name) || event.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0),
  ))
  if (toolNames.length === 0) return false
  // Skill runtime tools load guidance into context rather than producing external
  // evidence that needs a forced synthesis pass. A short exact answer after those
  // calls can already be the correct completion.
  return toolNames.every((toolName) => TOOL_SUMMARY_SHORT_RESPONSE_EXEMPT_TOOLS.has(toolName))
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
  write: (data: string) => void
  history: Message[]
  fallbackCredentialIds?: string[]
  signal?: AbortSignal
}

// LangGraph uses this internal configurable key to bypass subgraph lookup when
// resolving state from a namespaced checkpoint. It is not exported publicly in
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

function buildPluginCapabilityLines(enabledPlugins: string[], opts?: { delegationEnabled?: boolean }): string[] {
  const lines = collectCapabilityDescriptions(enabledPlugins)

  // Context tools are available to any session with plugins
  if (enabledPlugins.length > 0) {
    lines.push('- I can monitor my own context usage (`context_status`) and compact my conversation history (`context_summarize`) when I\'m running low on space.')
    if (opts?.delegationEnabled) {
      lines.push('- I can delegate tasks to other agents (`delegate_to_agent`) based on their strengths and availability.')
    }
  }
  return lines
}

function buildExactToolNameList(enabledPlugins: string[]): string[] {
  const planning = getEnabledToolPlanningView(enabledPlugins)
  const pluginToolNames = getPluginManager()
    .getTools(enabledPlugins)
    .map(({ tool }) => tool.name)
  const combined = [
    ...planning.displayToolIds,
    ...planning.entries.map((entry) => entry.toolName),
    ...pluginToolNames,
  ]
  return dedup(combined.filter((toolName) => typeof toolName === 'string' && toolName.trim()))
    .map((toolName) => toolName.trim())
    .sort()
}

export function buildToolAvailabilityLines(enabledPlugins: string[]): string[] {
  const toolNames = buildExactToolNameList(enabledPlugins)
  if (toolNames.length === 0) return []

  return [
    'Tool names are case-sensitive. Call tools exactly as listed.',
    ...toolNames.map((toolName) => `- \`${toolName}\``),
  ]
}

export function buildToolDisciplineLines(enabledPlugins: string[]): string[] {
  const planning = getEnabledToolPlanningView(enabledPlugins)
  const uniqueTools = buildExactToolNameList(enabledPlugins)
  if (uniqueTools.length === 0) return []
  const walletTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.walletInspect)
  const httpTools = getToolsForCapability(enabledPlugins, 'network.http')

  const lines = [
    `Enabled tools in this session: ${uniqueTools.map((toolId) => `\`${toolId}\``).join(', ')}.`,
    'Only call tools from this enabled list or tools explicitly returned by the runtime.',
    'Treat enabled tools as available now. Do not ask the user for permission before routine use of an enabled tool.',
    'If the request clearly maps to an enabled tool, try that tool before telling the user to do it themselves.',
    'Only talk about approvals when a tool result explicitly returns an approval boundary for a concrete state-changing action.',
  ]

  const directPlatformTools = uniqueTools.filter((toolId) => toolId.startsWith('manage_') && toolId !== 'manage_platform')
  if (directPlatformTools.length > 0 && !uniqueTools.includes('manage_platform')) {
    lines.push(`Use direct platform tools exactly as named (${directPlatformTools.map((toolId) => `\`${toolId}\``).join(', ')}). Do not substitute \`manage_platform\` unless it is explicitly enabled.`)
  }

  lines.push(...planning.disciplineGuidance)

  const researchSearchTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.researchSearch)
  const researchFetchTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.researchFetch)
  const browserCaptureTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.browserCapture)

  if ((researchSearchTools.length || researchFetchTools.length) && browserCaptureTools.length) {
    const researchLabel = [...researchSearchTools, ...researchFetchTools].map((toolName) => `\`${toolName}\``).join('/')
    lines.push(`Use ${researchLabel} for text/sources and \`${browserCaptureTools[0]}\` for screenshots. For research+screenshot tasks, gather sources first, then capture.`)
  }

  if (researchSearchTools.length) {
    lines.push(`For current events or live developments, use \`${researchSearchTools[0]}\` before answering from memory.`)
  }

  const alternateResearchTools = Array.from(new Set([
    ...(researchSearchTools.length || researchFetchTools.length ? [...researchSearchTools, ...researchFetchTools] : []),
    ...httpTools,
    ...(uniqueTools.includes('shell') ? ['shell'] : []),
    ...(uniqueTools.includes('browser') ? ['browser'] : []),
  ]))
  if (alternateResearchTools.length >= 2) {
    lines.push(`If one research path is blocked, try another (${alternateResearchTools.map((toolName) => `\`${toolName}\``).join(', ')}) before giving up.`)
  }

  if (walletTools.length && (uniqueTools.includes('browser') || httpTools.length > 0)) {
    lines.push(`For wallet/trading tasks, inspect the wallet first with \`${walletTools[0]}\`. Use a bounded loop: verify, attempt one reversible step, then execute or state the blocker.`)
  }

  if (uniqueTools.includes('manage_secrets')) {
    lines.push('Store secrets (passwords, API keys, tokens) with `manage_secrets` — never echo raw values in assistant text.')
  }

  return lines
}

const OPEN_ENDED_REVISION_BLOCK = [
  '## Revision Loop',
  'For open-ended deliverable work, do a real two-pass loop before declaring success: create the draft artifacts, critique them against the objective, then modify at least one artifact based on that critique.',
  'A critique by itself does not count as iteration. Iteration requires an actual changed artifact.',
  'When resuming in an existing workspace, inspect the current files first, then update them. Do not assume you lost access to the workspace without an explicit tool attempt.',
  'If `files` is available, use it with explicit actions and paths to inspect and revise the artifacts.',
].join('\n')

function getEnabledDisplayTool(enabledPlugins: string[], canonicalPluginId: string): string | null {
  return getEnabledToolPlanningView(enabledPlugins).displayToolIds.find((toolId) => toolId === canonicalPluginId) || null
}

export function shouldForceAttachmentFollowthrough(params: {
  userMessage: string
  enabledPlugins: string[]
  hasToolCalls: boolean
  hasAttachmentContext: boolean
}): boolean {
  if (!params.hasAttachmentContext) return false
  if (params.hasToolCalls) return false
  const decision = routeTaskIntent(params.userMessage, params.enabledPlugins, null)
  if (decision.intent !== 'research' && decision.intent !== 'browsing') return false
  return decision.preferredTools.some((toolName) => pluginIdMatches(params.enabledPlugins, toolName))
}

export function buildExternalWalletExecutionBlock(enabledPlugins: string[]): string {
  const hasExecutionContext = Boolean(
    getFirstToolForCapability(enabledPlugins, TOOL_CAPABILITY.walletInspect)
    || getFirstToolForCapability(enabledPlugins, 'network.http')
    || getEnabledDisplayTool(enabledPlugins, 'browser')
    || getEnabledDisplayTool(enabledPlugins, 'manage_capabilities'),
  )
  if (!hasExecutionContext) return ''
  const lines = [
    '## External Service Execution',
    'Define a stop condition before exploring: either complete one concrete reversible action, or identify the exact blocker with evidence.',
    'A prose sentence saying approval is needed is not enough. When the next step is a wallet signature or transaction, trigger the actual wallet approval request through the tool.',
    'After one or two discovery bursts, stop exploring and summarize the blocker if execution still depends on a missing capability such as injected wallet signing, external credentials, or unavailable approvals.',
    'Do not mutate already confirmed identifiers unless newer tool evidence proves the earlier value was wrong.',
    'Never claim success on a trading or dApp task unless you either completed the reversible step with tool evidence or clearly stated the final missing step.',
  ]
  return lines.join('\n')
}

async function buildForcedExternalServiceSummary(params: {
  llm: { invoke: (messages: HumanMessage[]) => Promise<{ content: unknown }> }
  userMessage: string
  fullText: string
  toolEvents: MessageToolEvent[]
}): Promise<string | null> {
  const prompt = [
    'You are finishing an interrupted external-service tool run.',
    'Do not call tools. Do not continue browsing.',
    'Based only on the objective, partial assistant text, and tool evidence below, produce a concise final status with exactly these headings:',
    'Last reversible step',
    'Exact blocker',
    'Safest next action',
    '',
    `Objective:\n${params.userMessage}`,
    '',
    `Partial assistant text:\n${params.fullText || '(none)'}`,
    '',
    `Tool evidence:\n${renderToolEvidence(params.toolEvents) || '(none)'}`,
  ].join('\n')

  try {
    const response = await Promise.race([
      params.llm.invoke([new HumanMessage(prompt)]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('forced-summary-timeout')), 10_000)),
    ])
    if (typeof response.content === 'string') return response.content.trim() || null
    if (Array.isArray(response.content)) {
      const text = response.content
        .map((block: Record<string, unknown>) => (typeof block.text === 'string' ? block.text : ''))
        .join('')
        .trim()
      return text || null
    }
    return null
  } catch {
    return null
  }
}


function buildExactStructureBlock(userMessage: string): string {
  const exactBulletMatch = userMessage.match(/\bexactly\s+(\d+)\s+bullet points?\b/i)
  if (!exactBulletMatch) return ''
  const bulletCount = exactBulletMatch[1]
  return [
    '## Exact Structural Constraints',
    `The user required exactly ${bulletCount} bullet points.`,
    'Treat that as a hard file-wide constraint unless the user explicitly says later sections get their own separate bullets.',
    'If the file also needs titled sections such as Owners or Risks, use short prose under those headings instead of adding more bullet lines.',
  ].join('\n')
}

const GOAL_DECOMPOSITION_BLOCK = [
  '## Goal Decomposition',
  'When you receive a broad, open-ended goal:',
  '1. Break it into 3-7 concrete, sequentially-executable subtasks before taking action.',
  '2. If manage_tasks is available, use it only for durable tracking: multi-turn work, delegation, explicit backlog requests, or work you expect to resume later. Do not create a task for every micro-step.',
  'Single-step instructions are not broad goals. For direct actions like storing a memory, answering a recall question, editing one file, or sending one message, execute the relevant tool immediately instead of creating tasks or delegating.',
  '3. Present the plan as a short checklist or numbered list in plain language. If durable tracking is unnecessary, keep it inline instead of creating tasks.',
  '4. Execute the first substantive subtask immediately — do not stop after planning.',
  '5. Update only the durable tasks you actually created; otherwise just continue executing and report progress plainly.',
].join('\n')

function buildAgenticExecutionPolicy(opts: {
  enabledPlugins: string[]
  loopMode: 'bounded' | 'ongoing'
  heartbeatPrompt: string
  heartbeatIntervalSec: number
  allowSilentReplies?: boolean
  isDirectConnectorSession?: boolean
  delegationEnabled?: boolean
  userMessage?: string
  history?: Message[]
  hasAttachmentContext?: boolean
  responseStyle?: 'concise' | 'normal' | 'detailed' | null
  responseMaxChars?: number | null
}) {
  const hasTooling = opts.enabledPlugins.length > 0
  const pluginLines = buildPluginCapabilityLines(opts.enabledPlugins, { delegationEnabled: opts.delegationEnabled })
  const toolDisciplineLines = buildToolDisciplineLines(opts.enabledPlugins)
  const hasMemoryTools = opts.enabledPlugins.some((toolId) => (canonicalizePluginId(toolId) || toolId) === 'memory')

  const parts: string[] = []

  // Core execution philosophy
  parts.push(
    '## How I Work',
    hasTooling
      ? 'I take initiative — plan briefly, execute tools, evaluate, iterate until done. Never stop at advice when action is implied.'
      : 'No tools enabled. Be explicit about what tool access is needed.',
    'IMPORTANT: If information was already mentioned in THIS conversation, answer from context — do NOT call memory tools or web search to look it up again. Only use memory tools to recall info from PREVIOUS conversations not in the current thread.',
    'If a skill applies to the task, follow its recommended approach first. Skill-specific commands are faster and more reliable than generic web search. Minimize tool calls — combine steps where possible.',
    'If a task explicitly names an enabled tool, use that tool before declaring success. A prose request is not a substitute for `ask_human`, and browser work is not a substitute for `email` delivery.',
    'When `ask_human` is enabled, collect required human input through the tool instead of asking for it only in plain assistant text.',
    'Do not narrate routine tool calls. Just call the tool and report the outcome. Only narrate when the step is complex, sensitive, or the user needs to understand what is happening.',
    'Do not repeat the same tool call with identical arguments. If a tool returns an error or empty result, try a different approach instead of retrying the same call.',
    'A single browser or web timeout is not final. Retry once with a corrected target or use another enabled acquisition path before concluding.',
    opts.loopMode === 'ongoing'
      ? 'Loop: ONGOING — keep iterating until done, blocked, or limits reached.'
      : 'Loop: BOUNDED — execute multiple steps but finish within recursion budget.',
  )

  if (hasMemoryTools) {
    parts.push(
      '## Immediate Memory Routes',
      'If the user asks you to remember, store, or correct a durable fact, call `memory_store` or `memory_update` immediately before any planning, delegation, task creation, or agent management.',
      'If the user asks about prior work, decisions, dates, people, preferences, or todos from earlier conversations, start with `memory_search`. Use `memory_get` only when you need one targeted follow-up read.',
      'Do not use `manage_tasks`, `manage_agents`, or `delegate` as a substitute for a direct memory write or recall step.',
    )
    if (opts.isDirectConnectorSession) {
      parts.push(
        'For direct connector chats, when storing a standing sender preference such as preferred name or reply medium, include structured `metadata.connectorPreference` fields so runtime can reuse them without reparsing prose.',
        'Use fields like `preferredDisplayName` and `preferredReplyMedium:"voice_note"` when they are relevant.',
      )
    }
  }
  if (hasTooling) {
    parts.push(
      '## Skill Runtime',
      'When the skill runtime section lists a fitting reusable workflow, use `use_skill` to select it before falling back to generic exploration.',
      'Prefer `use_skill` action `run` for executable skills and `use_skill` action `load` only when the skill is guidance-only.',
    )
  }
  if (opts.enabledPlugins.some((toolId) => (canonicalizePluginId(toolId) || toolId) === 'manage_skills')) {
    parts.push(
      '## Skill Resolution',
      'When you are blocked on a missing capability, binary, or environment setup, call `manage_skills` before repeating generic exploration.',
      'Use `manage_skills` action `recommend_for_task` or `status` to find a fitting local skill. If a fitting skill needs installation, request the explicit install approval through `manage_skills` and stop retrying the same blocker.',
      'Do not silently install skills during autonomous runs. Installation is explicit and approval-gated.',
    )
  }
  if (opts.hasAttachmentContext) {
    parts.push(
      '## Attachments',
      'User attachments (images, files, PDFs) are visible in this thread. Inspect attachment content before claiming it is unavailable. Extract identifiers from attachments and use enabled tools to continue.',
    )
  }

  // Tool-specific operating guidance (native capabilities first, then extensions)
  const guidanceLines = collectCapabilityOperatingGuidance(opts.enabledPlugins)
  if (guidanceLines.length) parts.push(...guidanceLines)

  // Response behavior
  parts.push(
    '## Response Rules',
    opts.allowSilentReplies
      ? 'NO_MESSAGE: use this only when no reply is actually needed. Do not use it for greetings, direct questions, or when the user is clearly opening a conversation.'
      : 'For direct user chats, always send a visible reply. Never answer with control tokens like NO_MESSAGE or HEARTBEAT_OK unless this is an explicit heartbeat poll.',
    'Execute by default — only confirm on high-risk actions.',
    'If a tool errors, retry or explain the blocker. Never claim success without evidence.',
    'Keep responses concise. Bullet points over prose. After file operations, confirm the result briefly (path and status) without echoing the full file contents.',
    'Do not end every reply with a question. Only ask when a specific missing detail blocks progress. When a task is done, state the result and stop.',
    opts.responseStyle === 'concise'
      ? `IMPORTANT: Be extremely concise.${opts.responseMaxChars ? ` Keep responses under ${opts.responseMaxChars} characters.` : ' Target under 500 characters.'} Lead with the answer, skip preamble.`
      : opts.responseStyle === 'detailed'
        ? 'Provide thorough, detailed explanations when helpful.'
        : '',
    `Heartbeat: if message is "${opts.heartbeatPrompt}", reply "HEARTBEAT_OK" unless you have a progress update.`,
  )

  if (toolDisciplineLines.length) parts.push('## Tool Discipline', ...toolDisciplineLines)
  if (pluginLines.length) parts.push('What I can do:\n' + pluginLines.join('\n'))
  if (opts.userMessage && isBroadGoal(opts.userMessage)) parts.push(GOAL_DECOMPOSITION_BLOCK)
  if (opts.userMessage && looksLikeExternalWalletTask(opts.userMessage)) {
    const externalExecutionBlock = buildExternalWalletExecutionBlock(opts.enabledPlugins)
    if (externalExecutionBlock) parts.push(externalExecutionBlock)
  }
  if (opts.userMessage && looksLikeOpenEndedDeliverableTask(opts.userMessage) && opts.enabledPlugins.some((toolId) => toolId === 'files' || toolId === 'edit_file')) {
    parts.push(OPEN_ENDED_REVISION_BLOCK)
  }
  if (opts.userMessage) {
    const exactStructureBlock = buildExactStructureBlock(opts.userMessage)
    if (exactStructureBlock) parts.push(exactStructureBlock)
  }
  if (opts.userMessage && isCurrentThreadRecallRequest(opts.userMessage)) {
    parts.push(buildCurrentThreadRecallBlock(opts.history || []))
  }

  return parts.filter(Boolean).join('\n')
}

function buildCurrentThreadRecallBlock(history: Message[]): string {
  const recentUserFacts = history
    .filter((entry) => entry.role === 'user' && typeof entry.text === 'string' && entry.text.trim())
    .slice(-3)
  const relevant = history
    .filter((entry) => (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string' && entry.text.trim())
    .slice(-6)
  const lines = [
    '## Current Thread Recall',
    'The user is asking about information from this same conversation.',
    'Treat the current chat history as the authoritative source for this request.',
    'Do NOT call memory tools, web search, or session-history tools unless the user explicitly asks you to verify outside the current thread.',
    'Answer directly from the existing conversation with the exact values already stated.',
    'Prefer the user\'s own earlier words and facts over assistant summaries, persona defaults, soul/config values, or generic background context.',
    'If the answer is present in the recent thread context below, do not say the information is missing, unknown, or from a first exchange.',
  ]
  if (recentUserFacts.length > 0) {
    lines.push('Recent user-provided facts to trust first:')
    for (const message of recentUserFacts) {
      const snippet = compactThreadRecallText(message.text || '')
      if (!snippet) continue
      lines.push(`- user: ${snippet}`)
    }
    lines.push('These user messages override tool traces, failed tool attempts, persona defaults, and generic background context.')
  }
  if (relevant.length > 0) {
    lines.push('Recent thread context:')
    for (const message of relevant) {
      const snippet = compactThreadRecallText(message.text || '')
      if (!snippet) continue
      lines.push(`- ${message.role}: ${snippet}`)
    }
  }
  return lines.join('\n')
}

function joinPromptSegments(...segments: Array<string | null | undefined>): string {
  return segments
    .map((segment) => (typeof segment === 'string' ? segment.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

function applyBeforePromptBuildResult(
  basePrompt: string,
  hookResult: PluginPromptBuildResult | null | undefined,
): string {
  if (!hookResult) return basePrompt

  const baseSystemPrompt = typeof hookResult.systemPrompt === 'string' && hookResult.systemPrompt.trim()
    ? hookResult.systemPrompt.trim()
    : basePrompt

  const systemPromptWithContext = joinPromptSegments(
    hookResult.prependSystemContext,
    baseSystemPrompt,
    hookResult.appendSystemContext,
  ) || baseSystemPrompt

  return joinPromptSegments(hookResult.prependContext, systemPromptWithContext) || systemPromptWithContext
}

export interface StreamAgentChatResult {
  /** All text accumulated across every LLM turn (for SSE / web UI history). */
  fullText: string
  /** Text from only the final LLM turn — after the last tool call completed.
   *  Use this for connector delivery so intermediate planning text isn't sent. */
  finalResponse: string
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
  const { session, message, imagePath, imageUrl, attachedFiles, apiKey, systemPrompt, write, history, fallbackCredentialIds, signal } = opts
  const isConnectorSession = isDirectConnectorSession(session)
  const rawPlugins = getEnabledCapabilityIds(session)
  const hasShellCapability = rawPlugins.some((toolId) => ['shell', 'execute_command'].includes(String(toolId)))
  const sessionPlugins = expandPluginIds([
    ...rawPlugins,
    ...(hasShellCapability ? ['process'] : []),
  ])

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
    if (settings.userPrompt) promptParts.push(settings.userPrompt)
    promptParts.push(buildCurrentDateTimePromptContext())
  }

  // Load agent context when a full prompt was not already composed by the route layer.
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
      // Identity block — make sure the agent knows who it is
      const identityLines = [`## My Identity`, `My name is ${agent?.name || 'Agent'}.`]
      if (agent?.description) identityLines.push(agent.description)
      identityLines.push('I should always refer to myself by this name. I am not "Assistant" — I have my own name and identity.')
      promptParts.push(identityLines.join(' '))
      const continuityBlock = buildIdentityContinuityContext(session, agent)
      if (continuityBlock) promptParts.push(continuityBlock)
      if (agent?.soul) promptParts.push(agent.soul)
      if (agent?.systemPrompt) promptParts.push(agent.systemPrompt)
      try {
        const allSkills = loadSkills()
        const runtimeSkills = resolveRuntimeSkills({
          cwd: session.cwd,
          enabledPlugins: sessionPlugins,
          agentId: agent?.id || null,
          sessionId: session.id,
          userId: session.user,
          agentSkillIds: agent?.skillIds || [],
          storedSkills: allSkills,
          selectedSkillId: session.skillRuntimeState?.selectedSkillId || null,
        })
        promptParts.push(...buildRuntimeSkillPromptBlocks(runtimeSkills))
      } catch { /* non-critical */ }
    }
  }

  // (conciseness and action-orientation are covered in the execution policy below)

  // Thinking level guidance (applies to all providers via system prompt)
  if (agentThinkingLevel) {
    const thinkingGuidance: Record<string, string> = {
      minimal: 'Be direct and concise. Skip extended analysis.',
      low: 'Keep reasoning brief. Focus on key conclusions.',
      medium: 'Provide moderate depth of analysis and reasoning.',
      high: 'Think deeply and thoroughly. Show detailed reasoning.',
    }
    promptParts.push(`## Reasoning Depth\n${thinkingGuidance[agentThinkingLevel]}`)
  }

  // Inject workspace context files only for agents with heartbeat enabled
  // (these files provide goals and autonomous operating context)
  if (!hasProvidedSystemPrompt && agentHeartbeatEnabled) {
    try {
      const { buildWorkspaceContext } = await import('@/lib/server/workspace-context')
      const wsCtx = buildWorkspaceContext({ cwd: session.cwd })
      if (wsCtx.block) promptParts.push(wsCtx.block)
    } catch {
      // Workspace context is non-critical
    }
  }

  // Inject agent awareness only if agent has delegation capabilities
  const hasDelegation = sessionPlugins.some(p => p === 'delegate' || p === 'spawn_subagent')
  if (hasDelegation && session.agentId) {
    try {
      const { buildAgentAwarenessBlock } = await import('@/lib/server/agents/agent-registry')
      const awarenessBlock = buildAgentAwarenessBlock(session.agentId)
      if (awarenessBlock) promptParts.push(awarenessBlock)
    } catch {
      // If agent registry fails, continue without blocking the run.
    }
  }

  // Collect dynamic context from enabled native capabilities and extensions.
  try {
    const pluginContextParts = await collectCapabilityAgentContext(session, sessionPlugins, message, history)
    promptParts.push(...pluginContextParts)
  } catch (err: unknown) {
    console.error('[stream-agent-chat] Capability context injection failed:', err instanceof Error ? err.message : String(err))
  }

  if (!hasProvidedSystemPrompt && activeProjectContext.projectId) {
    const projectLines = ['## Current Project']
    if (activeProjectContext.project?.name) {
      projectLines.push(`Active project: ${activeProjectContext.project.name}.`)
    } else {
      projectLines.push(`Active project ID: ${activeProjectContext.projectId}.`)
    }
    if (activeProjectContext.project?.description) {
      projectLines.push(`Project description: ${activeProjectContext.project.description}`)
      projectLines.push('Treat the project description above as authoritative context for who the project is for, what it is focused on, and which pilot priorities matter right now. If the user asks about the active project, answer from that description instead of saying the context is unavailable.')
    }
    if (activeProjectContext.objective) projectLines.push(`Project objective: ${activeProjectContext.objective}`)
    if (activeProjectContext.audience) projectLines.push(`Who it is for: ${activeProjectContext.audience}`)
    if (activeProjectContext.priorities.length > 0) projectLines.push(`Pilot priorities: ${activeProjectContext.priorities.join('; ')}`)
    if (activeProjectContext.openObjectives.length > 0) projectLines.push(`Open objectives: ${activeProjectContext.openObjectives.join('; ')}`)
    if (activeProjectContext.capabilityHints.length > 0) projectLines.push(`Suggested operating modes: ${activeProjectContext.capabilityHints.join('; ')}`)
    if (activeProjectContext.credentialRequirements.length > 0) projectLines.push(`Credential and secret requirements: ${activeProjectContext.credentialRequirements.join('; ')}`)
    if (activeProjectContext.successMetrics.length > 0) projectLines.push(`Success metrics: ${activeProjectContext.successMetrics.join('; ')}`)
    if (activeProjectContext.heartbeatPrompt) projectLines.push(`Preferred heartbeat prompt: ${activeProjectContext.heartbeatPrompt}`)
    if (activeProjectContext.heartbeatIntervalSec != null) projectLines.push(`Preferred heartbeat interval: ${activeProjectContext.heartbeatIntervalSec}s`)
    if (activeProjectContext.resourceSummary) {
      const summary = activeProjectContext.resourceSummary
      const resourceBits = [
        `open tasks ${summary.openTaskCount}`,
        `active schedules ${summary.activeScheduleCount}`,
        `project secrets ${summary.secretCount}`,
      ]
      if (summary.topTaskTitles.length > 0) projectLines.push(`Top open tasks: ${summary.topTaskTitles.join('; ')}`)
      if (summary.scheduleNames.length > 0) projectLines.push(`Active schedules: ${summary.scheduleNames.join('; ')}`)
      if (summary.secretNames.length > 0) projectLines.push(`Known project secrets: ${summary.secretNames.join('; ')}`)
      projectLines.push(`Project resource summary: ${resourceBits.join(', ')}.`)
    }
    if (activeProjectContext.projectRoot) projectLines.push(`Workspace root: ${activeProjectContext.projectRoot}`)
    projectLines.push('When creating project tasks, schedules, secrets, memories, or deliverables for this work, default them to the active project unless the user redirects you.')
    promptParts.push(projectLines.join('\n'))
  }

  // Tell the LLM about available tools/extensions and their access status
  {
    const agentEnabledSet = new Set(sessionPlugins)
    const { getPluginManager } = await import('@/lib/server/plugins')
    const allPlugins = [...listNativeCapabilities(), ...getPluginManager().listPlugins()]
    const mcpDisabled = agentMcpDisabledTools ?? []

    // Categorize native tools and extensions
    const globallyDisabled: string[] = [] // Disabled site-wide by admin
    const enabledButNoAccess: string[] = [] // Enabled globally but agent doesn't have access
    for (const p of allPlugins) {
      if (!p.enabled) {
        globallyDisabled.push(`${p.name} (${p.filename})`)
      } else if (!agentEnabledSet.has(p.filename)) {
        enabledButNoAccess.push(`${p.name} (${p.filename})`)
      }
    }

    const accessParts: string[] = []
    if (globallyDisabled.length > 0) {
      accessParts.push(`**Disabled site-wide:** ${globallyDisabled.join(', ')}`)
    }
    if (enabledButNoAccess.length > 0) {
      accessParts.push(`**Installed but not enabled in this chat:** ${enabledButNoAccess.join(', ')}`)
    }
    if (mcpDisabled.length > 0) {
      accessParts.push(`**MCP tools not available:** ${mcpDisabled.join(', ')}`)
    }
    if (accessParts.length > 0) {
      promptParts.push(`## Tool & Extension Access\n${accessParts.join('\n')}`)
    }
  }

  if (settings.suggestionsEnabled === true) {
    promptParts.push(
      [
        '## Follow-up Suggestions',
        'At the end of every response, include a <suggestions> block with exactly 3 short',
        'follow-up prompts the user might want to send next, as a JSON array. Keep each under 60 chars.',
        'Make them contextual to what you just said. Example:',
        '<suggestions>["Set up a Discord connector", "Create a research agent", "Show the task board"]</suggestions>',
      ].join('\n'),
    )
  }

  promptParts.push(
    buildAgenticExecutionPolicy({
      enabledPlugins: sessionPlugins,
      loopMode: runtime.loopMode,
      heartbeatPrompt,
      heartbeatIntervalSec,
      allowSilentReplies: isConnectorSession,
      isDirectConnectorSession: isConnectorSession,
      delegationEnabled: agentDelegationEnabled,
      userMessage: message,
      history,
      hasAttachmentContext,
      responseStyle: agentResponseStyle,
      responseMaxChars: agentResponseMaxChars,
    }),
  )

  // Proactive memory recall: inject relevant memories into context before LLM invocation
  // Skips heartbeat polls, very short messages, and thread-recall requests (which use chat history instead)
  if (session.agentId && !currentThreadRecallRequest && message.length > 12) {
    try {
      const agents = loadAgents()
      const agentForMemory = agents[session.agentId]
      if (agentForMemory?.proactiveMemory) {
        const { getMemoryDb } = await import('@/lib/server/memory/memory-db')
        const memDb = getMemoryDb()
        const recalled = memDb.search(message, session.agentId, {
          scope: buildSessionMemoryScopeFilter(session, agentForMemory?.memoryScopeMode || null, activeProjectContext.projectRoot),
        })
        const topRecalled = recalled.slice(0, 3)
        if (topRecalled.length > 0) {
          const recalledLines = topRecalled.map((entry) => `- ${entry.content.slice(0, 300)}`)
          promptParts.push(`## Recalled Context\nRelevant memories from previous interactions:\n${recalledLines.join('\n')}`)
        }
      }
    } catch {
      // Proactive memory recall is non-critical
    }
  }

  let prompt = promptParts.join('\n\n')
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
      // Detect actual MIME from magic bytes (fall back to extension-based)
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
        // Truncate very large PDFs to avoid token limits
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

  // Apply context-clear boundary: slice from most recent context-clear marker
  let contextStart = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].kind === 'context-clear') {
      contextStart = i + 1
      break
    }
  }
  const postClearHistory = history.slice(contextStart)

  // Hard cap: only send the most recent 30 messages to the LLM
  const recentHistory = postClearHistory.slice(-30)

  // Auto-compaction: only trigger if the messages we'll actually send exceed context limits.
  // The .slice(-30) hard cap already prevents context overflow for long conversations,
  // so this only fires for sessions with very large individual messages.
  let effectiveHistory = recentHistory
  try {
    const {
      shouldAutoCompact,
      llmCompact,
      estimateTokens,
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
    if (shouldAutoCompact(recentHistory, systemPromptTokens, session.provider, session.model, 80, {
      extraTokens: pendingInputTokens + CONTEXT_WARNING_OVERHEAD_TOKENS,
      reserveTokens,
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
        (result.summaryAdded ? ' (LLM summary)' : ' (sliding window fallback)'),
      )
    }
  } catch {
    // Context manager failure — continue with recent history
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
    { enabledIds: sessionPlugins },
  )
  prompt = applyBeforePromptBuildResult(prompt, promptHookResult)

  // Context degradation warning: prepend warning to system prompt when nearing limits
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
      },
    )
    if (warning) {
      prompt = joinPromptSegments(warning, prompt)
    }
  } catch {
    // Warning failure is non-critical
  }

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
    { enabledIds: sessionPlugins },
  )

  const endToolBuildPerf = perf.start('stream-agent-chat', 'buildSessionTools', { sessionId: session.id })
  const { tools, cleanup, toolToPluginMap, abortSignalRef } = await buildSessionTools(session.cwd, sessionPlugins, {
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
      return { warning: preview.message }
    },
    onToolCallWarning: ({ toolName, message }) => {
      write(`data: ${JSON.stringify({
        t: 'status',
        text: JSON.stringify({
          toolWarning: toolName,
          severity: 'warning',
          message,
          phase: 'before_tool_call',
        }),
      })}\n\n`)
    },
  })
  endToolBuildPerf({ toolCount: tools.length })

  // Use a fresh in-memory checkpointer instead of the SQLite one.  We manage
  // conversation history externally via langchainMessages — each iteration
  // receives full history, so no cross-iteration checkpoint state is needed.
  // MemorySaver avoids the SQLite serde round-trip that dropped tool_call IDs
  // or ToolMessages, causing OpenAI to reject with "tool_calls must be
  // followed by tool messages" errors.
  const agent = createReactAgent({
    llm,
    tools,
    prompt,
    checkpointer: new MemorySaver(),
  })
  let pendingGraphMessages = [...langchainMessages]

  let fullText = ''
  let lastSegment = ''
  let lastSettledSegment = ''
  let hasToolCalls = false
  let needsTextSeparator = false
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let accumulatedThinking = ''
  const pluginInvocations: PluginInvocationRecord[] = []
  const streamedToolEvents: MessageToolEvent[] = []
  let currentToolInputTokens = 0
  const boundedExternalExecutionTask = looksLikeBoundedExternalExecutionTask(message)
  const routingDecision = routeTaskIntent(message, sessionPlugins, null)
  const likelyResearchSynthesisTask = routingDecision.intent === 'research' || routingDecision.intent === 'browsing'

  await runCapabilityHook('beforeAgentStart', { session, message }, { enabledIds: sessionPlugins })

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

  const MAX_AUTO_CONTINUES = 3
  const MAX_TRANSIENT_RETRIES = 3
  const MAX_REQUIRED_TOOL_CONTINUES = 2
  const MAX_MEMORY_WRITE_FOLLOWTHROUGHS = 2
  let MAX_EXECUTION_FOLLOWTHROUGHS = 1
  const MAX_EXECUTION_KICKOFF_FOLLOWTHROUGHS = 1
  let MAX_ATTACHMENT_FOLLOWTHROUGHS = 1
  let MAX_DELIVERABLE_FOLLOWTHROUGHS = 2
  let MAX_UNFINISHED_TOOL_FOLLOWTHROUGHS = 2
  const MAX_TOOL_ERROR_FOLLOWTHROUGHS = 2
  let MAX_TOOL_SUMMARY_RETRIES = 2

  // Connector sessions (WhatsApp, Discord, etc.) don't need aggressive
  // follow-ups — short replies are normal for chat platforms.
  if (isConnectorSession) {
    MAX_DELIVERABLE_FOLLOWTHROUGHS = 0
    MAX_EXECUTION_FOLLOWTHROUGHS = 0
    MAX_ATTACHMENT_FOLLOWTHROUGHS = 0
    MAX_TOOL_SUMMARY_RETRIES = 1
    MAX_UNFINISHED_TOOL_FOLLOWTHROUGHS = 1
  }
  const REQUIRED_TOOL_KICKOFF_TIMEOUT_MS = runtime.requiredToolKickoffMs
  let autoContinueCount = 0
  let transientRetryCount = 0
  let pendingRetryAfterMs: number | null = null
  let requiredToolContinueCount = 0
  let memoryWriteFollowthroughCount = 0
  let executionFollowthroughCount = 0
  let executionKickoffFollowthroughCount = 0
  let attachmentFollowthroughCount = 0
  let deliverableFollowthroughCount = 0
  let unfinishedToolFollowthroughCount = 0
  let toolErrorFollowthroughCount = 0
  let toolSummaryRetryCount = 0
  const explicitRequiredToolNames = getExplicitRequiredToolNames(message, sessionPlugins)
  const shouldEnforceEarlyRequiredToolKickoff = explicitRequiredToolNames.length > 0
    && looksLikeOpenEndedDeliverableTask(message)
  const usedToolNames = new Set<string>()
  let loopDetectionTriggered: LoopDetectionResult | null = null
  let terminalToolBoundary: 'durable_wait' | 'context_compaction' | null = null
  let terminalToolResponse = ''

  try {
  const maxIterations = MAX_AUTO_CONTINUES + MAX_TRANSIENT_RETRIES + MAX_REQUIRED_TOOL_CONTINUES + MAX_MEMORY_WRITE_FOLLOWTHROUGHS + MAX_EXECUTION_KICKOFF_FOLLOWTHROUGHS + MAX_EXECUTION_FOLLOWTHROUGHS + MAX_DELIVERABLE_FOLLOWTHROUGHS + MAX_UNFINISHED_TOOL_FOLLOWTHROUGHS + MAX_TOOL_ERROR_FOLLOWTHROUGHS + MAX_TOOL_SUMMARY_RETRIES
    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let shouldContinue: ContinuationType = false
      let requiredToolReminderNames: string[] = []
      let waitingForToolResult = false
      let idleTimedOut = false
      let reachedExecutionBoundary = false
      let executionFollowthroughReason: 'research_limit' | 'post_simulation' | null = null
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let requiredToolKickoffTimer: ReturnType<typeof setTimeout> | null = null
      let requiredToolKickoffTimedOut = false
      let iterationText = ''
      const iterationStartState: {
        fullText: string
        lastSegment: string
        lastSettledSegment: string
        needsTextSeparator: boolean
        accumulatedThinking: string
        hasToolCalls: boolean
        toolEventCount: number
      } = {
        fullText,
        lastSegment,
        lastSettledSegment,
        needsTextSeparator,
        accumulatedThinking,
        hasToolCalls,
        toolEventCount: streamedToolEvents.length,
      }

      // Fresh per-iteration controller so an internal LangGraph abort doesn't poison subsequent iterations.
      // Linked to the parent so client disconnect / timeout still propagates.
      const iterationController = new AbortController()
      const onParentAbort = () => iterationController.abort()
      if (abortController.signal.aborted) iterationController.abort()
      else abortController.signal.addEventListener('abort', onParentAbort)

      const clearIdleWatchdog = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      const clearRequiredToolKickoff = () => {
        if (requiredToolKickoffTimer) {
          clearTimeout(requiredToolKickoffTimer)
          requiredToolKickoffTimer = null
        }
      }

      const armIdleWatchdog = () => {
        clearIdleWatchdog()
        if (waitingForToolResult || iterationController.signal.aborted) return
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          iterationController.abort()
        }, runtime.streamIdleStallMs)
      }

      const armRequiredToolKickoff = () => {
        clearRequiredToolKickoff()
        if (!shouldEnforceEarlyRequiredToolKickoff) return
        if (iteration > 0 || waitingForToolResult || hasToolCalls || iterationController.signal.aborted) return
        requiredToolKickoffTimer = setTimeout(() => {
          if (waitingForToolResult || hasToolCalls || iterationController.signal.aborted) return
          requiredToolKickoffTimedOut = true
          iterationController.abort()
        }, REQUIRED_TOOL_KICKOFF_TIMEOUT_MS)
      }

      // Only track tool events emitted by the LangGraph tool node itself.
      // Internal wrapper/invoke events do not carry the same metadata and would
      // otherwise look like duplicate tool calls.
      const toolEventTracker = new LangGraphToolEventTracker()
      const toolPerfEnds = new Map<string, (extra?: Record<string, unknown>) => number>()
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

      try {
        armIdleWatchdog()
        armRequiredToolKickoff()

        for await (const event of eventStream) {
          const kind = event.event

          if (kind === 'on_chat_model_stream') {
            armIdleWatchdog()
            const chunk = event.data?.chunk
            if (chunk?.content) {
              // content can be string or array of content blocks
              if (Array.isArray(chunk.content)) {
                for (const block of chunk.content) {
                  // Anthropic extended thinking blocks
                  if (block.type === 'thinking' && block.thinking) {
                    accumulatedThinking += block.thinking
                    write(`data: ${JSON.stringify({ t: 'thinking', text: block.thinking })}\n\n`)
                  // [[thinking]] prefix convention
                  } else if (typeof block.text === 'string' && block.text.startsWith('[[thinking]]')) {
                    accumulatedThinking += block.text.slice(12)
                    write(`data: ${JSON.stringify({ t: 'thinking', text: block.text.slice(12) })}\n\n`)
                  } else if (block.text) {
                    if (needsTextSeparator && fullText.length > 0) {
                      fullText += '\n\n'
                      iterationText += '\n\n'
                      write(`data: ${JSON.stringify({ t: 'd', text: '\n\n' })}\n\n`)
                      needsTextSeparator = false
                    }
                    fullText += block.text
                    iterationText += block.text
                    lastSegment += block.text
                    write(`data: ${JSON.stringify({ t: 'd', text: block.text })}\n\n`)
                  }
                }
              } else {
                const text = typeof chunk.content === 'string' ? chunk.content : ''
                if (text) {
                  if (needsTextSeparator && fullText.length > 0) {
                    fullText += '\n\n'
                    iterationText += '\n\n'
                    write(`data: ${JSON.stringify({ t: 'd', text: '\n\n' })}\n\n`)
                    needsTextSeparator = false
                  }
                  fullText += text
                  iterationText += text
                  lastSegment += text
                  write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
                }
              }
            }
          } else if (kind === 'on_llm_end') {
            armIdleWatchdog()
            // Track token usage from LLM responses — check all known LangChain event shapes
            const output = event.data?.output
            const usage = output?.llmOutput?.tokenUsage
              || output?.llmOutput?.usage
              || output?.usage_metadata
              || output?.response_metadata?.usage
              || output?.response_metadata?.tokenUsage
            if (usage) {
              totalInputTokens += usage.promptTokens || usage.input_tokens || usage.prompt_tokens || 0
              totalOutputTokens += usage.completionTokens || usage.output_tokens || usage.completion_tokens || 0
            }
          } else if (kind === 'on_tool_start') {
            if (!toolEventTracker.acceptStart(event)) continue
            const toolName = event.name || 'unknown'
            const input = event.data?.input
            const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
            toolPerfEnds.set(event.run_id, perf.start('tool-call', toolName, { sessionId: session.id }))

            clearIdleWatchdog()
            clearRequiredToolKickoff()
            waitingForToolResult = true
            hasToolCalls = true
            needsTextSeparator = true
            const settledSegment = extractSuggestions(lastSegment).clean.trim()
            if (settledSegment) lastSettledSegment = settledSegment
            lastSegment = ''
            usedToolNames.add(canonicalizePluginId(toolName) || toolName)
            // Shell-based HTTP (curl/wget/gh) satisfies research tool requirements —
            // don't force the agent to also use web_search when shell already fetched the data.
            if ((canonicalizePluginId(toolName) || toolName) === 'shell' && inputStr) {
              const cmdMatch = /curl|wget|http|gh\s+(issue|pr|api|repo|release|search|run)/.test(inputStr)
              if (cmdMatch) usedToolNames.add('web')
            }
            // Estimate input tokens for plugin invocation tracking
            currentToolInputTokens = Math.ceil((inputStr?.length || 0) / 4)
            logExecution(session.id, 'tool_call', `${toolName} invoked`, {
              agentId: session.agentId,
              detail: { toolName, input: inputStr?.slice(0, 4000) },
            })
            write(`data: ${JSON.stringify({
              t: 'tool_call',
              toolName,
              toolInput: inputStr,
              toolCallId: event.run_id,
            })}\n\n`)
            updateStreamedToolEvents(streamedToolEvents, {
              type: 'call',
              name: toolName,
              input: inputStr,
              toolCallId: event.run_id,
            })
          } else if (kind === 'on_tool_end') {
            if (!toolEventTracker.complete(event.run_id)) continue
            const endToolPerf = toolPerfEnds.get(event.run_id)
            toolPerfEnds.delete(event.run_id)

            waitingForToolResult = toolEventTracker.pendingCount > 0
            if (!waitingForToolResult) armIdleWatchdog()
            const toolName = event.name || 'unknown'
            const output = event.data?.output
            const rawOutputStr = typeof output === 'string'
              ? output
              : output?.content
                ? String(output.content)
                : JSON.stringify(output)
            // Apply tool result size guard to prevent context window blowout
            const { getContextWindowSize } = await import('@/lib/server/context-manager')
            const maxResultChars = calculateMaxToolResultChars(getContextWindowSize(session.provider, session.model))
            const outputStr = truncateToolResultText(rawOutputStr, maxResultChars)
            logExecution(session.id, 'tool_result', `${toolName} returned`, {
              agentId: session.agentId,
              detail: { toolName, output: outputStr?.slice(0, 4000), error: /^(Error:|error:)/i.test((outputStr || '').trim()) || undefined },
            })
            // Enriched file_op logging for file-mutating tools
            if (['write_file', 'edit_file', 'copy_file', 'move_file', 'delete_file'].includes(toolName)) {
              const inputData = event.data?.input
              const inputObj = typeof inputData === 'object' ? inputData : {}
              logExecution(session.id, 'file_op', `${toolName}: ${inputObj?.filePath || inputObj?.sourcePath || 'unknown'}`, {
                agentId: session.agentId,
                detail: { toolName, filePath: inputObj?.filePath, sourcePath: inputObj?.sourcePath, destinationPath: inputObj?.destinationPath, success: !/^Error/i.test((outputStr || '').trim()) },
              })
            }
            // Enriched commit logging for git operations
            if (toolName === 'execute_command' && outputStr) {
              const commitMatch = outputStr.match(/\[[\w/-]+\s+([a-f0-9]{7,40})\]/)
              if (commitMatch) {
                logExecution(session.id, 'commit', `git commit ${commitMatch[1]}`, {
                  agentId: session.agentId,
                  detail: { commitId: commitMatch[1], outputPreview: outputStr.slice(0, 500) },
                })
              }
            }
            // Track plugin invocation token estimates
            const pluginId = toolToPluginMap[toolName] || '_unknown'
            pluginInvocations.push({
              pluginId,
              toolName,
              inputTokens: currentToolInputTokens,
              outputTokens: Math.ceil((outputStr?.length || 0) / 4),
            })
            currentToolInputTokens = 0

            // --- Tool loop detection ---
            const loopResult = loopTracker.record(toolName, event.data?.input, output)
            if (loopResult) {
              logExecution(session.id, 'loop_detection', loopResult.message, {
                agentId: session.agentId,
                detail: { detector: loopResult.detector, severity: loopResult.severity, toolName },
              })
              if (loopResult.severity === 'critical') {
                loopDetectionTriggered = loopResult
                write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ loopDetection: loopResult.detector, severity: 'critical', message: loopResult.message }) })}\n\n`)
                break
              }
              if (loopResult.severity === 'warning') {
                write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ loopDetection: loopResult.detector, severity: 'warning', message: loopResult.message }) })}\n\n`)
              }
            }

            endToolPerf?.({ outputLen: outputStr?.length || 0 })
            write(`data: ${JSON.stringify({
              t: 'tool_result',
              toolName,
              toolOutput: outputStr?.slice(0, 2000),
              toolCallId: event.run_id,
            })}\n\n`)
            updateStreamedToolEvents(streamedToolEvents, {
              type: 'result',
              name: toolName,
              output: outputStr,
              toolCallId: event.run_id,
            })
            const toolBoundary = resolveSuccessfulTerminalToolBoundary({
              toolName,
              toolInput: event.data?.input,
              toolOutput: outputStr || '',
            })
            if (toolBoundary) {
              if (toolBoundary.kind === 'memory_write') {
                if (iterationText.trim() || fullText.trim()) {
                  write(`data: ${JSON.stringify({ t: 'reset', text: '' })}\n\n`)
                }
                shouldContinue = 'memory_write_followthrough'
                memoryWriteFollowthroughCount = Math.max(memoryWriteFollowthroughCount, 1)
                fullText = ''
                iterationText = ''
                lastSegment = ''
                lastSettledSegment = ''
                needsTextSeparator = false
                logExecution(session.id, 'decision', 'Successful memory write completed; requesting natural acknowledgement followthrough.', {
                  agentId: session.agentId,
                  detail: { toolName, action: resolveToolAction(event.data?.input) || null, boundary: toolBoundary.kind },
                })
                write(`data: ${JSON.stringify({
                  t: 'status',
                  text: JSON.stringify({ terminalToolResult: toolBoundary.kind }),
                })}\n\n`)
                break
              }
              terminalToolBoundary = toolBoundary.kind
              terminalToolResponse = 'responseText' in toolBoundary ? (toolBoundary.responseText || '') : ''
              if (terminalToolResponse) {
                lastSegment = terminalToolResponse
                lastSettledSegment = terminalToolResponse
              }
              logExecution(session.id, 'decision', `Terminal tool boundary reached: ${toolBoundary.kind}.`, {
                agentId: session.agentId,
                detail: { toolName, action: resolveToolAction(event.data?.input) || null, boundary: toolBoundary.kind },
              })
              write(`data: ${JSON.stringify({
                t: 'status',
                text: JSON.stringify({ terminalToolResult: toolBoundary.kind }),
              })}\n\n`)
              break
            }
            if (boundedExternalExecutionTask && getWalletApprovalBoundaryAction(outputStr || '')) {
              reachedExecutionBoundary = true
              write(`data: ${JSON.stringify({
                t: 'status',
                text: JSON.stringify({ executionBoundary: 'wallet_approval' }),
              })}\n\n`)
              break
            }
            if (
              boundedExternalExecutionTask
              && ['http_request', 'web', 'web_search', 'web_fetch', 'browser'].includes(toolName)
              && !hasStateChangingWalletEvidence(streamedToolEvents)
              && countExternalExecutionResearchSteps(streamedToolEvents) >= 5
              && countDistinctExternalResearchHosts(streamedToolEvents) >= 3
            ) {
              executionFollowthroughReason = 'research_limit'
              write(`data: ${JSON.stringify({
                t: 'status',
                text: JSON.stringify({ executionBoundary: 'research_limit' }),
              })}\n\n`)
              break
            }
            if (
              boundedExternalExecutionTask
              && !hasStateChangingWalletEvidence(streamedToolEvents)
              && isWalletSimulationResult(toolName, outputStr || '')
            ) {
              executionFollowthroughReason = 'post_simulation'
              write(`data: ${JSON.stringify({
                t: 'status',
                text: JSON.stringify({ executionBoundary: 'post_simulation' }),
              })}\n\n`)
              break
            }
          }
        }
      } catch (innerErr: unknown) {
        const errName = innerErr instanceof Error ? innerErr.constructor.name : ''
        const errMsg = idleTimedOut
          ? `Model stream stalled without emitting text or tool results for ${Math.trunc(runtime.streamIdleStallMs / 1000)} seconds.`
          : requiredToolKickoffTimedOut
            ? `The turn did not start the required workspace tool step within ${Math.trunc(REQUIRED_TOOL_KICKOFF_TIMEOUT_MS / 1000)} seconds.`
          : errorMessage(innerErr)
        const errStack = innerErr instanceof Error ? innerErr.stack?.slice(0, 500) : undefined

        // Classify the error:
        // 1. GraphRecursionError — explicit or wrapped as abort (LangGraph aborts internally on limit)
        // 2. Transient abort/timeout — LLM API failure, not from client disconnect
        const isRecursionError = errName === 'GraphRecursionError'
          || /recursion limit|maximum recursion/i.test(errMsg)
        const { statusCode, retryAfterMs: extractedRetryAfterMs } = extractProviderErrorInfo(innerErr)
        const isTransientProviderError = !isRecursionError && (
          [429, 500, 502, 503, 504].includes(statusCode)
          || /^(InternalServerError|RateLimitError|APIConnectionError|APIConnectionTimeoutError)$/i.test(errName)
          // Fallback: still check message for providers that don't set .status
          || /internal server error|too many requests|rate limit|service unavailable|bad gateway|gateway timeout|overloaded/i.test(errMsg)
        )
        const isTransientAbort = (!isRecursionError && idleTimedOut)
          || (!isRecursionError
          && /abort|timed?\s*out|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(errMsg)
          && !abortController.signal.aborted)
          || (isTransientProviderError && !abortController.signal.aborted)

        // Log diagnostic details for every error so we can trace root causes
        console.error(`[stream-agent-chat] Error in streamEvents iteration=${iteration}`, {
          errName, errMsg, errStack,
          statusCode, retryAfterMs: extractedRetryAfterMs,
          isRecursionError, isTransientAbort,
          hasToolCalls, fullTextLen: fullText.length,
          parentAborted: abortController.signal.aborted,
        })

        if (requiredToolKickoffTimedOut && requiredToolContinueCount < MAX_REQUIRED_TOOL_CONTINUES && !abortController.signal.aborted) {
          const hadPartialOutput = iterationText.length > 0 || streamedToolEvents.length > iterationStartState.toolEventCount
          fullText = iterationStartState.fullText
          lastSegment = iterationStartState.lastSegment
          lastSettledSegment = iterationStartState.lastSettledSegment
          needsTextSeparator = iterationStartState.needsTextSeparator
          accumulatedThinking = iterationStartState.accumulatedThinking
          hasToolCalls = iterationStartState.hasToolCalls
          streamedToolEvents.length = iterationStartState.toolEventCount
          requiredToolReminderNames = explicitRequiredToolNames.filter((toolName) => {
            const canonical = canonicalizePluginId(toolName) || toolName
            return !usedToolNames.has(toolName) && !usedToolNames.has(canonical)
          })
          if (requiredToolReminderNames.length === 0) requiredToolReminderNames = [...explicitRequiredToolNames]
          shouldContinue = 'required_tool'
          requiredToolContinueCount++
          logExecution(session.id, 'decision', `Required tool kickoff timed out, forcing tool reminder (${requiredToolContinueCount}/${MAX_REQUIRED_TOOL_CONTINUES})`, {
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
              reminderCount: requiredToolContinueCount,
              maxReminders: MAX_REQUIRED_TOOL_CONTINUES,
              reason: 'tool_kickoff_timeout',
            }),
          })}\n\n`)
        } else if (isRecursionError && autoContinueCount < MAX_AUTO_CONTINUES && !abortController.signal.aborted) {
          shouldContinue = 'recursion'
          autoContinueCount++
          logExecution(session.id, 'decision', `Recursion limit hit, auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUES})`, {
            agentId: session.agentId,
            detail: { errName, errMsg },
          })
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ autoContinue: autoContinueCount, maxContinues: MAX_AUTO_CONTINUES }) })}\n\n`)
        } else if (isTransientAbort && transientRetryCount < MAX_TRANSIENT_RETRIES && !abortController.signal.aborted) {
          // Reset client-side accumulated state — partial text/tool events from the
          // failed iteration can't be un-sent, so tell the client to clear them.
          const hadPartialOutput = iterationText.length > 0 || streamedToolEvents.length > iterationStartState.toolEventCount
          fullText = iterationStartState.fullText
          lastSegment = iterationStartState.lastSegment
          lastSettledSegment = iterationStartState.lastSettledSegment
          needsTextSeparator = iterationStartState.needsTextSeparator
          accumulatedThinking = iterationStartState.accumulatedThinking
          hasToolCalls = iterationStartState.hasToolCalls
          streamedToolEvents.length = iterationStartState.toolEventCount
          shouldContinue = 'transient'
          transientRetryCount++
          pendingRetryAfterMs = extractedRetryAfterMs
          logExecution(session.id, 'decision', `Transient error, retrying (${transientRetryCount}/${MAX_TRANSIENT_RETRIES}): ${errMsg}`, {
            agentId: session.agentId,
            detail: { errName, errMsg, statusCode, retryAfterMs: extractedRetryAfterMs, hadPartialOutput },
          })
          if (hadPartialOutput) {
            write(`data: ${JSON.stringify({ t: 'reset', text: iterationStartState.fullText })}\n\n`)
          }
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ transientRetry: transientRetryCount, maxRetries: MAX_TRANSIENT_RETRIES, error: errMsg }) })}\n\n`)
        } else {
          // Non-retryable error or exhausted retries — rethrow to outer catch
          throw innerErr
        }
      } finally {
        clearIdleWatchdog()
        clearRequiredToolKickoff()
        abortController.signal.removeEventListener('abort', onParentAbort)
      }

      if (reachedExecutionBoundary) break

      if (terminalToolBoundary) {
        const completedToolEvents = pruneIncompleteToolEvents(streamedToolEvents)
        streamedToolEvents.length = 0
        streamedToolEvents.push(...completedToolEvents)
        break
      }

      if (!shouldContinue
        && toolEventTracker.pendingCount > 0
        && !abortController.signal.aborted) {
        if (looksLikeOpenEndedDeliverableTask(message) && deliverableFollowthroughCount < MAX_DELIVERABLE_FOLLOWTHROUGHS) {
          shouldContinue = 'deliverable_followthrough'
          deliverableFollowthroughCount++
          write(`data: ${JSON.stringify({
            t: 'status',
            text: JSON.stringify({
              deliverableFollowthrough: deliverableFollowthroughCount,
              maxFollowthroughs: MAX_DELIVERABLE_FOLLOWTHROUGHS,
              reason: 'unfinished_tool_calls',
              pendingToolCallIds: toolEventTracker.listPendingRunIds(),
            }),
          })}\n\n`)
        } else if (unfinishedToolFollowthroughCount < MAX_UNFINISHED_TOOL_FOLLOWTHROUGHS) {
          shouldContinue = 'unfinished_tool_followthrough'
          unfinishedToolFollowthroughCount++
          write(`data: ${JSON.stringify({
            t: 'status',
            text: JSON.stringify({
              unfinishedToolFollowthrough: unfinishedToolFollowthroughCount,
              maxFollowthroughs: MAX_UNFINISHED_TOOL_FOLLOWTHROUGHS,
              pendingToolCallIds: toolEventTracker.listPendingRunIds(),
            }),
          })}\n\n`)
        }
      }

      // Tool loop detection: critical severity stops further tool calls.
      // However, if tools already produced results but the model has no/trivial text,
      // we attempt a tool_summary continuation instead of just erroring out.
      if (loopDetectionTriggered) {
        const skipToolSummaryForShortResponse = shouldSkipToolSummaryForShortResponse({
          fullText,
          toolEvents: streamedToolEvents,
          isConnectorSession,
        })
        const loopTextIsTrivial = !fullText.trim() || (
          !skipToolSummaryForShortResponse
          && fullText.trim().length < 150
          && streamedToolEvents.length >= 2
        )
        if (loopTextIsTrivial && streamedToolEvents.length > 0 && toolSummaryRetryCount < MAX_TOOL_SUMMARY_RETRIES) {
          // Override: let the tool_summary check below handle it instead of breaking
          loopDetectionTriggered = null
        } else {
          write(`data: ${JSON.stringify({ t: 'err', text: loopDetectionTriggered.message })}\n\n`)
          break
        }
      }

      if (
        executionFollowthroughReason
        && !shouldContinue
        && executionFollowthroughCount < MAX_EXECUTION_FOLLOWTHROUGHS
      ) {
        shouldContinue = 'execution_followthrough'
        executionFollowthroughCount++
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            externalExecutionFollowthrough: executionFollowthroughCount,
            maxFollowthroughs: MAX_EXECUTION_FOLLOWTHROUGHS,
            reason: executionFollowthroughReason,
          }),
        })}\n\n`)
      }

      if (!shouldContinue && explicitRequiredToolNames.length > 0 && requiredToolContinueCount < MAX_REQUIRED_TOOL_CONTINUES) {
        // Canonicalize required tool names before comparing — tool planning uses
        // alias names (e.g. web_search) while LangGraph emits canonical names (e.g. web).
        requiredToolReminderNames = explicitRequiredToolNames.filter((toolName) => {
          const canonical = canonicalizePluginId(toolName) || toolName
          return !usedToolNames.has(toolName) && !usedToolNames.has(canonical)
        })
        if (requiredToolReminderNames.length > 0) {
          shouldContinue = 'required_tool'
          requiredToolContinueCount++
          write(`data: ${JSON.stringify({
            t: 'status',
            text: JSON.stringify({
              requiredToolsPending: requiredToolReminderNames,
              reminderCount: requiredToolContinueCount,
              maxReminders: MAX_REQUIRED_TOOL_CONTINUES,
            }),
          })}\n\n`)
        }
      }

      if (!shouldContinue
        && !fullText.trim()
        && hasOnlySuccessfulMemoryMutationToolEvents(streamedToolEvents)
        && memoryWriteFollowthroughCount < MAX_MEMORY_WRITE_FOLLOWTHROUGHS
      ) {
        shouldContinue = 'memory_write_followthrough'
        memoryWriteFollowthroughCount++
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            memoryWriteFollowthrough: memoryWriteFollowthroughCount,
            maxFollowthroughs: MAX_MEMORY_WRITE_FOLLOWTHROUGHS,
            reason: 'empty_reply_after_memory_write',
          }),
        })}\n\n`)
      }

      if (!shouldContinue
        && attachmentFollowthroughCount < MAX_ATTACHMENT_FOLLOWTHROUGHS
        && shouldForceAttachmentFollowthrough({
          userMessage: message,
          enabledPlugins: sessionPlugins,
          hasToolCalls,
          hasAttachmentContext,
        })) {
        shouldContinue = 'attachment_followthrough'
        attachmentFollowthroughCount++
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            attachmentFollowthrough: attachmentFollowthroughCount,
            maxFollowthroughs: MAX_ATTACHMENT_FOLLOWTHROUGHS,
          }),
        })}\n\n`)
      }

      if (!shouldContinue
        && executionKickoffFollowthroughCount < MAX_EXECUTION_KICKOFF_FOLLOWTHROUGHS
        && shouldForceExternalExecutionKickoffFollowthrough({
          userMessage: message,
          finalResponse: resolveFinalStreamResponseText({
            fullText,
            lastSegment,
            lastSettledSegment,
            hasToolCalls,
            toolEvents: streamedToolEvents,
          }),
          hasToolCalls,
          toolEvents: streamedToolEvents,
        })) {
        shouldContinue = 'execution_kickoff_followthrough'
        executionKickoffFollowthroughCount++
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            externalExecutionKickoff: executionKickoffFollowthroughCount,
            maxFollowthroughs: MAX_EXECUTION_KICKOFF_FOLLOWTHROUGHS,
          }),
        })}\n\n`)
      }

      if (!shouldContinue
        && executionFollowthroughCount < MAX_EXECUTION_FOLLOWTHROUGHS
        && shouldForceExternalExecutionFollowthrough({
          userMessage: message,
          finalResponse: resolveFinalStreamResponseText({
            fullText,
            lastSegment,
            lastSettledSegment,
            hasToolCalls,
            toolEvents: streamedToolEvents,
          }),
          hasToolCalls,
          toolEvents: streamedToolEvents,
        })) {
        shouldContinue = 'execution_followthrough'
        executionFollowthroughCount++
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            externalExecutionFollowthrough: executionFollowthroughCount,
            maxFollowthroughs: MAX_EXECUTION_FOLLOWTHROUGHS,
          }),
        })}\n\n`)
      }

      if (!shouldContinue
        && deliverableFollowthroughCount < MAX_DELIVERABLE_FOLLOWTHROUGHS
        && shouldForceDeliverableFollowthrough({
          userMessage: message,
          finalResponse: resolveFinalStreamResponseText({
            fullText,
            lastSegment,
            lastSettledSegment,
            hasToolCalls,
            toolEvents: streamedToolEvents,
          }),
          hasToolCalls,
          toolEvents: streamedToolEvents,
          cwd: session.cwd,
        })) {
        shouldContinue = 'deliverable_followthrough'
        deliverableFollowthroughCount++
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            deliverableFollowthrough: deliverableFollowthroughCount,
            maxFollowthroughs: MAX_DELIVERABLE_FOLLOWTHROUGHS,
          }),
        })}\n\n`)
      }

      if (
        !shouldContinue
        && hasIncompleteDelegationWait(streamedToolEvents)
      ) {
        shouldContinue = 'unfinished_tool_followthrough'
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({ unfinishedDelegation: true }),
        })}\n\n`)
      }

      if (
        !shouldContinue
        && toolErrorFollowthroughCount < MAX_TOOL_ERROR_FOLLOWTHROUGHS
        && shouldForceRecoverableToolErrorFollowthrough({
          userMessage: message,
          finalResponse: resolveFinalStreamResponseText({
            fullText,
            lastSegment,
            lastSettledSegment,
            hasToolCalls,
            toolEvents: streamedToolEvents,
          }),
          hasToolCalls,
          toolEvents: streamedToolEvents,
        })
      ) {
        shouldContinue = 'tool_error_followthrough'
        toolErrorFollowthroughCount++
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({
            toolErrorRecovery: toolErrorFollowthroughCount,
            maxFollowthroughs: MAX_TOOL_ERROR_FOLLOWTHROUGHS,
          }),
        })}\n\n`)
      }

      // Generic fallback: tools were called but the model produced no substantive text.
      // Triggers when: (a) text is empty, or (b) text is trivially short (< 150 chars)
      // and multiple tools ran — the agent likely emitted a "I'll do X" preamble but
      // never synthesized the tool outputs into a real response.
      const skipToolSummaryForShortResponse = shouldSkipToolSummaryForShortResponse({
        fullText,
        toolEvents: streamedToolEvents,
        isConnectorSession,
      })
      const textIsTrivial = !fullText.trim() || (
        !skipToolSummaryForShortResponse
        && !isConnectorSession && fullText.trim().length < 150
        && (
          streamedToolEvents.length >= 2
          || likelyResearchSynthesisTask
          || looksLikeOpenEndedDeliverableTask(message)
        )
      )
      if (
        !shouldContinue
        && hasToolCalls
        && textIsTrivial
        && streamedToolEvents.length > 0
        && !skipToolSummaryForShortResponse
        && toolSummaryRetryCount < MAX_TOOL_SUMMARY_RETRIES
      ) {
        shouldContinue = 'tool_summary'
        toolSummaryRetryCount++
        logExecution(session.id, 'decision', `Tools called but response text is trivial (${fullText.trim().length} chars) — forcing summary continuation`, {
          agentId: session.agentId,
          detail: { toolEventCount: streamedToolEvents.length, toolSummaryRetryCount, textLength: fullText.trim().length },
        })
        const summaryReason = !fullText.trim() ? 'empty_response_after_tools' : 'trivial_preamble_after_tools'
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({ toolSummary: toolSummaryRetryCount, reason: summaryReason }),
        })}\n\n`)
      }

      if (!shouldContinue) break

      const continuationAssistantText = shouldContinue === 'memory_write_followthrough'
        ? ''
        : resolveContinuationAssistantText({
            iterationText,
            lastSegment,
          })

      const continuationPrompt = buildContinuationPrompt({
        type: shouldContinue,
        message,
        fullText,
        toolEvents: streamedToolEvents,
        requiredToolReminderNames,
        cwd: session.cwd,
      })

      if (continuationPrompt) {
        const continuationMessages: Array<HumanMessage | AIMessage> = []
        if (continuationAssistantText) {
          const assistantMessage = new AIMessage({ content: continuationAssistantText })
          langchainMessages.push(assistantMessage)
          continuationMessages.push(assistantMessage)
        }
        const settledSegment = extractSuggestions(lastSegment).clean.trim()
        if (settledSegment) lastSettledSegment = settledSegment
        const promptMessage = new HumanMessage({ content: continuationPrompt })
        langchainMessages.push(promptMessage)
        continuationMessages.push(promptMessage)
        // Provide full conversation history since the agent has no checkpointer
        // and each iteration starts with only the messages we explicitly pass.
        pendingGraphMessages = [...langchainMessages]
        lastSegment = ''
      } else if (shouldContinue === 'transient') {
        // Exponential backoff before retrying transient errors; respect Retry-After if present
        const backoffMs = pendingRetryAfterMs
          ? Math.min(pendingRetryAfterMs, 60_000)
          : Math.min(3000 * Math.pow(2, transientRetryCount - 1) + Math.random() * 2000, 30_000)
        pendingRetryAfterMs = null
        await sleep(backoffMs)
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

  const emitLlmOutputHook = async (response: string) => {
    const total = totalInputTokens + totalOutputTokens
    await runCapabilityHook(
      'llmOutput',
      {
        session,
        runId,
        provider: session.provider,
        model: session.model,
        assistantTexts: response ? [response] : [],
        response,
        usage: total > 0
          ? {
              input: totalInputTokens,
              output: totalOutputTokens,
              total,
              estimatedCost: estimateCost(session.model, totalInputTokens, totalOutputTokens),
            }
          : undefined,
      },
      { enabledIds: sessionPlugins },
    )
  }

  // Skip post-stream work if the client disconnected mid-stream
  if (signal?.aborted) {
    let finalResponse = resolveFinalStreamResponseText({
      fullText,
      lastSegment,
      lastSettledSegment,
      hasToolCalls,
      toolEvents: streamedToolEvents,
    })
    if (shouldForceExternalServiceSummary({
      userMessage: message,
      finalResponse,
      hasToolCalls,
      toolEventCount: streamedToolEvents.length,
    })) {
      const forcedSummary = await buildForcedExternalServiceSummary({
        llm,
        userMessage: message,
        fullText,
        toolEvents: streamedToolEvents,
      })
      if (forcedSummary) {
        fullText = fullText.trim() ? `${fullText.trim()}\n\n${forcedSummary}` : forcedSummary
        finalResponse = forcedSummary
      }
    }
    await emitLlmOutputHook(finalResponse)
    await cleanup()
    return { fullText, finalResponse }
  }

  // Extract LLM-generated suggestions from the response and strip the tag
  const extracted = extractSuggestions(fullText)
  fullText = extracted.clean
  if (!fullText.trim() && terminalToolResponse) fullText = terminalToolResponse
  if (extracted.suggestions) {
    write(`data: ${JSON.stringify({ t: 'md', text: JSON.stringify({ suggestions: extracted.suggestions }) })}\n\n`)
  }

  // Emit full thinking text as metadata so the client can persist it
  if (accumulatedThinking) {
    write(`data: ${JSON.stringify({ t: 'md', text: JSON.stringify({ thinking: accumulatedThinking }) })}\n\n`)
  }

  // Track cost — fall back to character-count estimation when providers
  // don't surface token counts through LangChain's on_llm_end event.
  if (totalInputTokens === 0 && totalOutputTokens === 0 && fullText) {
    const historyText = history.map((m) => m.text || '').join('')
    totalInputTokens = Math.ceil((message.length + historyText.length + prompt.length) / 4)
    totalOutputTokens = Math.ceil(fullText.length / 4)
  }
  const totalTokens = totalInputTokens + totalOutputTokens
  if (totalTokens > 0) {
    const cost = estimateCost(session.model, totalInputTokens, totalOutputTokens)
    const pluginDefinitionCosts = buildPluginDefinitionCosts(tools, toolToPluginMap)
    const usageRecord: UsageRecord = {
      sessionId: session.id,
      messageIndex: history.length,
      model: session.model,
      provider: session.provider,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
      estimatedCost: cost,
      timestamp: Date.now(),
      durationMs: Date.now() - startTs,
      pluginDefinitionCosts,
      pluginInvocations: pluginInvocations.length > 0 ? pluginInvocations : undefined,
    }
    appendUsage(session.id, usageRecord)
    // Send usage metadata to client
    write(`data: ${JSON.stringify({
      t: 'md',
      text: JSON.stringify({ usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens, estimatedCost: cost } }),
    })}\n\n`)
  }

  // If tools were called, finalResponse is the text from the last LLM turn only.
  // Fall back to fullText if the last segment is empty (e.g. agent ended on a tool call
  // with no summary text).
  // Strip suggestions tag from lastSegment too (connector delivery)
  let finalResponse = resolveFinalStreamResponseText({
    fullText,
    lastSegment,
    lastSettledSegment,
    hasToolCalls,
    toolEvents: streamedToolEvents,
  })
  if (shouldForceExternalServiceSummary({
    userMessage: message,
    finalResponse,
    hasToolCalls,
    toolEventCount: streamedToolEvents.length,
  })) {
    const forcedSummary = await buildForcedExternalServiceSummary({
      llm,
      userMessage: message,
      fullText,
      toolEvents: streamedToolEvents,
    })
    if (forcedSummary) {
      fullText = fullText.trim() ? `${fullText.trim()}\n\n${forcedSummary}` : forcedSummary
      finalResponse = forcedSummary
    }
  }

  await emitLlmOutputHook(finalResponse)

  await runCapabilityHook('afterAgentComplete', { session, response: fullText }, { enabledIds: sessionPlugins })

  // OpenClaw auto-sync: push memory if enabled
  try {
    const { loadSyncConfig, pushMemoryToOpenClaw } = await import('@/lib/server/openclaw/sync')
    const syncConfig = loadSyncConfig()
    if (syncConfig.autoSyncMemory) {
      pushMemoryToOpenClaw(session.agentId || undefined)
    }
  } catch { /* OpenClaw sync not available — ignore */ }

  // Clean up browser and other session resources
  await cleanup()

  return { fullText, finalResponse }
}
