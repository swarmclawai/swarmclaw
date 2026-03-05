import fs from 'fs'
import os from 'os'
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
  appendUsage,
  active,
} from './storage'
import { getProvider } from '@/lib/providers'
import { estimateCost, checkAgentBudgetLimits } from './cost'
import { log } from './logger'
import { logExecution } from './execution-log'
import { streamAgentChat } from './stream-agent-chat'
import { runLinkUnderstanding } from './link-understanding'
import { buildSessionTools } from './session-tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { Session } from '@/types'
import { stripMainLoopMetaForPersistence } from './main-agent-loop'
import { getPluginManager } from './plugins'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { routeTaskIntent } from './capability-router'
import { notify } from './ws-hub'
import { resolveConcreteToolPolicyBlock, resolveSessionToolPolicy } from './tool-capability-policy'
import { pluginIdMatches } from './tool-aliases'
import { buildCurrentDateTimePromptContext } from './prompt-runtime-context'
import {
  getCachedLlmResponse,
  resolveLlmResponseCacheConfig,
  setCachedLlmResponse,
  type LlmResponseCacheKeyInput,
} from './llm-response-cache'
import type { Message, MessageToolEvent, SSEEvent, UsageRecord } from '@/types'
import { markProviderFailure, markProviderSuccess, rankDelegatesByHealth } from './provider-health'
import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
type DelegateTool = 'delegate_to_claude_code' | 'delegate_to_codex_cli' | 'delegate_to_opencode_cli' | 'delegate_to_gemini_cli'

/** Slice history from the most recent context-clear marker forward */
function applyContextClearBoundary(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'context-clear') return messages.slice(i + 1)
  }
  return messages
}

interface SessionWithTools {
  plugins?: string[] | null
  /** @deprecated Use plugins */
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
  attachedFiles?: string[]
  internal?: boolean
  source?: string
  runId?: string
  signal?: AbortSignal
  onEvent?: (event: SSEEvent) => void
  modelOverride?: string
  heartbeatConfig?: { ackMaxChars: number; showOk: boolean; showAlerts: boolean; target: string | null }
  replyToId?: string
}

