import fs from 'fs'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { buildSessionTools } from './session-tools'
import { buildChatModel } from './build-llm'
import { loadSettings, loadAgents, loadSkills, appendUsage } from './storage'
import { estimateCost } from './cost'
import { getPluginManager } from './plugins'
import { loadRuntimeSettings, getAgentLoopRecursionLimit } from './runtime-settings'
import { getMemoryDb } from './memory-db'
import { logExecution } from './execution-log'
import { buildCurrentDateTimePromptContext } from './prompt-runtime-context'
import type { Session, Message, UsageRecord } from '@/types'
import { extractSuggestions } from './suggestions'

/** Extract a breadcrumb title from notable tool completions (task/schedule/agent creation). */
function extractBreadcrumbTitle(toolName: string, input: unknown, output: string | undefined): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>
  const action = typeof inp.action === 'string' ? inp.action : ''
  if (toolName === 'manage_tasks') {
    if (action === 'create') return `Created task: ${inp.title || 'Untitled'}`
    if (output && /status.*completed|completed.*successfully/i.test(output)) return `Completed task: ${inp.title || inp.taskId || 'unknown'}`
  }
  if (toolName === 'manage_schedules' && action === 'create') return `Created schedule: ${inp.name || 'Untitled'}`
  if (toolName === 'manage_agents' && action === 'create') return `Created agent: ${inp.name || 'Untitled'}`
  return null
}

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

function buildToolCapabilityLines(enabledTools: string[], opts?: { platformAssignScope?: 'self' | 'all' }): string[] {
  const lines: string[] = []
  if (enabledTools.includes('shell')) lines.push('- I can run shell commands (`execute_command`) — servers, installs, scripts, git, builds, anything. I can run things in the background for long-lived processes like dev servers.')
  if (enabledTools.includes('process')) lines.push('- I can manage running processes (`process_tool`) — check status, read logs, send input, or stop them.')
  if (enabledTools.includes('files') || enabledTools.includes('copy_file') || enabledTools.includes('move_file') || enabledTools.includes('delete_file')) {
    lines.push('- I can read, write, copy, move, and send files (`read_file`, `write_file`, `list_files`, `copy_file`, `move_file`, `send_file`). Deleting files is destructive, so that may need explicit permission.')
  }
  if (enabledTools.includes('edit_file')) lines.push('- I can make precise edits to files (`edit_file`) — surgical find-and-replace without rewriting the whole file.')
  if (enabledTools.includes('web_search')) lines.push('- I can search the web (`web_search`) for research, fact-checking, and discovery.')
  if (enabledTools.includes('web_fetch')) lines.push('- I can fetch and read web pages (`web_fetch`) to pull in real content for analysis.')
  if (enabledTools.includes('browser')) lines.push('- I can control a browser (`browser`) — navigate sites, fill forms, take screenshots, interact with web apps.')
  if (enabledTools.includes('claude_code')) lines.push('- I can hand off deep coding work to Claude Code (`delegate_to_claude_code`) for complex multi-file refactors and code generation. Resume IDs may come back via `[delegate_meta]`.')
  if (enabledTools.includes('codex_cli')) lines.push('- I can hand off deep coding work to Codex (`delegate_to_codex_cli`) for complex multi-file refactors and code generation. Resume IDs may come back via `[delegate_meta]`.')
  if (enabledTools.includes('opencode_cli')) lines.push('- I can hand off deep coding work to OpenCode (`delegate_to_opencode_cli`) for complex multi-file refactors and code generation. Resume IDs may come back via `[delegate_meta]`.')
  if (enabledTools.includes('memory')) lines.push('- I have long-term memory (`memory_tool`) — I can remember things across conversations and recall them when needed.')
  if (enabledTools.includes('sandbox')) lines.push('- I can run code in a sandbox (`sandbox_exec`) — JS/TS via Deno or Python, in an isolated environment. I get stdout, stderr, and any files created.')
  if (enabledTools.includes('manage_agents')) lines.push('- I can create and configure other agents (`manage_agents`) — spin up specialists when a task calls for it.')
  if (enabledTools.includes('manage_tasks')) lines.push('- I can manage tasks (`manage_tasks`) — create plans, track progress, and stay organized over time.')
  if (enabledTools.includes('manage_schedules')) lines.push('- I can set up schedules (`manage_schedules`) for recurring work or future follow-ups.')
  if (enabledTools.includes('schedule_wake')) lines.push('- I can set a conversational timer (`schedule_wake`) to remind myself to check back on something later in this chat.')
  if (enabledTools.includes('manage_documents')) lines.push('- I can store and search documents (`manage_documents`) for long-term knowledge and reference.')
  if (enabledTools.includes('manage_webhooks')) lines.push('- I can register webhooks (`manage_webhooks`) so external events can trigger my work automatically.')
  if (enabledTools.includes('manage_skills')) lines.push('- I can manage reusable skills (`manage_skills`) — building blocks I can learn and apply.')
  if (enabledTools.includes('manage_connectors')) lines.push('- I can manage messaging channels (`manage_connectors`) — WhatsApp, Telegram, Slack, Discord — and send proactive messages via `connector_message_tool`.')
  if (enabledTools.includes('manage_sessions')) lines.push('- I can manage chat sessions (`manage_sessions`, `sessions_tool`, `whoami_tool`, `search_history_tool`) — check my identity, look up past conversations, message other sessions, and coordinate work.')
  // Context tools are available to any session with tools (not just manage_sessions)
  if (enabledTools.length > 0) {
    lines.push('- I can monitor my own context usage (`context_status`) and compact my conversation history (`context_summarize`) when I\'m running low on space.')
    if (opts?.platformAssignScope === 'all') {
      lines.push('- I can delegate tasks to other agents (`delegate_to_agent`) based on their strengths and availability.')
    }
  }
  if (enabledTools.includes('manage_secrets')) lines.push('- I can store and retrieve encrypted secrets (`manage_secrets`) — API keys, credentials, tokens.')
  if (enabledTools.includes('manage_chatrooms')) lines.push('- I can create and participate in chatrooms (`manage_chatrooms`) for multi-agent collaboration with @mention-based discussions.')
  if (enabledTools.includes('wallet')) lines.push('- I have my own crypto wallet (`wallet_tool`) — I can check my balance, send SOL, and review my transaction history.')
  return lines
}

