import fs from 'fs'
import path from 'path'
import type { Message, MessageToolEvent } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { getUsageSpendSince } from '@/lib/server/storage'
import { pluginIdMatches } from '@/lib/server/tool-aliases'
import { buildToolEventAssistantSummary } from '@/lib/chat/tool-event-summary'
import { looksLikePositiveConnectorDeliveryText } from '@/lib/server/chat-execution/chat-execution-connector-delivery'
import { hasOnlySuccessfulMemoryMutationToolEvents } from '@/lib/server/chat-execution/memory-mutation-tools'
import { getEnabledCapabilityIds } from '@/lib/capability-selection'

export interface SessionWithTools {
  tools?: string[] | null
  extensions?: string[] | null
}

export type DelegateTool =
  | 'delegate_to_claude_code'
  | 'delegate_to_codex_cli'
  | 'delegate_to_opencode_cli'
  | 'delegate_to_gemini_cli'

export function applyContextClearBoundary(messages: Message[]): Message[] {
  const filterModelHistory = (items: Message[]) => items.filter((message) => message.historyExcluded !== true)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].kind === 'context-clear') return filterModelHistory(messages.slice(i + 1))
  }
  return filterModelHistory(messages)
}

export function shouldApplySessionFreshnessReset(source: string): boolean {
  return source !== 'eval'
}

export function shouldAutoRouteHeartbeatAlerts(config?: {
  showAlerts?: boolean
  deliveryMode?: 'default' | 'tool_only' | 'silent'
} | null): boolean {
  if (config?.showAlerts === false) return false
  return config?.deliveryMode !== 'tool_only' && config?.deliveryMode !== 'silent'
}

