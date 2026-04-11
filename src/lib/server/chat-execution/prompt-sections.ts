/**
 * Composable Prompt Section Builders
 *
 * Each function builds one section of the agent system prompt.
 * Returns `string | null` (sync) or `Promise<string | null>` (async).
 * The main prompt assembly in stream-agent-chat.ts composes these declaratively.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { KnowledgeRetrievalTrace, Session, Agent } from '@/types'
import type { PromptMode } from '@/lib/server/chat-execution/prompt-mode'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'
import type { ActiveProjectContext } from '@/lib/server/project-context'
import type { SessionToolPolicyDecision } from '@/lib/server/tool-capability-policy'
import { buildIdentityContinuityContext } from '@/lib/server/identity-continuity'
import {
  buildDelegationTaskProfile,
  formatDelegationRationale,
  resolveDelegationAdvisory,
} from '@/lib/server/agents/delegation-advisory'
import { getAgent, listAgents } from '@/lib/server/agents/agent-repository'
import { loadSkills } from '@/lib/server/skills/skill-repository'
import { buildRuntimeSkillPromptBlocks, resolveRuntimeSkills } from '@/lib/server/skills/runtime-skill-resolver'
import { resolveTeam } from '@/lib/server/agents/team-resolution'
import { canonicalizeExtensionId } from '@/lib/server/tool-aliases'

// ---------------------------------------------------------------------------
// Identity: agent name, description, continuity, soul, systemPrompt, skills
// ---------------------------------------------------------------------------

export function buildIdentitySection(
  agent: Agent | null | undefined,
  session: Session,
  sessionExtensions: string[],
  isMinimalPrompt: boolean,
): string[] {
  if (!agent) return []
  const parts: string[] = []

  if (isMinimalPrompt) {
    parts.push(`## My Identity\nMy name is ${agent.name || 'Agent'}.`)
  } else {
    const identityLines = [`## My Identity`, `My name is ${agent.name || 'Agent'}.`]
    if (agent.description) identityLines.push(agent.description)
    identityLines.push('I should always refer to myself by this name. I am not "Assistant" — I have my own name and identity.')
    parts.push(identityLines.join(' '))
  }

  // Identity continuity — full mode only
  if (!isMinimalPrompt) {
    const continuityBlock = buildIdentityContinuityContext(session, agent)
    if (continuityBlock) parts.push(continuityBlock)
  }

  // Soul — truncated to 300 chars in minimal mode
  if (agent.soul) {
    parts.push(isMinimalPrompt ? agent.soul.slice(0, 300) : agent.soul)
  }

  if (agent.systemPrompt) parts.push(agent.systemPrompt)

  // Skills — full mode only
  if (!isMinimalPrompt) {
    try {
      const allSkills = loadSkills()
      const runtimeSkills = resolveRuntimeSkills({
        cwd: session.cwd,
        enabledExtensions: sessionExtensions,
        agentId: agent.id || null,
        sessionId: session.id,
        userId: session.user,
        agentSkillIds: agent.skillIds || [],
        storedSkills: allSkills,
        selectedSkillId: session.skillRuntimeState?.selectedSkillId || null,
      })
      parts.push(...buildRuntimeSkillPromptBlocks(runtimeSkills))
    } catch { /* non-critical */ }
  }

  return parts
}

// ---------------------------------------------------------------------------
// Thinking Level Guidance
// ---------------------------------------------------------------------------

export function buildThinkingSection(
  thinkingLevel: string | undefined,
  isMinimalPrompt: boolean,
): string | null {
  if (isMinimalPrompt || !thinkingLevel) return null
  const guidance: Record<string, string> = {
    minimal: 'Be direct and concise. Skip extended analysis.',
    low: 'Keep reasoning brief. Focus on key conclusions.',
    medium: 'Provide moderate depth of analysis and reasoning.',
    high: 'Think deeply and thoroughly. Show detailed reasoning.',
  }
  const text = guidance[thinkingLevel]
  return text ? `## Reasoning Depth\n${text}` : null
}

