import fs from 'fs'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { buildSessionTools } from './session-tools'
import { buildChatModel } from './build-llm'
import { loadSettings, loadAgents, loadSkills, appendUsage } from './storage'
import { estimateCost, buildPluginDefinitionCosts } from './cost'
import { getPluginManager } from './plugins'
import { loadRuntimeSettings, getAgentLoopRecursionLimit } from './runtime-settings'

import { logExecution } from './execution-log'
import { buildCurrentDateTimePromptContext } from './prompt-runtime-context'
import { expandPluginIds } from './tool-aliases'
import type { Session, Message, UsageRecord, PluginInvocationRecord } from '@/types'
import { extractSuggestions } from './suggestions'

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
  enabledPlugins: string[]
  loopMode: 'bounded' | 'ongoing'
  heartbeatPrompt: string
  heartbeatIntervalSec: number
  platformAssignScope?: 'self' | 'all'
  userMessage?: string
  hasExistingPlan?: boolean
}) {
  const hasTooling = opts.enabledPlugins.length > 0
  const pluginLines = buildPluginCapabilityLines(opts.enabledPlugins, { platformAssignScope: opts.platformAssignScope })

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

  // Plugin-specific operating guidance (collected dynamically from plugins)
  const guidanceLines = getPluginManager().collectOperatingGuidance(opts.enabledPlugins)
  if (guidanceLines.length) parts.push(...guidanceLines)

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

  if (pluginLines.length) parts.push('What I can do:\n' + pluginLines.join('\n'))
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

  // Inject agent awareness (Phase 2: agents know about each other)
  if ((session.plugins || []).length > 0 && session.agentId) {
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
      enabledPlugins: sessionPlugins,
      loopMode: runtime.loopMode,
      heartbeatPrompt,
      heartbeatIntervalSec,
      platformAssignScope: agentPlatformAssignScope,
      userMessage: message,
      hasExistingPlan,
    }),
  )

  let stateModifier = stateModifierParts.join('\n\n')

  const { tools, cleanup, toolToPluginMap } = await buildSessionTools(session.cwd, sessionPlugins, {
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
  let hasToolCalls = false
  let needsTextSeparator = false
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let lastToolInput: unknown = null
  let accumulatedThinking = ''
  const pluginInvocations: PluginInvocationRecord[] = []
  let currentToolInputTokens = 0

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
            // Estimate input tokens for plugin invocation tracking
            const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
            currentToolInputTokens = Math.ceil((inputStr?.length || 0) / 4)
            // Plugin hooks: beforeToolExec
            await pluginMgr.runHook('beforeToolExec', { toolName, input })
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
            await pluginMgr.runHook('afterToolExec', { session, toolName, input: lastToolInput as Record<string, unknown> | null, output: outputStr })
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
            // Track plugin invocation token estimates
            const pluginId = toolToPluginMap[toolName] || '_unknown'
            pluginInvocations.push({
              pluginId,
              toolName,
              inputTokens: currentToolInputTokens,
              outputTokens: Math.ceil((outputStr?.length || 0) / 4),
            })
            currentToolInputTokens = 0

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
