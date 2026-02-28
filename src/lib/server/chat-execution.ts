import fs from 'fs'
import {
  loadSessions,
  saveSessions,
  loadCredentials,
  decryptKey,
  getSessionMessages,
  loadAgents,
  loadSkills,
  loadSettings,
  loadUsage,
  active,
} from './storage'
import { getProvider } from '@/lib/providers'
import { log } from './logger'
import { logExecution } from './execution-log'
import { streamAgentChat } from './stream-agent-chat'
import { buildSessionTools } from './session-tools'
import { stripMainLoopMetaForPersistence } from './main-agent-loop'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { getMemoryDb } from './memory-db'
import { routeTaskIntent } from './capability-router'
import { resolveConcreteToolPolicyBlock, resolveSessionToolPolicy } from './tool-capability-policy'
import type { MessageToolEvent, SSEEvent } from '@/types'
import { markProviderFailure, markProviderSuccess, rankDelegatesByHealth } from './provider-health'

const CLI_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli'])
type DelegateTool = 'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli'

interface SessionWithTools {
  tools?: string[] | null
}

interface SessionWithCredentials {
  credentialId?: string | null
}

interface ProviderApiKeyConfig {
  requiresApiKey?: boolean
  optionalApiKey?: boolean
}

export interface ExecuteChatTurnInput {
  sessionId: string
  message: string
  imagePath?: string
  imageUrl?: string
  internal?: boolean
  source?: string
  runId?: string
  signal?: AbortSignal
  onEvent?: (event: SSEEvent) => void
  modelOverride?: string
  heartbeatConfig?: { ackMaxChars: number; showOk: boolean; showAlerts: boolean; target: string | null }
}

export interface ExecuteChatTurnResult {
  runId?: string
  sessionId: string
  text: string
  persisted: boolean
  toolEvents: MessageToolEvent[]
  error?: string
}

function extractEventJson(line: string): SSEEvent | null {
  if (!line.startsWith('data: ')) return null
  try {
    return JSON.parse(line.slice(6).trim()) as SSEEvent
  } catch {
    return null
  }
}

function collectToolEvent(ev: SSEEvent, bag: MessageToolEvent[]) {
  if (ev.t === 'tool_call') {
    bag.push({
      name: ev.toolName || 'unknown',
      input: ev.toolInput || '',
    })
    return
  }
  if (ev.t === 'tool_result') {
    const idx = bag.findLastIndex((e) => e.name === (ev.toolName || 'unknown') && !e.output)
    if (idx === -1) return
    const output = ev.toolOutput || ''
    const isError = /^(Error:|error:)/i.test(output.trim())
      || output.includes('ECONNREFUSED')
      || output.includes('ETIMEDOUT')
      || output.includes('Error:')
    bag[idx] = {
      ...bag[idx],
      output,
      error: isError || undefined,
    }
  }
}

function requestedToolNamesFromMessage(message: string): string[] {
  const lower = message.toLowerCase()
  const candidates = [
    'delegate_to_claude_code',
    'delegate_to_codex_cli',
    'delegate_to_opencode_cli',
    'connector_message_tool',
    'sessions_tool',
    'whoami_tool',
    'search_history_tool',
    'manage_agents',
    'manage_tasks',
    'manage_schedules',
    'manage_documents',
    'manage_webhooks',
    'manage_skills',
    'manage_connectors',
    'manage_sessions',
    'manage_secrets',
    'memory_tool',
    'browser',
    'web_search',
    'web_fetch',
    'execute_command',
    'read_file',
    'write_file',
    'list_files',
    'copy_file',
    'move_file',
    'delete_file',
    'edit_file',
    'send_file',
    'process_tool',
  ]
  return candidates.filter((name) => lower.includes(name.toLowerCase()))
}

function parseKeyValueArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const regex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s,]+)/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1]
    const value = match[3] ?? match[4] ?? match[2] ?? ''
    out[key] = value.replace(/^['"]|['"]$/g, '').trim()
  }
  return out
}