export interface ExecuteChatTurnResult {
  runId?: string
  sessionId: string
  text: string
  persisted: boolean
  toolEvents: MessageToolEvent[]
  error?: string
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
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

function shouldReplaceRecentAssistantMessage(params: {
  previous: Message | null | undefined
  nextToolEvents: MessageToolEvent[]
  nextKind: Message['kind']
  now: number
}): boolean {
  const { previous, nextToolEvents, nextKind, now } = params
  if (!previous || previous.role !== 'assistant') return false
  if (nextToolEvents.length === 0) return false
  if (previous.kind && nextKind && previous.kind !== nextKind) return false
  if (typeof previous.time === 'number' && now - previous.time > 45_000) return false
  const prevTools = Array.isArray(previous.toolEvents) ? previous.toolEvents.length : 0
  return prevTools === 0
}

function requestedToolNamesFromMessage(message: string): string[] {
  const lower = message.toLowerCase()
  const candidates = [
    'delegate_to_claude_code',
    'delegate_to_codex_cli',
    'delegate_to_opencode_cli',
    'delegate_to_gemini_cli',
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
    'manage_capabilities',
    'manage_platform',
    'manage_chatrooms',
    'search_marketplace',
    'monitor_tool',
    'plugin_creator_tool',
    'memory_tool',
    'wallet_tool',
    'http_request',
    'send_file',
    'browser',
    'web',
    'shell',
    'files',
    'edit_file',
    'sandbox_exec',
    'sandbox_list_runtimes',
    'git',
    'canvas',
    'delegate',
    'schedule_wake',
    'spawn_subagent',
    'context_status',
    'context_summarize',
    'openclaw_nodes',
    'openclaw_workspace',
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
  action:
    | 'list_running'
    | 'list_targets'
    | 'start'
    | 'stop'
    | 'send'
    | 'send_voice_note'
    | 'schedule_followup'
  platform?: string
  connectorId?: string
  to?: string
  message?: string
  voiceText?: string
  voiceId?: string
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  delaySec?: number
  followUpMessage?: string
  followUpDelaySec?: number
  ptt?: boolean
  approved?: boolean
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
  const action = (
    actionRaw === 'list_running'
    || actionRaw === 'list_targets'
    || actionRaw === 'start'
    || actionRaw === 'stop'
    || actionRaw === 'send'
    || actionRaw === 'send_voice_note'
    || actionRaw === 'schedule_followup'
  )
    ? actionRaw
    : 'send'
  const args: {
    action:
      | 'list_running'
      | 'list_targets'
      | 'start'
      | 'stop'
      | 'send'
      | 'send_voice_note'
      | 'schedule_followup'
    platform?: string
    connectorId?: string
    to?: string
    message?: string
    voiceText?: string
    voiceId?: string
    imageUrl?: string
    fileUrl?: string
    mediaPath?: string
    mimeType?: string
    fileName?: string
    caption?: string
    delaySec?: number
    followUpMessage?: string
    followUpDelaySec?: number
    ptt?: boolean
    approved?: boolean
  } = { action }
  const quoted = (key: string): string | undefined => {
    const m = message.match(new RegExp(`${key}\\s*=\\s*(\"([^\"]*)\"|'([^']*)')`, 'i'))
    return (m?.[2] || m?.[3] || '').trim() || undefined
  }
  if (parsed.platform) args.platform = parsed.platform
  if (parsed.connectorId) args.connectorId = parsed.connectorId
  if (parsed.to) args.to = parsed.to
  if (payload) args.message = payload
  if (parsed.voiceText) args.voiceText = parsed.voiceText
  if (parsed.voiceId) args.voiceId = parsed.voiceId
  args.imageUrl = parsed.imageUrl || quoted('imageUrl')
  args.fileUrl = parsed.fileUrl || quoted('fileUrl')
  args.mediaPath = parsed.mediaPath || quoted('mediaPath')
  args.mimeType = parsed.mimeType || quoted('mimeType')
  args.fileName = parsed.fileName || quoted('fileName')
  args.caption = parsed.caption || quoted('caption')
  if (parsed.followUpMessage) args.followUpMessage = parsed.followUpMessage
  if (parsed.delaySec && Number.isFinite(Number(parsed.delaySec))) args.delaySec = Number(parsed.delaySec)
  if (parsed.followUpDelaySec && Number.isFinite(Number(parsed.followUpDelaySec))) args.followUpDelaySec = Number(parsed.followUpDelaySec)
  if (parsed.ptt) args.ptt = ['true', '1', 'yes', 'on'].includes(parsed.ptt.toLowerCase())
  if (parsed.approved) args.approved = ['true', '1', 'yes', 'on'].includes(parsed.approved.toLowerCase())
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
  return pluginIdMatches(session?.plugins || session?.tools || [], toolName)
}

function enabledDelegationTools(session: SessionWithTools): DelegateTool[] {
  const tools: DelegateTool[] = []
  if (hasToolEnabled(session, 'claude_code') || hasToolEnabled(session, 'delegate')) tools.push('delegate_to_claude_code')
  if (hasToolEnabled(session, 'codex_cli')) tools.push('delegate_to_codex_cli')
  if (hasToolEnabled(session, 'opencode_cli')) tools.push('delegate_to_opencode_cli')
  if (hasToolEnabled(session, 'gemini_cli')) tools.push('delegate_to_gemini_cli')
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
      const rec = record as Record<string, unknown>
      const ts = typeof rec?.timestamp === 'number' ? rec.timestamp : 0
      if (ts < minTs) continue
      const cost = typeof rec?.estimatedCost === 'number' ? rec.estimatedCost : 0
      if (Number.isFinite(cost) && cost > 0) total += cost
    }
  }
  return total
}

function findFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')]+/i)
  return m?.[0] || null
}

function isMemoryListIntent(message: string): boolean {
  const text = message.toLowerCase()
  if (!/\bmemory|memories|remember\b/.test(text)) return false
  if (/\b(save|store|memorize|add to memory|write to memory|remember this)\b/.test(text)) return false
  if (/\bmemory_tool\b/.test(text)) return true
  return (
    /\blist\b[\s\w]{0,24}\bmemories\b/.test(text)
    || /\bshow\b[\s\w]{0,24}\bmemories\b/.test(text)
    || /\bget\b[\s\w]{0,24}\bmemories\b/.test(text)
    || /\bwhat\b[\s\w]{0,40}\bmemories\b/.test(text)
    || /\bwhat do you remember\b/.test(text)
    || /\brecall\b[\s\w]{0,24}\bmemories?\b/.test(text)
  )
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
  if (!Array.isArray(session.plugins)) {
    session.plugins = Array.isArray(agent.plugins) ? [...agent.plugins] : []
    changed = true
  }

  if (changed) {
    sessions[sessionId] = session
    saveSessions(sessions)
  }
}