export function shouldPersistInboundUserMessage(internal: boolean, source: string): boolean {
  if (!internal) return true
  return source === 'eval' || source === 'subagent'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasExplicitToolMention(message: string, toolName: string): boolean {
  const escaped = escapeRegExp(toolName)
  const negated = new RegExp(`\\b(?:do not|don't|dont|avoid|skip|without|never)\\s+(?:use\\s+|call\\s+|invoke\\s+)?(?:the\\s+)?\`?${escaped}\`?(?:\\s+tool)?\\b`, 'i')
  if (negated.test(message)) return false
  const boundary = new RegExp(`(^|[^a-z0-9_])\`?${escaped}\`?([^a-z0-9_]|$)`, 'i')
  return boundary.test(message)
}

function hasExplicitGenericToolRequest(message: string, toolName: string): boolean {
  const escaped = escapeRegExp(toolName)
  const negated = new RegExp(`\\b(?:do not|don't|dont|avoid|skip|without|never)\\s+(?:use\\s+|call\\s+|invoke\\s+)?(?:the\\s+)?${escaped}(?:\\s+tool)?\\b`, 'i')
  if (negated.test(message)) return false
  return new RegExp(`(^|[\\s(])\`${escaped}\`([\\s).,!?]|$)|\\b${escaped}\\s+tool\\b|\\buse\\s+(?:the\\s+)?${escaped}\\b|\\bcall\\s+(?:the\\s+)?${escaped}\\b|\\binvoke\\s+(?:the\\s+)?${escaped}\\b`, 'i').test(message)
}

const MANAGE_PLATFORM_RESOURCE_TO_TOOL: Record<string, string> = {
  agent: 'manage_agents',
  agents: 'manage_agents',
  project: 'manage_projects',
  projects: 'manage_projects',
  task: 'manage_tasks',
  tasks: 'manage_tasks',
  schedule: 'manage_schedules',
  schedules: 'manage_schedules',
  skill: 'manage_skills',
  skills: 'manage_skills',
  document: 'manage_documents',
  documents: 'manage_documents',
  secret: 'manage_secrets',
  secrets: 'manage_secrets',
  connector: 'manage_connectors',
  connectors: 'manage_connectors',
  session: 'manage_sessions',
  sessions: 'manage_sessions',
}

export function translateRequestedToolInvocation(
  requestedName: string,
  rawArgs: Record<string, unknown>,
  messageFallback: string,
  availableToolNames?: Iterable<string>,
): { toolName: string; args: Record<string, unknown> } {
  const available = new Set(availableToolNames || [])

  if (requestedName === 'web_search') {
    return {
      toolName: 'web',
      args: {
        action: 'search',
        query: typeof rawArgs.query === 'string' ? rawArgs.query : messageFallback.trim(),
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
  if (requestedName === 'manage_platform') {
    const resource = typeof rawArgs.resource === 'string'
      ? rawArgs.resource.trim().toLowerCase()
      : ''
    const specificTool = MANAGE_PLATFORM_RESOURCE_TO_TOOL[resource]
    if (specificTool && available.has(specificTool) && !available.has('manage_platform')) {
      return { toolName: specificTool, args: rawArgs }
    }
    return { toolName: requestedName, args: rawArgs }
  }

  if (requestedName.startsWith(managePrefix) && requestedName !== 'manage_platform') {
    if (!available.has(requestedName) && available.has('manage_platform')) {
      const resource = requestedName.slice(managePrefix.length)
      if (resource) {
        const { action, id, data, ...rest } = rawArgs
        const nextArgs: Record<string, unknown> = { resource, ...rest }
        if (action !== undefined) nextArgs.action = action
        if (id !== undefined) nextArgs.id = id
        if (data !== undefined) nextArgs.data = data
        return {
          toolName: 'manage_platform',
          args: nextArgs,
        }
      }
    }
    return { toolName: requestedName, args: rawArgs }
  }

  return { toolName: requestedName, args: rawArgs }
}

function normalizeWorkspaceSandboxLinks(text: string, cwd: string): string {
  return text.replace(/\[([^\]]+)\]\(sandbox:\/workspace\/([^)]+)\)/g, (raw, label: string, relativePath: string) => {
    const normalized = String(relativePath || '').replace(/^\/+/, '')
    if (!normalized) return raw
    const resolvedCwd = path.resolve(cwd)
    const resolved = path.resolve(resolvedCwd, normalized)
    if (!resolved.startsWith(resolvedCwd)) return raw
    if (!fs.existsSync(resolved)) return raw
    return `[${label}](/api/files/serve?path=${encodeURIComponent(resolved)})`
  })
}

function normalizeAbsoluteFileMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (raw, label: string, target: string) => {
    if (!path.isAbsolute(target)) return raw
    const resolved = path.resolve(target)
    if (!fs.existsSync(resolved)) return raw
    return `[${label}](/api/files/serve?path=${encodeURIComponent(resolved)})`
  })
}