function extractConnectorMessageArgs(message: string): {
  action: 'list_running' | 'list_targets' | 'send'
  platform?: string
  connectorId?: string
  to?: string
  message?: string
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
} | null {
  if (!message.toLowerCase().includes('connector_message_tool')) return null
  const parsed = parseKeyValueArgs(message)

  let payload = parsed.message
  if (!payload) {
    const quoted = message.match(/message\s*=\s*("(.*?)"|'(.*?)')/i)
    if (quoted) payload = (quoted[2] || quoted[3] || '').trim()
  }
  if (!payload) {
    const raw = message.match(/message\s*=\s*([^\n]+)/i)
    if (raw?.[1]) {
      payload = raw[1]
        .replace(/\b(Return|Output|Then|Respond)\b[\s\S]*$/i, '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
    }
  }

  const actionRaw = (parsed.action || 'send').toLowerCase()
  const action = actionRaw === 'list_running' || actionRaw === 'list_targets' || actionRaw === 'send'
    ? actionRaw
    : 'send'
  const args: {
    action: 'list_running' | 'list_targets' | 'send'
    platform?: string
    connectorId?: string
    to?: string
    message?: string
    imageUrl?: string
    fileUrl?: string
    mediaPath?: string
    mimeType?: string
    fileName?: string
    caption?: string
  } = { action }
  const quoted = (key: string): string | undefined => {
    const m = message.match(new RegExp(`${key}\\s*=\\s*(\"([^\"]*)\"|'([^']*)')`, 'i'))
    return (m?.[2] || m?.[3] || '').trim() || undefined
  }
  if (parsed.platform) args.platform = parsed.platform
  if (parsed.connectorId) args.connectorId = parsed.connectorId
  if (parsed.to) args.to = parsed.to
  if (payload) args.message = payload
  args.imageUrl = parsed.imageUrl || quoted('imageUrl')
  args.fileUrl = parsed.fileUrl || quoted('fileUrl')
  args.mediaPath = parsed.mediaPath || quoted('mediaPath')
  args.mimeType = parsed.mimeType || quoted('mimeType')
  args.fileName = parsed.fileName || quoted('fileName')
  args.caption = parsed.caption || quoted('caption')
  return args
}

function extractDelegationTask(message: string, toolName: string): string | null {
  if (!message.toLowerCase().includes(toolName.toLowerCase())) return null
  const patterns = [
    /task\s+exactly\s*:\s*"([^"]+)"/i,
    /task\s+exactly\s*:\s*'([^']+)'/i,
    /task\s+exactly\s*:\s*([^\n]+?)(?:\.\s|$)/i,
    /task\s*:\s*"([^"]+)"/i,
    /task\s*:\s*'([^']+)'/i,
    /task\s*:\s*([^\n]+?)(?:\.\s|$)/i,
  ]
  for (const re of patterns) {
    const m = message.match(re)
    const task = (m?.[1] || '').trim()
    if (task) return task
  }
  return null
}

function hasToolEnabled(session: SessionWithTools, toolName: string): boolean {
  return Array.isArray(session?.tools) && session.tools.includes(toolName)
}

function enabledDelegationTools(session: SessionWithTools): DelegateTool[] {
  const tools: DelegateTool[] = []
  if (hasToolEnabled(session, 'claude_code')) tools.push('delegate_to_claude_code')
  if (hasToolEnabled(session, 'codex_cli')) tools.push('delegate_to_codex_cli')
  if (hasToolEnabled(session, 'opencode_cli')) tools.push('delegate_to_opencode_cli')
  return tools
}

function parseUsdLimit(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.max(0.01, Math.min(1_000_000, parsed))
}

function getTodaySpendUsd(): number {
  const usage = loadUsage()
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const minTs = dayStart.getTime()
  let total = 0
  for (const records of Object.values(usage)) {
    for (const record of records || []) {
      const ts = typeof (record as any)?.timestamp === 'number' ? (record as any).timestamp : 0
      if (ts < minTs) continue
      const cost = typeof (record as any)?.estimatedCost === 'number' ? (record as any).estimatedCost : 0
      if (Number.isFinite(cost) && cost > 0) total += cost
    }
  }
  return total
}

function findFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')]+/i)
  return m?.[0] || null
}

