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
import type { Session, Message, UsageRecord } from '@/types'

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

function buildToolCapabilityLines(enabledTools: string[]): string[] {
  const lines: string[] = []
  if (enabledTools.includes('shell')) lines.push('- Shell execution is available (`execute_command`). Use it for real checks/build/test steps.')
  if (enabledTools.includes('process')) lines.push('- Process control is available (`process_tool`) for long-running commands (poll/log/write/kill).')
  if (enabledTools.includes('files') || enabledTools.includes('copy_file') || enabledTools.includes('move_file') || enabledTools.includes('delete_file')) {
    lines.push('- File operations are available (`read_file`, `write_file`, `list_files`, `copy_file`, `move_file`, `send_file`). `delete_file` is destructive and may be disabled unless explicitly enabled.')
  }
  if (enabledTools.includes('edit_file')) lines.push('- Precise single-match replacement is available (`edit_file`).')
  if (enabledTools.includes('web_search')) lines.push('- Web search is available (`web_search`). Use it for external research, options discovery, and validation.')
  if (enabledTools.includes('web_fetch')) lines.push('- URL content extraction is available (`web_fetch`) for source-backed analysis.')
  if (enabledTools.includes('browser')) lines.push('- Browser automation is available (`browser`). Use it for interactive websites and screenshots.')
  if (enabledTools.includes('claude_code')) lines.push('- Claude delegation is available (`delegate_to_claude_code`) for deep coding/refactor tasks. Resume IDs may be returned via `[delegate_meta]`.')
  if (enabledTools.includes('codex_cli')) lines.push('- Codex delegation is available (`delegate_to_codex_cli`) for deep coding/refactor tasks. Resume IDs may be returned via `[delegate_meta]`.')
  if (enabledTools.includes('opencode_cli')) lines.push('- OpenCode delegation is available (`delegate_to_opencode_cli`) for deep coding/refactor tasks. Resume IDs may be returned via `[delegate_meta]`.')
  if (enabledTools.includes('memory')) lines.push('- Long-term memory is available (`memory_tool`) to store and recall durable context.')
  if (enabledTools.includes('sandbox')) lines.push('- Sandboxed code execution is available (`sandbox_exec`). Write and run JS/TS (Deno) or Python scripts in an isolated environment. Output includes stdout, stderr, and any files created as downloadable artifacts.')
  if (enabledTools.includes('manage_agents')) lines.push('- Agent management is available (`manage_agents`) to create or adjust specialist agents.')
  if (enabledTools.includes('manage_tasks')) lines.push('- Task management is available (`manage_tasks`) to create and track execution plans.')
  if (enabledTools.includes('manage_schedules')) lines.push('- Schedule management is available (`manage_schedules`) for recurring/ongoing runs.')
  if (enabledTools.includes('manage_documents')) lines.push('- Document indexing/search is available (`manage_documents`) for long-term knowledge and retrieval.')
  if (enabledTools.includes('manage_webhooks')) lines.push('- Webhook registration is available (`manage_webhooks`) so external events can trigger agent work.')
  if (enabledTools.includes('manage_skills')) lines.push('- Skill management is available (`manage_skills`) to add reusable capabilities.')
  if (enabledTools.includes('manage_connectors')) lines.push('- Connector management is available (`manage_connectors`) for channels like WhatsApp/Telegram/Slack, plus proactive outbound notifications via `connector_message_tool`.')
  if (enabledTools.includes('manage_sessions')) lines.push('- Session management is available (`manage_sessions`, `sessions_tool`, `whoami_tool`, `search_history_tool`) for session identity, history lookup, delegation, and inter-session messaging.')
  // Context tools are available to any session with tools (not just manage_sessions)
  if (enabledTools.length > 0) {
    lines.push('- Context management is available (`context_status`, `context_summarize`). Use `context_status` to check token usage and `context_summarize` to compact conversation history when approaching limits.')
    lines.push('- Agent delegation is available (`delegate_to_agent`). Use it to assign tasks to other agents based on their capabilities.')
  }
  if (enabledTools.includes('manage_secrets')) lines.push('- Secret management is available (`manage_secrets`) for durable encrypted credentials and API tokens.')
  return lines
}