function buildAgentSystemPrompt(session: Session): string | undefined {
  if (!session.agentId) return undefined
  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent) return undefined

  const settings = loadSettings()
  const parts: string[] = []

  // 1. Identity & Persona (Grounded OpenClaw Style)
  const identityLines = [`## My Identity`]
  identityLines.push(`Name: ${agent.name}`)
  if (agent.emoji) identityLines.push(`Emoji: ${agent.emoji}`)
  if (agent.creature) identityLines.push(`Creature: ${agent.creature}`)
  if (agent.vibe) identityLines.push(`Vibe: ${agent.vibe}`)
  if (agent.theme) identityLines.push(`Theme: ${agent.theme}`)
  if (agent.description) identityLines.push(`Description: ${agent.description}`)
  identityLines.push('I should always embody this identity. I am not just an "Assistant" — I am a persistent companion with my own soul and presence.')
  parts.push(identityLines.join('\n'))

  // 2. Runtime & Capabilities (OpenClaw Style)
  const runtimeLines = [
    '## Runtime',
    `os=${process.platform} | host=${os.hostname()} | agent=${agent.id} | provider=${agent.provider} | model=${agent.model}`,
    `capabilities=tools,heartbeats,autonomous_loop,multi_agent_chat`,
  ]
  parts.push(runtimeLines.join('\n'))

  // 3. User & DateTime Context
  if (settings.userPrompt) parts.push(`## User Instructions\n${settings.userPrompt}`)
  parts.push(buildCurrentDateTimePromptContext())

  // 4. Soul & Core Instructions
  if (agent.soul) parts.push(`## Soul\n${agent.soul}`)
  if (agent.systemPrompt) parts.push(`## System Prompt\n${agent.systemPrompt}`)

  // 5. Skills (SwarmClaw Core)
  if (agent.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of agent.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) parts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }

  // 6. Thinking & Output Format (OpenClaw Style)
  const thinkingHint = [
    '## Output Format',
    'If your model supports internal reasoning/thinking, put all internal analysis inside <think>...</think> tags.',
    'Your final response to the user should be clear and concise.',
    'When you have nothing to say, respond with ONLY: NO_MESSAGE',
  ]
  parts.push(thinkingHint.join('\n'))

  // 7. Heartbeat Guidance
  parts.push([
    '## Heartbeats',
    'You run on an autonomous heartbeat. If you receive a heartbeat poll and nothing needs attention, reply exactly: HEARTBEAT_OK',
  ].join('\n'))

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

function stripMarkupForHeartbeat(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')       // strip HTML tags
    .replace(/&nbsp;/gi, ' ')       // decode nbsp
    .replace(/^[*`~_]+/, '')        // strip leading markdown
    .replace(/[*`~_]+$/, '')        // strip trailing markdown
    .trim()
}

const HEARTBEAT_OK_RE = /HEARTBEAT_OK[^\w]{0,4}$/
const NO_MESSAGE_RE = /NO_MESSAGE[^\w]{0,4}$/

function classifyHeartbeatResponse(text: string, ackMaxChars: number, hadToolCalls: boolean): 'suppress' | 'strip' | 'keep' {
  const cleaned = stripMarkupForHeartbeat(text)
  if (cleaned === 'HEARTBEAT_OK' || cleaned === 'NO_MESSAGE') return 'suppress'
  if (HEARTBEAT_OK_RE.test(cleaned) || NO_MESSAGE_RE.test(cleaned)) return 'suppress'
  const stripped = cleaned.replace(/HEARTBEAT_OK/gi, '').replace(/NO_MESSAGE/gi, '').trim()
  if (!stripped) return 'suppress'
  if (!hadToolCalls && stripped.length <= ackMaxChars) return 'suppress'
  return stripped.length < cleaned.length ? 'strip' : 'keep'
}