// ---------------------------------------------------------------------------
// Runtime Orientation
// ---------------------------------------------------------------------------

const WORKSPACE_MARKER_FILES = [
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'TOOLS.md',
  'USER.md',
]

function normalizeRuntimeExtensionId(extensionId: string): string {
  const normalized = extensionId.trim().toLowerCase()
  if (!normalized) return ''
  if (normalized === 'delegate_to_claude_code' || normalized === 'claude_code') return 'claude_code'
  if (normalized === 'delegate_to_codex_cli' || normalized === 'codex_cli') return 'codex_cli'
  if (normalized === 'delegate_to_opencode_cli' || normalized === 'opencode_cli') return 'opencode_cli'
  if (normalized === 'delegate_to_gemini_cli' || normalized === 'gemini_cli') return 'gemini_cli'
  if (normalized === 'delegate_to_cursor_cli' || normalized === 'cursor_cli') return 'cursor_cli'
  if (normalized === 'delegate_to_qwen_code_cli' || normalized === 'qwen_code_cli') return 'qwen_code_cli'
  if (['session_info', 'sessions_tool', 'whoami_tool', 'search_history_tool'].includes(normalized)) return 'manage_sessions'
  return canonicalizeExtensionId(normalized)
}

function canonicalizeEnabledExtensions(enabledExtensions: string[]): string[] {
  const seen = new Set<string>()
  const values: string[] = []
  for (const extensionId of enabledExtensions) {
    const normalized = normalizeRuntimeExtensionId(extensionId)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    values.push(normalized)
  }
  return values
}

function formatInlineCodeList(values: string[], maxItems = 8): string {
  if (values.length === 0) return '(none)'
  const head = values.slice(0, maxItems).map((value) => `\`${value}\``)
  if (values.length > maxItems) head.push(`... +${values.length - maxItems} more`)
  return head.join(', ')
}

function formatPolicyBlocks(blocked: SessionToolPolicyDecision['blockedExtensions'], maxItems = 3): string {
  const lines = blocked
    .slice(0, maxItems)
    .map((entry) => `\`${canonicalizeExtensionId(entry.tool)}\` (${entry.reason})`)
  if (blocked.length > maxItems) lines.push(`... +${blocked.length - maxItems} more`)
  return lines.join(', ')
}

function collectWorkspaceMarkers(cwd: string | null | undefined): string[] {
  if (typeof cwd !== 'string' || !cwd.trim()) return []
  return WORKSPACE_MARKER_FILES.filter((filename) => {
    try {
      return fs.existsSync(path.join(cwd, filename))
    } catch {
      return false
    }
  })
}

function resolveRuntimeSessionKind(params: {
  session: Session
  isHeartbeat?: boolean
  isConnectorSession?: boolean
}): string {
  if (params.isHeartbeat) return 'heartbeat'
  if (params.isConnectorSession) return 'connector'
  if (params.session.parentSessionId) return 'delegated_child'
  return 'root_chat'
}