export function normalizeAssistantArtifactLinks(text: string, cwd: string): string {
  const uploadsNormalized = text.replace(/sandbox:\/api\/uploads\//g, '/api/uploads/')
  const workspaceNormalized = normalizeWorkspaceSandboxLinks(uploadsNormalized, cwd)
  return normalizeAbsoluteFileMarkdownLinks(workspaceNormalized)
}

export function extractHeartbeatStatus(text: string): { goal?: string; status?: string; summary?: string; nextAction?: string } | null {
  const match = text.match(/\[AGENT_HEARTBEAT_META\]\s*(\{[^\n]*\})/i)
  if (!match) return null
  try {
    const meta = JSON.parse(match[1]) as Record<string, unknown>
    const payload: { goal?: string; status?: string; summary?: string; nextAction?: string } = {}
    if (typeof meta.goal === 'string' && meta.goal.trim()) payload.goal = meta.goal.trim()
    if (typeof meta.status === 'string' && meta.status.trim()) payload.status = meta.status.trim()
    if (typeof meta.summary === 'string' && meta.summary.trim()) payload.summary = meta.summary.trim()
    if (typeof meta.next_action === 'string' && meta.next_action.trim()) payload.nextAction = meta.next_action.trim()
    return Object.keys(payload).length > 0 ? payload : null
  } catch {
    return null
  }
}

export function shouldReplaceRecentAssistantMessage(params: {
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

function isEligibleRecentAssistantComparison(params: {
  previous: Message | null | undefined
  nextKind: Message['kind']
  now: number
}): params is { previous: Message; nextKind: Message['kind']; now: number } {
  const { previous, nextKind, now } = params
  if (!previous || previous.role !== 'assistant') return false
  if (previous.kind && nextKind && previous.kind !== nextKind) return false
  return !(typeof previous.time === 'number' && now - previous.time > 90_000)
}

export function shouldReplaceRecentConnectorFollowupMessage(params: {
  previous: Message | null | undefined
  nextText: string
  nextToolEvents: MessageToolEvent[]
  nextKind: Message['kind']
  now: number
}): boolean {
  if (!isEligibleRecentAssistantComparison(params)) return false
  const { previous, nextText, nextToolEvents } = params
  const previousToolEvents = Array.isArray(previous.toolEvents) ? previous.toolEvents : []
  if (previousToolEvents.length !== 0 || nextToolEvents.length !== 0) return false
  return looksLikePositiveConnectorDeliveryText(previous.text || '', { requireConnectorContext: true })
    && looksLikePositiveConnectorDeliveryText(nextText || '', { requireConnectorContext: true })
}

export function shouldSuppressRedundantConnectorDeliveryFollowup(params: {
  previous: Message | null | undefined
  nextText: string
  nextToolEvents: MessageToolEvent[]
  nextKind: Message['kind']
  now: number
}): boolean {
  if (!isEligibleRecentAssistantComparison(params)) return false
  const { previous, nextText, nextToolEvents } = params
  const previousToolEvents = Array.isArray(previous.toolEvents) ? previous.toolEvents : []
  if (previousToolEvents.length === 0 || nextToolEvents.length !== 0) return false
  return looksLikePositiveConnectorDeliveryText(previous.text || '')
    && looksLikePositiveConnectorDeliveryText(nextText || '', { requireConnectorContext: true })
}

export function hasPersistableAssistantPayload(text: string, thinking: string, toolEvents: MessageToolEvent[]): boolean {
  if (!text.trim() && !thinking.trim() && hasOnlySuccessfulMemoryMutationToolEvents(toolEvents)) return false
  return text.trim().length > 0 || thinking.trim().length > 0 || toolEvents.length > 0
}

export function getPersistedAssistantText(text: string, toolEvents: MessageToolEvent[]): string {
  const trimmed = text.trim()
  if (trimmed) return trimmed
  if (hasOnlySuccessfulMemoryMutationToolEvents(toolEvents)) return ''
  return buildToolEventAssistantSummary(toolEvents)
}

export function getToolEventsSnapshotKey(toolEvents: MessageToolEvent[]): string {
  return JSON.stringify(toolEvents.map((event) => [
    event.name,
    event.input,
    event.output || '',
    event.error === true,
    event.toolCallId || '',
  ]))
}

export function requestedToolNamesFromMessage(message: string): string[] {
  const explicitCandidates = [
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
    'memory_search',
    'memory_get',
    'memory_store',
    'memory_update',
    'wallet_tool',
    'http_request',
    'send_file',
    'sandbox_exec',
    'sandbox_list_runtimes',
    'schedule_wake',
    'spawn_subagent',
    'ask_human',
    'context_status',
    'context_summarize',
    'openclaw_nodes',
    'openclaw_workspace',
  ]
  const genericCandidates = [
    'browser',
    'web',
    'shell',
    'files',
    'edit_file',
    'git',
    'canvas',
    'mailbox',
    'document',
    'extract',
    'table',
    'crawl',
    'email',
  ]
  const requested = explicitCandidates.filter((name) => hasExplicitToolMention(message, name))
  for (const name of genericCandidates) {
    if (hasExplicitGenericToolRequest(message, name)) requested.push(name)
  }
  if (hasExplicitGenericToolRequest(message, 'delegate')) {
    requested.push('delegate')
  }
  return dedup(requested)
}

export function hasToolEnabled(session: SessionWithTools, toolName: string): boolean {
  return pluginIdMatches(getEnabledCapabilityIds(session), toolName)
}

export function enabledDelegationTools(session: SessionWithTools): DelegateTool[] {
  const tools: DelegateTool[] = []
  if (hasToolEnabled(session, 'claude_code') || hasToolEnabled(session, 'delegate')) tools.push('delegate_to_claude_code')
  if (hasToolEnabled(session, 'codex_cli')) tools.push('delegate_to_codex_cli')
  if (hasToolEnabled(session, 'opencode_cli')) tools.push('delegate_to_opencode_cli')
  if (hasToolEnabled(session, 'gemini_cli')) tools.push('delegate_to_gemini_cli')
  return tools
}

export function hasDirectLocalCodingTools(session: SessionWithTools): boolean {
  return [
    'shell',
    'execute_command',
    'files',
    'edit_file',
    'openclaw_workspace',
    'sandbox',
  ].some((toolName) => hasToolEnabled(session, toolName))
}

export function parseUsdLimit(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.max(0.01, Math.min(1_000_000, parsed))
}

export function getTodaySpendUsd(): number {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  return getUsageSpendSince(dayStart.getTime())
}

export function findFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')]+/i)
  return match?.[0] || null
}

export function isMemoryListIntent(message: string): boolean {
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

export function extractDelegationTask(message: string, toolName: string): string | null {
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
    const match = message.match(re)
    const task = (match?.[1] || '').trim()
    if (task) return task
  }
  return null
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

export function extractConnectorMessageArgs(message: string): {
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
    const match = message.match(new RegExp(`${key}\\s*=\\s*(\"([^\"]*)\"|'([^']*)')`, 'i'))
    return (match?.[2] || match?.[3] || '').trim() || undefined
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

export function stripMarkupForHeartbeat(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/^[*`~_]+/, '')
    .replace(/[*`~_]+$/, '')
    .trim()
}

const HEARTBEAT_OK_RE = /HEARTBEAT_OK[^\w]{0,4}$/
const NO_MESSAGE_RE = /NO_MESSAGE[^\w]{0,4}$/

export function classifyHeartbeatResponse(text: string, ackMaxChars: number, hadToolCalls: boolean): 'suppress' | 'strip' | 'keep' {
  const cleaned = stripMarkupForHeartbeat(text)
  if (cleaned === 'HEARTBEAT_OK' || cleaned === 'NO_MESSAGE') return 'suppress'
  if (HEARTBEAT_OK_RE.test(cleaned) || NO_MESSAGE_RE.test(cleaned)) return 'suppress'
  const stripped = cleaned.replace(/HEARTBEAT_OK/gi, '').replace(/NO_MESSAGE/gi, '').trim()
  if (!stripped) return 'suppress'
  if (!hadToolCalls && stripped.length <= ackMaxChars) return 'suppress'
  return stripped.length < cleaned.length ? 'strip' : 'keep'
}

/**
 * Prune old heartbeat messages from the transcript to prevent context bloat.
 * Keeps only the most recent `maxKeep` heartbeat assistant messages.
 * Returns the number of messages removed.
 */
export function pruneOldHeartbeatMessages(messages: Message[], maxKeep = 2): number {
  const heartbeatIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i].kind === 'heartbeat') {
      heartbeatIndices.push(i)
    }
  }
  if (heartbeatIndices.length <= maxKeep) return 0
  const toRemove = new Set(heartbeatIndices.slice(0, heartbeatIndices.length - maxKeep))
  let removed = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (toRemove.has(i)) {
      messages.splice(i, 1)
      removed++
    }
  }
  return removed
}

export function estimateConversationTone(text: string): string {
  const t = text || ''
  if (/```/.test(t) || /\b(function|const|let|var|import|export|class|interface|async|await|return)\b/.test(t)) return 'technical'
  if (/\b(error|bug|debug|stack trace|exception|null|undefined|TypeError)\b/i.test(t)) return 'technical'
  if (/\b(understand|feel|sorry|empathize|appreciate|grateful|tough|difficult|challenging)\b/i.test(t)) return 'empathetic'
  if (/\b(furthermore|regarding|consequently|therefore|henceforth|pursuant|accordingly|notwithstanding)\b/i.test(t)) return 'formal'
  if (/\b(gonna|wanna|gotta|yeah|hey|awesome|cool|lol|btw|tbh)\b/i.test(t) || /!{2,}/.test(t)) return 'casual'
  return 'neutral'
}
