import fs from 'fs'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/heartbeat-defaults'
import { buildSessionTools } from './session-tools'
import { buildChatModel } from './build-llm'
import { loadSettings, loadAgents, loadSkills, appendUsage } from './storage'
import { estimateCost, buildPluginDefinitionCosts } from './cost'
import { getPluginManager } from './plugins'
import { loadRuntimeSettings, getAgentLoopRecursionLimit } from './runtime-settings'
import { buildSkillPromptText } from './skill-prompt-budget'

import { logExecution } from './execution-log'
import { buildCurrentDateTimePromptContext } from './prompt-runtime-context'
import { canonicalizePluginId, expandPluginIds } from './tool-aliases'
import type { Session, Message, UsageRecord, PluginInvocationRecord, MessageToolEvent } from '@/types'
import { extractSuggestions } from './suggestions'
import { buildIdentityContinuityContext } from './identity-continuity'
import { enqueueSystemEvent } from './system-events'
import { resolveActiveProjectContext } from './project-context'
import {
  getEnabledToolPlanningView,
  getFirstToolForCapability,
  getToolsForCapability,
  TOOL_CAPABILITY,
} from './tool-planning'
import { ToolLoopTracker } from './tool-loop-detection'
import type { LoopDetectionResult } from './tool-loop-detection'
import { isCurrentThreadRecallRequest } from './memory-policy'
import {
  isBroadGoal,
  looksLikeExternalWalletTask,
  looksLikeBoundedExternalExecutionTask,
  looksLikeOpenEndedDeliverableTask,
  shouldForceExternalExecutionFollowthrough,
  shouldForceDeliverableFollowthrough,
  hasStateChangingWalletEvidence,
  countExternalExecutionResearchSteps,
  countDistinctExternalResearchHosts,
  renderToolEvidence,
  resolveFinalStreamResponseText,
  resolveContinuationAssistantText,
  buildContinuationPrompt,
} from './stream-continuation'
import type { ContinuationType } from './stream-continuation'
import {
  compactThreadRecallText,
  getExplicitRequiredToolNames,
  getWalletApprovalBoundaryAction,
  isNarrowDirectMemoryWriteTurn,
  isWalletSimulationResult,
  resolveToolAction,
  shouldAllowToolForDirectMemoryWrite,
  shouldAllowToolForCurrentThreadRecall,
  shouldForceExternalServiceSummary,
  shouldTerminateOnSuccessfulMemoryMutation,
  updateStreamedToolEvents,
} from './chat-streaming-utils'

// Re-export continuation functions so existing consumers don't need to change imports
export {
  getExplicitRequiredToolNames,
  isNarrowDirectMemoryWriteTurn,
  isWalletSimulationResult,
  looksLikeOpenEndedDeliverableTask,
  shouldAllowToolForDirectMemoryWrite,
  shouldAllowToolForCurrentThreadRecall,
  shouldForceExternalExecutionFollowthrough,
  shouldForceDeliverableFollowthrough,
  shouldForceExternalServiceSummary,
  shouldTerminateOnSuccessfulMemoryMutation,
  resolveFinalStreamResponseText,
  resolveContinuationAssistantText,
}

/** Extract a breadcrumb title from notable tool completions (task/schedule/agent creation). */
interface StreamAgentChatOpts {
  session: Session
  message: string
  imagePath?: string
  attachedFiles?: string[]
  apiKey: string | null
  systemPrompt?: string
  write: (data: string) => void
  history: Message[]
  fallbackCredentialIds?: string[]
  signal?: AbortSignal
}

function buildPluginCapabilityLines(enabledPlugins: string[], opts?: { platformAssignScope?: 'self' | 'all' }): string[] {
  // Collect capability descriptions dynamically from plugins
  const lines = getPluginManager().collectCapabilityDescriptions(enabledPlugins)

  // Context tools are available to any session with plugins
  if (enabledPlugins.length > 0) {
    lines.push('- I can monitor my own context usage (`context_status`) and compact my conversation history (`context_summarize`) when I\'m running low on space.')
    if (opts?.platformAssignScope === 'all') {
      lines.push('- I can delegate tasks to other agents (`delegate_to_agent`) based on their strengths and availability.')
    }
  }
  return lines
}

