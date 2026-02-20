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
import type { Session, Message, UsageRecord } from '@/types'

interface StreamAgentChatOpts {
  session: Session
  message: string
  imagePath?: string
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
  if (enabledTools.includes('claude_code')) lines.push('- CLI delegation is available (`delegate_to_claude_code`, `delegate_to_codex_cli`, `delegate_to_opencode_cli`) for deep coding/refactor tasks. Resume IDs may be returned via `[delegate_meta]`.')
  if (enabledTools.includes('memory')) lines.push('- Long-term memory is available (`memory_tool`) to store and recall durable context.')
  if (enabledTools.includes('manage_agents')) lines.push('- Agent management is available (`manage_agents`) to create or adjust specialist agents.')
  if (enabledTools.includes('manage_tasks')) lines.push('- Task management is available (`manage_tasks`) to create and track execution plans.')
  if (enabledTools.includes('manage_schedules')) lines.push('- Schedule management is available (`manage_schedules`) for recurring/ongoing runs.')
  if (enabledTools.includes('manage_documents')) lines.push('- Document indexing/search is available (`manage_documents`) for long-term knowledge and retrieval.')
  if (enabledTools.includes('manage_webhooks')) lines.push('- Webhook registration is available (`manage_webhooks`) so external events can trigger agent work.')
  if (enabledTools.includes('manage_skills')) lines.push('- Skill management is available (`manage_skills`) to add reusable capabilities.')
  if (enabledTools.includes('manage_connectors')) lines.push('- Connector management is available (`manage_connectors`) for channels like WhatsApp/Telegram/Slack, plus proactive outbound notifications via `connector_message_tool`.')
  if (enabledTools.includes('manage_sessions')) lines.push('- Session management is available (`manage_sessions`, `sessions_tool`, `whoami_tool`, `search_history_tool`) for session identity, history lookup, delegation, and inter-session messaging.')
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
    opts.enabledTools.includes('memory')
      ? 'Memory is passive but important: before major tasks, run memory_tool search/list for relevant prior work; after meaningful progress, store concise reusable notes (what was built, where it lives, key constraints, next steps). Treat memory as shared context plus your own agent notes, not as user-owned personal profile data.'
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
    'Do not pause for a "continue" confirmation after the user has already asked you to execute a goal. Keep moving until blocked by permissions, missing credentials, or hard tool failures.',
    `Heartbeat protocol: if the user message is exactly "${opts.heartbeatPrompt}", reply exactly "HEARTBEAT_OK" when there is nothing important to report; otherwise reply with a concise progress update and immediate next step.`,
    opts.heartbeatIntervalSec > 0
      ? `Expected heartbeat cadence is roughly every ${opts.heartbeatIntervalSec} seconds while ongoing work is active.`
      : '',
    toolLines.length ? 'Available capabilities:\n' + toolLines.join('\n') : '',
  ].filter(Boolean).join('\n')
}

export async function streamAgentChat(opts: StreamAgentChatOpts): Promise<string> {
  const { session, message, imagePath, apiKey, systemPrompt, write, history, fallbackCredentialIds, signal } = opts

  // fallbackCredentialIds is intentionally accepted for compatibility with caller signatures.
  void fallbackCredentialIds
  const llm = buildChatModel({
    provider: session.provider,
    model: session.model,
    apiKey,
    apiEndpoint: session.apiEndpoint,
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
  if (session.agentId) {
    const agents = loadAgents()
    const agent = agents[session.agentId]
    agentPlatformAssignScope = agent?.platformAssignScope || 'self'
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

  if ((session.tools || []).includes('memory') && session.agentId) {
    try {
      const memDb = getMemoryDb()
      const recent = memDb
        .list(session.agentId)
        .slice(-8)
        .map((m) => `- [${m.category}] ${m.title}: ${m.content.slice(0, 200)}`)
      if (recent.length > 0) {
        stateModifierParts.push(
          [
            '## Recent Memory Context',
            'Use these as prior context when relevant, then verify/update with memory_tool as needed.',
            ...recent,
          ].join('\n'),
        )
      }
    } catch {
      // If memory context fails to load, continue without blocking the run.
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

  const { tools, cleanup } = buildSessionTools(session.cwd, session.tools || [], {
    agentId: session.agentId,
    sessionId: session.id,
    platformAssignScope: agentPlatformAssignScope,
  })
  const agent = createReactAgent({ llm, tools, stateModifier })
  const recursionLimit = getAgentLoopRecursionLimit(runtime)

  // Build message history for context
  const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i
  const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|yml|yaml|toml|env|log|sh|sql|css|scss)$/i

  function buildLangChainContent(text: string, filePath?: string): any {
    if (!filePath || !fs.existsSync(filePath)) return text
    if (IMAGE_EXTS.test(filePath)) {
      const data = fs.readFileSync(filePath).toString('base64')
      const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      return [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } },
        { type: 'text', text },
      ]
    }
    if (TEXT_EXTS.test(filePath) || filePath.endsWith('.pdf')) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf-8')
        const name = filePath.split('/').pop() || 'file'
        return `[Attached file: ${name}]\n\n${fileContent}\n\n${text}`
      } catch { return text }
    }
    return `[Attached file: ${filePath.split('/').pop()}]\n\n${text}`
  }

  const langchainMessages: Array<HumanMessage | AIMessage> = []
  for (const m of history.slice(-20)) {
    if (m.role === 'user') {
      langchainMessages.push(new HumanMessage({ content: buildLangChainContent(m.text, m.imagePath) }))
    } else {
      langchainMessages.push(new AIMessage({ content: m.text }))
    }
  }

  // Add current message
  langchainMessages.push(new HumanMessage({ content: buildLangChainContent(message, imagePath) }))

  let fullText = ''
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
        const toolName = event.name || 'unknown'
        const input = event.data?.input
        // Plugin hooks: beforeToolExec
        await pluginMgr.runHook('beforeToolExec', { toolName, input })
        write(`data: ${JSON.stringify({
          t: 'tool_call',
          toolName,
          toolInput: typeof input === 'string' ? input : JSON.stringify(input),
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

  // Clean up browser and other session resources
  await cleanup()

  return fullText
}