export function buildRuntimeOrientationSection(params: {
  session: Session
  promptMode: PromptMode
  sessionExtensions: string[]
  toolPolicy?: SessionToolPolicyDecision | null
  agent?: Agent | null
  activeProjectContext?: ActiveProjectContext | null
  rootSessionId?: string | null
  isHeartbeat?: boolean
  isConnectorSession?: boolean
}): string {
  const { session, agent } = params
  const activeProjectContext = params.activeProjectContext || null
  const enabledExtensions = canonicalizeEnabledExtensions(params.sessionExtensions)
  const workspaceMarkers = collectWorkspaceMarkers(session.cwd)
  const delegationEnabled = enabledExtensions.some((extensionId) =>
    ['delegate', 'spawn_subagent', 'claude_code', 'codex_cli', 'opencode_cli', 'gemini_cli', 'cursor_cli', 'qwen_code_cli'].includes(extensionId),
  )

  const lines = [
    '## Runtime Orientation',
    `Session: ${resolveRuntimeSessionKind({ session, isHeartbeat: params.isHeartbeat, isConnectorSession: params.isConnectorSession })} | prompt=${params.promptMode} | id=${session.id}`,
    session.parentSessionId || params.rootSessionId
      ? `Lineage: parent=${session.parentSessionId || '(none)'} | root=${params.rootSessionId || session.id}`
      : `Lineage: root=${session.id}`,
    `Agent: ${agent?.name || session.agentId || 'Unassigned'}${session.agentId ? ` [id: ${session.agentId}]` : ''}`,
    `Provider/model: ${session.provider} / ${session.model || '(default)'}`,
    `CWD: ${session.cwd || '(none)'}`,
  ]

  if (workspaceMarkers.length > 0) {
    lines.push(`Workspace markers: ${workspaceMarkers.join(', ')}`)
  }

  if (activeProjectContext?.projectId) {
    const projectLabel = activeProjectContext.project?.name || activeProjectContext.projectId
    const projectRoot = activeProjectContext.projectRoot ? ` | root=${activeProjectContext.projectRoot}` : ''
    lines.push(`Active project: ${projectLabel}${projectRoot}`)
  }

  lines.push(`Enabled capabilities now: ${formatInlineCodeList(enabledExtensions)}`)

  if (params.toolPolicy?.blockedExtensions?.length) {
    lines.push(`Policy blocked: ${formatPolicyBlocks(params.toolPolicy.blockedExtensions)}`)
  }

  if (delegationEnabled) {
    const delegateMode = agent?.delegationTargetMode === 'selected' ? 'selected' : 'all'
    const targetIds = Array.isArray(agent?.delegationTargetAgentIds)
      ? agent!.delegationTargetAgentIds.filter((value) => typeof value === 'string' && value.trim())
      : []
    lines.push(
      delegateMode === 'selected'
        ? `Delegation: enabled (${delegateMode}) | targets=${targetIds.length ? targetIds.join(', ') : '(none configured)'}`
        : 'Delegation: enabled (all allowed targets)',
    )
  } else {
    lines.push('Delegation: disabled in this runtime')
  }

  if (enabledExtensions.includes('manage_sessions')) {
    lines.push('Harness inspection: use `sessions_tool` action `identity` for live session/platform context; use action `history` only when you need earlier messages from this same session.')
  }

  lines.push('Platform routing: prefer direct `manage_*` tools when enabled; use `manage_platform` only as fallback.')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Workspace Context (async — dynamic import)
// ---------------------------------------------------------------------------

export async function buildWorkspaceSection(
  session: Session,
  isMinimalPrompt: boolean,
  heartbeatEnabled: boolean,
): Promise<string | null> {
  if (isMinimalPrompt || !heartbeatEnabled) return null
  try {
    const { buildWorkspaceContext } = await import('@/lib/server/workspace-context')
    const wsCtx = buildWorkspaceContext({ cwd: session.cwd })
    return wsCtx.block || null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Agent Awareness (async — dynamic import)
// ---------------------------------------------------------------------------

export async function buildAgentAwarenessSection(
  session: Session,
  sessionExtensions: string[],
  isMinimalPrompt: boolean,
): Promise<string | null> {
  if (isMinimalPrompt) return null
  const hasMultiAgentTool = sessionExtensions.some(p =>
    p === 'delegate' || p === 'spawn_subagent' ||
    p === 'manage_protocols' || p === 'protocol' ||
    p === 'manage_chatrooms' || p === 'chatroom'
  )
  if (!hasMultiAgentTool || !session.agentId) return null
  try {
    const { buildAgentAwarenessBlock } = await import('@/lib/server/agents/agent-registry')

    // Load agent to get delegation settings so the awareness block respects them
    let delegationOpts: { delegationTargetMode?: 'all' | 'selected'; delegationTargetAgentIds?: string[] } | undefined
    try {
      const agent = getAgent(session.agentId)
      if (agent?.delegationTargetMode === 'selected') {
        delegationOpts = {
          delegationTargetMode: 'selected',
          delegationTargetAgentIds: agent.delegationTargetAgentIds || [],
        }
      }
    } catch { /* non-critical */ }

    return buildAgentAwarenessBlock(session.agentId, delegationOpts) || null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Situational Awareness (async — dynamic import)
// ---------------------------------------------------------------------------

export async function buildSituationalSection(
  session: Session,
  isMinimalPrompt: boolean,
): Promise<string | null> {
  if (isMinimalPrompt || !session.agentId) return null
  try {
    const { buildSituationalAwarenessBlock } = await import(
      '@/lib/server/chat-execution/situational-awareness'
    )
    return buildSituationalAwarenessBlock({
      agentId: session.agentId,
      sessionId: session.id,
    }) || null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Project Context
// ---------------------------------------------------------------------------

export function buildProjectSection(
  activeProjectContext: ActiveProjectContext,
  isMinimalPrompt: boolean,
): string | null {
  if (isMinimalPrompt || !activeProjectContext.projectId) return null

  const lines = ['## Current Project']
  if (activeProjectContext.project?.name) {
    lines.push(`Active project: ${activeProjectContext.project.name}.`)
  } else {
    lines.push(`Active project ID: ${activeProjectContext.projectId}.`)
  }
  if (activeProjectContext.project?.description) {
    lines.push(`Project description: ${activeProjectContext.project.description}`)
    lines.push('Treat the project description above as authoritative context for who the project is for, what it is focused on, and which pilot priorities matter right now. If the user asks about the active project, answer from that description instead of saying the context is unavailable.')
  }
  if (activeProjectContext.objective) lines.push(`Project objective: ${activeProjectContext.objective}`)
  if (activeProjectContext.audience) lines.push(`Who it is for: ${activeProjectContext.audience}`)
  if (activeProjectContext.priorities.length > 0) lines.push(`Pilot priorities: ${activeProjectContext.priorities.join('; ')}`)
  if (activeProjectContext.openObjectives.length > 0) lines.push(`Open objectives: ${activeProjectContext.openObjectives.join('; ')}`)
  if (activeProjectContext.capabilityHints.length > 0) lines.push(`Suggested operating modes: ${activeProjectContext.capabilityHints.join('; ')}`)
  if (activeProjectContext.credentialRequirements.length > 0) lines.push(`Credential and secret requirements: ${activeProjectContext.credentialRequirements.join('; ')}`)
  if (activeProjectContext.successMetrics.length > 0) lines.push(`Success metrics: ${activeProjectContext.successMetrics.join('; ')}`)
  if (activeProjectContext.heartbeatPrompt) lines.push(`Preferred heartbeat prompt: ${activeProjectContext.heartbeatPrompt}`)
  if (activeProjectContext.heartbeatIntervalSec != null) lines.push(`Preferred heartbeat interval: ${activeProjectContext.heartbeatIntervalSec}s`)
  if (activeProjectContext.resourceSummary) {
    const summary = activeProjectContext.resourceSummary
    const resourceBits = [
      `open tasks ${summary.openTaskCount}`,
      `active schedules ${summary.activeScheduleCount}`,
      `project secrets ${summary.secretCount}`,
    ]
    if (summary.topTaskTitles.length > 0) lines.push(`Top open tasks: ${summary.topTaskTitles.join('; ')}`)
    if (summary.failedTaskCount > 0) lines.push(`Failed tasks needing attention: ${summary.failedTaskCount}`)
    if (summary.staleTaskCount > 0) lines.push(`Stale tasks (no update in 3+ days): ${summary.staleTaskCount}`)
    if (summary.scheduleNames.length > 0) lines.push(`Active schedules: ${summary.scheduleNames.join('; ')}`)
    if (summary.secretNames.length > 0) lines.push(`Known project secrets: ${summary.secretNames.join('; ')}`)
    lines.push(`Project resource summary: ${resourceBits.join(', ')}.`)
  }
  if (activeProjectContext.projectRoot) lines.push(`Workspace root: ${activeProjectContext.projectRoot}`)
  lines.push('When creating project tasks, schedules, secrets, memories, or deliverables for this work, default them to the active project unless the user redirects you.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tool & Extension Access Audit (async)
// ---------------------------------------------------------------------------

export async function buildExtensionAccessAuditSection(
  sessionExtensions: string[],
  mcpDisabledTools: string[] | undefined,
  isMinimalPrompt: boolean,
): Promise<string | null> {
  if (isMinimalPrompt) return null
  const { listNativeCapabilities } = await import('@/lib/server/native-capabilities')
  const { getExtensionManager: getEM } = await import('@/lib/server/extensions')
  const agentEnabledSet = new Set(sessionExtensions)
  const allExtensions = [...listNativeCapabilities(), ...getEM().listExtensions()]
  const mcpDisabled = mcpDisabledTools ?? []

  const globallyDisabled: string[] = []
  const enabledButNoAccess: string[] = []
  for (const p of allExtensions) {
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
  return accessParts.length > 0
    ? `## Tool & Extension Access\n${accessParts.join('\n')}`
    : null
}

// ---------------------------------------------------------------------------
// Follow-up Suggestions
// ---------------------------------------------------------------------------

export function buildSuggestionsSection(
  suggestionsEnabled: boolean | undefined,
  isMinimalPrompt: boolean,
): string | null {
  if (isMinimalPrompt || suggestionsEnabled !== true) return null
  return [
    '## Follow-up Suggestions',
    'At the end of every response, include a <suggestions> block with exactly 3 short',
    'follow-up prompts the user might want to send next, as a JSON array. Keep each under 60 chars.',
    'Make them contextual to what you just said. Example:',
    '<suggestions>["Set up a Discord connector", "Create a research agent", "Show the task board"]</suggestions>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Proactive Memory Recall (async)
// ---------------------------------------------------------------------------

export interface ProactiveMemoryResult {
  section: string | null
  injectedIds: Record<string, number>
  knowledgeTrace?: KnowledgeRetrievalTrace | null
}

export async function buildProactiveMemorySection(
  session: Session,
  agent: Agent | null | undefined,
  message: string,
  activeProjectRoot: string | null,
  isMinimalPrompt: boolean,
  currentThreadRecallRequest: boolean,
): Promise<ProactiveMemoryResult> {
  const noResult: ProactiveMemoryResult = { section: null, injectedIds: {}, knowledgeTrace: null }
  if (isMinimalPrompt || !session.agentId || currentThreadRecallRequest || message.length <= 12) return noResult
  if (!agent?.proactiveMemory) return noResult
  try {
    const { getMemoryDb } = await import('@/lib/server/memory/memory-db')
    const { buildSessionMemoryScopeFilter } = await import('@/lib/server/memory/session-memory-scope')
    const { buildKnowledgeRetrievalTrace } = await import('@/lib/server/knowledge-sources')
    const memDb = getMemoryDb()
    const recalled = memDb.search(message, session.agentId, {
      scope: buildSessionMemoryScopeFilter(session, agent.memoryScopeMode || null, activeProjectRoot),
    })
    const knowledgeTrace = await buildKnowledgeRetrievalTrace({
      query: message,
      viewerAgentId: session.agentId,
    })

    // Dedup: skip memories already injected 2+ times in this session
    const priorCounts = session.injectedMemoryIds || {}
    const filtered = recalled.filter((entry) => (priorCounts[entry.id] || 0) < 2)

    const topRecalled = filtered.slice(0, 3)
    const sections: string[] = []
    if (topRecalled.length > 0) {
      // Track injection counts
      const updatedCounts: Record<string, number> = { ...priorCounts }
      for (const entry of topRecalled) {
        updatedCounts[entry.id] = (updatedCounts[entry.id] || 0) + 1
      }

      const recalledLines = topRecalled.map((entry) =>
        `- ${entry.abstract || entry.content.slice(0, 300)}`,
      )
      sections.push(`## Recalled Context\nRelevant memories from previous interactions:\n${recalledLines.join('\n')}`)
      if (knowledgeTrace?.hits.length) {
        const groundingLines = knowledgeTrace.hits.map((hit) =>
          `- [${hit.chunkIndex + 1}/${hit.chunkCount}] ${hit.sourceTitle}: ${hit.snippet}`,
        )
        sections.push(`## Source Grounding\nSource-backed knowledge retrieved for this turn:\n${groundingLines.join('\n')}`)
      }
      return {
        section: sections.join('\n\n'),
        injectedIds: updatedCounts,
        knowledgeTrace,
      }
    }

    if (knowledgeTrace?.hits.length) {
      const groundingLines = knowledgeTrace.hits.map((hit) =>
        `- [${hit.chunkIndex + 1}/${hit.chunkCount}] ${hit.sourceTitle}: ${hit.snippet}`,
      )
      return {
        section: `## Source Grounding\nSource-backed knowledge retrieved for this turn:\n${groundingLines.join('\n')}`,
        injectedIds: priorCounts,
        knowledgeTrace,
      }
    }
  } catch { /* non-critical */ }
  return noResult
}

// ---------------------------------------------------------------------------
// Coordinator Section — lists available workers for coordinator agents
// ---------------------------------------------------------------------------

const COORDINATOR_MAX_WORKERS = 20
const COORDINATOR_MAX_CHARS = 3000

export function buildCoordinatorSection(
  agent: Agent | null | undefined,
  sessionExtensions?: string[],
): string | null {
  if (!agent || agent.role !== 'coordinator') return null

  const allAgents = listAgents()
  const selfId = agent.id

  // Resolve which agents this coordinator can delegate to
  const delegateMode = agent.delegationTargetMode || 'all'
  const delegateIds = new Set(agent.delegationTargetAgentIds || [])

  const workers = Object.values(allAgents).filter((a) => {
    if (a.id === selfId) return false
    if (a.disabled) return false
    if (delegateMode === 'selected' && !delegateIds.has(a.id)) return false
    return true
  })

  if (workers.length === 0) return null

  const lines: string[] = [
    '## Coordinator — Available Workers',
    'You are a **coordinator agent**. Your primary role is to orchestrate work by delegating to specialist workers.',
    'You CAN use tools directly for quick lookups, validation, and reconnaissance (checking files, listing directories, reading configs, light web searches).',
    'You SHOULD delegate via `spawn_subagent` for substantial work: building projects, writing code, deep research, creating documents, or any multi-step task that matches a worker\'s specialty.',
    'After delegating, wait for results, then synthesize a coherent final response.',
    '',
    '### Workers',
  ]

  let charBudget = COORDINATOR_MAX_CHARS - lines.join('\n').length
  const listed = workers.slice(0, COORDINATOR_MAX_WORKERS)

  for (const w of listed) {
    const caps = w.capabilities?.length ? ` [${w.capabilities.join(', ')}]` : ''
    const desc = w.description ? ` — ${w.description.slice(0, 100)}` : ''
    const line = `- **${w.name}** [id: ${w.id}]${caps}${desc}`
    if (charBudget - line.length < 0) break
    charBudget -= line.length + 1
    lines.push(line)
  }

  if (workers.length > COORDINATOR_MAX_WORKERS) {
    lines.push(`- ... and ${workers.length - COORDINATOR_MAX_WORKERS} more workers`)
  }

  if (delegateMode === 'selected') {
    lines.push('')
    lines.push('**IMPORTANT:** You may ONLY delegate to the workers listed above. Do NOT attempt to delegate to any other agents — such attempts will be rejected.')
  }

  lines.push('')
  lines.push('### Orchestration Tools')
  lines.push('- **`spawn_subagent`** — Simple fire-and-forget delegation. Best for: single tasks, batch parallel/serial, basic swarm. Use when tasks are independent.')

  const hasProtocols = sessionExtensions?.some((e) => e === 'manage_protocols' || e === 'protocol')
  if (hasProtocols) {
    lines.push('- **`manage_protocols`** — Structured orchestration workflows. **Default choice for any work with defined steps, goals, or deliverables.** Best for: sequential pipelines (research → synthesize → review), conditional branching (if/else on results), looping (retry until condition), DAG (tasks with dependencies), forEach (dynamic parallel over a list), subflows (nested workflows), review panels, decision rounds, competitive swarm (work items + claim semantics). Use whenever execution order matters, tasks have dependencies, or you need to track progress through phases.')
  }

  lines.push('- **`manage_chatrooms`** — Multi-agent conversation. Use **only** for genuinely open-ended discussion with no predetermined structure: brainstorming sessions, debates, real-time Q&A, or collaborative exploration where the conversation direction is unknown in advance. Chatrooms are for talking, not for executing work.')
  lines.push('')
  lines.push('**Anti-pattern:** Do NOT use chatrooms as a substitute for protocols when work has defined steps, goals, or deliverables. If you can describe the work as a sequence of phases or tasks, use `manage_protocols`. Chatrooms should be rare — most coordinated work is structured.')
  lines.push('')
  lines.push('- Always wait for all delegated work to complete before synthesizing your final response.')
  lines.push('- Match tasks to workers based on their capabilities and description.')

  lines.push('')
  lines.push('### When to Delegate vs. Do Directly')
  lines.push('- **Delegate:** Multi-step work, coding, building, deep research, document creation — anything matching a worker\'s specialty')
  lines.push('- **Do directly:** Quick file reads, listing directories, checking configs, simple web lookups to inform your delegation plan')
  lines.push('- **Anti-pattern:** Writing multiple files, running build commands, or doing extended research yourself when you have specialist workers available')

  lines.push('')
  lines.push('### Delegation Brief Template')
  lines.push('When delegating via `spawn_subagent`, structure your objective clearly:')
  lines.push('- **Objective:** What the worker should accomplish (one sentence)')
  lines.push('- **Acceptance criteria:** How you will know the work is done correctly')
  lines.push('- **Context:** Relevant background the worker needs (file paths, prior findings)')
  lines.push('- **Expected output:** What format or deliverable you expect back')

  return lines.join('\n')
}

export function buildDelegationRecommendationSection(params: {
  agent: Agent | null | undefined
  classification?: MessageClassification | null
}): string | null {
  const agent = params.agent
  if (!agent || agent.delegationEnabled !== true) return null
  const profile = buildDelegationTaskProfile({
    classification: params.classification,
  })
  if (!profile.substantial) return null

  const advisory = resolveDelegationAdvisory({
    currentAgent: agent,
    agents: listAgents(),
    profile,
    delegationTargetMode: agent.delegationTargetMode === 'selected' ? 'selected' : 'all',
    delegationTargetAgentIds: agent.delegationTargetAgentIds || [],
  })
  if (!advisory.shouldDelegate || !advisory.recommended) return null

  const recommendation = advisory.recommended
  const workLabel = profile.workType === 'general' ? 'substantial work' : `${profile.workType} work`
  const recommendationLabel = advisory.style === 'managerial'
    ? 'Managerial Delegation Recommendation'
    : 'Delegation Recommendation'

  return [
    `## ${recommendationLabel}`,
    `This request looks like ${workLabel}.`,
    `Best-fit teammate: **${recommendation.agentName}** [id: ${recommendation.agentId}]`,
    `Why: ${formatDelegationRationale(recommendation)}.`,
    advisory.style === 'managerial'
      ? 'Prefer delegating the execution and keep your direct work to reconnaissance, validation, and synthesis.'
      : 'Prefer delegating the execution and reserve direct tool use for quick lookups or validation.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Credential Awareness
// ---------------------------------------------------------------------------

export function buildCredentialAwarenessSection(
  activeProjectContext: ActiveProjectContext,
  isMinimalPrompt: boolean,
): string | null {
  if (isMinimalPrompt) return null
  const requirements = activeProjectContext.credentialRequirements
  if (!requirements || requirements.length === 0) return null

  const secretNames = activeProjectContext.resourceSummary?.secretNames || []

  const missing: string[] = []
  const available: string[] = []
  for (const req of requirements) {
    const reqLower = req.toLowerCase()
    const isAvailable = secretNames.some(
      (name) => reqLower.includes(name.toLowerCase()) || name.toLowerCase().includes(reqLower),
    )
    if (isAvailable) {
      available.push(req)
    } else {
      missing.push(req)
    }
  }

  if (missing.length === 0) return null

  const lines = ['## Credential Status']
  if (available.length > 0) {
    lines.push(`Available: ${available.join(', ')}`)
  }
  lines.push(`Missing: ${missing.join(', ')}`)
  lines.push('')
  lines.push('When you encounter a missing credential, use the self-service workflow:')
  lines.push('1. manage_secrets(action="check", service="<name>") — verify it is truly missing')
  lines.push('2. manage_secrets(action="request", service="<name>", reason="<why>") — request it from the human')
  lines.push('Do NOT report a credential blocker without first checking and requesting.')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI Delegation Context — condensed context for CLI backends
// ---------------------------------------------------------------------------

const DELEGATION_CONTEXT_BUDGET = 2000

/**
 * Assemble condensed context for CLI delegation backends.
 * Budget-capped to ~2000 chars so it doesn't overwhelm the CLI tool's context.
 */
export function buildCliDelegationContext(opts: {
  agent?: Agent | null
  session?: Session | null
  task?: string
  projectName?: string | null
  projectDescription?: string | null
}): string {
  const parts: string[] = []
  let budget = DELEGATION_CONTEXT_BUDGET

  const append = (line: string) => {
    if (budget - line.length < 0) return false
    parts.push(line)
    budget -= line.length + 1
    return true
  }

  // Agent identity
  if (opts.agent) {
    const name = opts.agent.name || 'Agent'
    const desc = opts.agent.description ? ` — ${opts.agent.description.slice(0, 150)}` : ''
    append(`You are ${name}${desc}.`)
  }

  // Project context
  if (opts.projectName) {
    const projDesc = opts.projectDescription ? `: ${opts.projectDescription.slice(0, 200)}` : ''
    append(`Project: ${opts.projectName}${projDesc}`)
  }

  // Current task
  if (opts.task) {
    append(`Task: ${opts.task.slice(0, 300)}`)
  }

  // Working directory
  if (opts.session?.cwd) {
    append(`Working directory: ${opts.session.cwd}`)
  }

  // Team roster summary
  if (opts.agent?.id) {
    try {
      const team = resolveTeam(opts.agent.id, listAgents())
      if (team.mode === 'team') {
        const teammates = [
          ...(team.coordinator ? [`${team.coordinator.name} (coordinator)`] : []),
          ...team.peers.map((p) => p.name),
          ...team.directReports.map((r) => r.name),
        ].slice(0, 8)
        if (teammates.length > 0) {
          append(`Team: ${teammates.join(', ')}`)
        }
      }
    } catch { /* non-critical */ }
  }

  return parts.join('\n')
}

// Re-export RunContext prompt builder from its canonical home
export { buildRunContextSection } from '@/lib/server/run-context'