function syncSessionFromAgent(sessionId: string): void {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session?.agentId) return
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent) return

  let changed = false
  if (agent.provider && agent.provider !== session.provider) { session.provider = agent.provider; changed = true }
  if (agent.model !== undefined && agent.model !== session.model) { session.model = agent.model; changed = true }
  if (agent.credentialId !== undefined && agent.credentialId !== session.credentialId) { session.credentialId = agent.credentialId ?? null; changed = true }
  if (agent.apiEndpoint !== undefined) {
    const normalized = normalizeProviderEndpoint(agent.provider, agent.apiEndpoint ?? null)
    if (normalized !== session.apiEndpoint) { session.apiEndpoint = normalized; changed = true }
  }
  if (!Array.isArray(session.tools)) {
    session.tools = Array.isArray(agent.tools) ? [...agent.tools] : []
    changed = true
  }

  if (changed) {
    sessions[sessionId] = session
    saveSessions(sessions)
  }
}

function buildAgentSystemPrompt(session: any): string | undefined {
  if (!session.agentId) return undefined
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent?.systemPrompt && !agent?.soul) return undefined

  const settings = loadSettings()
  const parts: string[] = []
  if (settings.userPrompt) parts.push(settings.userPrompt)
  if (agent.soul) parts.push(agent.soul)
  if (agent.systemPrompt) parts.push(agent.systemPrompt)
  if (agent.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of agent.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) parts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }
  return parts.join('\n\n')
}

function resolveApiKeyForSession(session: SessionWithCredentials, provider: ProviderApiKeyConfig): string | null {
  if (provider.requiresApiKey) {
    if (!session.credentialId) throw new Error('No API key configured for this session')
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (!cred) throw new Error('API key not found. Please add one in Settings.')
    return decryptKey(cred.encryptedKey)
  }
  if (provider.optionalApiKey && session.credentialId) {
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (cred) {
      try { return decryptKey(cred.encryptedKey) } catch { return null }
    }
  }
  return null
}

function classifyHeartbeatResponse(text: string, ackMaxChars: number): 'suppress' | 'strip' | 'keep' {
  const trimmed = text.trim()
  if (trimmed === 'HEARTBEAT_OK') return 'suppress'
  const stripped = trimmed.replace(/HEARTBEAT_OK/gi, '').trim()
  if (!stripped) return 'suppress'
  if (stripped.length <= ackMaxChars) return 'suppress'
  return stripped.length < trimmed.length ? 'strip' : 'keep'
}

const AUTO_MEMORY_MIN_INTERVAL_MS = 45 * 60 * 1000

function normalizeMemoryText(value: string): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function shouldStoreAutoMemoryNote(opts: {
  session: any
  source: string
  internal: boolean
  message: string
  response: string
  now: number
}): boolean {
  const { session, source, internal, message, response, now } = opts
  if (internal) return false
  if (source !== 'chat' && source !== 'connector') return false
  if (!session?.agentId) return false
  if (!Array.isArray(session.tools) || !session.tools.includes('memory')) return false
  const msg = (message || '').trim()
  const resp = (response || '').trim()
  if (msg.length < 20 || resp.length < 40) return false
  if (/^(ok|okay|cool|thanks|thx|got it|nice)[.! ]*$/i.test(msg)) return false
  if (resp === 'HEARTBEAT_OK') return false
  const last = typeof session.lastAutoMemoryAt === 'number' ? session.lastAutoMemoryAt : 0
  if (last > 0 && now - last < AUTO_MEMORY_MIN_INTERVAL_MS) return false
  return true
}

function storeAutoMemoryNote(opts: {
  session: any
  message: string
  response: string
  source: string
  now: number
}): string | null {
  const { session, message, response, source, now } = opts
  try {
    const db = getMemoryDb()
    const compactMessage = message.replace(/\s+/g, ' ').trim().slice(0, 220)
    const compactResponse = response.replace(/\s+/g, ' ').trim().slice(0, 700)
    const title = `[auto] ${compactMessage.slice(0, 90)}`
    const content = [
      `source: ${source}`,
      `user_request: ${compactMessage}`,
      `assistant_outcome: ${compactResponse}`,
    ].join('\n')
    const latest = db.getLatestBySessionCategory?.(session.id, 'execution')
    if (latest) {
      const sameTitle = normalizeMemoryText(latest.title) === normalizeMemoryText(title)
      const sameContent = normalizeMemoryText(latest.content) === normalizeMemoryText(content)
      if (sameTitle && sameContent) {
        session.lastAutoMemoryAt = now
        return latest.id
      }
    }
    const created = db.add({
      agentId: session.agentId,
      sessionId: session.id,
      category: 'execution',
      title,
      content,
    } as any)
    session.lastAutoMemoryAt = now
    return created?.id || null
  } catch {
    return null
  }
}

