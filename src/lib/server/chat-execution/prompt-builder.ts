/**
 * System prompt construction helpers extracted from stream-agent-chat.ts.
 *
 * Pure functions that build prompt segments — no streaming state, no
 * side effects.
 */
import type { Message, ExtensionPromptBuildResult } from '@/types'
import type { PromptMode } from '@/lib/server/chat-execution/prompt-mode'
import {
  collectCapabilityDescriptions,
  collectCapabilityOperatingGuidance,
} from '@/lib/server/native-capabilities'
import { getExtensionManager } from '@/lib/server/extensions'
import {
  getEnabledToolPlanningView,
  getToolsForCapability,
  TOOL_CAPABILITY,
} from '@/lib/server/tool-planning'
import { canonicalizeExtensionId, extensionIdMatches } from '@/lib/server/tool-aliases'
import { dedup } from '@/lib/shared-utils'
import { routeTaskIntent } from '@/lib/server/capability-router'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'
import {
  isBroadGoal as classifiedIsBroadGoal,
  isDeliverableTask as classifiedIsDeliverableTask,
} from '@/lib/server/chat-execution/message-classifier'
import { isCurrentThreadRecallRequest } from '@/lib/server/memory/memory-policy'
import { compactThreadRecallText } from '@/lib/server/chat-execution/chat-streaming-utils'
import { CLI_PROVIDER_CAPABILITIES, isCliProvider } from '@/lib/providers/cli-utils'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildExtensionCapabilityLines(enabledExtensions: string[], opts?: { delegationEnabled?: boolean; agentId?: string | null }): string[] {
  const lines = collectCapabilityDescriptions(enabledExtensions)

  // Context tools are available to any session with extensions
  if (enabledExtensions.length > 0) {
    lines.push('- I can monitor my own context usage (`context_status`) and compact my conversation history (`context_summarize`) when I\'m running low on space.')
    if (opts?.delegationEnabled) {
      lines.push('- I can delegate tasks to other agents (`delegate_to_agent`) based on their strengths and availability.')

      // CLI team hint — if teammates run CLI providers, mention their strengths
      if (opts.agentId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { loadAgents } = require('../storage')
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { resolveTeam } = require('../agents/team-resolution')
          const agents = loadAgents() as Record<string, Record<string, unknown>>
          const team = resolveTeam(opts.agentId, agents)
          if (team.mode === 'team') {
            const cliTeammates: string[] = []
            const allMembers = [...(team.coordinator ? [team.coordinator] : []), ...team.peers, ...team.directReports]
            for (const member of allMembers) {
              const provider = String(member.provider || '')
              if (isCliProvider(provider)) {
                const caps = CLI_PROVIDER_CAPABILITIES[provider] || ''
                cliTeammates.push(`${member.name} (${provider} — ${caps})`)
              }
            }
            if (cliTeammates.length > 0) {
              lines.push(`- Your team includes coding specialists: ${cliTeammates.join(', ')}. For complex coding tasks involving file changes, these teammates are well-suited. Use your judgment — simple tasks are fine to handle yourself.`)
            }
          }
        } catch { /* non-critical — team resolution may not be available */ }
      }
    }
  }
  return lines
}

const DISPLAY_TOOL_ALIASES: Record<string, string[]> = {
  files: ['send_file'],
}

function buildExactToolNameList(enabledExtensions: string[]): string[] {
  const planning = getEnabledToolPlanningView(enabledExtensions)
  const displayAliases = dedup(
    enabledExtensions
      .map((toolId) => canonicalizeExtensionId(toolId))
      .flatMap((toolId) => DISPLAY_TOOL_ALIASES[toolId] || []),
  )
  const extensionToolNames = getExtensionManager()
    .getTools(enabledExtensions)
    .map(({ tool }) => tool.name)
  const combined = [
    ...planning.displayToolIds,
    ...displayAliases,
    ...planning.entries.map((entry) => entry.toolName),
    ...extensionToolNames,
  ]
  return dedup(combined.filter((toolName) => typeof toolName === 'string' && toolName.trim()))
    .map((toolName) => toolName.trim())
    .sort()
}