function estimateConversationTone(text: string): string {
  const t = text || ''
  // Technical: code blocks, function signatures, technical terms
  if (/```/.test(t) || /\b(function|const|let|var|import|export|class|interface|async|await|return)\b/.test(t)) return 'technical'
  if (/\b(error|bug|debug|stack trace|exception|null|undefined|TypeError)\b/i.test(t)) return 'technical'
  // Empathetic: emotional/supportive language
  if (/\b(understand|feel|sorry|empathize|appreciate|grateful|tough|difficult|challenging)\b/i.test(t)) return 'empathetic'
  // Formal: academic/business language
  if (/\b(furthermore|regarding|consequently|therefore|henceforth|pursuant|accordingly|notwithstanding)\b/i.test(t)) return 'formal'
  // Casual: contractions, exclamations, informal language
  if (/\b(gonna|wanna|gotta|yeah|hey|awesome|cool|lol|btw|tbh)\b/i.test(t) || /!{2,}/.test(t)) return 'casual'
  return 'neutral'
}


export async function executeSessionChatTurn(input: ExecuteChatTurnInput): Promise<ExecuteChatTurnResult> {
  const { message } = input
  const {
    sessionId,
    imagePath,
    imageUrl,
    attachedFiles,
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
  const toolPolicy = resolveSessionToolPolicy(session.plugins, appSettings)
  const isHeartbeatRun = internal && source === 'heartbeat'
  const isAutoRunNoHistory = isHeartbeatRun || (internal && source === 'main-loop-followup')
  const heartbeatStatus = session.mainLoopState?.status || 'idle'
  const mainLoopIdle = session.id.startsWith('agent-thread-')
    && (heartbeatStatus === 'ok' || heartbeatStatus === 'idle')
    && !(session.mainLoopState?.pendingEvents?.length > 0)
  const heartbeatStatusOnly = isHeartbeatRun && mainLoopIdle
  const pluginsForRun = heartbeatStatusOnly ? [] : toolPolicy.enabledPlugins
  let sessionForRun = pluginsForRun === session.plugins
    ? session
    : { ...session, plugins: pluginsForRun }

  // Apply model override for heartbeat runs (cheaper model)
  if (isHeartbeatRun && input.modelOverride) {
    sessionForRun = { ...sessionForRun, model: input.modelOverride }
  }

  if (!heartbeatStatusOnly && toolPolicy.blockedPlugins.length > 0) {
    const blockedSummary = toolPolicy.blockedPlugins
      .map((entry) => `${entry.tool} (${entry.reason})`)
      .join(', ')
    onEvent?.({ t: 'err', text: `Capability policy blocked plugins for this run: ${blockedSummary}` })
  }

  // --- Agent spend-limit enforcement (hourly/daily/monthly) ---
  if (session.agentId) {
    const agentsMap = loadAgents()
    const agent = agentsMap[session.agentId]
    if (agent) {
      const budgetCheck = checkAgentBudgetLimits(agent)
      const action = agent.budgetAction || 'warn'

      if (budgetCheck.exceeded.length > 0) {
        const budgetError = budgetCheck.exceeded.map((entry) => entry.message).join(' ')
        if (action === 'block') {
          onEvent?.({ t: 'err', text: budgetError })

          let persisted = false
          if (!internal) {
            session.messages.push({
              role: 'assistant',
              text: budgetError,
              time: Date.now(),
            })
            session.lastActiveAt = Date.now()
            saveSessions(sessions)
            persisted = true
          }

          return {
            runId,
            sessionId,
            text: budgetError,
            persisted,
            toolEvents: [],
            error: budgetError,
          }
        }
        // budgetAction === 'warn': emit a warning but continue
        onEvent?.({ t: 'status', text: JSON.stringify({ budgetWarning: budgetError }) })
      } else if (budgetCheck.warnings.length > 0) {
        const warningText = budgetCheck.warnings.map((entry) => entry.message).join(' ')
        onEvent?.({ t: 'status', text: JSON.stringify({ budgetWarning: warningText }) })
      }
    }
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
    const linkAnalysis = await runLinkUnderstanding(message)
    session.messages.push({
      role: 'user',
      text: message,
      time: Date.now(),
      imagePath: imagePath || undefined,
      imageUrl: imageUrl || undefined,
      attachedFiles: attachedFiles?.length ? attachedFiles : undefined,
      replyToId: input.replyToId || undefined,
    })
    if (linkAnalysis.length > 0) {
      session.messages.push({
        role: 'assistant',
        kind: 'system',
        text: `[Automated Link Analysis]\n${linkAnalysis.join('\n\n')}`,
        time: Date.now(),
      })
    }
    session.lastActiveAt = Date.now()
    saveSessions(sessions)
  }

  const systemPrompt = buildAgentSystemPrompt(session)
  const toolEvents: MessageToolEvent[] = []
  const streamErrors: string[] = []
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }

  let thinkingText = ''
  let streamingPartialText = ''
  const emit = (ev: SSEEvent) => {
    if (ev.t === 'd' && typeof ev.text === 'string') {
      streamingPartialText += ev.text
    }
    if (ev.t === 'err' && typeof ev.text === 'string') {
      const trimmed = ev.text.trim()
      if (trimmed) {
        streamErrors.push(trimmed)
        if (streamErrors.length > 8) streamErrors.shift()
      }
    }
    if (ev.t === 'thinking' && ev.text) {
      thinkingText += ev.text
    }
    if (ev.t === 'md' && ev.text) {
      try {
        const mdPayload = JSON.parse(ev.text) as Record<string, unknown>
        const usage = mdPayload.usage as { inputTokens?: number; outputTokens?: number; estimatedCost?: number } | undefined
        if (usage) {
          if (typeof usage.inputTokens === 'number') accumulatedUsage.inputTokens += usage.inputTokens
          if (typeof usage.outputTokens === 'number') accumulatedUsage.outputTokens += usage.outputTokens
          if (typeof usage.estimatedCost === 'number') accumulatedUsage.estimatedCost += usage.estimatedCost
        }
      } catch { /* ignore non-JSON md events */ }
    }
    collectToolEvent(ev, toolEvents)
    onEvent?.(ev)
  }

  // Periodic partial save so a browser refresh doesn't lose the in-flight response.
  let lastPartialSaveLen = 0
  const PARTIAL_SAVE_INTERVAL_MS = 5000
  const partialSaveTimer = setInterval(() => {
    if (streamingPartialText.length > lastPartialSaveLen) {
      lastPartialSaveLen = streamingPartialText.length
      try {
        const fresh = loadSessions()
        const current = fresh[sessionId]
        if (!current) return
        const partialMsg: Message = {
          role: 'assistant',
          text: streamingPartialText,
          time: Date.now(),
          streaming: true,
          toolEvents: toolEvents.length ? [...toolEvents] : undefined,
        }
        const lastMsg = current.messages.at(-1)
        if (lastMsg?.streaming) {
          current.messages[current.messages.length - 1] = partialMsg
        } else {
          current.messages.push(partialMsg)
        }
        fresh[sessionId] = current
        saveSessions(fresh)
        notify(`messages:${sessionId}`)
      } catch { /* partial save is best-effort */ }
    }
  }, PARTIAL_SAVE_INTERVAL_MS)

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

  // Capture provider-reported usage for the direct (non-tools) path.
  // Uses a mutable object because TS can't track callback mutations on plain variables.
  const directUsage = { inputTokens: 0, outputTokens: 0, received: false }
  const responseCacheConfig = resolveLlmResponseCacheConfig(appSettings)
  let responseCacheHit = false
  let responseCacheInput: LlmResponseCacheKeyInput | null = null
  const hasPlugins = !!(sessionForRun.plugins?.length || sessionForRun.tools?.length) && !NON_LANGGRAPH_PROVIDER_IDS.has(providerType)

  let durationMs = 0
  const startTs = Date.now()
  try {
    // Heartbeat runs get a small tail of recent messages so the agent can see
    // prior findings and avoid repeating the same searches. Full history is
    // skipped to avoid blowing the context window on long-lived sessions.
    const heartbeatHistory = isAutoRunNoHistory
      ? getSessionMessages(sessionId).slice(-6)
      : undefined

    console.log(`[chat-execution] provider=${providerType}, hasPlugins=${hasPlugins}, imagePath=${imagePath || 'none'}, attachedFiles=${attachedFiles?.length || 0}, plugins=${(sessionForRun.plugins || sessionForRun.tools || []).length}`)
    if (hasPlugins) {
      fullResponse = (await streamAgentChat({
        session: sessionForRun,
        message: message,
        imagePath,
        attachedFiles,
        apiKey,
        systemPrompt,
        write: (raw) => parseAndEmit(raw),
        history: heartbeatHistory ?? applyContextClearBoundary(getSessionMessages(sessionId)),
        signal: abortController.signal,
      })).fullText
    } else {
      const directHistorySnapshot = isAutoRunNoHistory
        ? getSessionMessages(sessionId).slice(-6)
        : applyContextClearBoundary(getSessionMessages(sessionId))
      responseCacheInput = {
        provider: providerType,
        model: sessionForRun.model,
        apiEndpoint: sessionForRun.apiEndpoint || '',
        systemPrompt,
        message: message,
        imagePath,
        imageUrl,
        attachedFiles,
        history: directHistorySnapshot,
      }
      const canUseResponseCache = !internal && responseCacheConfig.enabled
      const cached = canUseResponseCache
        ? getCachedLlmResponse(responseCacheInput, responseCacheConfig)
        : null
      if (cached) {
        responseCacheHit = true
        fullResponse = cached.text
        emit({
          t: 'md',
          text: JSON.stringify({
            cache: {
              hit: true,
              ageMs: cached.ageMs,
              provider: cached.provider,
              model: cached.model,
            },
          }),
        })
        emit({ t: 'd', text: cached.text })
      } else {
        fullResponse = await provider.handler.streamChat({
          session: sessionForRun,
          message: message,
          imagePath,
          apiKey,
          systemPrompt,
          write: (raw: string) => parseAndEmit(raw),
          active,
          loadHistory: (sid: string) => {
            if (sid === sessionId) return directHistorySnapshot
            return isAutoRunNoHistory
              ? getSessionMessages(sid).slice(-6)
              : applyContextClearBoundary(getSessionMessages(sid))
          },
          onUsage: (u) => { directUsage.inputTokens = u.inputTokens; directUsage.outputTokens = u.outputTokens; directUsage.received = true },
          signal: abortController.signal,
        })
        if (canUseResponseCache && responseCacheInput && fullResponse) {
          setCachedLlmResponse(responseCacheInput, fullResponse, responseCacheConfig)
        }
      }
    }
    durationMs = Date.now() - startTs
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err)
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
    clearInterval(partialSaveTimer)
    active.delete(sessionId)
    if (signal) signal.removeEventListener('abort', abortFromOutside)
  }

  if (!errorMessage) {
    markProviderSuccess(providerType)
  }

  // Record usage for the direct (non-tools) streamChat path.
  // streamAgentChat already calls appendUsage internally for the tools path.
  if (!hasPlugins && fullResponse && !errorMessage && !responseCacheHit) {
    const inputTokens = directUsage.received ? directUsage.inputTokens : Math.ceil(message.length / 4)
    const outputTokens = directUsage.received ? directUsage.outputTokens : Math.ceil(fullResponse.length / 4)
    const totalTokens = inputTokens + outputTokens
    if (totalTokens > 0) {
      const cost = estimateCost(sessionForRun.model, inputTokens, outputTokens)
      const history = getSessionMessages(sessionId)
      const usageRecord: UsageRecord = {
        sessionId,
        messageIndex: history.length,
        model: sessionForRun.model,
        provider: providerType,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost: cost,
        timestamp: Date.now(),
        durationMs,
      }
      appendUsage(sessionId, usageRecord)
      emit({
        t: 'md',
        text: JSON.stringify({ usage: { inputTokens, outputTokens, totalTokens, estimatedCost: cost } }),
      })
    }
  }

  const requestedToolNames = (!internal && source === 'chat')
    ? requestedToolNamesFromMessage(message)
    : []
  const routingDecision = (!internal && source === 'chat')
    ? routeTaskIntent(message, pluginsForRun, appSettings)
    : null
  const calledNames = new Set((toolEvents || []).map((t) => t.name))

  const translateToolInvocation = (
    requestedName: string,
    rawArgs: Record<string, unknown>,
  ): { toolName: string; args: Record<string, unknown> } => {
    if (requestedName === 'web_search') {
      return {
        toolName: 'web',
        args: {
          action: 'search',
          query: typeof rawArgs.query === 'string' ? rawArgs.query : message.trim(),
          maxResults: typeof rawArgs.maxResults === 'number' ? rawArgs.maxResults : 5,
        },
      }
    }
    if (requestedName === 'web_fetch') {
      return {
        toolName: 'web',
        args: {
          action: 'fetch',
          url: rawArgs.url,
        },
      }
    }
    if (requestedName === 'delegate_to_claude_code') {
      return { toolName: 'delegate', args: { ...rawArgs, backend: 'claude' } }
    }
    if (requestedName === 'delegate_to_codex_cli') {
      return { toolName: 'delegate', args: { ...rawArgs, backend: 'codex' } }
    }
    if (requestedName === 'delegate_to_opencode_cli') {
      return { toolName: 'delegate', args: { ...rawArgs, backend: 'opencode' } }
    }
    if (requestedName === 'delegate_to_gemini_cli') {
      return { toolName: 'delegate', args: { ...rawArgs, backend: 'gemini' } }
    }

    const managePrefix = 'manage_'
    if (requestedName.startsWith(managePrefix) && requestedName !== 'manage_platform') {
      const resource = requestedName.slice(managePrefix.length)
      if (resource) {
        const { action, id, data, ...rest } = rawArgs
        return {
          toolName: 'manage_platform',
          args: { resource, action, id, data, ...rest },
        }
      }
    }

    return { toolName: requestedName, args: rawArgs }
  }

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
    const { tools, cleanup } = await buildSessionTools(session.cwd, sessionForRun.plugins || sessionForRun.tools || [], {
      agentId: session.agentId || null,
      sessionId,
      platformAssignScope: agent?.platformAssignScope || 'self',
      mcpServerIds: agent?.mcpServerIds,
      mcpDisabledTools: agent?.mcpDisabledTools,
    })
    try {
      const translated = translateToolInvocation(toolName, args)
      const selectedTool = tools.find((t) => t?.name === translated.toolName) as StructuredToolInterface | undefined
      if (!selectedTool?.invoke) return false
      const toolInput = JSON.stringify(translated.args)
      emit({ t: 'tool_call', toolName, toolInput })
      const toolOutput = await selectedTool.invoke(translated.args)
      const outputText = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
      emit({ t: 'tool_result', toolName, toolOutput: outputText })
      // Don't overwrite fullResponse with raw tool output — it's already captured
      // in toolEvents. Only set a brief notice when the LLM produced no text,
      // so the message bubble isn't empty.
      if (!fullResponse.trim() && outputText?.trim()) {
        const label = toolName.replace(/_/g, ' ')
        fullResponse = `Used **${label}** — see tool output above for details.`
      }
      calledNames.add(toolName)
      return true
    } catch (forceErr: unknown) {
      emit({ t: 'err', text: `${failurePrefix}: ${forceErr instanceof Error ? forceErr.message : String(forceErr)}` })
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

  const forcedDelegationTools: DelegateTool[] = [
    'delegate_to_claude_code',
    'delegate_to_codex_cli',
    'delegate_to_opencode_cli',
    'delegate_to_gemini_cli',
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

  if (
    canAutoRouteWithTools
    && calledNames.size === 0
    && hasToolEnabled(sessionForRun, 'memory')
    && isMemoryListIntent(message)
  ) {
    await invokeSessionTool(
      'memory_tool',
      { action: 'list', key: '', scope: 'auto' },
      'Auto memory listing failed',
    )
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
  const textForPersistence = stripMainLoopMetaForPersistence(finalText)

  // Emit status SSE event from [MAIN_LOOP_META] if present
  if (internal && finalText) {
    const metaMatch = finalText.match(/\[MAIN_LOOP_META\]\s*(\{[^\n]*\})/i)
    if (metaMatch) {
      try {
        const meta = JSON.parse(metaMatch[1])
        const statusPayload: Record<string, string | undefined> = {}
        if (meta.goal) statusPayload.goal = String(meta.goal)
        if (meta.status) statusPayload.status = String(meta.status)
        if (meta.summary) statusPayload.summary = String(meta.summary)
        if (meta.next_action) statusPayload.nextAction = String(meta.next_action)
        if (Object.keys(statusPayload).length > 0) {
          emit({ t: 'status', text: JSON.stringify(statusPayload) })
        }
      } catch {
        // ignore malformed meta JSON
      }
    }
  }

  // HEARTBEAT_OK suppression
  const heartbeatConfig = input.heartbeatConfig
  let heartbeatClassification: 'suppress' | 'strip' | 'keep' | null = null
  if (isHeartbeatRun && textForPersistence.length > 0) {
    heartbeatClassification = classifyHeartbeatResponse(textForPersistence, heartbeatConfig?.ackMaxChars ?? 300, toolEvents.length > 0)

    // Deduplication logic from OpenClaw (nagging prevention)
    // If the model repeats itself exactly within 24h, suppress the heartbeat alert.
    if (heartbeatClassification !== 'suppress' && !toolEvents.length) {
      const prevText = session.lastHeartbeatText || ''
      const prevSentAt = session.lastHeartbeatSentAt || 0
      const isDuplicate = prevText.trim() === textForPersistence.trim()
        && (Date.now() - prevSentAt) < 24 * 60 * 60 * 1000
      if (isDuplicate) {
        heartbeatClassification = 'suppress'
      }
    }
  }

  // Emit WS notification for every heartbeat completion so UI can show pulse
  if (isHeartbeatRun && session.agentId) {
    notify(`heartbeat:agent:${session.agentId}`)
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
      if ((current as Record<string, unknown>)[key] !== normalized) {
        ;(current as Record<string, unknown>)[key] = normalized
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
      const sr = sourceResume as Record<string, unknown>
      const cr = currentResume as Record<string, unknown>
      const nextResume = {
        claudeCode: normalizeResumeId(sr.claudeCode ?? cr.claudeCode),
        codex: normalizeResumeId(sr.codex ?? cr.codex),
        opencode: normalizeResumeId(sr.opencode ?? cr.opencode),
      }
      if (JSON.stringify(currentResume) !== JSON.stringify(nextResume)) {
        current.delegateResumeIds = nextResume
        changed = true
      }
    }

    if (shouldPersistAssistant) {
      const persistedKind = internal && source === 'heartbeat' ? 'heartbeat' : 'chat'
      const persistedText = heartbeatClassification === 'strip'
        ? textForPersistence.replace(/HEARTBEAT_OK/gi, '').trim()
        : textForPersistence
      const nowTs = Date.now()
      const nextAssistantMessage: Message = {
        role: 'assistant',
        text: persistedText,
        time: nowTs,
        thinking: thinkingText || undefined,
        toolEvents: toolEvents.length ? toolEvents : undefined,
        kind: persistedKind,
      }
      const previous = current.messages.at(-1)
      if (previous?.streaming || shouldReplaceRecentAssistantMessage({
        previous,
        nextToolEvents: toolEvents,
        nextKind: persistedKind,
        now: nowTs,
      })) {
        current.messages[current.messages.length - 1] = nextAssistantMessage
      } else {
        current.messages.push(nextAssistantMessage)
      }
      if (isHeartbeatRun) {
        current.lastHeartbeatText = persistedText
        current.lastHeartbeatSentAt = nowTs
      }
      changed = true

      // Conversation tone detection
      if (!internal) {
        const tone = estimateConversationTone(persistedText)
        if (tone !== current.conversationTone) {
          current.conversationTone = tone
        }
      }

      // Target routing for non-suppressed heartbeat alerts
      if (isHeartbeatRun && heartbeatConfig?.target && heartbeatConfig.target !== 'none' && heartbeatConfig.showAlerts !== false) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { listRunningConnectors, sendConnectorMessage } = require('./connectors/manager')
          let connectorId: string | undefined
          let channelId: string | undefined
          if (heartbeatConfig.target === 'last') {
            const running = listRunningConnectors()
            const first = running.find((c: { recentChannelId?: string }) => c.recentChannelId)
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

      // Auto-discover connectors linked to this agent when no explicit target is set
      if (isHeartbeatRun && !heartbeatConfig?.target && heartbeatConfig?.showAlerts !== false && session.agentId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { listRunningConnectors: listRunning, sendConnectorMessage: sendMsg } = require('./connectors/manager')
          const agentConnectors = listRunning().filter((c: { agentId: string | null; recentChannelId: string | null; supportsSend: boolean }) =>
            c.agentId === session.agentId && c.recentChannelId && c.supportsSend
          )
          for (const conn of agentConnectors) {
            sendMsg({ connectorId: conn.id, channelId: conn.recentChannelId, text: persistedText }).catch(() => {})
          }
        } catch {
          // Best effort — connector manager may not be loaded
        }
      }
    }

    // Fire afterChatTurn hook for all enabled plugins (memory auto-save, logging, etc.)
    try {
      await getPluginManager().runHook('afterChatTurn', {
        session: current,
        message,
        response: textForPersistence,
        source,
        internal,
      })
    } catch { /* afterChatTurn hooks are non-critical */ }

    // Don't extend idle timeout for heartbeat runs — only user-initiated activity counts
    if (source !== 'heartbeat' && source !== 'heartbeat-wake' && source !== 'main-loop-followup') {
      current.lastActiveAt = Date.now()
    }
    fresh[sessionId] = current
    saveSessions(fresh)
    notify(`messages:${sessionId}`)
  }

  return {
    runId,
    sessionId,
    text: finalText,
    persisted: shouldPersistAssistant,
    toolEvents,
    error: errorMessage,
    inputTokens: accumulatedUsage.inputTokens || undefined,
    outputTokens: accumulatedUsage.outputTokens || undefined,
    estimatedCost: accumulatedUsage.estimatedCost || undefined,
  }
}
