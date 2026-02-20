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
  active,
} from './storage'
import { getProvider } from '@/lib/providers'
import { log } from './logger'
import { logExecution } from './execution-log'
import { streamAgentChat } from './stream-agent-chat'
import { buildSessionTools } from './session-tools'
import type { MessageToolEvent, SSEEvent } from '@/types'

const CLI_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli'])

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
  if (agent.apiEndpoint !== undefined && agent.apiEndpoint !== session.apiEndpoint) { session.apiEndpoint = agent.apiEndpoint ?? null; changed = true }
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

function resolveApiKeyForSession(session: any, provider: any): string | null {
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

  const emit = (ev: SSEEvent) => {
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
    const hasTools = !!session.tools?.length && !CLI_PROVIDER_IDS.has(providerType)
    fullResponse = hasTools
      ? (await streamAgentChat({
          session,
          message,
          imagePath,
          apiKey,
          systemPrompt,
          write: (raw) => parseAndEmit(raw),
          history: getSessionMessages(sessionId),
          signal: abortController.signal,
        })).fullText
      : await provider.handler.streamChat({
          session,
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
    emit({ t: 'err', text: errorMessage })
    log.error('chat-run', `Run failed for session ${sessionId}`, {
      runId,
      source,
      internal,
      error: errorMessage,
    })
  } finally {
    active.delete(sessionId)
    if (signal) signal.removeEventListener('abort', abortFromOutside)
  }

  const requestedToolNames = requestedToolNamesFromMessage(message)
  const calledNames = new Set((toolEvents || []).map((t) => t.name))
  if (requestedToolNames.includes('connector_message_tool')) {
    if (!calledNames.has('connector_message_tool')) {
      const forcedArgs = extractConnectorMessageArgs(message)
      if (forcedArgs) {
        const agent = session.agentId ? loadAgents()[session.agentId] : null
        const { tools, cleanup } = buildSessionTools(session.cwd, session.tools || [], {
          agentId: session.agentId || null,
          sessionId,
          platformAssignScope: agent?.platformAssignScope || 'self',
        })
        try {
          const connectorTool = tools.find((t: any) => t?.name === 'connector_message_tool') as any
          if (connectorTool?.invoke) {
            const toolInput = JSON.stringify(forcedArgs)
            emit({ t: 'tool_call', toolName: 'connector_message_tool', toolInput })
            const toolOutput = await connectorTool.invoke(forcedArgs)
            const outputText = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
            emit({ t: 'tool_result', toolName: 'connector_message_tool', toolOutput: outputText })
            if (outputText?.trim()) {
              fullResponse = outputText.trim()
            }
            calledNames.add('connector_message_tool')
          }
        } catch (forceErr: any) {
          emit({ t: 'err', text: `Forced connector_message_tool invocation failed: ${forceErr?.message || String(forceErr)}` })
        } finally {
          await cleanup()
        }
      }
    }
  }

  const forcedDelegationTools = ['delegate_to_claude_code', 'delegate_to_codex_cli', 'delegate_to_opencode_cli']
  for (const toolName of forcedDelegationTools) {
    if (!requestedToolNames.includes(toolName)) continue
    if (calledNames.has(toolName)) continue
    const task = extractDelegationTask(message, toolName)
    if (!task) continue

    const agent = session.agentId ? loadAgents()[session.agentId] : null
    const { tools, cleanup } = buildSessionTools(session.cwd, session.tools || [], {
      agentId: session.agentId || null,
      sessionId,
      platformAssignScope: agent?.platformAssignScope || 'self',
    })
    try {
      const delegatedTool = tools.find((t: any) => t?.name === toolName) as any
      if (!delegatedTool?.invoke) continue
      const forcedArgs = { task }
      emit({ t: 'tool_call', toolName, toolInput: JSON.stringify(forcedArgs) })
      const toolOutput = await delegatedTool.invoke(forcedArgs)
      const outputText = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
      emit({ t: 'tool_result', toolName, toolOutput: outputText })
      if (outputText?.trim()) {
        fullResponse = outputText.trim()
      }
      calledNames.add(toolName)
    } catch (forceErr: any) {
      emit({ t: 'err', text: `Forced ${toolName} invocation failed: ${forceErr?.message || String(forceErr)}` })
    } finally {
      await cleanup()
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

  const finalText = (fullResponse || '').trim()
  const shouldPersistAssistant = finalText.length > 0
    && (!internal || finalText !== 'HEARTBEAT_OK')

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
      current.messages.push({
        role: 'assistant',
        text: finalText,
        time: Date.now(),
        toolEvents: toolEvents.length ? toolEvents : undefined,
        kind: internal ? 'heartbeat' : 'chat',
      })
      changed = true
    }

    // Always update lastActiveAt after a successful run (including heartbeats),
    // even if no messages were persisted — the session was still active.
    current.lastActiveAt = Date.now()
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