export function buildToolAvailabilityLines(enabledExtensions: string[]): string[] {
  const toolNames = buildExactToolNameList(enabledExtensions)
  if (toolNames.length === 0) return []

  return [
    'Tool names are case-sensitive. Call tools exactly as listed.',
    ...toolNames.map((toolName) => `- \`${toolName}\``),
  ]
}

export function buildToolDisciplineLines(enabledExtensions: string[]): string[] {
  const planning = getEnabledToolPlanningView(enabledExtensions)
  const uniqueTools = buildExactToolNameList(enabledExtensions)
  if (uniqueTools.length === 0) return []
  const httpTools = getToolsForCapability(enabledExtensions, 'network.http')

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

  // Universal tool efficiency guidance — tool-specific lines live in CORE_TOOL_PLANNING (tool-planning.ts)
  lines.push(
    '## Tool Efficiency',
    'Plan your approach before starting tool calls. State what you will do, then do it.',
    'Prefer fewer, larger tool calls over many small ones.',
    'Do not poll for status in a loop. If waiting on a process, check once and move on.',
    'If stuck after 2-3 attempts with the same approach, stop and state the blocker — do not keep retrying.',
    'When delegating to subagents, use waitForCompletion or wait/wait_all instead of polling status in a loop.',
  )

  const researchSearchTools = getToolsForCapability(enabledExtensions, TOOL_CAPABILITY.researchSearch)
  const researchFetchTools = getToolsForCapability(enabledExtensions, TOOL_CAPABILITY.researchFetch)
  const browserCaptureTools = getToolsForCapability(enabledExtensions, TOOL_CAPABILITY.browserCapture)

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
    ...(uniqueTools.includes('execute') ? ['execute'] : []),
    ...(uniqueTools.includes('browser') ? ['browser'] : []),
  ]))
  if (alternateResearchTools.length >= 2) {
    lines.push(`If one research path is blocked, try another (${alternateResearchTools.map((toolName) => `\`${toolName}\``).join(', ')}) before giving up.`)
  }

  if (uniqueTools.includes('manage_secrets')) {
    lines.push('Store secrets (passwords, API keys, tokens) with `manage_secrets` — never echo raw values in assistant text.')
  }

  return lines
}

/**
 * Unified tool section — lists tools once and includes all discipline guidance.
 * Replaces the pattern of calling buildToolAvailabilityLines + buildToolDisciplineLines
 * separately (which listed tools 2x).
 */
export function buildToolSection(enabledExtensions: string[]): string[] {
  const toolDisciplineLines = buildToolDisciplineLines(enabledExtensions)
  if (toolDisciplineLines.length === 0) return []

  // buildToolDisciplineLines already opens with "Enabled tools in this session: ..."
  // and includes all discipline guidance + case-sensitivity from planning view.
  // Just add the case-sensitivity note that buildToolAvailabilityLines provided.
  return [
    'Tool names are case-sensitive. Call tools exactly as listed.',
    ...toolDisciplineLines,
  ]
}

function getEnabledDisplayTool(enabledExtensions: string[], canonicalExtensionId: string): string | null {
  return getEnabledToolPlanningView(enabledExtensions).displayToolIds.find((toolId) => toolId === canonicalExtensionId) || null
}

export function shouldForceAttachmentFollowthrough(params: {
  userMessage: string
  enabledExtensions: string[]
  hasToolCalls: boolean
  hasAttachmentContext: boolean
  classification?: MessageClassification | null
}): boolean {
  if (!params.hasAttachmentContext) return false
  if (params.hasToolCalls) return false
  const decision = routeTaskIntent(params.userMessage, params.enabledExtensions, null, params.classification ?? null)
  if (decision.intent !== 'research' && decision.intent !== 'browsing') return false
  return decision.preferredTools.some((toolName) => extensionIdMatches(params.enabledExtensions, toolName))
}

export async function buildForcedExternalServiceSummary(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llm: { invoke: (messages: any[]) => Promise<{ content: unknown }> }
  userMessage: string
  fullText: string
  toolEvents: import('@/types').MessageToolEvent[]
}): Promise<string | null> {
  const { HumanMessage } = await import('@langchain/core/messages')
  const { renderToolEvidence } = await import('@/lib/server/chat-execution/stream-continuation')
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
      const text = (response.content as Array<Record<string, unknown>>)
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
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

const OPEN_ENDED_REVISION_BLOCK = [
  '## Revision Loop',
  'For open-ended deliverable work, do a real two-pass loop before declaring success: create the draft artifacts, critique them against the objective, then modify at least one artifact based on that critique.',
  'A critique by itself does not count as iteration. Iteration requires an actual changed artifact.',
  'When resuming in an existing workspace, inspect the current files first, then update them. Do not assume you lost access to the workspace without an explicit tool attempt.',
  'If `files` is available, use it with explicit actions and paths to inspect and revise the artifacts.',
].join('\n')

const GOAL_DECOMPOSITION_BLOCK = [
  '## Goal Decomposition',
  'When you receive a broad, open-ended goal:',
  '1. Break it into 3-7 concrete, sequentially-executable subtasks before taking action.',
  '2. If manage_tasks is available, use it only for durable tracking: multi-turn work, delegation, explicit backlog requests, or work you expect to resume later. Do not create a task for every micro-step. Do not re-read the task list after every update. Read once, make your changes, then move on.',
  'Single-step instructions are not broad goals. For direct actions like storing a memory, answering a recall question, editing one file, or sending one message, execute the relevant tool immediately instead of creating tasks or delegating.',
  '3. Present the plan as a short checklist or numbered list in plain language. If durable tracking is unnecessary, keep it inline instead of creating tasks.',
  '4. Execute the first substantive subtask immediately — do not stop after planning.',
  '5. Update only the durable tasks you actually created; otherwise just continue executing and report progress plainly.',
].join('\n')

export function buildAgenticExecutionPolicy(opts: {
  enabledExtensions: string[]
  loopMode: 'bounded' | 'ongoing'
  heartbeatPrompt: string
  heartbeatIntervalSec: number
  allowSilentReplies?: boolean
  isDirectConnectorSession?: boolean
  delegationEnabled?: boolean
  agentId?: string | null
  userMessage?: string
  history?: Message[]
  hasAttachmentContext?: boolean
  responseStyle?: 'concise' | 'normal' | 'detailed' | null
  responseMaxChars?: number | null
  mode?: PromptMode
  classification?: MessageClassification | null
}): string {
  const mode = opts.mode || 'full'
  const isMinimal = mode === 'minimal'
  const hasTooling = opts.enabledExtensions.length > 0
  const extensionLines = isMinimal ? [] : buildExtensionCapabilityLines(opts.enabledExtensions, { delegationEnabled: opts.delegationEnabled, agentId: opts.agentId })
  const toolDisciplineLines = buildToolSection(opts.enabledExtensions)
  const hasMemoryTools = opts.enabledExtensions.some((toolId) => (canonicalizeExtensionId(toolId) || toolId) === 'memory')
  const hasManageSessions = opts.enabledExtensions.some((toolId) => (canonicalizeExtensionId(toolId) || toolId) === 'manage_sessions')
  const hasManageTasks = opts.enabledExtensions.some((toolId) => (canonicalizeExtensionId(toolId) || toolId) === 'manage_tasks')
  const hasManageSkills = opts.enabledExtensions.some((toolId) => (canonicalizeExtensionId(toolId) || toolId) === 'manage_skills')
  const lightweightDirectChat = opts.classification?.isLightweightDirectChat === true && !opts.isDirectConnectorSession
  const hasDelegationTools = opts.enabledExtensions.some((toolId) => {
    const canonical = canonicalizeExtensionId(toolId) || toolId
    return canonical === 'delegate' || canonical === 'spawn_subagent'
  })

  const parts: string[] = []

  // Core execution philosophy
  parts.push(
    '## How I Work',
    hasTooling
      ? 'I take initiative — plan briefly, execute tools, evaluate, iterate until done. Never stop at advice when action is implied.'
      : 'No tools enabled. Be explicit about what tool access is needed.',
    'IMPORTANT: If information was already mentioned in THIS conversation, answer from context — do NOT call memory tools or web search to look it up again. Only use memory tools to recall info from PREVIOUS conversations not in the current thread.',
    ...(isMinimal ? [] : [
      'If a skill applies to the task, follow its recommended approach first. Skill-specific commands are faster and more reliable than generic web search. Minimize tool calls — combine steps where possible.',
      'If a task explicitly names an enabled tool, use that tool before declaring success. A prose request is not a substitute for `ask_human`, and browser work is not a substitute for `email` delivery.',
      'When `ask_human` is enabled, collect required human input through the tool instead of asking for it only in plain assistant text.',
    ]),
    'Do not narrate routine tool calls. Just call the tool and report the outcome. Only narrate when the step is complex, sensitive, or the user needs to understand what is happening.',
    'Do not repeat the same tool call with identical arguments. If a tool returns an error or empty result, try a different approach instead of retrying the same call.',
    ...(isMinimal ? [] : [
      'A single browser or web timeout is not final. Retry once with a corrected target or use another enabled acquisition path before concluding.',
    ]),
    opts.loopMode === 'ongoing'
      ? 'Loop: ONGOING — keep iterating until done, blocked, or limits reached.'
      : 'Loop: BOUNDED — execute multiple steps but finish within recursion budget.',
  )

  if (lightweightDirectChat) {
    parts.push(
      '## Lightweight Chat',
      'This turn is a lightweight direct chat. Reply naturally and briefly.',
      'Do not delegate, create tasks, outline a workflow, or narrate tools unless the user adds a concrete task that actually requires that escalation.',
      'For greetings, acknowledgements, and simple social questions, a short human-sounding answer is sufficient.',
    )
  }

  if (hasTooling) {
    parts.push(
      '## Routing Matrix',
      'Current-thread facts already visible in this chat: answer directly from the thread before using tools.',
      hasMemoryTools
        ? 'Facts from previous conversations: start with `memory_search`, then `memory_get` only for a targeted follow-up read.'
        : 'Facts from previous conversations: rely on the visible thread only and state when memory tools are unavailable.',
      hasManageSessions
        ? 'Harness/session context, lineage, project attachment, or enabled-tool questions: use `sessions_tool` action `identity`.'
        : 'Harness/session introspection is limited here; rely on the runtime orientation block and visible context.',
      hasManageSessions
        ? 'Earlier messages from this same session that are not already visible in the thread: use `sessions_tool` action `history`.'
        : 'Do not claim hidden session history is checked when `sessions_tool` is unavailable.',
      hasManageTasks
        ? 'Durable backlog or resumable progress tracking: use `manage_tasks` for multi-turn work, delegation, or explicit task-board requests.'
        : 'Do not create pseudo-task workflows in prose when task tooling is unavailable.',
      hasManageSkills
        ? 'Missing capability, workflow, or environment setup blocker: use `manage_skills` before repeating generic exploration.'
        : 'If a capability is genuinely missing, say so plainly instead of pretending a skill install happened.',
      hasDelegationTools
        ? 'Multi-step specialist work: delegate or spawn a subagent instead of doing the whole chain yourself.'
        : 'If delegation tools are unavailable, execute directly with the tools you do have.',
      'For direct reversible execution, use the concrete tool now instead of creating a task or stopping at advice.',
      'When both `manage_platform` and a direct `manage_*` tool are available, prefer the direct `manage_*` tool.',
    )
  }

  // Sections skipped in minimal mode
  if (!isMinimal) {
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
    if (hasManageSkills) {
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
        'If an attachment is already present inline, inspect that attachment directly. Do not open /api/uploads, localhost, or file:// copies of the same attachment in the browser just to view it.',
      )
    }
  }

  // Tool-specific operating guidance (native capabilities first, then extensions)
  const guidanceLines = collectCapabilityOperatingGuidance(opts.enabledExtensions)
  if (guidanceLines.length) parts.push(...guidanceLines)

  // Response behavior
  parts.push(
    '## Response Rules',
    opts.allowSilentReplies
      ? 'NO_MESSAGE: use this only when no reply is actually needed. Do not use it for greetings, direct questions, or when the user is clearly opening a conversation.'
      : 'For direct user chats, always send a visible reply. Never answer with control tokens like NO_MESSAGE or HEARTBEAT_OK unless this is an explicit heartbeat poll.',
    'Execute by default — only confirm on high-risk actions.',
    'If a tool errors, retry or explain the blocker. Never claim success without evidence.',
    ...(isMinimal ? [] : [
      'When assessing the platform, repo, runtime, or implementation status, inspect the relevant files, logs, or state first. Do not claim a feature is missing, empty, or implemented unless you actually observed evidence for that claim in this run.',
      'If the user explicitly asks for one exact literal final response, token, phrase, or single line, treat that as a hard output contract. After the work succeeds, reply with exactly that literal and nothing else.',
    ]),
    'Keep responses concise. Bullet points over prose. After file operations, confirm the result briefly (path and status) without echoing the full file contents.',
    'Do not end every reply with a question. Only ask when a specific missing detail blocks progress. When a task is done, state the result and stop.',
    ...(lightweightDirectChat
      ? ['For this turn, prefer 1-3 short sentences over bullets, planning, or process narration.']
      : []),
    opts.responseStyle === 'concise'
      ? `IMPORTANT: Be extremely concise.${opts.responseMaxChars ? ` Keep responses under ${opts.responseMaxChars} characters.` : ' Target under 500 characters.'} Lead with the answer, skip preamble.`
      : opts.responseStyle === 'detailed'
        ? 'Provide thorough, detailed explanations when helpful.'
        : '',
    `Heartbeat: if message is "${opts.heartbeatPrompt}", reply "HEARTBEAT_OK" unless you have a progress update.`,
  )

  if (toolDisciplineLines.length) parts.push('## Tool Discipline', ...toolDisciplineLines)
  if (extensionLines.length) parts.push('What I can do:\n' + extensionLines.join('\n'))

  // Situational blocks — skipped in minimal mode
  if (!isMinimal) {
    if (opts.userMessage && classifiedIsBroadGoal(opts.classification ?? null, opts.userMessage)) parts.push(GOAL_DECOMPOSITION_BLOCK)
    if (opts.userMessage && classifiedIsDeliverableTask(opts.classification ?? null, opts.userMessage) && opts.enabledExtensions.some((toolId) => toolId === 'files' || toolId === 'edit_file')) {
      parts.push(OPEN_ENDED_REVISION_BLOCK)
    }
    if (opts.userMessage) {
      const exactStructureBlock = buildExactStructureBlock(opts.userMessage)
      if (exactStructureBlock) parts.push(exactStructureBlock)
    }
    if (opts.userMessage && isCurrentThreadRecallRequest(opts.userMessage)) {
      parts.push(buildCurrentThreadRecallBlock(opts.history || []))
    }
  }

  return parts.filter(Boolean).join('\n')
}

export function buildCurrentThreadRecallBlock(history: Message[]): string {
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

export function joinPromptSegments(...segments: Array<string | null | undefined>): string {
  return segments
    .map((segment) => (typeof segment === 'string' ? segment.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

export function applyBeforePromptBuildResult(
  basePrompt: string,
  hookResult: ExtensionPromptBuildResult | null | undefined,
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