export async function executeSessionChatTurn(input: ExecuteChatTurnInput): Promise<ExecuteChatTurnResult> {
  const {
    sessionId,
    message,
    imagePath,
    imageUrl,
    internal = false,
    runId,
    source = 'chat',
    onEvent,
    signal,
  } = input

  syncSessionFromAgent(sessionId)

  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  const appSettings = loadSettings()
  const toolPolicy = resolveSessionToolPolicy(session.tools, appSettings)
  const isHeartbeatRun = internal && source === 'heartbeat'
  const heartbeatStatus = session.mainLoopState?.status || 'idle'
  const heartbeatStatusOnly = isHeartbeatRun
    && (session.name !== '__main__' || heartbeatStatus === 'ok' || heartbeatStatus === 'idle')
  const toolsForRun = heartbeatStatusOnly ? [] : toolPolicy.enabledTools
  let sessionForRun = toolsForRun === session.tools
    ? session
    : { ...session, tools: toolsForRun }

  // Apply model override for heartbeat runs (cheaper model)
  if (isHeartbeatRun && input.modelOverride) {
    sessionForRun = { ...sessionForRun, model: input.modelOverride }
  }

  if (!heartbeatStatusOnly && toolPolicy.blockedTools.length > 0) {
    const blockedSummary = toolPolicy.blockedTools
      .map((entry) => `${entry.tool} (${entry.reason})`)
      .join(', ')
    onEvent?.({ t: 'err', text: `Capability policy blocked tools for this run: ${blockedSummary}` })
  }

  const dailySpendLimitUsd = parseUsdLimit(appSettings.safetyMaxDailySpendUsd)
  if (dailySpendLimitUsd !== null) {
    const todaySpendUsd = getTodaySpendUsd()
    if (todaySpendUsd >= dailySpendLimitUsd) {
      const spendError = `Safety budget reached: today's spend is $${todaySpendUsd.toFixed(4)} (limit $${dailySpendLimitUsd.toFixed(4)}). Increase safetyMaxDailySpendUsd to continue autonomous runs.`
      onEvent?.({ t: 'err', text: spendError })

      let persisted = false
      if (!internal) {
        session.messages.push({
          role: 'assistant',
          text: spendError,
          time: Date.now(),
        })
        session.lastActiveAt = Date.now()
        saveSessions(sessions)
        persisted = true
      }

      return {
        runId,
        sessionId,
        text: spendError,
        persisted,
        toolEvents: [],
        error: spendError,
      }
    }
  }

  // Log the trigger
  logExecution(sessionId, 'trigger', `${source} message received`, {
    runId,
    agentId: session.agentId,
    detail: {
      source,
      internal,
      provider: session.provider,
      model: session.model,
      messagePreview: message.slice(0, 200),
      hasImage: !!(imagePath || imageUrl),
    },
  })

  const providerType = session.provider || 'claude-cli'
  const provider = getProvider(providerType)
  if (!provider) throw new Error(`Unknown provider: ${providerType}`)

  if (providerType === 'claude-cli' && !fs.existsSync(session.cwd)) {
    throw new Error(`Directory not found: ${session.cwd}`)
  }

  const apiKey = resolveApiKeyForSession(session, provider)

  if (!internal) {
    session.messages.push({
      role: 'user',
      text: message,
      time: Date.now(),
      imagePath: imagePath || undefined,
      imageUrl: imageUrl || undefined,
    })
    session.lastActiveAt = Date.now()
    saveSessions(sessions)
  }

  const systemPrompt = buildAgentSystemPrompt(session)
  const toolEvents: MessageToolEvent[] = []
  const streamErrors: string[] = []

  const emit = (ev: SSEEvent) => {
    if (ev.t === 'err' && typeof ev.text === 'string') {
      const trimmed = ev.text.trim()
      if (trimmed) {
        streamErrors.push(trimmed)
        if (streamErrors.length > 8) streamErrors.shift()
      }
    }
    collectToolEvent(ev, toolEvents)
    onEvent?.(ev)
  }

  const parseAndEmit = (raw: string) => {
    const lines = raw.split('\n').filter(Boolean)
    for (const line of lines) {
      const ev = extractEventJson(line)
      if (ev) emit(ev)
    }
  }

  let fullResponse = ''
  let errorMessage: string | undefined

  const abortController = new AbortController()
  const abortFromOutside = () => abortController.abort()
  if (signal) {
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', abortFromOutside)
  }

  active.set(sessionId, {
    runId: runId || null,
    source,
    kill: () => abortController.abort(),
  })

  try {
    const hasTools = !!sessionForRun.tools?.length && !CLI_PROVIDER_IDS.has(providerType)
    fullResponse = hasTools
      ? (await streamAgentChat({
          session: sessionForRun,
          message,
          imagePath,
          apiKey,
          systemPrompt,
          write: (raw) => parseAndEmit(raw),
          history: getSessionMessages(sessionId),
          signal: abortController.signal,
        })).fullText
      : await provider.handler.streamChat({
          session: sessionForRun,
          message,
          imagePath,
          apiKey,
          systemPrompt,
          write: (raw: string) => parseAndEmit(raw),
          active,
          loadHistory: getSessionMessages,
        })
  } catch (err: any) {
    errorMessage = err?.message || String(err)
    const failureText = errorMessage || 'Run failed.'
    markProviderFailure(providerType, failureText)
    emit({ t: 'err', text: failureText })
    log.error('chat-run', `Run failed for session ${sessionId}`, {
      runId,
      source,
      internal,
      error: failureText,
    })
  } finally {
    active.delete(sessionId)
    if (signal) signal.removeEventListener('abort', abortFromOutside)
  }

  if (!errorMessage) {
    markProviderSuccess(providerType)
  }

  const requestedToolNames = (!internal && source === 'chat')
    ? requestedToolNamesFromMessage(message)
    : []
  const routingDecision = (!internal && source === 'chat')
    ? routeTaskIntent(message, toolsForRun, appSettings)
    : null
  const calledNames = new Set((toolEvents || []).map((t) => t.name))

  const invokeSessionTool = async (toolName: string, args: Record<string, unknown>, failurePrefix: string): Promise<boolean> => {
    const blockedReason = resolveConcreteToolPolicyBlock(toolName, toolPolicy, appSettings)
    if (blockedReason) {
      emit({ t: 'err', text: `Capability policy blocked tool invocation "${toolName}": ${blockedReason}` })
      return false
    }
    if (
      appSettings.safetyRequireApprovalForOutbound === true
      && toolName === 'connector_message_tool'
      && source !== 'chat'
    ) {
      emit({ t: 'err', text: 'Outbound connector messaging requires explicit user approval.' })
      return false
    }
    const agent = session.agentId ? loadAgents()[session.agentId] : null
    const { tools, cleanup } = buildSessionTools(session.cwd, sessionForRun.tools || [], {
      agentId: session.agentId || null,
      sessionId,
      platformAssignScope: agent?.platformAssignScope || 'self',
      mcpServerIds: agent?.mcpServerIds,
    })
    try {
      const selectedTool = tools.find((t: any) => t?.name === toolName) as any
      if (!selectedTool?.invoke) return false
      const toolInput = JSON.stringify(args)
      emit({ t: 'tool_call', toolName, toolInput })
      const toolOutput = await selectedTool.invoke(args)
      const outputText = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
      emit({ t: 'tool_result', toolName, toolOutput: outputText })
      if (outputText?.trim()) fullResponse = outputText.trim()
      calledNames.add(toolName)
      return true
    } catch (forceErr: any) {
      emit({ t: 'err', text: `${failurePrefix}: ${forceErr?.message || String(forceErr)}` })
      return false
    } finally {
      await cleanup()
    }
  }

  if (requestedToolNames.includes('connector_message_tool') && !calledNames.has('connector_message_tool')) {
    const forcedArgs = extractConnectorMessageArgs(message)
    if (forcedArgs) {
      await invokeSessionTool(
        'connector_message_tool',
        forcedArgs as unknown as Record<string, unknown>,
        'Forced connector_message_tool invocation failed',
      )
    }
  }

  const forcedDelegationTools: Array<'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli'> = [
    'delegate_to_claude_code',
    'delegate_to_codex_cli',
    'delegate_to_opencode_cli',
  ]
  for (const toolName of forcedDelegationTools) {
    if (!requestedToolNames.includes(toolName)) continue
    if (calledNames.has(toolName)) continue
    const task = extractDelegationTask(message, toolName)
    if (!task) continue
    await invokeSessionTool(toolName, { task }, `Forced ${toolName} invocation failed`)
  }

  const hasDelegationCall = forcedDelegationTools.some((toolName) => calledNames.has(toolName))
  const enabledDelegateTools = enabledDelegationTools(sessionForRun)
  const shouldAutoDelegateCoding = (!internal && source === 'chat')
    && enabledDelegateTools.length > 0
    && !hasDelegationCall
    && routingDecision?.intent === 'coding'

  if (shouldAutoDelegateCoding) {
    const baseDelegationOrder = routingDecision?.preferredDelegates?.length
      ? routingDecision.preferredDelegates
      : forcedDelegationTools
    const delegationOrder = rankDelegatesByHealth(baseDelegationOrder as DelegateTool[])
      .filter((tool) => enabledDelegateTools.includes(tool))
    for (const delegateTool of delegationOrder) {
      const invoked = await invokeSessionTool(delegateTool, { task: message.trim() }, 'Auto-delegation failed')
      if (invoked) break
    }
  }

  const shouldFailoverDelegate = (!internal && source === 'chat')
    && !!errorMessage
    && !(fullResponse || '').trim()
    && enabledDelegateTools.length > 0
    && !hasDelegationCall
    && (routingDecision?.intent === 'coding' || routingDecision?.intent === 'general')
  if (shouldFailoverDelegate) {
    const preferred = routingDecision?.preferredDelegates?.length
      ? routingDecision.preferredDelegates
      : forcedDelegationTools
    const fallbackOrder = rankDelegatesByHealth(preferred as DelegateTool[])
      .filter((tool) => enabledDelegateTools.includes(tool))
    for (const delegateTool of fallbackOrder) {
      const invoked = await invokeSessionTool(
        delegateTool,
        { task: message.trim() },
        `Provider failover via ${delegateTool} failed`,
      )
      if (invoked) {
        errorMessage = undefined
        break
      }
    }
  }

  const canAutoRouteWithTools = (!internal && source === 'chat')
    && !!routingDecision
    && calledNames.size === 0
    && requestedToolNames.length === 0

  if (canAutoRouteWithTools && routingDecision?.intent === 'browsing' && routingDecision.primaryUrl && hasToolEnabled(sessionForRun, 'browser')) {
    await invokeSessionTool(
      'browser',
      { action: 'navigate', url: routingDecision.primaryUrl },
      'Auto browser routing failed',
    )
  }

  if (canAutoRouteWithTools && routingDecision?.intent === 'research') {
    const routeUrl = routingDecision.primaryUrl || findFirstUrl(message)
    if (routeUrl && hasToolEnabled(sessionForRun, 'web_fetch')) {
      await invokeSessionTool('web_fetch', { url: routeUrl }, 'Auto web_fetch routing failed')
    } else if (hasToolEnabled(sessionForRun, 'web_search')) {
      await invokeSessionTool('web_search', { query: message.trim(), maxResults: 5 }, 'Auto web_search routing failed')
    }
  }

  if (requestedToolNames.length > 0) {
    const missed = requestedToolNames.filter((name) => !calledNames.has(name))
    if (missed.length > 0) {
      const notice = `Tool execution notice: requested tool(s) ${missed.join(', ')} were not actually invoked in this run.`
      emit({ t: 'err', text: notice })
      if (!fullResponse.includes('Tool execution notice:')) {
        const trimmedResponse = (fullResponse || '').trim()
        fullResponse = trimmedResponse
          ? `${trimmedResponse}\n\n${notice}`
          : notice
      }
    }
  }

  if (!errorMessage && streamErrors.length > 0 && !(fullResponse || '').trim()) {
    errorMessage = streamErrors[streamErrors.length - 1]
  }

  const finalText = (fullResponse || '').trim() || (!internal && errorMessage ? `Error: ${errorMessage}` : '')
  const textForPersistence = stripMainLoopMetaForPersistence(finalText, internal)

  // HEARTBEAT_OK suppression
  const heartbeatConfig = input.heartbeatConfig
  let heartbeatClassification: 'suppress' | 'strip' | 'keep' | null = null
  if (isHeartbeatRun && textForPersistence.length > 0) {
    heartbeatClassification = classifyHeartbeatResponse(textForPersistence, heartbeatConfig?.ackMaxChars ?? 300)
  }

  const shouldPersistAssistant = textForPersistence.length > 0
    && heartbeatClassification !== 'suppress'

  const normalizeResumeId = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null

  const fresh = loadSessions()
  const current = fresh[sessionId]
  if (current) {
    let changed = false
    const persistField = (key: string, value: unknown) => {
      const normalized = normalizeResumeId(value)
      if ((current as any)[key] !== normalized) {
        ;(current as any)[key] = normalized
        changed = true
      }
    }

    persistField('claudeSessionId', session.claudeSessionId)
    persistField('codexThreadId', session.codexThreadId)
    persistField('opencodeSessionId', session.opencodeSessionId)

    const sourceResume = session.delegateResumeIds
    if (sourceResume && typeof sourceResume === 'object') {
      const currentResume = (current.delegateResumeIds && typeof current.delegateResumeIds === 'object')
        ? current.delegateResumeIds
        : {}
      const nextResume = {
        claudeCode: normalizeResumeId((sourceResume as any).claudeCode ?? (currentResume as any).claudeCode),
        codex: normalizeResumeId((sourceResume as any).codex ?? (currentResume as any).codex),
        opencode: normalizeResumeId((sourceResume as any).opencode ?? (currentResume as any).opencode),
      }
      if (JSON.stringify(currentResume) !== JSON.stringify(nextResume)) {
        current.delegateResumeIds = nextResume
        changed = true
      }
    }

    if (shouldPersistAssistant) {
      const persistedKind = internal && source !== 'session-awakening' ? 'heartbeat' : 'chat'
      const persistedText = heartbeatClassification === 'strip'
        ? textForPersistence.replace(/HEARTBEAT_OK/gi, '').trim()
        : textForPersistence
      current.messages.push({
        role: 'assistant',
        text: persistedText,
        time: Date.now(),
        toolEvents: toolEvents.length ? toolEvents : undefined,
        kind: persistedKind,
      })
      changed = true

      // Target routing for non-suppressed heartbeat alerts
      if (isHeartbeatRun && heartbeatConfig?.target && heartbeatConfig.target !== 'none' && heartbeatConfig.showAlerts !== false) {
        try {
          const { listRunningConnectors, sendConnectorMessage } = require('./connectors/manager')
          let connectorId: string | undefined
          let channelId: string | undefined
          if (heartbeatConfig.target === 'last') {
            const running = listRunningConnectors()
            const first = running.find((c: any) => c.recentChannelId)
            if (first) {
              connectorId = first.id
              channelId = first.recentChannelId
            }
          } else if (heartbeatConfig.target.includes(':')) {
            const [cId, chId] = heartbeatConfig.target.split(':', 2)
            connectorId = cId
            channelId = chId
          } else {
            channelId = heartbeatConfig.target
          }
          if (channelId) {
            sendConnectorMessage({ connectorId, channelId, text: persistedText }).catch(() => {})
          }
        } catch {
          // Best effort — connector manager may not be loaded
        }
      }
    }

    const autoMemoryEligible = shouldStoreAutoMemoryNote({
      session: current,
      source,
      internal,
      message,
      response: textForPersistence,
      now: Date.now(),
    })
    if (autoMemoryEligible) {
      const storedId = storeAutoMemoryNote({
        session: current,
        message,
        response: textForPersistence,
        source,
        now: Date.now(),
      })
      if (storedId) changed = true
    }

    // Don't extend idle timeout for heartbeat runs — only user-initiated activity counts
    if (source !== 'heartbeat' && source !== 'main-loop-followup') {
      current.lastActiveAt = Date.now()
    }
    fresh[sessionId] = current
    saveSessions(fresh)
  }

  return {
    runId,
    sessionId,
    text: finalText,
    persisted: shouldPersistAssistant,
    toolEvents,
    error: errorMessage,
  }
}