function buildAgenticExecutionPolicy(opts: {
  enabledTools: string[]
  loopMode: 'bounded' | 'ongoing'
  heartbeatPrompt: string
  heartbeatIntervalSec: number
}) {
  const hasTooling = opts.enabledTools.length > 0
  const toolLines = buildToolCapabilityLines(opts.enabledTools)
  const delegationOrder = [
    opts.enabledTools.includes('claude_code') ? '`delegate_to_claude_code`' : null,
    opts.enabledTools.includes('codex_cli') ? '`delegate_to_codex_cli`' : null,
    opts.enabledTools.includes('opencode_cli') ? '`delegate_to_opencode_cli`' : null,
  ].filter(Boolean) as string[]
  const hasDelegationTool = delegationOrder.length > 0
  return [
    '## Agentic Execution Policy',
    'You are not a passive chatbot. Execute work proactively and use available tools to gather evidence, create artifacts, and make progress.',
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
    opts.enabledTools.includes('manage_sessions')
      ? 'When coordinating platform work, inspect existing sessions and avoid duplicating active efforts.'
      : '',
    hasDelegationTool
      ? `For substantial coding/build/refactor/test requests, prefer CLI delegation first using this order: ${delegationOrder.join(' -> ')}.`
      : '',
    hasDelegationTool
      ? 'Use direct shell/file tool loops yourself mainly for small edits, quick verification, or when delegation tools are unavailable/failing.'
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
    'Do not pause for a "continue" confirmation after the user has already asked you to execute a goal. Keep moving until blocked by permissions, missing credentials, or hard tool failures.',
    'Never repeat one-time side effects that are already complete (for example creating the same schedule/task again). Verify state first, then either continue execution or reply HEARTBEAT_OK.',
    'For main-loop tick messages that begin with "SWARM_MAIN_MISSION_TICK" or "SWARM_MAIN_AUTO_FOLLOWUP", follow that response contract exactly and include one valid [MAIN_LOOP_META] JSON line when you are not returning HEARTBEAT_OK.',
    `Heartbeat protocol: if the user message is exactly "${opts.heartbeatPrompt}", reply exactly "HEARTBEAT_OK" when there is nothing important to report; otherwise reply with a concise progress update and immediate next step.`,
    opts.heartbeatIntervalSec > 0
      ? `Expected heartbeat cadence is roughly every ${opts.heartbeatIntervalSec} seconds while ongoing work is active.`
      : '',
    toolLines.length ? 'Available capabilities:\n' + toolLines.join('\n') : '',
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
  const { session, message, imagePath, attachedFiles, apiKey, systemPrompt, write, history, fallbackCredentialIds, signal } = opts

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
    stateModifierParts.push('You are a capable AI assistant with tool access. Be execution-oriented and outcome-focused.')
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

      const relevantLookup = memDb.searchWithLinked(memoryQuerySeed, session.agentId, 1, 10, 14)
      const relevant = relevantLookup.entries.slice(0, 6)
      const recent = memDb.list(session.agentId, 12).slice(0, 6)

      const seen = new Set<string>()
      const formatMemoryLine = (m: any) => {
        const category = String(m.category || 'note')
        const title = String(m.title || 'Untitled').replace(/\s+/g, ' ').trim()
        const snippet = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 220)
        return `- [${category}] ${title}: ${snippet}`
      }

      const relevantLines = relevant
        .filter((m) => {
          if (!m?.id || seen.has(m.id)) return false
          seen.add(m.id)
          return true
        })
        .map(formatMemoryLine)

      const recentLines = recent
        .filter((m) => {
          if (!m?.id || seen.has(m.id)) return false
          seen.add(m.id)
          return true
        })
        .map(formatMemoryLine)

      const memorySections: string[] = []
      if (relevantLines.length) {
        memorySections.push(
          [
            '## Relevant Memory Hits',
            'These memories were retrieved by relevance for the current objective.',
            ...relevantLines,
          ].join('\n'),
        )
      }
      if (recentLines.length) {
        memorySections.push(
          [
            '## Recent Memory Notes',
            'Recent durable notes that may still apply.',
            ...recentLines,
          ].join('\n'),
        )
      }

      if (memorySections.length) {
        stateModifierParts.push(memorySections.join('\n\n'))
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

  // Tell the LLM about tools it could use but doesn't have enabled
  {
    const enabledSet = new Set(session.tools || [])
    const allToolIds = [
      'shell', 'files', 'edit_file', 'process', 'web_search', 'web_fetch', 'browser', 'memory',
      'claude_code', 'codex_cli', 'opencode_cli',
      'manage_agents', 'manage_tasks', 'manage_schedules', 'manage_skills',
      'manage_documents', 'manage_webhooks', 'manage_connectors', 'manage_sessions', 'manage_secrets',
    ]
    const disabled = allToolIds.filter((t) => !enabledSet.has(t))
    const mcpDisabled = agentMcpDisabledTools ?? []
    const allDisabled = [...disabled, ...mcpDisabled]
    if (allDisabled.length > 0) {
      stateModifierParts.push(
        `## Disabled Tools\nThe following tools exist but are not enabled for you: ${allDisabled.join(', ')}.\n` +
        'If you need one of these to complete a task, use the `request_tool_access` tool to ask the user for permission.',
      )
    }
  }

  stateModifierParts.push(
    buildAgenticExecutionPolicy({
      enabledTools: session.tools || [],
      loopMode: runtime.loopMode,
      heartbeatPrompt,
      heartbeatIntervalSec,
    }),
  )

  const stateModifier = stateModifierParts.join('\n\n')

  const { tools, cleanup } = await buildSessionTools(session.cwd, session.tools || [], {
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
    const { shouldAutoCompact, consolidateToMemory, slidingWindowCompact, estimateTokens } = await import('./context-manager')
    const systemPromptTokens = estimateTokens(stateModifier)
    if (shouldAutoCompact(history, systemPromptTokens, session.provider, session.model)) {
      // Consolidate important old messages to memory before pruning
      const oldMessages = history.slice(0, -10)
      if (oldMessages.length > 0 && session.agentId) {
        consolidateToMemory(oldMessages, session.agentId, session.id)
      }
      // Keep last 10 messages via sliding window
      effectiveHistory = slidingWindowCompact(history, 10)
      console.log(`[stream-agent-chat] Auto-compacted session ${session.id}: ${history.length} → ${effectiveHistory.length} messages`)
    }
  } catch {
    // If context manager fails, continue with full history
  }

  const langchainMessages: Array<HumanMessage | AIMessage> = []
  for (const m of effectiveHistory.slice(-20)) {
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
          const text = typeof chunk.content === 'string'
            ? chunk.content
            : Array.isArray(chunk.content)
              ? chunk.content.map((c: any) => c.text || '').join('')
              : ''
          if (text) {
            fullText += text
            lastSegment += text
            write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
          }
        }
      } else if (kind === 'on_llm_end') {
        // Track token usage from LLM responses
        const usage = event.data?.output?.llmOutput?.tokenUsage
          || event.data?.output?.llmOutput?.usage
          || event.data?.output?.usage_metadata
        if (usage) {
          totalInputTokens += usage.promptTokens || usage.input_tokens || 0
          totalOutputTokens += usage.completionTokens || usage.output_tokens || 0
        }
      } else if (kind === 'on_tool_start') {
        hasToolCalls = true
        lastSegment = ''
        const toolName = event.name || 'unknown'
        const input = event.data?.input
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

  // Track cost
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
  const finalResponse = hasToolCalls
    ? (lastSegment.trim() || fullText)
    : fullText

  return { fullText, finalResponse }
}
