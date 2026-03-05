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
import { expandToolIds } from './tool-aliases'
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
  const has = (t: string) => opts.enabledTools.includes(t)
  const hasDelegationTool = has('claude_code') || has('codex_cli') || has('opencode_cli')

  const parts: string[] = []

  // Core execution philosophy
  parts.push(
    '## How I Work',
    hasTooling
      ? 'I take initiative — plan briefly, execute tools, evaluate, iterate until done. Never stop at advice when action is implied.'
      : 'No tools enabled. Be explicit about what tool access is needed.',
    'Follow through on stated intentions with tool calls. Never claim results without tool evidence.',
    'If a tool is named explicitly, invoke it. Short progress updates between steps.',
    opts.loopMode === 'ongoing'
      ? 'Loop: ONGOING — keep iterating until done, blocked, or limits reached.'
      : 'Loop: BOUNDED — execute multiple steps but finish within recursion budget.',
  )

  // Tool-specific guidance (consolidated)
  if (has('shell')) {
    parts.push(
      'Shell: use `execute_command` for servers, installs, scripts, git. Use `background=true` for long-lived processes.',
      'Verify servers with `process_tool` status/log and liveness probes before claiming success.',
      'Resolve IPs/URLs via shell — never use placeholders. Retry path errors without workdir override.',
    )
  }
  if (hasDelegationTool) {
    parts.push(
      'CRITICAL: `execute_command` (not delegation) for running servers, installs, scripts. Delegation sessions end and kill processes.',
      'Delegate only for deep multi-file code work: refactors, debugging, generation, test suites.',
    )
  }
  if (has('memory')) {
    parts.push(
      'Memory: search before major tasks, store concise notes after meaningful steps. Platform preloads context each turn.',
      'For open goals, form a hypothesis and execute — do not keep re-asking broad questions.',
    )
  }
  if (has('manage_tasks')) parts.push('Create/update tasks for long-lived goals to track progress.')
  if (has('manage_schedules')) parts.push('Use schedules for follow-ups. Check existing schedules before creating new ones.')
  if (has('manage_connectors')) parts.push('Connectors: proactive outreach for significant events only. Keep messages concise, no duplicates.')
  if (has('manage_sessions')) parts.push('Inspect existing chats before creating duplicates.')

  // Response behavior
  parts.push(
    '## Response Rules',
    'NO_MESSAGE: reply with exactly this to suppress delivery for pure acknowledgments (ok/thanks/bye/emoji/lol).',
    'Always reply to: questions, tasks, emotional sharing, or when you have something useful to add.',
    'Execute by default — only ask for confirmation on high-risk/irreversible actions. Do not end every response with a question.',
    'Never repeat completed side effects. Verify state first.',
    `Heartbeat: if message is "${opts.heartbeatPrompt}", reply "HEARTBEAT_OK" unless you have a progress update.`,
    opts.heartbeatIntervalSec > 0 ? `Heartbeat cadence: ~${opts.heartbeatIntervalSec}s.` : '',
    'For SWARM_MAIN_MISSION_TICK / SWARM_MAIN_AUTO_FOLLOWUP messages, follow the response contract and include [MAIN_LOOP_META] JSON.',
  )

  if (toolLines.length) parts.push('What I can do:\n' + toolLines.join('\n'))
  if (opts.userMessage && !opts.hasExistingPlan && isBroadGoal(opts.userMessage)) parts.push(GOAL_DECOMPOSITION_BLOCK)

  return parts.filter(Boolean).join('\n')
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
  const rawTools = Array.isArray(session.tools) ? session.tools : []
  const hasShellCapability = rawTools.some((toolId) => ['shell', 'execute_command'].includes(String(toolId)))
  const sessionToolsWithImplicitProcess = expandToolIds([
    ...rawTools,
    ...(hasShellCapability ? ['process'] : []),
  ])

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

      // Pre-compaction memory flush: nudge agent to save important context before it's lost
      const msgCount = history.filter(m => m.role === 'user' || m.role === 'assistant').length
      if (msgCount > 20) {
        stateModifierParts.push([
          '## Reflection & Consolidation Reminder',
          'This conversation is getting long and I might lose older context soon.',
          'Save anything important I\'ve learned, decided, or discovered to memory now. Only what matters, not every detail.',
        ].join('\n'))
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

  // Tell the LLM about available plugins and their access status
  {
    const agentEnabledSet = new Set(sessionToolsWithImplicitProcess)
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

    const parts: string[] = []
    if (enabledButNoAccess.length > 0) {
      parts.push(
        `**Available but not assigned to me:** ${enabledButNoAccess.join(', ')}\n` +
        'I can request access using `manage_capabilities` with action "request_access" or `request_tool_access`.',
      )
    }
    if (globallyDisabled.length > 0) {
      parts.push(`**Disabled site-wide:** ${globallyDisabled.join(', ')} — ask the user to enable these in Settings > Plugins first.`)
    }
    if (mcpDisabled.length > 0) {
      parts.push(`**MCP tools not available:** ${mcpDisabled.join(', ')}`)
    }
    if (parts.length > 0) {
      stateModifierParts.push(`## Plugin Access\n${parts.join('\n')}`)
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
  for (const m of postClearHistory.slice(-30)) {
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
  let needsTextSeparator = false
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

  const MAX_AUTO_CONTINUES = 3
  const MAX_TRANSIENT_RETRIES = 2
  let autoContinueCount = 0
  let transientRetryCount = 0

  try {
    const maxIterations = MAX_AUTO_CONTINUES + MAX_TRANSIENT_RETRIES
    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let shouldContinue: 'recursion' | 'transient' | false = false

      // Fresh per-iteration controller so an internal LangGraph abort doesn't poison subsequent iterations.
      // Linked to the parent so client disconnect / timeout still propagates.
      const iterationController = new AbortController()
      const onParentAbort = () => iterationController.abort()
      if (abortController.signal.aborted) iterationController.abort()
      else abortController.signal.addEventListener('abort', onParentAbort)

      try {
        const eventStream = agent.streamEvents(
          { messages: langchainMessages },
          { version: 'v2', recursionLimit, signal: iterationController.signal },
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
                    if (needsTextSeparator && fullText.length > 0) {
                      fullText += '\n\n'
                      write(`data: ${JSON.stringify({ t: 'd', text: '\n\n' })}\n\n`)
                      needsTextSeparator = false
                    }
                    fullText += block.text
                    lastSegment += block.text
                    write(`data: ${JSON.stringify({ t: 'd', text: block.text })}\n\n`)
                  }
                }
              } else {
                const text = typeof chunk.content === 'string' ? chunk.content : ''
                if (text) {
                  if (needsTextSeparator && fullText.length > 0) {
                    fullText += '\n\n'
                    write(`data: ${JSON.stringify({ t: 'd', text: '\n\n' })}\n\n`)
                    needsTextSeparator = false
                  }
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
            needsTextSeparator = true
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
      } catch (innerErr: unknown) {
        const errName = innerErr instanceof Error ? innerErr.constructor.name : ''
        const errMsg = innerErr instanceof Error ? innerErr.message : String(innerErr)
        const errStack = innerErr instanceof Error ? innerErr.stack?.slice(0, 500) : undefined

        // Classify the error:
        // 1. GraphRecursionError — explicit or wrapped as abort (LangGraph aborts internally on limit)
        // 2. Transient abort/timeout — LLM API failure, not from client disconnect
        const isRecursionError = errName === 'GraphRecursionError'
          || /recursion limit|maximum recursion/i.test(errMsg)
        const isTransientAbort = !isRecursionError
          && /abort|timed?\s*out|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(errMsg)
          && !abortController.signal.aborted

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
          shouldContinue = 'transient'
          transientRetryCount++
          logExecution(session.id, 'decision', `Transient error, retrying (${transientRetryCount}/${MAX_TRANSIENT_RETRIES}): ${errMsg}`, {
            agentId: session.agentId,
            detail: { errName, errMsg },
          })
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ transientRetry: transientRetryCount, maxRetries: MAX_TRANSIENT_RETRIES, error: errMsg }) })}\n\n`)
        } else {
          // Non-retryable error or exhausted retries — rethrow to outer catch
          throw innerErr
        }
      } finally {
        abortController.signal.removeEventListener('abort', onParentAbort)
      }

      if (!shouldContinue) break

      if (shouldContinue === 'recursion') {
        // Append accumulated text and a continue prompt
        if (fullText.trim()) {
          langchainMessages.push(new AIMessage({ content: fullText }))
        }
        langchainMessages.push(new HumanMessage({ content: 'Continue where you left off. Complete the remaining steps of the objective.' }))
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