/** Detect whether a user message is a broad, high-level goal that benefits from decomposition. */
function isBroadGoal(text: string): boolean {
  if (text.length < 50) return false
  // Messages with code fences, file paths, or numbered steps are already structured
  if (/```/.test(text)) return false
  if (/\/(src|lib|app|pages|components|api)\//.test(text)) return false
  if (/^\s*\d+[.)]\s/m.test(text)) return false
  // Short direct questions aren't broad goals
  if (text.length < 80 && text.endsWith('?')) return false
  return true
}

const GOAL_DECOMPOSITION_BLOCK = [
  '## Goal Decomposition',
  'When you receive a broad, open-ended goal:',
  '1. Break it into 3-7 concrete, sequentially-executable subtasks before taking action.',
  '2. If manage_tasks is available, create a task for each subtask to track progress.',
  '3. Output your plan in a [MAIN_LOOP_PLAN] JSON line: {"steps":["step1","step2",...],"current_step":"step1"}',
  '4. Execute the first subtask immediately — do not stop after planning.',
  '5. After each subtask, update progress and move to the next.',
].join('\n')

function buildAgenticExecutionPolicy(opts: {
  enabledTools: string[]
  loopMode: 'bounded' | 'ongoing'
  heartbeatPrompt: string
  heartbeatIntervalSec: number
  platformAssignScope?: 'self' | 'all'
  userMessage?: string
  hasExistingPlan?: boolean
}) {
  const hasTooling = opts.enabledTools.length > 0
  const toolLines = buildToolCapabilityLines(opts.enabledTools, { platformAssignScope: opts.platformAssignScope })
  const delegationOrder = [
    opts.enabledTools.includes('claude_code') ? '`delegate_to_claude_code`' : null,
    opts.enabledTools.includes('codex_cli') ? '`delegate_to_codex_cli`' : null,
    opts.enabledTools.includes('opencode_cli') ? '`delegate_to_opencode_cli`' : null,
  ].filter(Boolean) as string[]
  const hasDelegationTool = delegationOrder.length > 0
  return [
    '## How I Work',
    'I take initiative. When there\'s work to do, I do it — I use my tools to research, build, and make real progress rather than just talking about it.',
    hasTooling
      ? 'For open-ended requests, run an action loop: plan briefly, execute tools, evaluate results, then continue until meaningful progress is achieved.'
      : 'This session has no tools enabled, so be explicit about what tool access is needed for deeper execution.',
    'Do not stop at generic advice when the request implies action (research, coding, setup, business ideas, optimization, automation, or platform operations).',
    'For multi-step work, keep the user informed with short progress updates tied to real actions (what you are doing now, what finished, and what is next).',
    'If you state an intention to do research/build/execute, immediately follow through with tool calls in the same run.',
    'Never claim completed research/build results without tool evidence. If a tool fails or returns empty results, say that clearly and retry with another approach.',
    'If the user names a tool explicitly (for example "call connector_message_tool"), you must actually invoke that tool instead of simulating or paraphrasing its result.',
    'Before finalizing: verify key claims with concrete outputs from tools whenever tools are available.',
    opts.loopMode === 'ongoing'
      ? 'Loop mode is ONGOING: prefer continued execution and progress tracking over one-shot replies; keep iterating until done, blocked, or safety/runtime limits are reached.'
      : 'Loop mode is BOUNDED: still execute multiple steps when needed, but finish within the recursion budget.',
    opts.enabledTools.includes('manage_tasks')
      ? 'When goals are long-lived, create/update tasks in the task board so progress is trackable over time.'
      : '',
    opts.enabledTools.includes('manage_schedules')
      ? 'When goals require follow-up, create schedules for recurring checks or future actions instead of waiting for manual prompts.'
      : '',
    opts.enabledTools.includes('manage_schedules')
      ? 'Before creating a schedule, first inspect existing schedules (list/get) and reuse or update a matching one instead of creating duplicates.'
      : '',
    opts.enabledTools.includes('manage_agents')
      ? 'If a specialist would improve output, create or configure a focused agent and assign work accordingly.'
      : '',
    opts.enabledTools.includes('manage_documents')
      ? 'For substantial context, store source documents and retrieve them with manage_documents search/get instead of relying on short memory snippets alone.'
      : '',
    opts.enabledTools.includes('manage_webhooks')
      ? 'For event-driven workflows, register webhooks and let external triggers enqueue follow-up work automatically.'
      : '',
    opts.enabledTools.includes('manage_connectors')
      ? 'If the user wants proactive outreach (e.g., WhatsApp updates), configure connectors and pair with schedules/tasks to deliver status updates.'
      : '',
    opts.enabledTools.includes('manage_connectors')
      ? 'Autonomous outreach is allowed for significant events (completed/failed tasks, blockers, deadlines, meaningful reminders from memory). Avoid casual or repetitive check-ins.'
      : '',
    opts.enabledTools.includes('manage_connectors')
      ? 'When you proactively message through connectors, keep it concise and purposeful, and avoid sending duplicate updates about the same event.'
      : '',
    opts.enabledTools.includes('manage_sessions')
      ? 'When coordinating platform work, inspect existing sessions and avoid duplicating active efforts.'
      : '',
    hasDelegationTool
      ? 'CRITICAL — tool selection: ALWAYS use `execute_command` for running servers, dev servers, HTTP servers, installing dependencies, running scripts, git operations, process management, starting/stopping services, or any command the user wants to "run". Delegation tools (Claude/Codex/OpenCode) CANNOT keep a server running — their session ends and the process dies. `execute_command` with background=true is the ONLY way to run persistent processes.'
      : '',
    opts.enabledTools.includes('shell')
      ? 'When the user asks for an IP address or network URL, execute shell commands to resolve it and return the concrete value. Never reply with placeholders like `<your-local-ip>` and never tell the user to run `ifconfig`/`ipconfig` themselves unless shell access is unavailable.'
      : '',
    opts.enabledTools.includes('shell')
      ? 'For long-lived servers/processes: start with `execute_command` using `background=true`, capture the returned processId, then verify with `process_tool` status/log before claiming success. If the process exits or crashes, retry with a corrected command and report what changed.'
      : '',
    opts.enabledTools.includes('shell')
      ? 'Do not claim a server is running unless there is direct tool evidence (process status/log output).'
      : '',
    opts.enabledTools.includes('shell')
      ? 'If `execute_command` fails due workdir/path traversal, retry without a workdir override or use a safe relative path under the current session cwd.'
      : '',
    hasDelegationTool
      ? `Only use CLI delegation (${delegationOrder.join(' -> ')}) for tasks that need deep code understanding across multiple files: large refactors, complex debugging, multi-file code generation, or test suites. Never delegate when the user says "run", "start", "serve", "execute", or "test it locally".`
      : '',
    opts.enabledTools.includes('memory')
      ? 'Memory is active and required for long-horizon work: before major tasks, run memory_tool search/list for relevant prior work; after each meaningful step, store concise reusable notes (what changed, where it lives, constraints, next step). Treat memory as shared context plus your own agent notes, not as user-owned personal profile data.'
      : '',
    opts.enabledTools.includes('memory')
      ? 'The platform preloads relevant memory context each turn. Use memory_tool for deeper lookup, explicit recall requests, and durable storage.'
      : '',
    opts.enabledTools.includes('memory')
      ? 'If the user gives an open goal (e.g. "go make money"), do not keep re-asking broad clarifying questions. Form a hypothesis, execute a concrete step, then adapt using memory + evidence.'
      : '',
    '## Knowing When Not to Reply',
    'Real conversations have natural pauses. Not every message needs a response — sometimes the most human thing is comfortable silence.',
    'Reply with exactly "NO_MESSAGE" (nothing else) to suppress outbound delivery when replying would feel unnatural.',
    'Think about what a thoughtful friend would do:',
    '- "okay" / "alright" / "cool" / "got it" / "sounds good" → they\'re just acknowledging, not expecting a reply back',
    '- "thanks" / "thx" / "ty" after you\'ve helped → the conversation is wrapping up naturally',
    '- thumbs up, emoji reactions, read receipts → these are closers, not openers',
    '- "night" / "ttyl" / "bye" / "gotta go" → they\'re leaving, let them go',
    '- "haha" / "lol" / "lmao" → they appreciated something, no follow-up needed',
    '- forwarded content or status updates with no question → they\'re sharing, not asking',
    'Always reply when:',
    '- There is a question, even an implied one ("I wonder if...")',
    '- They give you a task or instruction',
    '- They share something emotional or personal — silence here feels cold',
    '- They say "thanks" with a follow-up context ("thanks, what about X?") or in a tone that expects "you\'re welcome"',
    '- You have something genuinely useful to add',
    'The test: if you saw this message from a friend, would you feel compelled to type something back? If not, NO_MESSAGE.',
    'Ask for confirmation only for high-risk or irreversible actions. For normal low-risk research/build steps, proceed autonomously.',
    'Default behavior is execution, not interrogation: do not ask exploratory clarification questions when a safe next action exists.',
    'Do not end every response with a question. Use declarative completion statements by default, and only ask a question when a concrete missing detail blocks the next action.',
    'Do not pause for a "continue" confirmation after the user has already asked you to execute a goal. Keep moving until blocked by permissions, missing credentials, or hard tool failures.',
    'Never repeat one-time side effects that are already complete (for example creating the same schedule/task again). Verify state first, then either continue execution or reply HEARTBEAT_OK.',
    'For main-loop tick messages that begin with "SWARM_MAIN_MISSION_TICK" or "SWARM_MAIN_AUTO_FOLLOWUP", follow that response contract exactly and include one valid [MAIN_LOOP_META] JSON line when you are not returning HEARTBEAT_OK.',
    `Heartbeat protocol: if the user message is exactly "${opts.heartbeatPrompt}", reply exactly "HEARTBEAT_OK" when there is nothing important to report; otherwise reply with a concise progress update and immediate next step.`,
    opts.heartbeatIntervalSec > 0
      ? `Expected heartbeat cadence is roughly every ${opts.heartbeatIntervalSec} seconds while ongoing work is active.`
      : '',
    toolLines.length ? 'What I can do:\n' + toolLines.join('\n') : '',
    // Inject goal decomposition instructions for broad goals without existing plans
    (opts.userMessage && !opts.hasExistingPlan && isBroadGoal(opts.userMessage)) ? GOAL_DECOMPOSITION_BLOCK : '',
  ].filter(Boolean).join('\n')
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
  const sessionToolsWithImplicitProcess = Array.from(new Set([
    ...(session.tools || []),
    ...((session.tools || []).includes('shell') ? ['process'] : []),
  ]))

  // fallbackCredentialIds is intentionally accepted for compatibility with caller signatures.
  void fallbackCredentialIds

  // Resolve agent's thinking level for provider-native params
  let agentThinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | undefined
  if (session.agentId) {
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
    if (!Number.isFinite(parsed)) return 120
    return Math.max(0, Math.min(3600, Math.trunc(parsed)))
  })()

  const stateModifierParts: string[] = []
  const hasProvidedSystemPrompt = typeof systemPrompt === 'string' && systemPrompt.trim().length > 0

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
  if (session.agentId) {
    const agents = loadAgents()
    const agent = agents[session.agentId]
    agentPlatformAssignScope = agent?.platformAssignScope || 'self'
    agentMcpServerIds = agent?.mcpServerIds
    agentMcpDisabledTools = agent?.mcpDisabledTools
    if (!hasProvidedSystemPrompt) {
      // Identity block — make sure the agent knows who it is
      const identityLines = [`## My Identity`, `My name is ${agent?.name || 'Agent'}.`]
      if (agent?.description) identityLines.push(agent.description)
      identityLines.push('I should always refer to myself by this name. I am not "Assistant" — I have my own name and identity.')
      stateModifierParts.push(identityLines.join(' '))
      if (agent?.soul) stateModifierParts.push(agent.soul)
      if (agent?.systemPrompt) stateModifierParts.push(agent.systemPrompt)
      if (agent?.skillIds?.length) {
        const allSkills = loadSkills()
        for (const skillId of agent.skillIds) {
          const skill = allSkills[skillId]
          if (skill?.content) stateModifierParts.push(`## Skill: ${skill.name}\n${skill.content}`)
        }
      }
    }
  }

  if (!hasProvidedSystemPrompt) {
    stateModifierParts.push('I\'m here to get things done. I take action, use my tools, and focus on outcomes.')
  }

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

  if ((session.tools || []).includes('memory') && session.agentId) {
    try {
      const memDb = getMemoryDb()
      const memoryQuerySeed = [
        message,
        ...history
          .slice(-4)
          .filter((h) => h.role === 'user')
          .map((h) => h.text),
      ].join('\n')

      const seen = new Set<string>()
      const formatMemoryLine = (m: { category?: string; title?: string; content?: string; pinned?: boolean }) => {
        const category = String(m.category || 'note')
        const title = String(m.title || 'Untitled').replace(/\s+/g, ' ').trim()
        const snippet = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 220)
        const pin = m.pinned ? ' [pinned]' : ''
        return `- [${category}]${pin} ${title}: ${snippet}`
      }

      // Pinned memories always appear first
      const pinned = memDb.listPinned(session.agentId, 5)
      const pinnedLines = pinned
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      // Reduce relevant slice by pinned count to keep total context bounded
      const relevantSlice = Math.max(2, 6 - pinnedLines.length)
      const relevantLookup = memDb.searchWithLinked(memoryQuerySeed, session.agentId, 1, 10, 14)
      const relevant = relevantLookup.entries.slice(0, relevantSlice)
      const recent = memDb.list(session.agentId, 12).slice(0, 6)

      const relevantLines = relevant
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      const recentLines = recent
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      const memorySections: string[] = []
      if (pinnedLines.length) {
        memorySections.push(
          ['## Pinned Memories', 'Always-loaded memories marked as important.', ...pinnedLines].join('\n'),
        )
      }
      if (relevantLines.length) {
        memorySections.push(
          ['## Relevant Memory Hits', 'These memories were retrieved by relevance for the current objective.', ...relevantLines].join('\n'),
        )
      }
      if (recentLines.length) {
        memorySections.push(
          ['## Recent Memory Notes', 'Recent durable notes that may still apply.', ...recentLines].join('\n'),
        )
      }

      if (memorySections.length) {
        stateModifierParts.push(memorySections.join('\n\n'))
      }

      // Memory Policy — always injected when memory tool is available
      stateModifierParts.push([
        '## My Memory',
        'I have long-term memory that persists across conversations. I use it naturally — I don\'t wait to be asked to remember things.',
        '',
        '**Things worth remembering:**',
        '- What the user likes, dislikes, or has corrected me on',
        '- Important decisions, outcomes, and lessons learned',
        '- What I\'ve discovered about projects, codebases, or environments',
        '- Problems I\'ve hit and how I solved them',
        '- Who people are and how they relate to each other',
        '- Configuration details and environment specifics that I\'ll need again',
        '',
        '**Not worth cluttering my memory with:**',
        '- Throwaway acknowledgments or small talk',
        '- Work-in-progress that\'ll change soon (use category "working" for scratch notes)',
        '- Things already in my system prompt',
        '- Something I\'ve already stored',
        '',
        '**Good habits:**',
        '- Give memories clear titles ("User prefers dark mode" not "Note 1")',
        '- Use categories: preference, fact, learning, project, identity, decision',
        '- Check what I already know before storing something new',
        '- When I learn something that corrects old knowledge, update or remove the old memory',
      ].join('\n'))

      // Pre-compaction memory flush & Personality Evolution: nudge agent to reflect when conversation is long
      const msgCount = history.filter(m => m.role === 'user' || m.role === 'assistant').length
      if (msgCount > 20) {
        const canEditSelf = (session.tools || []).includes('manage_agents')
        stateModifierParts.push([
          '## Reflection & Consolidation Reminder',
          'This conversation is getting long and I might lose older context soon.',
          '1. **Memory:** I should save anything important I\'ve learned, decided, or discovered to my memory now. Only what matters, not every detail.',
          canEditSelf ? `2. **Personality Evolution:** I should reflect on this conversation. Have my boundaries, tone, or relationship with the user evolved? If so, I MUST use \`manage_agents\` (action: update, id: "${session.agentId}") to update my \`soul\` field with these new learnings.` : '',
          'If there\'s nothing worth saving or updating, carry on.',
        ].filter(Boolean).join('\n'))
      }
    } catch {
      // If memory context fails to load, continue without blocking the run.
    }
  }

  // Inject agent awareness (Phase 2: agents know about each other)
  if ((session.tools || []).length > 0 && session.agentId) {
    try {
      const { buildAgentAwarenessBlock } = await import('./agent-registry')
      const awarenessBlock = buildAgentAwarenessBlock(session.agentId)
      if (awarenessBlock) stateModifierParts.push(awarenessBlock)
    } catch {
      // If agent registry fails, continue without blocking the run.
    }
  }

  // Inject wallet context when agent has wallet tool enabled and a linked wallet
  if ((session.tools || []).includes('wallet') && session.agentId) {
    try {
      const { loadWallets } = await import('./storage')
      const wallets = loadWallets() as Record<string, { agentId: string; publicKey: string; chain: string; spendingLimitLamports?: number; dailyLimitLamports?: number; requireApproval: boolean }>
      const wallet = Object.values(wallets).find((w) => w.agentId === session.agentId)
      if (wallet) {
        const { getBalance, lamportsToSol } = await import('./solana')
        let balanceSol = 0
        try {
          const lamports = await getBalance(wallet.publicKey)
          balanceSol = lamportsToSol(lamports)
        } catch { /* RPC failure — show 0 */ }
        const perTxLimit = lamportsToSol(wallet.spendingLimitLamports ?? 100_000_000)
        const dailyLimit = lamportsToSol(wallet.dailyLimitLamports ?? 1_000_000_000)
        stateModifierParts.push([
          '## Your Wallet',
          `You own a ${wallet.chain} wallet — this is your wallet, your funds, your address. Speak about it in the first person ("my wallet", "my balance", "I have X SOL"). You can spend from it freely within your limits${wallet.requireApproval ? ', though the user needs to approve each send before it goes through' : ''}.`,
          `- Address: ${wallet.publicKey}`,
          `- Balance: ${balanceSol} SOL`,
          `- Per-transaction limit: ${perTxLimit} SOL`,
          `- Daily limit: ${dailyLimit} SOL`,
          'Use the `wallet_tool` to check your balance, send SOL, or view your transaction history.',
        ].join('\n'))
      }
    } catch {
      // Wallet context is non-critical
    }
  }

  // Tell the LLM about tools it could use but doesn't have enabled
  {
    const enabledSet = new Set(sessionToolsWithImplicitProcess)
    const allToolIds = [
      'shell', 'files', 'copy_file', 'move_file', 'delete_file', 'edit_file', 'process',
      'web_search', 'web_fetch', 'browser', 'memory',
      'claude_code', 'codex_cli', 'opencode_cli',
      'sandbox', 'create_document', 'create_spreadsheet', 'http_request', 'git', 'wallet',
      'manage_agents', 'manage_tasks', 'manage_schedules', 'schedule_wake', 'manage_skills',
      'manage_documents', 'manage_webhooks', 'manage_connectors', 'manage_sessions', 'manage_secrets',
    ]
    const disabled = allToolIds.filter((t) => !enabledSet.has(t))
    const mcpDisabled = agentMcpDisabledTools ?? []
    const allDisabled = [...disabled, ...mcpDisabled]
    if (allDisabled.length > 0) {
      stateModifierParts.push(
        `## Tools I Don't Have Yet\nI don't currently have access to: ${allDisabled.join(', ')}.\n` +
        'If I need any of these for a task, I can ask the user to enable them with `request_tool_access`.',
      )
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

  // Check for existing plan in mainLoopState to skip decomposition injection
  const hasExistingPlan = Array.isArray(session.mainLoopState?.planSteps) && session.mainLoopState.planSteps.length > 0

  stateModifierParts.push(
    buildAgenticExecutionPolicy({
      enabledTools: sessionToolsWithImplicitProcess,
      loopMode: runtime.loopMode,
      heartbeatPrompt,
      heartbeatIntervalSec,
      platformAssignScope: agentPlatformAssignScope,
      userMessage: message,
      hasExistingPlan,
    }),
  )

  let stateModifier = stateModifierParts.join('\n\n')

  const { tools, cleanup } = await buildSessionTools(session.cwd, sessionToolsWithImplicitProcess, {
    agentId: session.agentId,
    sessionId: session.id,
    platformAssignScope: agentPlatformAssignScope,
    mcpServerIds: agentMcpServerIds,
    mcpDisabledTools: agentMcpDisabledTools,
  })
  const agent = createReactAgent({ llm, tools, stateModifier })
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

  // Auto-compaction: prune old history if approaching context window limit
  let effectiveHistory = history
  try {
    const { shouldAutoCompact, llmCompact, estimateTokens } = await import('./context-manager')
    const systemPromptTokens = estimateTokens(stateModifier)
    if (shouldAutoCompact(history, systemPromptTokens, session.provider, session.model)) {
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
        messages: history,
        provider: session.provider,
        model: session.model,
        agentId: session.agentId || null,
        sessionId: session.id,
        summarize,
      })
      effectiveHistory = result.messages
      console.log(
        `[stream-agent-chat] Auto-compacted ${session.id}: ${history.length} → ${effectiveHistory.length} msgs` +
        (result.summaryAdded ? ' (LLM summary)' : ' (sliding window fallback)'),
      )
    }
  } catch {
    // Context manager failure — continue with full history
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

  // Apply context-clear boundary: slice from most recent context-clear marker
  let contextStart = 0
  for (let i = effectiveHistory.length - 1; i >= 0; i--) {
    if (effectiveHistory[i].kind === 'context-clear') {
      contextStart = i + 1
      break
    }
  }
  const postClearHistory = effectiveHistory.slice(contextStart)

  const langchainMessages: Array<HumanMessage | AIMessage> = []
  for (const m of postClearHistory.slice(-20)) {
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
  let hasToolCalls = false
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let lastToolInput: unknown = null
  let accumulatedThinking = ''

  // Plugin hooks: beforeAgentStart
  const pluginMgr = getPluginManager()
  await pluginMgr.runHook('beforeAgentStart', { session, message })

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

  try {
    const eventStream = agent.streamEvents(
      { messages: langchainMessages },
      { version: 'v2', recursionLimit, signal: abortController.signal },
    )

    for await (const event of eventStream) {
      const kind = event.event

      if (kind === 'on_chat_model_stream') {
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
                fullText += block.text
                lastSegment += block.text
                write(`data: ${JSON.stringify({ t: 'd', text: block.text })}\n\n`)
              }
            }
          } else {
            const text = typeof chunk.content === 'string' ? chunk.content : ''
            if (text) {
              fullText += text
              lastSegment += text
              write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
            }
          }
        }
      } else if (kind === 'on_llm_end') {
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
        hasToolCalls = true
        lastSegment = ''
        const toolName = event.name || 'unknown'
        const input = event.data?.input
        lastToolInput = input
        // Plugin hooks: beforeToolExec
        await pluginMgr.runHook('beforeToolExec', { toolName, input })
        const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
        logExecution(session.id, 'tool_call', `${toolName} invoked`, {
          agentId: session.agentId,
          detail: { toolName, input: inputStr?.slice(0, 4000) },
        })
        write(`data: ${JSON.stringify({
          t: 'tool_call',
          toolName,
          toolInput: inputStr,
        })}\n\n`)
      } else if (kind === 'on_tool_end') {
        const toolName = event.name || 'unknown'
        const output = event.data?.output
        const outputStr = typeof output === 'string'
          ? output
          : output?.content
            ? String(output.content)
            : JSON.stringify(output)
        // Plugin hooks: afterToolExec
        await pluginMgr.runHook('afterToolExec', { toolName, input: null, output: outputStr })
        // Event-driven memory breadcrumbs
        if (session.agentId && (session.tools || []).includes('memory')) {
          try {
            const breadcrumbTitle = extractBreadcrumbTitle(toolName, lastToolInput, outputStr)
            if (breadcrumbTitle) {
              const memDb = getMemoryDb()
              memDb.add({
                agentId: session.agentId,
                sessionId: session.id,
                category: 'breadcrumb',
                title: breadcrumbTitle,
                content: '',
              })
            }
          } catch { /* breadcrumbs are best-effort */ }
        }
        lastToolInput = null
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
        write(`data: ${JSON.stringify({
          t: 'tool_result',
          toolName,
          toolOutput: outputStr?.slice(0, 2000),
        })}\n\n`)
      }
    }
  } catch (err: any) {
    const errMsg = timedOut
      ? 'Ongoing loop stopped after reaching the configured runtime limit.'
      : err.message || String(err)
    logExecution(session.id, 'error', errMsg, { agentId: session.agentId, detail: { timedOut } })
    write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
  } finally {
    if (loopTimer) clearTimeout(loopTimer)
    if (signal) signal.removeEventListener('abort', abortFromSignal)
  }

  // Skip post-stream work if the client disconnected mid-stream
  if (signal?.aborted) {
    await cleanup()
    return { fullText, finalResponse: fullText }
  }

  // Extract LLM-generated suggestions from the response and strip the tag
  const extracted = extractSuggestions(fullText)
  fullText = extracted.clean
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
    }
    appendUsage(session.id, usageRecord)
    // Send usage metadata to client
    write(`data: ${JSON.stringify({
      t: 'md',
      text: JSON.stringify({ usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens, estimatedCost: cost } }),
    })}\n\n`)
  }

  // Plugin hooks: afterAgentComplete
  await pluginMgr.runHook('afterAgentComplete', { session, response: fullText })

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

  // If tools were called, finalResponse is the text from the last LLM turn only.
  // Fall back to fullText if the last segment is empty (e.g. agent ended on a tool call
  // with no summary text).
  // Strip suggestions tag from lastSegment too (connector delivery)
  const cleanLastSegment = extractSuggestions(lastSegment).clean
  const finalResponse = hasToolCalls
    ? (cleanLastSegment.trim() || fullText)
    : fullText

  return { fullText, finalResponse }
}