export function buildToolDisciplineLines(enabledPlugins: string[]): string[] {
  const planning = getEnabledToolPlanningView(enabledPlugins)
  const uniqueTools = planning.displayToolIds
  if (uniqueTools.length === 0) return []
  const walletTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.walletInspect)
  const httpTools = getToolsForCapability(enabledPlugins, 'network.http')

  const lines = [
    `Enabled tools in this session: ${uniqueTools.map((toolId) => `\`${toolId}\``).join(', ')}.`,
    'Only call tools from this enabled list or tools explicitly returned by the runtime.',
  ]

  const directPlatformTools = uniqueTools.filter((toolId) => toolId.startsWith('manage_') && toolId !== 'manage_platform')
  if (directPlatformTools.length > 0 && !uniqueTools.includes('manage_platform')) {
    lines.push(`Use direct platform tools exactly as named (${directPlatformTools.map((toolId) => `\`${toolId}\``).join(', ')}). Do not substitute \`manage_platform\` unless it is explicitly enabled.`)
  }

  lines.push(...planning.disciplineGuidance)

  const researchSearchTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.researchSearch)
  const researchFetchTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.researchFetch)
  const browserCaptureTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.browserCapture)
  const deliveryMediaTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.deliveryMedia)
  const deliveryVoiceTools = getToolsForCapability(enabledPlugins, TOOL_CAPABILITY.deliveryVoiceNote)

  if ((researchSearchTools.length || researchFetchTools.length) && browserCaptureTools.length) {
    const researchLabel = [...researchSearchTools, ...researchFetchTools].map((toolName) => `\`${toolName}\``).join('/')
    lines.push(`Research tools like ${researchLabel} gather sources and text, but they do not capture screenshots. Use \`${browserCaptureTools[0]}\` for screenshots or rendered page evidence.`)
    lines.push(`When a task asks for both research and screenshots, use ${researchLabel} first to identify the right source URLs, then use \`${browserCaptureTools[0]}\` to capture the relevant page.`)
  }

  if (researchSearchTools.length) {
    lines.push(`For current events, live conflicts, or “keep watching for updates” requests, use \`${researchSearchTools[0]}\` before answering. Do not rely on memory or unstated background knowledge for fresh developments.`)
  }

  if (browserCaptureTools.length && deliveryMediaTools.length) {
    lines.push(`When the user asks you to send screenshots or other media, capture the artifact first with \`${browserCaptureTools[0]}\`, then deliver that exact file or upload URL through \`${deliveryMediaTools[0]}\` instead of saying the capability is unavailable.`)
  }

  if (deliveryVoiceTools.length) {
    lines.push(`If the user asks for a voice note and \`${deliveryVoiceTools[0]}\` is enabled, try it before saying voice notes are unsupported.`)
  }

  if (walletTools.length && (uniqueTools.includes('browser') || httpTools.length > 0)) {
    lines.push(`For external wallet or trading workflows, inspect the available wallet first with \`${walletTools[0]}\` before browsing or calling third-party APIs.`)
    lines.push('For dApps, exchanges, and wallet-connect flows, use a bounded loop: verify the wallet/tooling you control, attempt one concrete reversible step, then either execute the next real action or state the exact blocker. Do not keep browsing once the blocker is clear.')
    lines.push('For swaps, purchases, and other live onchain tasks, do not shop across venues indefinitely. After a small number of failed API families, either use a direct onchain read path with the tools you have or state the blocker.')
  }

  if (uniqueTools.includes('browser')) {
    lines.push('For browser form workflows, start with `read_page` or `extract_form_fields`, then prefer `fill_form` and `submit_form`. Only use raw `click`/`type`/`select` when you already have the exact target information from the current page.')
    lines.push('When the task provides a literal URL or you are already on the correct page, keep working from that page state. Do not invent alternate domains, ports, or routes unless the current page explicitly links to them.')
  }

  if (uniqueTools.includes('ask_human')) {
    lines.push('For human-loop tasks, use `ask_human` in order: `request_input` with a concrete question, `wait_for_reply` with the returned `correlationId`, then `list_mailbox` to read the `human_reply` payload. Use `ack_mailbox` with the reply envelope id once consumed, or omit `envelopeId` to ack the newest unread human reply. Do not loop on `status` without a `watchJobId` or `approvalId`.')
  }

  if (uniqueTools.includes('manage_schedules')) {
    lines.push('Before creating a schedule, inspect existing schedules in this chat and reuse or update matching agent-created schedules instead of creating near-duplicates.')
    lines.push('For one-off reminders, prefer `scheduleType: "once"`; reserve recurring schedules for work that truly needs to repeat.')
    lines.push('When the user says stop, pause, cancel, or disable a reminder, list schedules first and pause or delete every matching schedule you created in this chat.')
  }

  if (uniqueTools.includes('schedule_wake')) {
    lines.push('For a one-off conversational reminder in the current chat, prefer `schedule_wake` over creating a recurring schedule.')
  }

  if (uniqueTools.includes('manage_secrets')) {
    lines.push('When a workflow reveals a password, app password, API key, recovery token, or other secret, store it with `manage_secrets` and do not echo the raw value in assistant text. Refer to the secret by name, service, or secret id instead.')
    lines.push('Use `manage_secrets` only for sensitive credentials or tokens. Do not use it for normal memory, user preferences, durable facts, or project notes.')
  }

  if (uniqueTools.includes('manage_capabilities')) {
    lines.push('Use `manage_capabilities` only when a needed tool is actually unavailable. If a direct tool for the job is already enabled in this session, call that tool immediately instead of requesting access or re-running discovery.')
  }

  if (uniqueTools.includes('files') || uniqueTools.includes('edit_file')) {
    lines.push('When the user specifies exact counts or exact section titles for file content, treat those as hard constraints. If a file must have exactly N bullet points, keep the total bullet count at N and put extra required detail into short prose under titled sections unless the user explicitly asked for more bullets.')
    lines.push('When summarizing or restructuring a source document into named sections, make sure each top-level source section is represented somewhere in the output. Lower-priority logistics belong in FYI rather than being dropped.')
  }

  if (uniqueTools.includes('delegate') && (uniqueTools.includes('shell') || uniqueTools.includes('files') || uniqueTools.includes('edit_file'))) {
    lines.push('When local workspace tools like `shell`, `files`, or `edit_file` are already enabled, prefer using them directly for straightforward coding and verification. Use `delegate` when you need a specialist backend, a second implementation pass, or parallel work.')
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
  platformAssignScope?: 'self' | 'all'
  userMessage?: string
  history?: Message[]
  responseStyle?: 'concise' | 'normal' | 'detailed' | null
  responseMaxChars?: number | null
}) {
  const hasTooling = opts.enabledPlugins.length > 0
  const pluginLines = buildPluginCapabilityLines(opts.enabledPlugins, { platformAssignScope: opts.platformAssignScope })
  const toolDisciplineLines = buildToolDisciplineLines(opts.enabledPlugins)
  const hasMemoryTools = opts.enabledPlugins.some((toolId) => (canonicalizePluginId(toolId) || toolId) === 'memory')
  const directMemoryWriteOnlyTurn = Boolean(opts.userMessage && isNarrowDirectMemoryWriteTurn(opts.userMessage))

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
  }
  if (hasMemoryTools && directMemoryWriteOnlyTurn) {
    parts.push(buildDirectMemoryWriteBlock())
  }

  // Plugin-specific operating guidance (collected dynamically from plugins)
  const guidanceLines = getPluginManager().collectOperatingGuidance(opts.enabledPlugins)
  if (guidanceLines.length) parts.push(...guidanceLines)

  // Response behavior
  parts.push(
    '## Response Rules',
    'NO_MESSAGE: reply with exactly this for pure acknowledgments (ok/thanks/bye/emoji).',
    'Execute by default — only confirm on high-risk actions.',
    'If a tool errors, retry or explain the blocker. Never claim success without evidence.',
    'Keep responses concise. Bullet points over prose. After file operations, confirm the result briefly (path and status) without echoing the full file contents.',
    opts.responseStyle === 'concise'
      ? `IMPORTANT: Be extremely concise.${opts.responseMaxChars ? ` Keep responses under ${opts.responseMaxChars} characters.` : ' Target under 500 characters.'} Lead with the answer, skip preamble.`
      : opts.responseStyle === 'detailed'
        ? 'Provide thorough, detailed explanations when helpful.'
        : '',
    `Heartbeat: if message is "${opts.heartbeatPrompt}", reply "HEARTBEAT_OK" unless you have a progress update.`,
    opts.heartbeatIntervalSec > 0 ? `Heartbeat cadence: ~${opts.heartbeatIntervalSec}s.` : '',
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

function buildDirectMemoryWriteBlock(): string {
  return [
    '## Direct Memory Write',
    'This turn is a direct request to remember, store, or correct a durable fact.',
    'Call `memory_store` or `memory_update` immediately, then confirm the stored value succinctly.',
    'If the user bundled several related facts into one remember request, store them together in one canonical memory write unless they explicitly asked for separate entries.',
    'Do not inspect skills, browse the workspace, request capabilities, manage tasks, manage agents, or delegate before the direct memory write is complete.',
  ].join('\n')
}

export interface StreamAgentChatResult {
  /** All text accumulated across every LLM turn (for SSE / web UI history). */
  fullText: string
  /** Text from only the final LLM turn — after the last tool call completed.
   *  Use this for connector delivery so intermediate planning text isn't sent. */
  finalResponse: string
}

export async function streamAgentChat(opts: StreamAgentChatOpts): Promise<StreamAgentChatResult> {
  const startTs = Date.now()
  const { session, message, imagePath, attachedFiles, apiKey, systemPrompt, write, history, fallbackCredentialIds, signal } = opts
  const rawPlugins = Array.isArray(session.plugins) ? session.plugins : []
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

  // Build stateModifier
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

  const stateModifierParts: string[] = []
  const hasProvidedSystemPrompt = typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
  const directMemoryWriteOnlyTurn = isNarrowDirectMemoryWriteTurn(message)
  const currentThreadRecallRequest = !directMemoryWriteOnlyTurn && isCurrentThreadRecallRequest(message)

  if (hasProvidedSystemPrompt) {
    stateModifierParts.push(systemPrompt!.trim())
  } else {
    if (settings.userPrompt) stateModifierParts.push(settings.userPrompt)
    stateModifierParts.push(buildCurrentDateTimePromptContext())
  }

  // Load agent context when a full prompt was not already composed by the route layer.
  let agentPlatformAssignScope: 'self' | 'all' = 'self'
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
    agentPlatformAssignScope = agent?.platformAssignScope || 'self'
    agentMcpServerIds = agent?.mcpServerIds
    agentMcpDisabledTools = agent?.mcpDisabledTools
    agentHeartbeatEnabled = agent?.heartbeatEnabled === true
    agentMemoryScopeMode = agent?.memoryScopeMode || null
    agentResponseStyle = agent?.responseStyle || null
    agentResponseMaxChars = agent?.responseMaxChars || null
    if (!hasProvidedSystemPrompt) {
      // Identity block — make sure the agent knows who it is
      const identityLines = [`## My Identity`, `My name is ${agent?.name || 'Agent'}.`]
      if (agent?.description) identityLines.push(agent.description)
      identityLines.push('I should always refer to myself by this name. I am not "Assistant" — I have my own name and identity.')
      stateModifierParts.push(identityLines.join(' '))
      const continuityBlock = buildIdentityContinuityContext(session, agent)
      if (continuityBlock) stateModifierParts.push(continuityBlock)
      if (agent?.soul) stateModifierParts.push(agent.soul)
      if (agent?.systemPrompt) stateModifierParts.push(agent.systemPrompt)
      if (agent?.skillIds?.length) {
        const allSkills = loadSkills()
        const skillPromptText = buildSkillPromptText(allSkills, agent.skillIds)
        if (skillPromptText) stateModifierParts.push(skillPromptText)
      }

      // Auto-discover workspace/bundled skills not already in the DB
      try {
        const { discoverSkills } = await import('./skill-discovery')
        const discovered = discoverSkills({ cwd: session.cwd })
        if (discovered.length > 0) {
          const discoveredBlock = discovered
            .map(s => `- **${s.name}**: ${(s.description || '').slice(0, 120)}`)
            .join('\n')
          stateModifierParts.push(`## Available Skills\n${discoveredBlock}`)
        }
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
    stateModifierParts.push(`## Reasoning Depth\n${thinkingGuidance[agentThinkingLevel]}`)
  }

  // Inject workspace context files only for agents with heartbeat enabled
  // (these files provide goals and autonomous operating context)
  if (!hasProvidedSystemPrompt && agentHeartbeatEnabled) {
    try {
      const { buildWorkspaceContext } = await import('./workspace-context')
      const wsCtx = buildWorkspaceContext({ cwd: session.cwd })
      if (wsCtx.block) stateModifierParts.push(wsCtx.block)
    } catch {
      // Workspace context is non-critical
    }
  }

  // Inject agent awareness only if agent has delegation capabilities
  const hasDelegation = sessionPlugins.some(p => p === 'delegate' || p === 'spawn_subagent')
  if (hasDelegation && session.agentId) {
    try {
      const { buildAgentAwarenessBlock } = await import('./agent-registry')
      const awarenessBlock = buildAgentAwarenessBlock(session.agentId)
      if (awarenessBlock) stateModifierParts.push(awarenessBlock)
    } catch {
      // If agent registry fails, continue without blocking the run.
    }
  }

  // Collect dynamic context from enabled plugins (wallet, memory, etc.)
  try {
    const pluginContextParts = await getPluginManager().collectAgentContext(session, sessionPlugins, message, history)
    stateModifierParts.push(...pluginContextParts)
  } catch {
    // Plugin context injection is non-critical
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
    stateModifierParts.push(projectLines.join('\n'))
  }

  // Tell the LLM about available plugins and their access status
  {
    const agentEnabledSet = new Set(sessionPlugins)
    const { getPluginManager } = await import('./plugins')
    const allPlugins = getPluginManager().listPlugins()
    const mcpDisabled = agentMcpDisabledTools ?? []

    // Categorize plugins
    const globallyDisabled: string[] = [] // Disabled site-wide by admin
    const enabledButNoAccess: string[] = [] // Enabled globally but agent doesn't have access
    const agentHasAccess: string[] = [] // Agent can use these

    for (const p of allPlugins) {
      if (!p.enabled) {
        globallyDisabled.push(`${p.name} (${p.filename})`)
      } else if (!agentEnabledSet.has(p.filename)) {
        enabledButNoAccess.push(`${p.name} (${p.filename})`)
      } else {
        agentHasAccess.push(p.filename)
      }
    }

    const accessParts: string[] = []
    if (globallyDisabled.length > 0) {
      accessParts.push(`**Disabled site-wide:** ${globallyDisabled.join(', ')}`)
    }
    if (mcpDisabled.length > 0) {
      accessParts.push(`**MCP tools not available:** ${mcpDisabled.join(', ')}`)
    }
    if (accessParts.length > 0) {
      stateModifierParts.push(`## Plugin Access\n${accessParts.join('\n')}`)
    }
  }

  if (settings.suggestionsEnabled === true) {
    stateModifierParts.push(
      [
        '## Follow-up Suggestions',
        'At the end of every response, include a <suggestions> block with exactly 3 short',
        'follow-up prompts the user might want to send next, as a JSON array. Keep each under 60 chars.',
        'Make them contextual to what you just said. Example:',
        '<suggestions>["Set up a Discord connector", "Create a research agent", "Show the task board"]</suggestions>',
      ].join('\n'),
    )
  }

  stateModifierParts.push(
    buildAgenticExecutionPolicy({
      enabledPlugins: sessionPlugins,
      loopMode: runtime.loopMode,
      heartbeatPrompt,
      heartbeatIntervalSec,
      platformAssignScope: agentPlatformAssignScope,
      userMessage: message,
      history,
      responseStyle: agentResponseStyle,
      responseMaxChars: agentResponseMaxChars,
    }),
  )

  let stateModifier = stateModifierParts.join('\n\n')

  const { tools, cleanup, toolToPluginMap } = await buildSessionTools(session.cwd, sessionPlugins, {
    agentId: session.agentId,
    sessionId: session.id,
    platformAssignScope: agentPlatformAssignScope,
    mcpServerIds: agentMcpServerIds,
    mcpDisabledTools: agentMcpDisabledTools,
    projectId: activeProjectContext.projectId,
    projectRoot: activeProjectContext.projectRoot,
    projectName: activeProjectContext.project?.name || null,
    projectDescription: activeProjectContext.project?.description || null,
    memoryScopeMode: agentMemoryScopeMode,
  })
  const toolsForTurn = currentThreadRecallRequest
    ? tools.filter((tool) => {
        const toolName = typeof (tool as { name?: unknown }).name === 'string'
          ? String((tool as { name?: unknown }).name)
          : ''
        return shouldAllowToolForCurrentThreadRecall(toolName)
      })
    : directMemoryWriteOnlyTurn
      ? tools.filter((tool) => {
          const toolName = typeof (tool as { name?: unknown }).name === 'string'
            ? String((tool as { name?: unknown }).name)
            : ''
          return shouldAllowToolForDirectMemoryWrite(toolName)
        })
      : tools
  const agent = createReactAgent({ llm, tools: toolsForTurn, stateModifier })
  const recursionLimit = getAgentLoopRecursionLimit(runtime)

  // Build message history for context
  const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i
  const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|yml|yaml|toml|env|log|sh|sql|css|scss)$/i

  async function buildContentForFile(filePath: string): Promise<{ type: string; [k: string]: any } | string | null> {
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
        // @ts-ignore — pdf-parse types
        const pdfParse = (await import(/* webpackIgnore: true */ 'pdf-parse')).default
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

  async function buildLangChainContent(text: string, filePath?: string, extraFiles?: string[]): Promise<any> {
    const filePaths: string[] = []
    if (filePath) filePaths.push(filePath)
    if (extraFiles?.length) {
      for (const f of extraFiles) {
        if (f && !filePaths.includes(f)) filePaths.push(f)
      }
    }
    if (!filePaths.length) return text

    const parts: any[] = []
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
    const { shouldAutoCompact, llmCompact, estimateTokens } = await import('./context-manager')
    const systemPromptTokens = estimateTokens(stateModifier)
    if (shouldAutoCompact(recentHistory, systemPromptTokens, session.provider, session.model)) {
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

  // Context degradation warning: prepend warning to system prompt when nearing limits
  try {
    const { getContextDegradationWarning, estimateTokens: estTokens } = await import('./context-manager')
    const sysTokens = estTokens(stateModifier)
    const warning = getContextDegradationWarning(effectiveHistory, sysTokens, session.provider, session.model)
    if (warning) {
      stateModifierParts.unshift(warning)
      stateModifier = stateModifierParts.join('\n\n')
    }
  } catch {
    // Warning failure is non-critical
  }

  const langchainMessages: Array<HumanMessage | AIMessage> = []
  for (const m of effectiveHistory) {
    if (m.role === 'user') {
      langchainMessages.push(new HumanMessage({ content: await buildLangChainContent(m.text, m.imagePath, m.attachedFiles) }))
    } else {
      langchainMessages.push(new AIMessage({ content: m.text }))
    }
  }

  // Add current message
  const currentContent = await buildLangChainContent(message, imagePath, attachedFiles)
  langchainMessages.push(new HumanMessage({ content: currentContent }))

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

  // Plugin hooks: beforeAgentStart
  const pluginMgr = getPluginManager()
  await pluginMgr.runHook('beforeAgentStart', { session, message }, { enabledIds: sessionPlugins })

  const abortController = new AbortController()
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
  const MAX_TRANSIENT_RETRIES = 2
  const MAX_REQUIRED_TOOL_CONTINUES = 2
  const MAX_EXECUTION_FOLLOWTHROUGHS = 1
  const MAX_DELIVERABLE_FOLLOWTHROUGHS = 2
  const MAX_TOOL_SUMMARY_RETRIES = 2
  let autoContinueCount = 0
  let transientRetryCount = 0
  let requiredToolContinueCount = 0
  let executionFollowthroughCount = 0
  let deliverableFollowthroughCount = 0
  let toolSummaryRetryCount = 0
  const explicitRequiredToolNames = getExplicitRequiredToolNames(message, sessionPlugins)
  const usedToolNames = new Set<string>()
  const loopTracker = new ToolLoopTracker()
  let loopDetectionTriggered: LoopDetectionResult | null = null
  let terminalToolResponse = ''

  try {
  const maxIterations = MAX_AUTO_CONTINUES + MAX_TRANSIENT_RETRIES + MAX_REQUIRED_TOOL_CONTINUES + MAX_EXECUTION_FOLLOWTHROUGHS + MAX_DELIVERABLE_FOLLOWTHROUGHS + MAX_TOOL_SUMMARY_RETRIES
    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let shouldContinue: ContinuationType = false
      let requiredToolReminderNames: string[] = []
      let waitingForToolResult = false
      let idleTimedOut = false
      let reachedExecutionBoundary = false
      let executionFollowthroughReason: 'research_limit' | 'post_simulation' | null = null
      let idleTimer: ReturnType<typeof setTimeout> | null = null
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

      const armIdleWatchdog = () => {
        clearIdleWatchdog()
        if (waitingForToolResult || iterationController.signal.aborted) return
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          iterationController.abort()
        }, 90_000)
      }

      // Dedup tracking: the tool() wrapper in session-tools/index.ts creates nested
      // tool invocations. LangGraph's streamEvents v2 emits on_tool_start/on_tool_end
      // at both the wrapper level and the inner invoke level. We track accepted run_ids
      // to suppress the duplicate nested events.
      const acceptedToolRunIds = new Set<string>()
      const seenToolInputKeys = new Set<string>()

      try {
        armIdleWatchdog()
        const eventStream = agent.streamEvents(
          { messages: langchainMessages },
          { version: 'v2', recursionLimit, signal: iterationController.signal },
        )

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
                  // OpenClaw [[thinking]] prefix convention
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
            const toolName = event.name || 'unknown'
            const input = event.data?.input
            const inputStr = typeof input === 'string' ? input : JSON.stringify(input)

            // Dedup: skip nested duplicate from tool() wrapper in session-tools.
            // The wrapper creates a second on_tool_start with the same (name, input)
            // but a different run_id. We accept the first and reject the rest.
            const toolDedupeKey = `${toolName}::${inputStr}`
            if (seenToolInputKeys.has(toolDedupeKey)) {
              // Nested duplicate — don't emit SSE, don't log, don't track
              continue
            }
            seenToolInputKeys.add(toolDedupeKey)
            acceptedToolRunIds.add(event.run_id)

            clearIdleWatchdog()
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
            // Dedup: skip on_tool_end for run_ids we didn't accept in on_tool_start
            if (!acceptedToolRunIds.has(event.run_id)) continue
            acceptedToolRunIds.delete(event.run_id)

            waitingForToolResult = false
            armIdleWatchdog()
            const toolName = event.name || 'unknown'
            const output = event.data?.output
            const outputStr = typeof output === 'string'
              ? output
              : output?.content
                ? String(output.content)
                : JSON.stringify(output)
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

            // --- Tool loop detection (modelled after OpenClaw) ---
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
            if (shouldTerminateOnSuccessfulMemoryMutation({
              toolName,
              toolInput: event.data?.input,
              toolOutput: outputStr || '',
            })) {
              terminalToolResponse = extractSuggestions(outputStr || '').clean.trim()
              if (terminalToolResponse) {
                lastSegment = terminalToolResponse
                lastSettledSegment = terminalToolResponse
              }
              logExecution(session.id, 'decision', 'Successful memory write is terminal for this turn.', {
                agentId: session.agentId,
                detail: { toolName, action: resolveToolAction(event.data?.input) || null },
              })
              write(`data: ${JSON.stringify({
                t: 'status',
                text: JSON.stringify({ terminalToolResult: 'memory_write' }),
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
          ? 'Model stream stalled without emitting text or tool results for 90 seconds.'
          : innerErr instanceof Error ? innerErr.message : String(innerErr)
        const errStack = innerErr instanceof Error ? innerErr.stack?.slice(0, 500) : undefined

        // Classify the error:
        // 1. GraphRecursionError — explicit or wrapped as abort (LangGraph aborts internally on limit)
        // 2. Transient abort/timeout — LLM API failure, not from client disconnect
        const isRecursionError = errName === 'GraphRecursionError'
          || /recursion limit|maximum recursion/i.test(errMsg)
        const isTransientAbort = (!isRecursionError && idleTimedOut)
          || (!isRecursionError
          && /abort|timed?\s*out|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(errMsg)
          && !abortController.signal.aborted)

        // Log diagnostic details for every error so we can trace root causes
        console.error(`[stream-agent-chat] Error in streamEvents iteration=${iteration}`, {
          errName, errMsg, errStack,
          isRecursionError, isTransientAbort,
          hasToolCalls, fullTextLen: fullText.length,
          parentAborted: abortController.signal.aborted,
        })

        if (isRecursionError && autoContinueCount < MAX_AUTO_CONTINUES && !abortController.signal.aborted) {
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
          logExecution(session.id, 'decision', `Transient error, retrying (${transientRetryCount}/${MAX_TRANSIENT_RETRIES}): ${errMsg}`, {
            agentId: session.agentId,
            detail: { errName, errMsg, hadPartialOutput },
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
        abortController.signal.removeEventListener('abort', onParentAbort)
      }

      if (reachedExecutionBoundary) break

      // Tool loop detection: critical severity stops further tool calls.
      // However, if tools already produced results but the model has no/trivial text,
      // we attempt a tool_summary continuation instead of just erroring out.
      if (loopDetectionTriggered) {
        const loopTextIsTrivial = !fullText.trim() || (fullText.trim().length < 150 && streamedToolEvents.length >= 2)
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

      // Generic fallback: tools were called but the model produced no substantive text.
      // Triggers when: (a) text is empty, or (b) text is trivially short (< 150 chars)
      // and multiple tools ran — the agent likely emitted a "I'll do X" preamble but
      // never synthesized the tool outputs into a real response.
      const textIsTrivial = !fullText.trim() || (fullText.trim().length < 150 && streamedToolEvents.length >= 2)
      if (
        !shouldContinue
        && hasToolCalls
        && textIsTrivial
        && streamedToolEvents.length > 0
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

      const continuationAssistantText = resolveContinuationAssistantText({
        iterationText,
        lastSegment,
      })

      const continuationPrompt = buildContinuationPrompt({
        type: shouldContinue,
        message,
        fullText,
        toolEvents: streamedToolEvents,
        requiredToolReminderNames,
      })

      if (continuationPrompt) {
        if (continuationAssistantText) {
          langchainMessages.push(new AIMessage({ content: continuationAssistantText }))
        }
        const settledSegment = extractSuggestions(lastSegment).clean.trim()
        if (settledSegment) lastSettledSegment = settledSegment
        langchainMessages.push(new HumanMessage({ content: continuationPrompt }))
        lastSegment = ''
      } else if (shouldContinue === 'transient') {
        // Short delay before retrying transient errors (API timeout, rate limit, etc.)
        await new Promise((r) => setTimeout(r, 2000 * transientRetryCount))
      }
    }
  } catch (err: unknown) {
    const errMsg = timedOut
      ? 'Ongoing loop stopped after reaching the configured runtime limit.'
      : err instanceof Error ? err.message : String(err)
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
    totalInputTokens = Math.ceil((message.length + historyText.length + (systemPrompt?.length || 0)) / 4)
    totalOutputTokens = Math.ceil(fullText.length / 4)
  }
  const totalTokens = totalInputTokens + totalOutputTokens
  if (totalTokens > 0) {
    const cost = estimateCost(session.model, totalInputTokens, totalOutputTokens)
    const pluginDefinitionCosts = buildPluginDefinitionCosts(toolsForTurn, toolToPluginMap)
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

  // Plugin hooks: afterAgentComplete
  await pluginMgr.runHook('afterAgentComplete', { session, response: fullText }, { enabledIds: sessionPlugins })

  // OpenClaw auto-sync: push memory if enabled
  try {
    const { loadSyncConfig, pushMemoryToOpenClaw } = await import('./openclaw-sync')
    const syncConfig = loadSyncConfig()
    if (syncConfig.autoSyncMemory) {
      pushMemoryToOpenClaw(session.agentId || undefined)
    }
  } catch { /* OpenClaw sync not available — ignore */ }

  // Clean up browser and other session resources
  await cleanup()

  return { fullText, finalResponse }
}
