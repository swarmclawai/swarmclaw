import { genId } from '@/lib/id'
import {
  loadConnectors, saveConnectors, loadSessions, saveSessions,
  loadAgents, loadCredentials, decryptKey, loadSettings, loadSkills,
  loadChatrooms, saveChatrooms,
  upsertConnectorHealthEvent,
} from '../storage'
import type { ConnectorHealthEventType } from '@/types'
import { WORKSPACE_DIR } from '../data-dir'
import { UPLOAD_DIR } from '../storage'
import fs from 'fs'
import path from 'path'
import { streamAgentChat } from '../stream-agent-chat'
import { notify } from '../ws-hub'
import { logExecution } from '../execution-log'
import { enqueueSystemEvent } from '../system-events'
import { requestHeartbeatNow } from '../heartbeat-wake'
import { buildCurrentDateTimePromptContext } from '../prompt-runtime-context'
import {
  parseMentions,
  compactChatroomMessages,
  buildChatroomSystemPrompt,
  ensureSyntheticSession,
  buildAgentSystemPromptForChatroom,
  buildHistoryForAgent,
  resolveApiKey as resolveApiKeyHelper,
} from '../chatroom-helpers'
import { filterHealthyChatroomAgents } from '../chatroom-health'
import { evaluateRoutingRules } from '../chatroom-routing'
import { markProviderFailure, markProviderSuccess } from '../provider-health'
import { syncSessionArchiveMemory } from '../session-archive-memory'
import { buildIdentityContinuityContext } from '../identity-continuity'
import { getProvider } from '@/lib/providers'
import type { Agent, Connector, MessageSource, Chatroom, ChatroomMessage, Session } from '@/types'
import type { ConnectorInstance, InboundMessage, InboundMedia } from './types'
import {
  addAllowedSender,
  approvePairingCode,
  createOrTouchPairingRequest,
  isSenderAllowed,
  listPendingPairingRequests,
  listStoredAllowedSenders,
  parseAllowFromCsv,
  parsePairingPolicy,
  type PairingPolicy,
} from './pairing'
import { enrichInboundMessageWithAudioTranscript } from './inbound-audio-transcription'
import {
  buildConnectorConversationKey,
  buildConnectorDoctorWarnings,
  buildInboundDebounceKey,
  buildInboundDedupeKey,
  getConnectorSessionStaleness,
  isReplyToLastOutbound,
  mergeInboundMessages,
  resetConnectorSessionRuntime,
  resolveConnectorSessionPolicy,
  shouldReplyToInboundMessage,
  textMentionsAlias,
} from './policy'
import { buildConnectorThreadContextBlock, resolveThreadPersonaLabel } from './thread-context'

function resolveUploadPathFromUrl(rawUrl: string): string | null {
  if (!rawUrl) return null
  const normalized = rawUrl.trim()
  const match = normalized.match(/\/api\/uploads\/([^?#)\s]+)/)
  if (!match) return null
  let decoded: string
  try { decoded = decodeURIComponent(match[1]) } catch { decoded = match[1] }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safeName) return null
  const filePath = path.join(UPLOAD_DIR, safeName)
  return fs.existsSync(filePath) ? filePath : null
}

function uploadApiUrlFromPath(filePath: string): string | null {
  const rel = path.relative(UPLOAD_DIR, filePath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const fileName = path.basename(rel)
  return `/api/uploads/${encodeURIComponent(fileName)}`
}

function parseSseDataEvents(raw: string): Array<Record<string, unknown>> {
  if (!raw) return []
  const events: Array<Record<string, unknown>> = []
  const lines = raw.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      const parsed = JSON.parse(line.slice(6).trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>)
      }
    } catch { /* ignore malformed event lines */ }
  }
  return events
}

function parseConnectorToolResult(toolOutput: string): { status?: string; to?: string; followUpId?: string; messageId?: string } | null {
  const raw = toolOutput.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const status = typeof record.status === 'string' ? String(record.status) : undefined
    const to = typeof record.to === 'string' ? String(record.to) : undefined
    const followUpId = typeof record.followUpId === 'string' ? String(record.followUpId) : undefined
    const messageId = typeof record.messageId === 'string' ? String(record.messageId) : undefined
    return { status, to, followUpId, messageId }
  } catch {
    return null
  }
}

function canonicalUploadMediaKey(filePath: string): string {
  const base = path.basename(filePath)
  const ext = path.extname(base).toLowerCase()
  const normalized = base
    .replace(/^\d{10,16}-/, '')
    .replace(/^(?:browser|screenshot)-\d{10,16}(?:-\d+)?\./, `playwright-capture.`)
    .toLowerCase()
  return normalized || `unknown${ext}`
}

function shouldAllowMultipleMediaSends(userText: string): boolean {
  const text = (userText || '').toLowerCase()
  return /\b(all|both|multiple|several|many|every|each|two|three|4|four|screenshots|images|photos|files|documents)\b/.test(text)
}

function preferSingleBestMediaFile(files: Array<{ path: string; alt: string }>): Array<{ path: string; alt: string }> {
  if (files.length <= 1) return files
  const ranked = [...files].sort((a, b) => {
    const score = (entry: { path: string }) => {
      const base = path.basename(entry.path).toLowerCase()
      let value = 0
      if (/^\d{10,16}-/.test(base)) value += 20
      if (!base.startsWith('browser-') && !base.startsWith('screenshot-')) value += 10
      if (base.endsWith('.pdf')) value += 8
      if (base.endsWith('.png') || base.endsWith('.jpg') || base.endsWith('.jpeg') || base.endsWith('.webp')) value += 6
      try {
        const stat = fs.statSync(entry.path)
        value += Math.min(5, Math.round((stat.mtimeMs % 10_000) / 2_000))
      } catch { /* ignore stat errors */ }
      return value
    }
    return score(b) - score(a)
  })
  return [ranked[0]]
}

export function selectOutboundMediaFiles(
  files: Array<{ path: string; alt: string }>,
  userText: string,
): Array<{ path: string; alt: string }> {
  if (files.length === 0) return []
  const mergedFiles: Array<{ path: string; alt: string }> = []
  const seenMediaKeys = new Set<string>()
  for (const candidate of files) {
    const mediaKey = canonicalUploadMediaKey(candidate.path)
    if (seenMediaKeys.has(mediaKey)) continue
    seenMediaKeys.add(mediaKey)
    mergedFiles.push(candidate)
  }
  return shouldAllowMultipleMediaSends(userText || '')
    ? mergedFiles
    : preferSingleBestMediaFile(mergedFiles)
}

/**
 * Extract embedded media references from agent response text.
 * Supports markdown images/links and bare upload URLs.
 */
export function extractEmbeddedMedia(text: string): { cleanText: string; files: Array<{ path: string; alt: string }> } {
  const files: Array<{ path: string; alt: string }> = []
  const seen = new Set<string>()
  let cleanText = text

  const pushFile = (filePath: string, alt: string) => {
    if (!filePath || seen.has(filePath)) return
    seen.add(filePath)
    files.push({ path: filePath, alt: alt.trim() })
  }

  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  cleanText = cleanText.replace(imageRegex, (full, altRaw, urlRaw) => {
    const filePath = resolveUploadPathFromUrl(String(urlRaw || ''))
    if (!filePath) return full
    pushFile(filePath, String(altRaw || ''))
    return ''
  })

  const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g
  cleanText = cleanText.replace(linkRegex, (full, altRaw, urlRaw) => {
    const filePath = resolveUploadPathFromUrl(String(urlRaw || ''))
    if (!filePath) return full
    pushFile(filePath, String(altRaw || ''))
    return ''
  })

  const bareUploadUrlRegex = /(?:https?:\/\/[^\s)]+)?\/api\/uploads\/[^\s)\]]+/g
  cleanText = cleanText.replace(bareUploadUrlRegex, (full) => {
    const filePath = resolveUploadPathFromUrl(full)
    if (!filePath) return full
    pushFile(filePath, '')
    return ''
  })

  if (files.length === 0) return { cleanText: text, files }
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim()
  return { cleanText, files }
}

function buildInboundAttachmentPaths(msg: InboundMessage): string[] {
  if (!Array.isArray(msg.media) || msg.media.length === 0) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const media of msg.media) {
    const localPath = typeof media.localPath === 'string' ? media.localPath.trim() : ''
    if (!localPath || seen.has(localPath)) continue
    if (!fs.existsSync(localPath)) continue
    seen.add(localPath)
    paths.push(localPath)
  }
  return paths
}

function normalizeWhatsappTarget(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  if (trimmed.includes('@')) return trimmed
  let cleaned = trimmed.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
  if (cleaned.startsWith('0') && cleaned.length >= 10) {
    cleaned = `44${cleaned.slice(1)}`
  }
  cleaned = cleaned.replace(/[^\d]/g, '')
  return cleaned ? `${cleaned}@s.whatsapp.net` : trimmed
}

function connectorSupportsBinaryMedia(platform: string): boolean {
  return platform === 'whatsapp'
    || platform === 'telegram'
    || platform === 'slack'
    || platform === 'discord'
    || platform === 'openclaw'
}

/** Sentinel value agents return when no outbound reply should be sent */
export const NO_MESSAGE_SENTINEL = 'NO_MESSAGE'

/** Check if an agent response is the NO_MESSAGE sentinel (case-insensitive, trimmed) */
export function isNoMessage(text: string): boolean {
  return text.trim().toUpperCase() === NO_MESSAGE_SENTINEL
}

/** Map of running connector instances by connector ID.
 *  Stored on globalThis to survive HMR reloads in dev mode —
 *  prevents duplicate sockets fighting for the same WhatsApp session. */
const globalKey = '__swarmclaw_running_connectors__' as const
const g = globalThis as typeof globalThis & Record<string, unknown>

function getOrInitGlobalValue<T>(key: string, factory: () => T): T {
  const existing = g[key]
  if (existing !== undefined) return existing as T
  const created = factory()
  g[key] = created
  return created
}

type ConnectorSession = Session
type ConnectorAgent = Agent

const running: Map<string, ConnectorInstance> =
  getOrInitGlobalValue(globalKey, () => new Map<string, ConnectorInstance>())

/** Most recent inbound channel per connector (used for proactive replies/default outbound target) */
const lastInboundKey = '__swarmclaw_connector_last_inbound__' as const
const lastInboundChannelByConnector: Map<string, string> =
  getOrInitGlobalValue(lastInboundKey, () => new Map<string, string>())

/** Last inbound message timestamp per connector (for presence indicators) */
const lastInboundTimeKey = '__swarmclaw_connector_last_inbound_time__' as const
const lastInboundTimeByConnector: Map<string, number> =
  getOrInitGlobalValue(lastInboundTimeKey, () => new Map<string, number>())

/** Per-connector lock to prevent concurrent start/stop operations */
const lockKey = '__swarmclaw_connector_locks__' as const
const locks: Map<string, Promise<void>> =
  getOrInitGlobalValue(lockKey, () => new Map<string, Promise<void>>())

/** Generation counter per connector — used to detect stale lifecycle events after restart */
const genCounterKey = '__swarmclaw_connector_gen__' as const
const generationCounter: Map<string, number> =
  getOrInitGlobalValue(genCounterKey, () => new Map<string, number>())

type ScheduledConnectorFollowup = {
  id: string
  connectorId?: string
  platform?: string
  channelId: string
  sendAt: number
  timer: ReturnType<typeof setTimeout>
}

const followupKey = '__swarmclaw_connector_followups__' as const
const scheduledFollowups: Map<string, ScheduledConnectorFollowup> =
  getOrInitGlobalValue(followupKey, () => new Map<string, ScheduledConnectorFollowup>())

const inboundDedupeKey = '__swarmclaw_connector_inbound_dedupe__' as const
const recentInboundByKey: Map<string, number> =
  getOrInitGlobalValue(inboundDedupeKey, () => new Map<string, number>())

type DebouncedInboundEntry = {
  connector: Connector
  messages: InboundMessage[]
  timer: ReturnType<typeof setTimeout>
}

const inboundDebounceKey = '__swarmclaw_connector_inbound_debounce__' as const
const pendingInboundDebounce: Map<string, DebouncedInboundEntry> =
  getOrInitGlobalValue(inboundDebounceKey, () => new Map<string, DebouncedInboundEntry>())

const followupDedupeKey = '__swarmclaw_connector_followup_dedupe__' as const
const scheduledFollowupByDedupe: Map<string, { id: string; sendAt: number }> =
  getOrInitGlobalValue(followupDedupeKey, () => new Map<string, { id: string; sendAt: number }>())

/** Reconnect state per connector — tracks backoff and retry attempts for crash recovery */
export interface ConnectorReconnectState {
  attempts: number
  lastAttemptAt: number
  nextRetryAt: number
  backoffMs: number
  error: string
  exhausted: boolean
}

const reconnectStateKey = '__swarmclaw_connector_reconnect_state__' as const
const reconnectState: Map<string, ConnectorReconnectState> =
  getOrInitGlobalValue(reconnectStateKey, () => new Map<string, ConnectorReconnectState>())

const RECONNECT_INITIAL_BACKOFF_MS = 1_000
const RECONNECT_MAX_BACKOFF_MS = 5 * 60 * 1_000
const RECONNECT_MAX_ATTEMPTS = 10

interface ConnectorReconnectPolicy {
  initialBackoffMs?: number
  maxBackoffMs?: number
  maxAttempts?: number
}

export function createConnectorReconnectState(
  init: Partial<ConnectorReconnectState> = {},
  policy: ConnectorReconnectPolicy = {},
): ConnectorReconnectState {
  return {
    attempts: init.attempts ?? 0,
    lastAttemptAt: init.lastAttemptAt ?? 0,
    nextRetryAt: init.nextRetryAt ?? 0,
    backoffMs: init.backoffMs ?? policy.initialBackoffMs ?? RECONNECT_INITIAL_BACKOFF_MS,
    error: init.error ?? '',
    exhausted: init.exhausted ?? false,
  }
}

export function advanceConnectorReconnectState(
  previous: ConnectorReconnectState,
  error: string,
  now = Date.now(),
  policy: ConnectorReconnectPolicy = {},
): ConnectorReconnectState {
  const initialBackoffMs = policy.initialBackoffMs ?? RECONNECT_INITIAL_BACKOFF_MS
  const maxBackoffMs = policy.maxBackoffMs ?? RECONNECT_MAX_BACKOFF_MS
  const maxAttempts = policy.maxAttempts ?? RECONNECT_MAX_ATTEMPTS
  const attempts = previous.attempts + 1
  const backoffMs = Math.min(maxBackoffMs, initialBackoffMs * (2 ** Math.max(0, attempts - 1)))
  return {
    attempts,
    lastAttemptAt: now,
    nextRetryAt: now + backoffMs,
    backoffMs,
    error,
    exhausted: attempts >= maxAttempts,
  }
}

export function clearReconnectState(connectorId: string): void {
  reconnectState.delete(connectorId)
}

export function setReconnectState(connectorId: string, state: ConnectorReconnectState): void {
  reconnectState.set(connectorId, state)
}

/** Record a health event for a connector (persisted to connector_health collection) */
function recordHealthEvent(connectorId: string, event: ConnectorHealthEventType, message?: string): void {
  const id = genId()
  upsertConnectorHealthEvent(id, {
    id,
    connectorId,
    event,
    message: message || undefined,
    timestamp: new Date().toISOString(),
  })
}

function statusReactionForPlatform(platform: string, state: 'processing' | 'sent' | 'silent'): string {
  if (platform === 'slack') {
    if (state === 'processing') return 'eyes'
    if (state === 'sent') return 'white_check_mark'
    return 'zipper_mouth_face'
  }
  if (state === 'processing') return '👀'
  if (state === 'sent') return '✅'
  return '🤐'
}

function pruneTransientConnectorState(now = Date.now()): void {
  for (const [key, seenAt] of recentInboundByKey.entries()) {
    if (now - seenAt > 120_000) recentInboundByKey.delete(key)
  }
  for (const [key, entry] of scheduledFollowupByDedupe.entries()) {
    if (entry.sendAt <= now) scheduledFollowupByDedupe.delete(key)
  }
}

function rememberRecentInbound(key: string, now = Date.now(), ttlMs = 120_000): boolean {
  pruneTransientConnectorState(now)
  const previous = recentInboundByKey.get(key) || 0
  if (previous && now - previous < ttlMs) return false
  recentInboundByKey.set(key, now)
  return true
}

function findDirectSessionForInbound(connector: Connector, msg: InboundMessage): ConnectorSession | null {
  if (connector.chatroomId) return null
  const effectiveAgentId = msg.agentIdOverride || connector.agentId
  const sessions = Object.values(loadSessions() as Record<string, ConnectorSession>)
  const candidates = sessions.filter((session) =>
    session?.agentId === effectiveAgentId
      && session?.connectorContext?.connectorId === connector.id
      && session?.connectorContext?.channelId === msg.channelId,
  )
  if (msg.threadId) {
    const threadExact = candidates.find((session) => session?.connectorContext?.threadId === msg.threadId)
    if (threadExact) return threadExact
  }
  const senderExact = candidates.find((session) => session?.connectorContext?.senderId === msg.senderId)
  if (senderExact) return senderExact
  return candidates[0] || null
}

async function maybeSendStatusReaction(
  connector: Connector,
  msg: InboundMessage,
  state: 'processing' | 'sent' | 'silent',
): Promise<void> {
  if (!msg.messageId) return
  const session = findDirectSessionForInbound(connector, msg)
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (!policy.statusReactions) return
  const instance = running.get(connector.id)
  if (!instance?.sendReaction) return
  try {
    await instance.sendReaction(msg.channelId, msg.messageId, statusReactionForPlatform(connector.platform, state))
  } catch {
    // Ignore reaction failures — connectors vary widely here.
  }
}

function startConnectorTypingLoop(connector: Connector, msg: InboundMessage): (() => void) | null {
  const session = findDirectSessionForInbound(connector, msg)
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (!policy.typingIndicators) return null
  const instance = running.get(connector.id)
  if (!instance?.sendTyping) return null
  const replyOptions = shouldReplyToInboundMessage({ msg, session, policy })

  const sendTyping = () => {
    void instance.sendTyping?.(msg.channelId, { threadId: replyOptions.threadId }).catch(() => {
      // Best effort only.
    })
  }

  sendTyping()
  const timer = setInterval(sendTyping, 4_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

type RouteMessageHandler = (connector: Connector, msg: InboundMessage) => Promise<string>
const routeHandlerKey = '__swarmclaw_connector_route_handler__' as const
const routeMessageHandlerRef: { current: RouteMessageHandler } =
  getOrInitGlobalValue(routeHandlerKey, () => ({ current: async () => '[Error] Connector router unavailable.' }))

async function flushDebouncedInbound(key: string): Promise<void> {
  const entry = pendingInboundDebounce.get(key)
  if (!entry) return
  pendingInboundDebounce.delete(key)
  clearTimeout(entry.timer)
  const merged = mergeInboundMessages(entry.messages)
  const response = await routeMessageHandlerRef.current(entry.connector, merged)
  if (isNoMessage(response)) {
    return
  }
  const replyOptions = getConnectorReplySendOptions({ connectorId: entry.connector.id, inbound: merged })
  const session = findDirectSessionForInbound(entry.connector, merged)
  await sendConnectorMessage({
    connectorId: entry.connector.id,
    channelId: merged.channelId,
    text: response,
    sessionId: session?.id,
    replyToMessageId: replyOptions.replyToMessageId,
    threadId: replyOptions.threadId,
  })
  await maybeSendStatusReaction(entry.connector, merged, 'sent')
}

async function routeOrDebounceInbound(connector: Connector, msg: InboundMessage): Promise<string> {
  const dedupeKey = buildInboundDedupeKey(connector, msg)
  const dedupeTtlMs = dedupeKey.startsWith('msg:') ? 120_000 : 15_000
  if (!rememberRecentInbound(dedupeKey, Date.now(), dedupeTtlMs)) return NO_MESSAGE_SENTINEL

  const session = findDirectSessionForInbound(connector, msg)
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (policy.inboundDebounceMs <= 0) {
    return routeMessageHandlerRef.current(connector, msg)
  }

  const debounceKey = buildInboundDebounceKey(connector, msg)
  const pending = pendingInboundDebounce.get(debounceKey)
  if (pending) {
    pending.messages.push(msg)
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      void flushDebouncedInbound(debounceKey).catch((err: unknown) => {
        console.warn(`[connector] Debounced inbound flush failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, policy.inboundDebounceMs)
    pending.timer.unref?.()
  } else {
    const timer = setTimeout(() => {
      void flushDebouncedInbound(debounceKey).catch((err: unknown) => {
        console.warn(`[connector] Debounced inbound flush failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, policy.inboundDebounceMs)
    timer.unref?.()
    pendingInboundDebounce.set(debounceKey, {
      connector,
      messages: [msg],
      timer,
    })
  }
  return NO_MESSAGE_SENTINEL
}

function dispatchInboundConnectorMessage(
  connectorId: string,
  fallbackConnector: Connector,
  msg: InboundMessage,
): Promise<string> {
  const connectors = loadConnectors()
  const currentConnector = connectors[connectorId] as Connector | undefined
  return routeOrDebounceInbound(currentConnector ?? fallbackConnector, msg)
}

/** Get the current generation number for a connector (0 if never started) */
export function getConnectorGeneration(connectorId: string): number {
  return generationCounter.get(connectorId) ?? 0
}

/** Check whether a given generation is still the current one for a connector */
export function isCurrentGeneration(connectorId: string, gen: number): boolean {
  return generationCounter.get(connectorId) === gen
}

/** Get platform implementation lazily */
export async function getPlatform(platform: string) {
  // 1. Check Built-ins
  switch (platform) {
    case 'discord':  return (await import('./discord')).default
    case 'telegram': return (await import('./telegram')).default
    case 'slack':    return (await import('./slack')).default
    case 'whatsapp': return (await import('./whatsapp')).default
    case 'openclaw': return (await import('./openclaw')).default
    case 'bluebubbles': return (await import('./bluebubbles')).default
    case 'signal':    return (await import('./signal')).default
    case 'teams':     return (await import('./teams')).default
    case 'googlechat': return (await import('./googlechat')).default
    case 'matrix':    return (await import('./matrix')).default
    case 'email':     return (await import('./email')).default
  }

  // 2. Check Plugin-provided connectors
  try {
    const { getPluginManager } = await import('../plugins')
    const manager = getPluginManager()
    const pluginConnectors = manager.getConnectors()
    const found = pluginConnectors.find(c => c.id === platform)
    
    if (found) {
      return {
        start: async (connector: Connector, token: string, onMessage: (msg: InboundMessage) => Promise<string>) => {
          const stop = found.startListener ? await found.startListener(onMessage) : () => {}
          return {
            connector,
            stop: async () => { if (stop) await stop() },
            sendMessage: found.sendMessage,
            authenticated: true,
          }
        }
      }
    }
  } catch (err: unknown) {
    console.warn(`[connector] Failed to check plugins for platform "${platform}":`, err instanceof Error ? err.message : String(err))
  }

  throw new Error(`Unknown platform: ${platform}`)
}

export function formatMediaLine(media: InboundMedia): string {
  const typeLabel = media.type.toUpperCase()
  const name = media.fileName || media.mimeType || 'attachment'
  const size = media.sizeBytes ? ` (${Math.max(1, Math.round(media.sizeBytes / 1024))} KB)` : ''
  if (media.url) return `- ${typeLabel}: ${name}${size} -> ${media.url}`
  return `- ${typeLabel}: ${name}${size}`
}

export function formatInboundUserText(msg: InboundMessage): string {
  const baseText = (msg.text || '').trim()
  const lines: string[] = []
  if (baseText) lines.push(`[${msg.senderName}] ${baseText}`)
  else lines.push(`[${msg.senderName}]`)

  if (Array.isArray(msg.media) && msg.media.length > 0) {
    lines.push('')
    lines.push('Media received:')
    const preview = msg.media.slice(0, 6)
    for (const media of preview) lines.push(formatMediaLine(media))
    if (msg.media.length > preview.length) {
      lines.push(`- ...and ${msg.media.length - preview.length} more attachment(s)`)
    }
  }

  return lines.join('\n').trim()
}

type ConnectorCommandName =
  | 'help'
  | 'status'
  | 'new'
  | 'reset'
  | 'compact'
  | 'think'
  | 'pair'
  | 'session'
  | 'focus'
  | 'doctor'

interface ParsedConnectorCommand {
  name: ConnectorCommandName
  args: string
}

function parseConnectorCommand(text: string): ParsedConnectorCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...rest] = trimmed.split(/\s+/)
  const name = head.slice(1).toLowerCase()
  const args = rest.join(' ').trim()
  switch (name) {
    case 'help':
    case 'status':
    case 'new':
    case 'reset':
    case 'compact':
    case 'think':
    case 'pair':
    case 'session':
    case 'focus':
    case 'doctor':
      return { name, args } as ParsedConnectorCommand
    default:
      return null
  }
}

function persistSessionRecord(session: ConnectorSession): void {
  const sessions = loadSessions()
  sessions[session.id] = session
  saveSessions(sessions)
}

function updateSessionConnectorContext(session: ConnectorSession, connector: Connector, msg: InboundMessage, sessionKey: string): void {
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  session.connectorContext = {
    ...(session.connectorContext || {}),
    connectorId: connector.id,
    platform: connector.platform,
    channelId: msg.channelId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    sessionKey,
    peerKey: msg.senderId,
    scope: policy.scope,
    replyMode: policy.replyMode,
    threadBinding: policy.threadBinding,
    groupPolicy: policy.groupPolicy,
    threadId: msg.threadId || session.connectorContext?.threadId || null,
    threadTitle: msg.threadTitle || session.connectorContext?.threadTitle || null,
    threadPersonaLabel: resolveThreadPersonaLabel(msg) || session.connectorContext?.threadPersonaLabel || null,
    threadParentChannelId: msg.threadParentChannelId || session.connectorContext?.threadParentChannelId || null,
    threadParentChannelName: msg.threadParentChannelName || session.connectorContext?.threadParentChannelName || null,
    isGroup: !!msg.isGroup,
    lastInboundAt: Date.now(),
    lastInboundMessageId: msg.messageId || null,
    lastInboundReplyToMessageId: msg.replyToMessageId || null,
    lastInboundThreadId: msg.threadId || null,
    lastOutboundAt: session.connectorContext?.lastOutboundAt ?? null,
    lastOutboundMessageId: session.connectorContext?.lastOutboundMessageId ?? null,
    lastResetAt: session.connectorContext?.lastResetAt ?? null,
    lastResetReason: session.connectorContext?.lastResetReason ?? null,
  }
}

function describeSessionControls(session: ConnectorSession, connector: Connector, msg: InboundMessage): string {
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  const context = session.connectorContext || {}
  const sessionAgeSec = Math.max(0, Math.round((Date.now() - (session.createdAt || Date.now())) / 1000))
  const idleSec = Math.max(0, Math.round((Date.now() - (session.lastActiveAt || Date.now())) / 1000))
  return [
    `Session controls for ${connector.platform}/${connector.name}:`,
    `- Session: ${session.id}`,
    `- Scope: ${policy.scope}`,
    `- Reply mode: ${policy.replyMode}`,
    `- Thread binding: ${policy.threadBinding}`,
    `- Group policy: ${policy.groupPolicy}`,
    `- Reset mode: ${policy.resetMode}`,
    `- Idle timeout: ${policy.idleTimeoutSec ?? 0}s`,
    `- Max age: ${policy.maxAgeSec ?? 0}s`,
    `- Daily reset: ${policy.dailyResetAt || 'off'}`,
    `- Reset timezone: ${policy.resetTimezone || 'local'}`,
    `- Debounce: ${policy.inboundDebounceMs}ms`,
    `- Typing indicators: ${policy.typingIndicators ? 'on' : 'off'}`,
    `- Thinking: ${policy.thinkingLevel || session.thinkingLevel || 'inherit'}`,
    `- Model: ${session.provider}/${session.model}`,
    `- Last outbound message: ${context.lastOutboundMessageId || 'none'}`,
    `- Thread: ${context.threadId || 'none'}`,
    `- Thread title: ${context.threadTitle || 'none'}`,
    `- Thread persona: ${context.threadPersonaLabel || 'none'}`,
    `- Session age: ${sessionAgeSec}s`,
    `- Idle for: ${idleSec}s`,
  ].join('\n')
}

function normalizeSessionSettingKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_-]+/g, '')
}

function applySessionSetting(session: ConnectorSession, keyRaw: string, valueRaw: string, msg: InboundMessage): string {
  const key = normalizeSessionSettingKey(keyRaw)
  const value = valueRaw.trim()
  const asInt = () => {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid numeric value for ${keyRaw}: ${valueRaw}`)
    }
    return parsed
  }
  const asEnum = <T extends string>(allowed: readonly T[], label: string): T | null => {
    if (!value) return null
    const normalized = value.toLowerCase()
    if ((allowed as readonly string[]).includes(normalized)) return normalized as T
    throw new Error(`Invalid ${label}. Use one of: ${allowed.join(', ')}.`)
  }

  switch (key) {
    case 'think':
    case 'thinkinglevel':
      session.connectorThinkLevel = asEnum(['minimal', 'low', 'medium', 'high'] as const, '/think level')
      return `Connector thinking level set to ${session.connectorThinkLevel || 'inherit'}.`
    case 'reply':
    case 'replymode':
      session.connectorReplyMode = asEnum(['off', 'first', 'all'] as const, 'reply mode')
      return `Reply mode set to ${session.connectorReplyMode || 'inherit'}.`
    case 'scope':
    case 'sessionscope':
      session.connectorSessionScope = asEnum(['main', 'channel', 'peer', 'channel-peer', 'thread'] as const, 'session scope')
      return `Session scope set to ${session.connectorSessionScope || 'inherit'}.`
    case 'thread':
    case 'threadbinding':
      session.connectorThreadBinding = asEnum(['off', 'prefer', 'strict'] as const, 'thread binding')
      if (!value) {
        session.connectorContext = { ...(session.connectorContext || {}), threadId: null }
      } else if (session.connectorThreadBinding === 'strict' && msg.threadId) {
        session.connectorContext = { ...(session.connectorContext || {}), threadId: msg.threadId }
      }
      return `Thread binding set to ${session.connectorThreadBinding || 'inherit'}.`
    case 'group':
    case 'grouppolicy':
      session.connectorGroupPolicy = asEnum(['open', 'mention', 'reply-or-mention', 'disabled'] as const, 'group policy')
      return `Group policy set to ${session.connectorGroupPolicy || 'inherit'}.`
    case 'idle':
    case 'idletimeout':
      session.connectorIdleTimeoutSec = asInt()
      return `Idle timeout set to ${session.connectorIdleTimeoutSec}s.`
    case 'maxage':
      session.connectorMaxAgeSec = asInt()
      return `Max age set to ${session.connectorMaxAgeSec}s.`
    case 'reset':
    case 'resetmode': {
      const normalized = value.toLowerCase()
      if (!value) {
        session.sessionResetMode = null
        return 'Reset mode set to inherit.'
      }
      if (normalized !== 'idle' && normalized !== 'daily') {
        throw new Error('Reset mode must be "idle" or "daily".')
      }
      session.sessionResetMode = normalized
      return `Reset mode set to ${session.sessionResetMode}.`
    }
    case 'daily':
    case 'dailyreset':
    case 'dailyresetat':
      if (!value) {
        session.sessionDailyResetAt = null
        return 'Daily reset time cleared.'
      }
      if (!/^\d{1,2}:\d{2}$/.test(value)) {
        throw new Error('Daily reset time must be in HH:MM format.')
      }
      session.sessionDailyResetAt = value
      return `Daily reset time set to ${session.sessionDailyResetAt}.`
    case 'timezone':
    case 'resettimezone':
      session.sessionResetTimezone = value || null
      return `Reset timezone set to ${session.sessionResetTimezone || 'inherit/local'}.`
    case 'model':
      session.model = value
      return `Model set to ${session.model}.`
    case 'provider': {
      const provider = getProvider(value)
      if (!provider) {
        throw new Error(`Unknown provider "${value}".`)
      }
      session.provider = provider.id as Session['provider']
      session.apiEndpoint = provider.defaultEndpoint || session.apiEndpoint || null
      return `Provider set to ${session.provider}.`
    }
    default:
      throw new Error(`Unknown session setting "${keyRaw}".`)
  }
}

function evaluateGroupPolicy(params: {
  connector: Connector
  msg: InboundMessage
  session?: ConnectorSession | null
  aliases: string[]
}): { allowed: boolean; reason: string } {
  const { connector, msg, session, aliases } = params
  if (!msg.isGroup) return { allowed: true, reason: 'dm' }
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (policy.groupPolicy === 'open') return { allowed: true, reason: 'open' }
  if (policy.groupPolicy === 'disabled') return { allowed: false, reason: 'disabled' }
  const mentioned = !!msg.mentionsBot || textMentionsAlias(msg.text || '', aliases)
  const replied = isReplyToLastOutbound(msg, session)
  if (policy.groupPolicy === 'mention') {
    return { allowed: mentioned, reason: mentioned ? 'mentioned' : 'mention_required' }
  }
  const allowed = mentioned || replied
  return { allowed, reason: allowed ? (mentioned ? 'mentioned' : 'reply') : 'reply_or_mention_required' }
}

function applyConnectorRuntimeDefaults(session: ConnectorSession, defaults: {
  provider: Session['provider']
  model: string
  apiEndpoint: string | null
  thinkingLevel: Session['connectorThinkLevel']
}): void {
  session.provider = defaults.provider
  session.model = defaults.model
  session.apiEndpoint = defaults.apiEndpoint
  session.connectorThinkLevel = defaults.thinkingLevel
}

function resolveDirectSession(params: {
  connector: Connector
  msg: InboundMessage
  agent: ConnectorAgent
}): { session: ConnectorSession; sessionKey: string; wasCreated: boolean; staleReason?: string | null; clearedMessages?: number } {
  const { connector, msg, agent } = params
  const policySeed = resolveConnectorSessionPolicy(connector, msg)
  const providerInfo = policySeed.providerOverride ? getProvider(policySeed.providerOverride) : null
  const defaultProvider: Session['provider'] = providerInfo?.id || (agent.provider === 'claude-cli' ? 'anthropic' : agent.provider)
  const defaultModel = policySeed.modelOverride || agent.model
  const defaultApiEndpoint = agent.apiEndpoint || providerInfo?.defaultEndpoint || null
  const runtimeDefaults = {
    provider: defaultProvider,
    model: defaultModel,
    apiEndpoint: defaultApiEndpoint,
    thinkingLevel: policySeed.thinkingLevel || null,
  }
  const sessionKey = buildConnectorConversationKey({
    connector,
    msg,
    agentId: agent.id,
    policy: policySeed,
  })
  const sessions = loadSessions()
  let session = Object.values(sessions as Record<string, ConnectorSession>).find((item) => item?.name === sessionKey)
  let wasCreated = false
  if (!session) {
    const id = genId()
    session = {
      id,
      name: sessionKey,
      cwd: WORKSPACE_DIR,
      user: 'connector',
      provider: defaultProvider,
      model: defaultModel,
      credentialId: agent.credentialId || null,
      fallbackCredentialIds: Array.isArray(agent.fallbackCredentialIds) ? [...agent.fallbackCredentialIds] : [],
      apiEndpoint: defaultApiEndpoint,
      claudeSessionId: null,
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: {
        claudeCode: null,
        codex: null,
        opencode: null,
        gemini: null,
      },
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human' as const,
      agentId: agent.id,
      plugins: agent.plugins || agent.tools || [],
      thinkingLevel: agent.thinkingLevel || null,
      connectorThinkLevel: policySeed.thinkingLevel || null,
    }
    wasCreated = true
  }
  session.name = sessionKey
  session.agentId = agent.id
  session.plugins = Array.isArray(session.plugins) ? session.plugins : (agent.plugins || agent.tools || [])
  if (!session.provider) session.provider = defaultProvider
  if (!session.model) session.model = defaultModel
  if (session.credentialId === undefined) session.credentialId = agent.credentialId || null
  if (!Array.isArray(session.fallbackCredentialIds) && Array.isArray(agent.fallbackCredentialIds)) {
    session.fallbackCredentialIds = [...agent.fallbackCredentialIds]
  }
  if (session.apiEndpoint === undefined || session.apiEndpoint === null) session.apiEndpoint = defaultApiEndpoint
  if ((session.connectorThinkLevel === undefined || session.connectorThinkLevel === null) && policySeed.thinkingLevel) {
    session.connectorThinkLevel = policySeed.thinkingLevel
  }

  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  const staleness = getConnectorSessionStaleness(session, policy)
  let clearedMessages = 0
  if (staleness.stale) {
    try { syncSessionArchiveMemory(session, { agent }) } catch { /* archive sync is best-effort */ }
    clearedMessages = resetConnectorSessionRuntime(session, staleness.reason || 'session_refresh')
    applyConnectorRuntimeDefaults(session, {
      ...runtimeDefaults,
      thinkingLevel: policySeed.thinkingLevel || session.connectorThinkLevel || null,
    })
  }
  updateSessionConnectorContext(session, connector, msg, sessionKey)
  sessions[session.id] = session
  saveSessions(sessions)
  return {
    session,
    sessionKey,
    wasCreated,
    staleReason: staleness.reason || null,
    clearedMessages,
  }
}

function pushSessionMessage(session: ConnectorSession, role: 'user' | 'assistant', text: string): void {
  if (!text.trim()) return
  if (!Array.isArray(session.messages)) session.messages = []
  session.messages.push({ role, text: text.trim(), time: Date.now() })
  session.lastActiveAt = Date.now()
}

function persistSession(session: ConnectorSession): void {
  const sessions = loadSessions()
  sessions[session.id] = session
  saveSessions(sessions)
  notify(`messages:${session.id}`)
}

function summarizeForCompaction(messages: Array<{ role?: string; text?: string }>): string {
  const preview = messages
    .slice(-8)
    .map((m, i) => {
      const role = (m.role || 'unknown').toUpperCase()
      const body = (m.text || '').replace(/\s+/g, ' ').trim()
      const clipped = body.length > 180 ? `${body.slice(0, 177)}...` : body
      return `${i + 1}. [${role}] ${clipped || '(no text)'}`
    })
  if (!preview.length) return 'No earlier messages to summarize.'
  return preview.join('\n')
}

function resolvePairingAccess(connector: Connector, msg: InboundMessage): {
  policy: PairingPolicy
  configAllowFrom: string[]
  isAllowed: boolean
  hasAnyApprover: boolean
} {
  const policy = parsePairingPolicy(connector.config?.dmPolicy, 'open')
  const configAllowFrom = parseAllowFromCsv(connector.config?.allowFrom)
  const stored = listStoredAllowedSenders(connector.id)
  const isAllowed = isSenderAllowed({
    connectorId: connector.id,
    senderId: msg.senderId,
    configAllowFrom,
  })
  return {
    policy,
    configAllowFrom,
    isAllowed,
    hasAnyApprover: (configAllowFrom.length + stored.length) > 0,
  }
}

async function handlePairCommand(params: {
  connector: Connector
  msg: InboundMessage
  args: string
}): Promise<string> {
  const { connector, msg, args } = params
  const access = resolvePairingAccess(connector, msg)
  const parts = args.split(/\s+/).map((item) => item.trim()).filter(Boolean)
  const subcommand = (parts[0] || 'status').toLowerCase()

  if (subcommand === 'request') {
    const request = createOrTouchPairingRequest({
      connectorId: connector.id,
      senderId: msg.senderId,
      senderName: msg.senderName,
      channelId: msg.channelId,
    })
    return request.created
      ? `Pairing request created. Share this code with an approved user: ${request.code}`
      : `Pairing request is already pending. Your code is: ${request.code}`
  }

  if (subcommand === 'list') {
    if (access.hasAnyApprover && !access.isAllowed) {
      return 'Pairing list is restricted to approved senders.'
    }
    const pending = listPendingPairingRequests(connector.id)
    if (!pending.length) return 'No pending pairing requests.'
    const lines = pending.slice(0, 20).map((entry) => {
      const ageMin = Math.max(1, Math.round((Date.now() - entry.updatedAt) / 60_000))
      const sender = entry.senderName ? `${entry.senderName} (${entry.senderId})` : entry.senderId
      return `- ${entry.code} -> ${sender} (${ageMin}m ago)`
    })
    return `Pending pairing requests (${pending.length}):\n${lines.join('\n')}`
  }

  if (subcommand === 'approve') {
    const code = (parts[1] || '').trim()
    if (!code) return 'Usage: /pair approve <code>'
    if (access.hasAnyApprover && !access.isAllowed) {
      return 'Pairing approvals are restricted to approved senders.'
    }
    const approved = approvePairingCode(connector.id, code)
    if (!approved.ok) return approved.reason || 'Pairing approval failed.'
    const sender = approved.senderName ? `${approved.senderName} (${approved.senderId})` : approved.senderId
    return `Pairing approved: ${sender}`
  }

  if (subcommand === 'allow') {
    const senderId = (parts[1] || '').trim()
    if (!senderId) return 'Usage: /pair allow <senderId>'
    if (access.hasAnyApprover && !access.isAllowed) {
      return 'Allowlist updates are restricted to approved senders.'
    }
    const result = addAllowedSender(connector.id, senderId)
    if (!result.normalized) return 'Could not parse senderId.'
    return result.added
      ? `Allowed sender: ${result.normalized}`
      : `Sender is already allowed: ${result.normalized}`
  }

  const pending = listPendingPairingRequests(connector.id)
  const stored = listStoredAllowedSenders(connector.id)
  const policyLine = `Policy: ${access.policy}`
  const approvedLine = `You are ${access.isAllowed ? 'approved' : 'not approved'} as ${msg.senderId}`
  return [
    'Pairing controls:',
    policyLine,
    approvedLine,
    `- Stored approvals: ${stored.length}`,
    `- Pending requests: ${pending.length}`,
    '- Commands: /pair request, /pair list, /pair approve <code>, /pair allow <senderId>',
  ].join('\n')
}

function enforceInboundAccessPolicy(connector: Connector, msg: InboundMessage): string | null {
  if (msg.isGroup) return null
  const { policy, configAllowFrom, isAllowed } = resolvePairingAccess(connector, msg)
  const storedAllowFrom = listStoredAllowedSenders(connector.id)
  if (policy === 'open') return null

  if (policy === 'disabled') return NO_MESSAGE_SENTINEL
  if (isAllowed) return null

  if (policy === 'allowlist') {
    if (!configAllowFrom.length && !storedAllowFrom.length) {
      return 'This connector is set to allowlist mode, but no allowFrom entries are configured.'
    }
    return 'You are not authorized for this connector. Ask an approved user to add your sender ID via /pair allow <senderId>.'
  }

  if (policy === 'pairing') {
    const request = createOrTouchPairingRequest({
      connectorId: connector.id,
      senderId: msg.senderId,
      senderName: msg.senderName,
      channelId: msg.channelId,
    })
    return [
      'Pairing is required before this connector will respond.',
      `Your pairing code: ${request.code}`,
      'Ask an approved sender to run /pair approve <code>.',
      'Tip: if this is first-time setup with no approvals yet, run /pair approve <code> from this chat to bootstrap.',
    ].join('\n')
  }

  return null
}

async function handleConnectorCommand(params: {
  command: ParsedConnectorCommand
  connector: Connector
  session: ConnectorSession
  msg: InboundMessage
  agentName: string
}): Promise<string> {
  const { command, connector, session, msg, agentName } = params
  const inboundText = formatInboundUserText(msg)

  if (command.name === 'help') {
    const text = [
      'Connector commands:',
      '/status — Show active session status',
      '/new or /reset — Clear this connector conversation thread',
      '/compact [keepLastN] — Summarize older history and keep recent messages (default 10)',
      '/think <minimal|low|medium|high> — Set connector thread reasoning guidance',
      '/session — Show session controls',
      '/session set <scope|reply|thread|group|idle|maxAge|resetMode|dailyResetAt|timezone|think|model|provider> <value> — Patch this connector session',
      '/focus here|clear — Bind or clear focus on the current thread/topic',
      '/doctor — Show autonomy and safety warnings for this connector/session',
      '/pair — Pairing/access controls (status, request, list, approve, allow)',
      '/help — Show this list',
    ].join('\n')
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'status') {
    const policy = resolveConnectorSessionPolicy(connector, msg, session)
    const all = Array.isArray(session.messages) ? session.messages : []
    const userCount = all.filter((m: { role?: string }) => m?.role === 'user').length
    const assistantCount = all.filter((m: { role?: string }) => m?.role === 'assistant').length
    const toolsCount = Array.isArray(session.plugins) ? session.plugins.length : 0
    const statusText = [
      `Status for ${connector.platform} / ${connector.name}:`,
      `- Agent: ${agentName}`,
      `- Session: ${session.id}`,
      `- Model: ${session.provider}/${session.model}`,
      `- Messages: ${all.length} (${userCount} user, ${assistantCount} assistant)`,
      `- Tools enabled: ${toolsCount}`,
      `- Channel: ${msg.channelName || msg.channelId}`,
      `- Last active: ${new Date(session.lastActiveAt || session.createdAt || Date.now()).toLocaleString()}`,
      `- Reset mode: ${policy.resetMode}`,
      `- Reply mode: ${policy.replyMode}`,
      `- Scope: ${policy.scope}`,
    ].join('\n')
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', statusText)
    persistSession(session)
    return statusText
  }

  if (command.name === 'new' || command.name === 'reset') {
    const agent = session.agentId ? (loadAgents() as Record<string, ConnectorAgent>)[session.agentId] : undefined
    try { syncSessionArchiveMemory(session, { agent }) } catch { /* best effort */ }
    const cleared = resetConnectorSessionRuntime(session, 'manual_reset')
    const policy = resolveConnectorSessionPolicy(connector, msg, session)
    const providerInfo = policy.providerOverride ? getProvider(policy.providerOverride) : null
    applyConnectorRuntimeDefaults(session, {
      provider: providerInfo?.id || session.provider,
      model: policy.modelOverride || session.model,
      apiEndpoint: providerInfo?.defaultEndpoint || session.apiEndpoint || null,
      thinkingLevel: policy.thinkingLevel || session.connectorThinkLevel || null,
    })
    updateSessionConnectorContext(session, connector, msg, session.name || session.id)
    persistSession(session)
    return `Reset complete for ${connector.platform} channel thread. Cleared ${cleared} message(s).`
  }

  if (command.name === 'compact') {
    const keepParsed = Number.parseInt(command.args, 10)
    const keepLastN = Number.isFinite(keepParsed) ? Math.max(4, Math.min(50, keepParsed)) : 10
    const history = Array.isArray(session.messages) ? session.messages : []
    if (history.length <= keepLastN) {
      const text = `Nothing to compact. Current history has ${history.length} message(s), keepLastN=${keepLastN}.`
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    const oldMessages = history.slice(0, -keepLastN)
    const recentMessages = history.slice(-keepLastN)
    const summary = summarizeForCompaction(oldMessages)
    const summaryMessage = {
      role: 'assistant' as const,
      text: `[Context summary: compacted ${oldMessages.length} message(s)]\n${summary}`,
      time: Date.now(),
      kind: 'system' as const,
    }
    session.messages = [summaryMessage, ...recentMessages]
    session.lastActiveAt = Date.now()
    const text = `Compacted ${oldMessages.length} message(s). Kept ${recentMessages.length} recent message(s) plus a summary.`
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'think') {
    const requested = command.args.trim().toLowerCase()
    const allowed = new Set(['minimal', 'low', 'medium', 'high'] as const)
    if (!requested) {
      const policy = resolveConnectorSessionPolicy(connector, msg, session)
      const current = typeof policy.thinkingLevel === 'string' && allowed.has(policy.thinkingLevel)
        ? policy.thinkingLevel
        : 'medium'
      const text = `Current /think level: ${current}. Usage: /think <minimal|low|medium|high>.`
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    if (
      requested !== 'minimal'
      && requested !== 'low'
      && requested !== 'medium'
      && requested !== 'high'
    ) {
      const text = 'Invalid /think level. Use one of: minimal, low, medium, high.'
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    session.connectorThinkLevel = requested
    session.lastActiveAt = Date.now()
    const text = `Set /think level to ${requested} for this connector thread.`
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'doctor') {
    const warnings = buildConnectorDoctorWarnings({ connector, msg, session })
    const text = warnings.length
      ? ['Connector doctor:', ...warnings.map((item) => `- ${item}`)].join('\n')
      : 'Connector doctor: no obvious autonomy or safety issues detected.'
    pushSessionMessage(session, 'user', inboundText)
    pushSessionMessage(session, 'assistant', text)
    persistSession(session)
    return text
  }

  if (command.name === 'session') {
    const parts = command.args.split(/\s+/).map((item) => item.trim()).filter(Boolean)
    if (!parts.length || parts[0].toLowerCase() === 'show' || parts[0].toLowerCase() === 'status') {
      const text = describeSessionControls(session, connector, msg)
      pushSessionMessage(session, 'user', inboundText)
      pushSessionMessage(session, 'assistant', text)
      persistSession(session)
      return text
    }
    if (parts[0].toLowerCase() === 'reset') {
      const agent = session.agentId ? (loadAgents() as Record<string, ConnectorAgent>)[session.agentId] : undefined
      try { syncSessionArchiveMemory(session, { agent }) } catch { /* best effort */ }
      const cleared = resetConnectorSessionRuntime(session, 'manual_reset')
      const policy = resolveConnectorSessionPolicy(connector, msg, session)
      const providerInfo = policy.providerOverride ? getProvider(policy.providerOverride) : null
      applyConnectorRuntimeDefaults(session, {
        provider: providerInfo?.id || session.provider,
        model: policy.modelOverride || session.model,
        apiEndpoint: providerInfo?.defaultEndpoint || session.apiEndpoint || null,
        thinkingLevel: policy.thinkingLevel || session.connectorThinkLevel || null,
      })
      updateSessionConnectorContext(session, connector, msg, session.name || session.id)
      persistSession(session)
      return `Connector session reset. Cleared ${cleared} message(s).`
    }
    if (parts[0].toLowerCase() === 'set') {
      const key = parts[1] || ''
      const value = parts.slice(2).join(' ').trim()
      if (!key) return 'Usage: /session set <scope|reply|thread|group|idle|maxAge|resetMode|dailyResetAt|timezone|think|model|provider> <value>'
      try {
        const text = applySessionSetting(session, key, value, msg)
        updateSessionConnectorContext(session, connector, msg, session.name || session.id)
        persistSession(session)
        return text
      } catch (err: unknown) {
        return err instanceof Error ? err.message : String(err)
      }
    }
    return 'Usage: /session, /session show, /session set <key> <value>, /session reset'
  }

  if (command.name === 'focus') {
    const subcommand = command.args.trim().toLowerCase()
    if (subcommand === 'clear') {
      session.connectorThreadBinding = null
      session.connectorSessionScope = null
      session.connectorContext = { ...(session.connectorContext || {}), threadId: null }
      persistSession(session)
      return 'Cleared connector thread focus.'
    }
    if (!msg.threadId) {
      return 'Focus can only be set from a threaded or topic-bound message.'
    }
    session.connectorThreadBinding = 'strict'
    session.connectorSessionScope = 'thread'
    session.connectorReplyMode = session.connectorReplyMode || 'all'
    session.connectorContext = { ...(session.connectorContext || {}), threadId: msg.threadId }
    persistSession(session)
    return `Focused this connector session on thread ${msg.threadId}.`
  }

  return 'Unknown command.'
}

/** Route an inbound message to a chatroom — process mentioned agents and return concatenated responses */
async function routeMessageToChatroom(connector: Connector, msg: InboundMessage): Promise<string> {
  const chatroomId = connector.chatroomId
  if (!chatroomId) return '[Error] No chatroom configured.'

  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[chatroomId] as Chatroom | undefined
  if (!chatroom) return '[Error] Chatroom not found.'

  const agents = loadAgents()
  const chatroomAgentAliases = chatroom.agentIds
    .map((agentId) => agents[agentId]?.name)
    .filter((name): name is string => typeof name === 'string' && !!name.trim())
  const preferredCredentialId = (() => {
    if (connector.agentId && agents[connector.agentId]?.credentialId) {
      return agents[connector.agentId].credentialId as string
    }
    for (const agentId of chatroom.agentIds) {
      const credentialId = agents[agentId]?.credentialId
      if (credentialId) return credentialId as string
    }
    return null
  })()
  msg = await enrichInboundMessageWithAudioTranscript({
    msg,
    preferredCredentialId,
  })
  const groupGate = evaluateGroupPolicy({
    connector,
    msg,
    aliases: [connector.name, ...chatroomAgentAliases],
  })
  if (!groupGate.allowed) return NO_MESSAGE_SENTINEL

  await maybeSendStatusReaction(connector, msg, 'processing')
  const stopTyping = startConnectorTypingLoop(connector, msg)
  try {

  const source: MessageSource = {
    platform: connector.platform,
    connectorId: connector.id,
    connectorName: connector.name,
    channelId: msg.channelId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    messageId: msg.messageId,
    replyToMessageId: msg.replyToMessageId,
    threadId: msg.threadId,
  }
  const inboundText = formatInboundUserText(msg)
  const inboundAttachmentPaths = buildInboundAttachmentPaths(msg)
  const firstImagePath = msg.media?.find((m) => m.type === 'image')?.localPath
  const threadContextBlock = buildConnectorThreadContextBlock(msg)

  // Parse mentions from the message text
  let mentions = parseMentions(msg.text || '', agents, chatroom.agentIds)
  // Routing rules: if no explicit mentions, evaluate keyword/capability rules
  if (mentions.length === 0 && chatroom.routingRules?.length) {
    const agentList = chatroom.agentIds.map((id) => agents[id]).filter(Boolean)
    mentions = evaluateRoutingRules(msg.text || '', chatroom.routingRules, agentList)
  }
  // Auto-address: if enabled and still no mentions, address all agents
  if (chatroom.autoAddress && mentions.length === 0) {
    mentions = [...chatroom.agentIds]
  }
  const mentionHealth = filterHealthyChatroomAgents(mentions, agents)
  mentions = mentionHealth.healthyAgentIds

  // Create and persist the user message in the chatroom
  const userMessage: ChatroomMessage = {
    id: genId(),
    senderId: 'user',
    senderName: msg.senderName || 'User',
    role: 'user',
    text: msg.text || '',
    mentions,
    reactions: [],
    time: Date.now(),
    ...(firstImagePath ? { imagePath: firstImagePath } : {}),
    ...(inboundAttachmentPaths.length ? { attachedFiles: inboundAttachmentPaths } : {}),
    source,
  }
  chatroom.messages.push(userMessage)
  compactChatroomMessages(chatroom)
  chatroom.updatedAt = Date.now()
  chatrooms[chatroomId] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${chatroomId}`)

  if (mentions.length === 0) {
    if (mentionHealth.skipped.length > 0) {
      const skippedSummary = mentionHealth.skipped
        .map((row) => `${agents[row.agentId]?.name || row.agentId}: ${row.reason}`)
        .join(', ')
      return `[Error] No healthy agents were available for this request. Skipped: ${skippedSummary}`
    }
    return '[Error] No agents were selected for this request.'
  }

  // Process mentioned agents sequentially and collect responses
  const responses: string[] = []
  for (const agentId of mentions) {
    const agent = agents[agentId]
    if (!agent) continue

    const apiKey = resolveApiKeyHelper(agent.credentialId)
    const freshChatrooms = loadChatrooms()
    const freshChatroom = freshChatrooms[chatroomId] as Chatroom
    if (compactChatroomMessages(freshChatroom)) {
      freshChatrooms[chatroomId] = freshChatroom
      saveChatrooms(freshChatrooms)
      notify(`chatroom:${chatroomId}`)
    }

    const providerInfo = getProvider(agent.provider)
    if (providerInfo?.requiresApiKey && !apiKey) {
      markProviderFailure(agent.provider, 'missing_api_credentials')
      responses.push(`[${agent.name}] [Error] Missing API credentials.`)
      continue
    }
    if (providerInfo?.requiresEndpoint && !agent.apiEndpoint) {
      markProviderFailure(agent.provider, 'missing_api_endpoint')
      responses.push(`[${agent.name}] [Error] Missing endpoint configuration.`)
      continue
    }

    const syntheticSession = ensureSyntheticSession(agent, chatroomId)
    const agentSystemPrompt = buildAgentSystemPromptForChatroom(agent)
    const chatroomContext = buildChatroomSystemPrompt(freshChatroom, agents, agent.id)
    const fullSystemPrompt = [agentSystemPrompt, chatroomContext, threadContextBlock].filter(Boolean).join('\n\n')
    const history = buildHistoryForAgent(freshChatroom, agent.id)

    try {
      const result = await streamAgentChat({
        session: syntheticSession,
        message: inboundText,
        imagePath: firstImagePath || undefined,
        attachedFiles: inboundAttachmentPaths.length ? inboundAttachmentPaths : undefined,
        apiKey,
        systemPrompt: fullSystemPrompt,
        write: () => {},
        history,
      })

      const responseText = result.finalResponse || result.fullText
      if (responseText.trim() && !isNoMessage(responseText)) {
        // Persist agent response to chatroom
        const agentSource: MessageSource = {
          platform: connector.platform,
          connectorId: connector.id,
          connectorName: connector.name,
          channelId: msg.channelId,
        }
        const agentMessage: ChatroomMessage = {
          id: genId(),
          senderId: agent.id,
          senderName: agent.name,
          role: 'assistant',
          text: responseText,
          mentions: filterHealthyChatroomAgents(
            parseMentions(responseText, agents, freshChatroom.agentIds),
            agents,
          ).healthyAgentIds,
          reactions: [],
          time: Date.now(),
          source: agentSource,
        }
        const latestChatrooms = loadChatrooms()
        const latestChatroom = latestChatrooms[chatroomId] as Chatroom
        latestChatroom.messages.push(agentMessage)
        latestChatroom.updatedAt = Date.now()
        latestChatrooms[chatroomId] = latestChatroom
        saveChatrooms(latestChatrooms)
        notify(`chatroom:${chatroomId}`)

        markProviderSuccess(agent.provider)
        responses.push(`[${agent.name}] ${responseText}`)
      } else {
        markProviderSuccess(agent.provider)
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      markProviderFailure(agent.provider, errMsg)
      console.error(`[connector] Chatroom agent ${agent.name} error:`, errMsg)
    }
  }

  if (responses.length === 0) {
    await maybeSendStatusReaction(connector, msg, 'silent')
    return NO_MESSAGE_SENTINEL
  }

  const joined = responses.join('\n\n')
  // Extract embedded media from agent responses and send them via connector
  const extracted = extractEmbeddedMedia(joined)
  const filesToSend = selectOutboundMediaFiles(extracted.files, msg.text || '')
  if (filesToSend.length > 0) {
    const inst = running.get(connector.id)
    if (inst?.sendMessage) {
      const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound: msg })
      for (const file of filesToSend) {
        try {
          await sendConnectorMessage({
            connectorId: connector.id,
            channelId: msg.channelId,
            text: '',
            mediaPath: file.path,
            caption: file.alt || undefined,
            replyToMessageId: replyOptions.replyToMessageId,
            threadId: replyOptions.threadId,
          })
          console.log(`[connector] Sent chatroom media to ${msg.platform}: ${path.basename(file.path)}`)
        } catch (err: unknown) {
          console.error(`[connector] Failed to send chatroom media ${path.basename(file.path)}:`, err instanceof Error ? err.message : String(err))
        }
      }
    }
    return extracted.cleanText || '(no response)'
  }
  return joined
  } finally {
    stopTyping?.()
  }
}

/** Route an inbound message through the assigned agent and return the response */
async function routeMessage(connector: Connector, msg: InboundMessage): Promise<string> {
  if (msg?.channelId) {
    lastInboundChannelByConnector.set(connector.id, msg.channelId)
  }
  lastInboundTimeByConnector.set(connector.id, Date.now())

  // Route to chatroom if configured
  if (connector.chatroomId) {
    return routeMessageToChatroom(connector, msg)
  }

  const agents = loadAgents()
  const effectiveAgentId = msg.agentIdOverride || connector.agentId
  if (!effectiveAgentId) return '[Error] Connector has no agent configured.'
  const agent = agents[effectiveAgentId]
  if (!agent) return '[Error] Connector agent not found.'
  msg = await enrichInboundMessageWithAudioTranscript({
    msg,
    preferredCredentialId: agent.credentialId || null,
  })

  const { session, sessionKey, wasCreated, staleReason, clearedMessages } = resolveDirectSession({
    connector,
    msg,
    agent,
  })

  const parsedCommand = parseConnectorCommand(msg.text || '')
  if (parsedCommand?.name === 'pair') {
    const commandResult = await handlePairCommand({
      connector,
      msg,
      args: parsedCommand.args,
    })
    logExecution(session.id, 'decision', 'Connector pair command handled', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        command: 'pair',
        args: parsedCommand.args || null,
      },
    })
    return commandResult
  }

  const accessPolicyResult = enforceInboundAccessPolicy(connector, msg)
  if (accessPolicyResult) {
    logExecution(session.id, 'decision', 'Connector inbound blocked by access policy', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
        policy: parsePairingPolicy(connector.config?.dmPolicy, 'open'),
      },
    })
    return accessPolicyResult
  }

  const groupGate = evaluateGroupPolicy({
    connector,
    msg,
    session,
    aliases: [agent.name, connector.name],
  })
  if (!groupGate.allowed) {
    logExecution(session.id, 'decision', 'Connector inbound blocked by group policy', {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
        groupPolicy: resolveConnectorSessionPolicy(connector, msg, session).groupPolicy,
        reason: groupGate.reason,
      },
    })
    return NO_MESSAGE_SENTINEL
  }

  if (parsedCommand) {
    const commandResult = await handleConnectorCommand({
      command: parsedCommand,
      connector,
      session,
      msg,
      agentName: agent.name,
    })
    logExecution(session.id, 'decision', `Connector command handled: /${parsedCommand.name}`, {
      agentId: agent.id,
      detail: {
        platform: msg.platform,
        channelId: msg.channelId,
        command: parsedCommand.name,
        args: parsedCommand.args || null,
      },
    })
    return commandResult
  }

  await maybeSendStatusReaction(connector, msg, 'processing')
  const stopTyping = startConnectorTypingLoop(connector, msg)
  try {
    // Enqueue system event + heartbeat wake for the agent only after access/gating checks pass.
    const preview = (msg.text || '').slice(0, 80)
    enqueueSystemEvent(
      sessionKey,
      `Inbound message from ${msg.platform}: ${preview}`,
      'connector-message',
    )
    requestHeartbeatNow({ agentId: effectiveAgentId, reason: 'connector-message' })

    logExecution(session.id, 'trigger', `${msg.platform} message from ${msg.senderName}`, {
      agentId: agent.id,
      detail: {
        source: 'connector',
        platform: msg.platform,
        connectorId: connector.id,
        channelId: msg.channelId,
        senderName: msg.senderName,
        sessionKey,
        messagePreview: (msg.text || '').slice(0, 200),
        hasMedia: !!(msg.media?.length || msg.imageUrl),
        staleReason: staleReason || null,
        clearedMessages: clearedMessages || 0,
      },
    })

  // Resolve API key for the effective session provider, preferring matching fallback credentials.
  let apiKey: string | null = null
  const sessionCredentialIds = [
    session.credentialId,
    ...(Array.isArray(session.fallbackCredentialIds) ? session.fallbackCredentialIds : []),
  ].filter(Boolean) as string[]
  if (sessionCredentialIds.length > 0) {
    const creds = loadCredentials()
    const matching = sessionCredentialIds.find((credentialId) => creds[credentialId]?.provider === session.provider)
    const ordered = matching
      ? [matching, ...sessionCredentialIds.filter((credentialId) => credentialId !== matching)]
      : sessionCredentialIds
    for (const credentialId of ordered) {
      const cred = creds[credentialId]
      if (!cred?.encryptedKey) continue
      try {
        apiKey = decryptKey(cred.encryptedKey)
        break
      } catch {
        // Try the next candidate.
      }
    }
  }

  // Build system prompt: [identity] \n\n [userPrompt] \n\n [soul] \n\n [systemPrompt]
  const settings = loadSettings()
  const promptParts: string[] = []
  // Identity block — agent needs to know who it is
  const identityLines = [`## My Identity`, `My name is ${agent.name}.`]
  if (agent.description) identityLines.push(agent.description)
  identityLines.push('I should always refer to myself by this name. I am not "Assistant" — I have my own name and identity.')
  promptParts.push(identityLines.join(' '))
  const continuityBlock = buildIdentityContinuityContext(session as Session, agent)
  if (continuityBlock) promptParts.push(continuityBlock)
  if (settings.userPrompt) promptParts.push(settings.userPrompt)
  promptParts.push(buildCurrentDateTimePromptContext())
  if (agent.soul) promptParts.push(agent.soul)
  if (agent.systemPrompt) promptParts.push(agent.systemPrompt)
  if (agent.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of agent.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) promptParts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }
  const thinkLevel = resolveConnectorSessionPolicy(connector, msg, session).thinkingLevel || ''
  if (thinkLevel) {
    promptParts.push(`Connector thinking guidance: ${thinkLevel}. Keep responses concise and useful for chat.`)
  }
  const threadContextBlock = buildConnectorThreadContextBlock(msg, { isFirstThreadTurn: wasCreated })
  if (threadContextBlock) promptParts.push(threadContextBlock)
  // Add connector context
  promptParts.push(`\nYou are receiving messages via ${msg.platform}. The user "${msg.senderName}" is messaging from channel "${msg.channelName || msg.channelId}". Respond naturally and conversationally.

## Response Style
Be action-first and autonomous: when the user gives an instruction, execute it instead of asking routine follow-up questions.
Do not end every reply with a question.
Only ask a question when a specific missing detail blocks progress.
When a task is complete, state the result plainly and stop.

## Async Update Routing
When you start work that may finish later (task, schedule, delegated run), tell the user where updates will be sent.
Default to this same ${msg.platform} chat unless the user requested another destination.
If channel preference is ambiguous and there are multiple reasonable destinations, ask one short routing question.

## Knowing When Not to Reply
Real conversations have natural pauses — not every message needs a response. Reply with exactly "NO_MESSAGE" (nothing else) to stay silent when replying would feel unnatural or forced.
Stay silent for simple acknowledgments ("okay", "alright", "cool", "got it", "sounds good"), conversation closers ("thanks", "bye", "night", "ttyl"), reactions (emoji, "haha", "lol"), and forwarded content with no question attached.
Always reply when there's a question, task, instruction, emotional sharing, or something genuinely useful to add.
The test: would a thoughtful friend feel compelled to type something back? If not, NO_MESSAGE.

## Media Delivery Rules
When the user asks to send media (image, screenshot, PDF, file, or voice note), actually call tools to send it.
Do not claim "sent" unless a tool call succeeded.
If voice note is requested, prefer connector_message_tool action=send_voice_note when available.
If media sending fails, report the exact error and retry with a corrected path/target.`)
  const systemPrompt = promptParts.join('\n\n')

  // Add message to session
  const firstImage = msg.media?.find((m) => m.type === 'image')
  const firstImageUrl = msg.imageUrl || (firstImage?.url) || undefined
  const firstImagePath = firstImage?.localPath || undefined
  const inboundAttachmentPaths = buildInboundAttachmentPaths(msg)
  const inboundText = formatInboundUserText(msg)
  const modelInputText = inboundText
  // Store the raw user text for display (source.senderName handles attribution).
  // The formatted text with [SenderName] prefix is only used for LLM history context.
  const rawText = (msg.text || '').trim()
  const messageSource: MessageSource = {
    platform: connector.platform,
    connectorId: connector.id,
    connectorName: connector.name,
    channelId: msg.channelId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    messageId: msg.messageId,
    replyToMessageId: msg.replyToMessageId,
    threadId: msg.threadId,
  }
  session.messages.push({
    role: 'user',
    text: rawText || inboundText,
    time: Date.now(),
    imageUrl: firstImageUrl,
    imagePath: firstImagePath,
    attachedFiles: inboundAttachmentPaths.length ? inboundAttachmentPaths : undefined,
    source: messageSource,
  })
  session.lastActiveAt = Date.now()
  updateSessionConnectorContext(session, connector, msg, sessionKey)
  persistSessionRecord(session)
  notify(`messages:${session.id}`)

  // Stream the response
  let fullText = ''
  let mediaExtractionText = ''
  let connectorToolDeliveredCurrentChannel = false
  let connectorToolDeliveredMessageId: string | undefined
  const hasTools = session.plugins?.length && session.provider !== 'claude-cli'
  console.log(`[connector] Routing message to agent "${agent.name}" (${session.provider}/${session.model}), hasTools=${!!hasTools}`)

  if (hasTools) {
    try {
      const toolMediaOutputs: string[] = []
      const result = await streamAgentChat({
        session: session as Session,
        message: modelInputText,
        imagePath: firstImagePath,
        attachedFiles: inboundAttachmentPaths.length ? inboundAttachmentPaths : undefined,
        apiKey,
        systemPrompt,
        write: (raw) => {
          for (const event of parseSseDataEvents(raw)) {
            if (event.t !== 'tool_result') continue
            const toolOutput = typeof event.toolOutput === 'string' ? event.toolOutput : ''
            if (!toolOutput) continue
            toolMediaOutputs.push(toolOutput)
            if (event.toolName === 'connector_message_tool') {
              const parsed = parseConnectorToolResult(toolOutput)
              if (!parsed?.status || !parsed.to) continue
              const sentLikeStatus = parsed.status === 'sent' || parsed.status === 'voice_sent'
              if (!sentLikeStatus) continue
              const inboundTarget = connector.platform === 'whatsapp'
                ? normalizeWhatsappTarget(msg.channelId)
                : msg.channelId
              const outboundTarget = connector.platform === 'whatsapp'
                ? normalizeWhatsappTarget(parsed.to)
                : parsed.to
              if (inboundTarget && outboundTarget && inboundTarget === outboundTarget) {
                connectorToolDeliveredCurrentChannel = true
                if (parsed.messageId) connectorToolDeliveredMessageId = parsed.messageId
              }
            }
          }
        },
        history: session.messages.slice(-20),
      })
      // Use finalResponse for connectors — strips intermediate planning/tool-use text
      fullText = result.finalResponse || result.fullText
      mediaExtractionText = [result.fullText || '', ...toolMediaOutputs].filter(Boolean).join('\n\n')
      console.log(`[connector] streamAgentChat returned ${result.fullText.length} chars total, ${fullText.length} chars final`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[connector] streamAgentChat error:`, message)
      return `[Error] ${message}`
    }
  } else {
    // Use the provider directly
    const { getProvider } = await import('../../providers')
    const provider = getProvider(session.provider)
    if (!provider) return '[Error] Provider not found.'

    await provider.handler.streamChat({
      session: session as Session,
      message: modelInputText,
      imagePath: firstImagePath,
      apiKey,
      systemPrompt,
      write: (data: string) => {
        if (data.startsWith('data: ')) {
          try {
            const event = JSON.parse(data.slice(6))
            if (event.t === 'd') fullText += event.text || ''
            else if (event.t === 'r') fullText = event.text || ''
          } catch { /* ignore */ }
        }
      },
      active: new Map(),
      loadHistory: () => session.messages.slice(-20),
    })
    mediaExtractionText = fullText
  }

  // If the agent chose NO_MESSAGE, skip saving it to history — the user's message
  // is already recorded, and saving the sentinel would pollute the LLM's context
  if (isNoMessage(fullText)) {
    if (connectorToolDeliveredCurrentChannel) {
      session.connectorContext = {
        ...(session.connectorContext || {}),
        lastOutboundAt: Date.now(),
        lastOutboundMessageId: connectorToolDeliveredMessageId || session.connectorContext?.lastOutboundMessageId || null,
      }
      persistSessionRecord(session)
      await maybeSendStatusReaction(connector, msg, 'sent')
    } else {
      await maybeSendStatusReaction(connector, msg, 'silent')
    }
    console.log(`[connector] Agent returned NO_MESSAGE — suppressing outbound reply`)
    logExecution(session.id, 'decision', 'Agent suppressed outbound (NO_MESSAGE)', {
      agentId: agent.id,
      detail: { platform: msg.platform, channelId: msg.channelId },
    })
    return NO_MESSAGE_SENTINEL
  }

  // Log outbound message
  logExecution(session.id, 'outbound', `Reply sent via ${msg.platform}`, {
    agentId: agent.id,
    detail: {
      platform: msg.platform,
      channelId: msg.channelId,
      recipientName: msg.senderName,
      responsePreview: fullText.slice(0, 500),
      responseLength: fullText.length,
    },
  })

  // Save assistant response to session (full text with image markdown for web UI rendering)
  const assistantSource: MessageSource = {
    platform: connector.platform,
    connectorId: connector.id,
    connectorName: connector.name,
    channelId: msg.channelId,
    replyToMessageId: msg.messageId,
    threadId: msg.threadId,
  }
  if (fullText.trim()) {
    session.messages.push({ role: 'assistant', text: fullText.trim(), time: Date.now(), source: assistantSource })
    session.lastActiveAt = Date.now()
    persistSessionRecord(session)
    notify(`messages:${session.id}`)
  }

  // Extract embedded media (screenshots, uploaded files) and send them as separate
  // media messages via the connector, then return the cleaned text
  const extractedFromReply = extractEmbeddedMedia(fullText)
  const extractedFromTools = mediaExtractionText && mediaExtractionText !== fullText
    ? extractEmbeddedMedia(mediaExtractionText)
    : { cleanText: mediaExtractionText || fullText, files: [] as Array<{ path: string; alt: string }> }
  const filesToSend = selectOutboundMediaFiles(
    [...extractedFromReply.files, ...extractedFromTools.files],
    msg.text || '',
  )

  if (filesToSend.length > 0) {
    const inst = running.get(connector.id)
    if (inst?.sendMessage) {
      const replyOptions = getConnectorReplySendOptions({ connectorId: connector.id, inbound: msg })
      for (const file of filesToSend) {
        try {
          await sendConnectorMessage({
            connectorId: connector.id,
            channelId: msg.channelId,
            text: '',
            sessionId: session.id,
            mediaPath: file.path,
            caption: file.alt || undefined,
            replyToMessageId: replyOptions.replyToMessageId,
            threadId: replyOptions.threadId,
          })
          console.log(`[connector] Sent media to ${msg.platform}: ${path.basename(file.path)}`)
          logExecution(session.id, 'outbound', 'Connector media sent', {
            agentId: agent.id,
            detail: {
              platform: msg.platform,
              channelId: msg.channelId,
              filePath: file.path,
              fileName: path.basename(file.path),
            },
          })
        } catch (err: unknown) {
          console.error(`[connector] Failed to send media ${path.basename(file.path)}:`, err instanceof Error ? err.message : String(err))
          logExecution(session.id, 'error', 'Connector media send failed', {
            agentId: agent.id,
            detail: {
              platform: msg.platform,
              channelId: msg.channelId,
              filePath: file.path,
              fileName: path.basename(file.path),
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
    } else {
      logExecution(session.id, 'error', 'Connector media skipped: sendMessage unavailable', {
        agentId: agent.id,
        detail: {
          platform: msg.platform,
          channelId: msg.channelId,
          fileCount: filesToSend.length,
          connectorId: connector.id,
        },
      })
    }
    if (connectorToolDeliveredCurrentChannel) return NO_MESSAGE_SENTINEL
    return extractedFromReply.cleanText || '(no response)'
  }

    if (connectorToolDeliveredCurrentChannel) return NO_MESSAGE_SENTINEL
    return fullText || '(no response)'
  } finally {
    stopTyping?.()
  }
}

routeMessageHandlerRef.current = routeMessage

/** Start a connector (serialized per ID to prevent concurrent start/stop races) */
export async function startConnector(connectorId: string): Promise<void> {
  // Wait for any pending operation on this connector to finish (with timeout)
  const pending = locks.get(connectorId)
  if (pending) {
    await Promise.race([pending, new Promise(r => setTimeout(r, 15_000))]).catch(() => {})
    locks.delete(connectorId)
  }

  const op = withTimeout(_startConnectorImpl(connectorId), 30_000, 'Connector start timed out')
  locks.set(connectorId, op)
  try { await op } finally {
    if (locks.get(connectorId) === op) locks.delete(connectorId)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

async function _startConnectorImpl(connectorId: string): Promise<void> {
  // If already running, stop it first (handles stale entries)
  if (running.has(connectorId)) {
    try {
      const existing = running.get(connectorId)
      await existing?.stop()
    } catch { /* ignore cleanup errors */ }
    running.delete(connectorId)
  }

  const connectors = loadConnectors()
  const connector = connectors[connectorId] as Connector | undefined
  if (!connector) throw new Error('Connector not found')

  // Starting a connector expresses durable intent: keep it enabled across
  // transient failures so daemon recovery and server restarts can retry it.
  if (connector.isEnabled !== true) {
    connector.isEnabled = true
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
  }

  try {
    // Resolve bot token from credential
    let botToken = ''
    if (connector.credentialId) {
      const creds = loadCredentials()
      const cred = creds[connector.credentialId]
      if (cred?.encryptedKey) {
        try { botToken = decryptKey(cred.encryptedKey) } catch { /* ignore */ }
      }
    }
    // Also check config for inline token (some platforms)
    if (!botToken && connector.config.botToken) {
      botToken = connector.config.botToken
    }
    if (!botToken && connector.platform === 'bluebubbles' && connector.config.password) {
      botToken = connector.config.password
    }

    if (!botToken && connector.platform !== 'whatsapp' && connector.platform !== 'openclaw' && connector.platform !== 'signal' && connector.platform !== 'email') {
      throw new Error('No bot token configured')
    }

    const platform = await getPlatform(connector.platform)

    // Bump generation counter so stale events from previous instances are ignored
    generationCounter.set(connectorId, (generationCounter.get(connectorId) ?? 0) + 1)

    const instance = await platform.start(
      connector,
      botToken,
      (msg) => dispatchInboundConnectorMessage(connectorId, connector, msg),
    )
    running.set(connectorId, instance)

    // Update status in storage
    connector.status = 'running'
    connector.isEnabled = true
    connector.lastError = null
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    clearReconnectState(connectorId)
    notify('connectors')

    console.log(`[connector] Started ${connector.platform} connector: ${connector.name}`)
    recordHealthEvent(connectorId, 'started', `${connector.platform} connector "${connector.name}" started`)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    connector.status = 'error'
    connector.isEnabled = true
    connector.lastError = errMsg
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
    recordHealthEvent(connectorId, 'error', errMsg)
    throw err
  }
}

/** Stop a connector */
export async function stopConnector(connectorId: string): Promise<void> {
  const instance = running.get(connectorId)
  if (instance) {
    await instance.stop()
    running.delete(connectorId)
  }
  clearReconnectState(connectorId)

  for (const [debounceKey, entry] of pendingInboundDebounce.entries()) {
    if (entry.connector.id !== connectorId) continue
    clearTimeout(entry.timer)
    pendingInboundDebounce.delete(debounceKey)
  }

  for (const [followupId, followup] of scheduledFollowups.entries()) {
    if (followup.connectorId !== connectorId) continue
    clearTimeout(followup.timer)
    scheduledFollowups.delete(followupId)
  }
  for (const [key, entry] of scheduledFollowupByDedupe.entries()) {
    if (!scheduledFollowups.has(entry.id)) {
      scheduledFollowupByDedupe.delete(key)
    }
  }

  const connectors = loadConnectors()
  const connector = connectors[connectorId]
  if (connector) {
    connector.status = 'stopped'
    connector.isEnabled = false
    connector.lastError = null
    connector.updatedAt = Date.now()
    connectors[connectorId] = connector
    saveConnectors(connectors)
    notify('connectors')
  }

  console.log(`[connector] Stopped connector: ${connectorId}`)
  recordHealthEvent(connectorId, 'stopped', `Connector stopped`)
}

/** Get the runtime status of a connector */
export function getConnectorStatus(connectorId: string): 'running' | 'stopped' {
  return running.has(connectorId) ? 'running' : 'stopped'
}

/** Get the QR code data URL for a WhatsApp connector (null if not available) */
export function getConnectorQR(connectorId: string): string | null {
  const instance = running.get(connectorId)
  return instance?.qrDataUrl ?? null
}

/** Check if a WhatsApp connector has authenticated (paired) */
export function isConnectorAuthenticated(connectorId: string): boolean {
  const instance = running.get(connectorId)
  if (!instance) return false
  return instance.authenticated === true
}

/** Check if a WhatsApp connector has stored credentials */
export function hasConnectorCredentials(connectorId: string): boolean {
  const instance = running.get(connectorId)
  if (!instance) return false
  return instance.hasCredentials === true
}

/** Clear WhatsApp auth state and restart connector for fresh QR pairing */
export async function repairConnector(connectorId: string): Promise<void> {
  // Stop existing instance
  const instance = running.get(connectorId)
  if (instance) {
    await instance.stop()
    running.delete(connectorId)
  }
  clearReconnectState(connectorId)

  // Clear auth directory
  const { clearAuthDir } = await import('./whatsapp')
  clearAuthDir(connectorId)

  // Restart the connector — will get fresh QR
  await startConnector(connectorId)
}

/** Stop all running connectors (for cleanup) */
export async function stopAllConnectors(): Promise<void> {
  for (const [id] of running) {
    await stopConnector(id)
  }
}

/** Auto-start connectors that are marked as enabled (skips already-running ones) */
export async function autoStartConnectors(): Promise<void> {
  const connectors = loadConnectors()
  for (const connector of Object.values(connectors) as Connector[]) {
    if (connector.isEnabled && !running.has(connector.id)) {
      try {
        console.log(`[connector] Auto-starting ${connector.platform} connector: ${connector.name}`)
        await startConnector(connector.id)
      } catch (err: unknown) {
        console.error(`[connector] Failed to auto-start ${connector.name}:`, err instanceof Error ? err.message : err)
      }
    }
  }
}

/** List connector IDs that are currently running (optionally by platform) */
export function listRunningConnectors(platform?: string): Array<{
  id: string
  name: string
  platform: string
  agentId: string | null
  supportsSend: boolean
  configuredTargets: string[]
  recentChannelId: string | null
}> {
  const connectors = loadConnectors()
  const out: Array<{
    id: string
    name: string
    platform: string
    agentId: string | null
    supportsSend: boolean
    configuredTargets: string[]
    recentChannelId: string | null
  }> = []

  for (const [id, instance] of running.entries()) {
    const connector = connectors[id] as Connector | undefined
    if (!connector) continue
    if (platform && connector.platform !== platform) continue
    const configuredTargets: string[] = []
    if (connector.platform === 'whatsapp') {
      const outboundJid = connector.config?.outboundJid?.trim()
      if (outboundJid) configuredTargets.push(outboundJid)
      const allowed = connector.config?.allowedJids?.split(',').map((s) => s.trim()).filter(Boolean) || []
      configuredTargets.push(...allowed)
    } else if (connector.platform === 'bluebubbles') {
      const outbound = connector.config?.outboundTarget?.trim()
      if (outbound) configuredTargets.push(outbound)
      const allowed = connector.config?.allowFrom?.split(',').map((s) => s.trim()).filter(Boolean) || []
      configuredTargets.push(...allowed)
    }
    out.push({
      id,
      name: connector.name,
      platform: connector.platform,
      agentId: connector.agentId || null,
      supportsSend: typeof instance.sendMessage === 'function',
      configuredTargets: Array.from(new Set(configuredTargets)),
      recentChannelId: lastInboundChannelByConnector.get(id) || null,
    })
  }

  return out
}

/** Get the most recent inbound channel id seen for a connector */
export function getConnectorRecentChannelId(connectorId: string): string | null {
  return lastInboundChannelByConnector.get(connectorId) || null
}

/** Get presence info for a connector */
export function getConnectorPresence(connectorId: string): { lastMessageAt: number | null; channelId: string | null } {
  return {
    lastMessageAt: lastInboundTimeByConnector.get(connectorId) ?? null,
    channelId: lastInboundChannelByConnector.get(connectorId) ?? null,
  }
}

/** Get a running connector instance (internal use for rich messaging). */
export function getRunningInstance(connectorId: string): ConnectorInstance | undefined {
  return running.get(connectorId)
}

export function getConnectorReplySendOptions(params: {
  connectorId: string
  inbound: InboundMessage
}): { replyToMessageId?: string; threadId?: string } {
  const connectors = loadConnectors()
  const connector = connectors[params.connectorId] as Connector | undefined
  if (!connector) return {}
  const session = findDirectSessionForInbound(connector, params.inbound)
  const policy = resolveConnectorSessionPolicy(connector, params.inbound, session)
  return shouldReplyToInboundMessage({
    msg: params.inbound,
    session,
    policy,
  })
}

export async function recordConnectorOutboundDelivery(params: {
  connectorId: string
  inbound: InboundMessage
  messageId?: string
  state?: 'sent' | 'silent'
}): Promise<void> {
  const connectors = loadConnectors()
  const connector = connectors[params.connectorId] as Connector | undefined
  if (!connector) return
  const session = findDirectSessionForInbound(connector, params.inbound)
  if (session) {
    session.connectorContext = {
      ...(session.connectorContext || {}),
      lastOutboundAt: Date.now(),
      lastOutboundMessageId: params.messageId || session.connectorContext?.lastOutboundMessageId || null,
      threadId: params.inbound.threadId || session.connectorContext?.threadId || null,
    }
    const history = Array.isArray(session.messages) ? session.messages : []
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const entry = history[i]
      if (entry?.role !== 'assistant') continue
      const source: Partial<MessageSource> = entry?.source || {}
      if (source.connectorId !== connector.id) continue
      if (source.channelId !== params.inbound.channelId) continue
      if (!source.messageId && params.messageId) {
        entry.source = {
          platform: source.platform || connector.platform,
          connectorId: source.connectorId || connector.id,
          connectorName: source.connectorName || connector.name,
          channelId: source.channelId || params.inbound.channelId,
          senderId: source.senderId,
          senderName: source.senderName,
          messageId: params.messageId,
          replyToMessageId: source.replyToMessageId || params.inbound.messageId,
          threadId: source.threadId || params.inbound.threadId,
        }
      }
      break
    }
    persistSessionRecord(session)
    notify(`messages:${session.id}`)
  }
  if (params.state) {
    await maybeSendStatusReaction(connector, params.inbound, params.state)
  }
}

export async function performConnectorMessageAction(params: {
  connectorId?: string
  platform?: string
  channelId: string
  action: 'react' | 'edit' | 'delete' | 'pin'
  messageId?: string
  emoji?: string
  text?: string
  sessionId?: string | null
  targetMessage?: 'last_inbound' | 'last_outbound'
}): Promise<{ connectorId: string; platform: string; channelId: string; messageId?: string }> {
  const connectors = loadConnectors()
  const requestedId = params.connectorId?.trim()
  let connector: Connector | undefined
  let connectorId: string | undefined

  if (requestedId) {
    connector = connectors[requestedId] as Connector | undefined
    connectorId = requestedId
    if (!connector) throw new Error(`Connector not found: ${requestedId}`)
  } else {
    const candidates = Object.values(connectors) as Connector[]
    const filtered = candidates.filter((item) => (!params.platform || item.platform === params.platform) && running.has(item.id))
    if (!filtered.length) throw new Error(`No running connector found${params.platform ? ` for platform "${params.platform}"` : ''}.`)
    connector = filtered[0]
    connectorId = connector.id
  }

  if (!connector || !connectorId) throw new Error('Connector resolution failed.')
  const instance = running.get(connectorId)
  if (!instance) throw new Error(`Connector "${connectorId}" is not running.`)

  const targetMessageId = (() => {
    if (params.messageId?.trim()) return params.messageId.trim()
    if (!params.sessionId) return ''
    const session = loadSessions()[params.sessionId]
    if (!session) return ''
    if (params.targetMessage === 'last_inbound') return session.connectorContext?.lastInboundMessageId || ''
    if (params.targetMessage === 'last_outbound' || !params.targetMessage) return session.connectorContext?.lastOutboundMessageId || ''
    return ''
  })()
  if (!targetMessageId) throw new Error('messageId is required for connector message actions.')

  switch (params.action) {
    case 'react':
      if (!instance.sendReaction) throw new Error(`Connector "${connector.name}" does not support reactions.`)
      if (!params.emoji?.trim()) throw new Error('emoji is required for react action.')
      await instance.sendReaction(params.channelId, targetMessageId, params.emoji.trim())
      break
    case 'edit':
      if (!instance.editMessage) throw new Error(`Connector "${connector.name}" does not support edits.`)
      if (!params.text?.trim()) throw new Error('text is required for edit action.')
      await instance.editMessage(params.channelId, targetMessageId, params.text.trim())
      break
    case 'delete':
      if (!instance.deleteMessage) throw new Error(`Connector "${connector.name}" does not support deletes.`)
      await instance.deleteMessage(params.channelId, targetMessageId)
      break
    case 'pin':
      if (!instance.pinMessage) throw new Error(`Connector "${connector.name}" does not support pinning.`)
      await instance.pinMessage(params.channelId, targetMessageId)
      break
  }

  return {
    connectorId,
    platform: connector.platform,
    channelId: params.channelId,
    messageId: targetMessageId,
  }
}

/**
 * Send an outbound message through a running connector.
 * Intended for proactive agent notifications (e.g. WhatsApp updates).
 */
export async function sendConnectorMessage(params: {
  connectorId?: string
  platform?: string
  channelId: string
  text: string
  sessionId?: string | null
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  ptt?: boolean
}): Promise<{ connectorId: string; platform: string; channelId: string; messageId?: string }> {
  const connectors = loadConnectors()
  const requestedId = params.connectorId?.trim()
  let connector: Connector | undefined
  let connectorId: string | undefined

  if (requestedId) {
    connector = connectors[requestedId] as Connector | undefined
    connectorId = requestedId
    if (!connector) throw new Error(`Connector not found: ${requestedId}`)
  } else {
    const candidates = Object.values(connectors) as Connector[]
    const filtered = candidates.filter((c) => {
      if (params.platform && c.platform !== params.platform) return false
      return running.has(c.id)
    })
    if (!filtered.length) {
      throw new Error(`No running connector found${params.platform ? ` for platform "${params.platform}"` : ''}.`)
    }
    connector = filtered[0]
    connectorId = connector.id
  }

  if (!connector || !connectorId) throw new Error('Connector resolution failed.')

  const instance = running.get(connectorId)
  if (!instance) {
    throw new Error(`Connector "${connectorId}" is not running.`)
  }
  if (typeof instance.sendMessage !== 'function') {
    throw new Error(`Connector "${connector.name}" (${connector.platform}) does not support outbound sends.`)
  }

  // Apply NO_MESSAGE filter at the delivery layer so all outbound paths respect it
  if (isNoMessage(params.text) && !params.imageUrl && !params.fileUrl && !params.mediaPath) {
    console.log(`[connector] sendConnectorMessage: NO_MESSAGE — suppressing outbound send`)
    return { connectorId, platform: connector.platform, channelId: params.channelId }
  }

  const hasMedia = !!(params.imageUrl || params.fileUrl || params.mediaPath)
  const channelId = connector.platform === 'whatsapp'
    ? normalizeWhatsappTarget(params.channelId)
    : params.channelId

  let outboundText = params.text || ''
  let outboundOptions: Parameters<NonNullable<ConnectorInstance['sendMessage']>>[2] | undefined = {
    imageUrl: params.imageUrl,
    fileUrl: params.fileUrl,
    mediaPath: params.mediaPath,
    mimeType: params.mimeType,
    fileName: params.fileName,
    caption: params.caption,
    replyToMessageId: params.replyToMessageId,
    threadId: params.threadId,
    ptt: params.ptt,
  }

  if (hasMedia && !connectorSupportsBinaryMedia(connector.platform)) {
    const mediaLink = params.imageUrl
      || params.fileUrl
      || (params.mediaPath ? uploadApiUrlFromPath(params.mediaPath) : null)
    const fallbackParts = [
      (params.text || '').trim(),
      (params.caption || '').trim(),
      mediaLink ? `Attachment: ${mediaLink}` : '',
      !mediaLink && params.mediaPath ? `Attachment: ${path.basename(params.mediaPath)}` : '',
    ].filter(Boolean)
    outboundText = fallbackParts.join('\n')
    outboundOptions = undefined
  }

  const result = await instance.sendMessage(channelId, outboundText, outboundOptions)
  if (params.sessionId) {
    const sessions = loadSessions()
    const session = sessions[params.sessionId]
    if (session) {
      session.connectorContext = {
        ...(session.connectorContext || {}),
        connectorId,
        platform: connector.platform,
        channelId,
        threadId: params.threadId || session.connectorContext?.threadId || null,
        lastOutboundAt: Date.now(),
        lastOutboundMessageId: result?.messageId || session.connectorContext?.lastOutboundMessageId || null,
      }
      const history = Array.isArray(session.messages) ? session.messages : []
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i]
        if (entry?.role !== 'assistant') continue
        const source: Partial<MessageSource> = entry?.source || {}
        if (source.connectorId !== connectorId) continue
        if (source.channelId !== channelId) continue
        if (!source.messageId && result?.messageId) {
          entry.source = {
            ...source,
            messageId: result.messageId,
            threadId: source.threadId || params.threadId,
            replyToMessageId: source.replyToMessageId || params.replyToMessageId,
          }
        }
        break
      }
      sessions[session.id] = session
      saveSessions(sessions)
      notify(`messages:${session.id}`)
    }
  }
  return {
    connectorId,
    platform: connector.platform,
    channelId,
    messageId: result?.messageId,
  }
}

export function scheduleConnectorFollowUp(params: {
  connectorId?: string
  platform?: string
  channelId: string
  text: string
  delaySec?: number
  dedupeKey?: string
  replaceExisting?: boolean
  sessionId?: string | null
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  ptt?: boolean
}): { followUpId: string; sendAt: number } {
  const delaySecRaw = Number.isFinite(params.delaySec) ? Number(params.delaySec) : 300
  const delayMs = Math.max(1_000, Math.min(86_400_000, Math.round(delaySecRaw * 1000)))
  const dedupeKey = params.dedupeKey || [
    params.connectorId || params.platform || '',
    params.channelId,
    params.threadId || '',
    (params.text || '').trim().slice(0, 160),
  ].join('|')
  const existing = scheduledFollowupByDedupe.get(dedupeKey)
  if (existing && existing.sendAt > Date.now() && !params.replaceExisting) {
    return { followUpId: existing.id, sendAt: existing.sendAt }
  }
  if (existing && params.replaceExisting) {
    const scheduled = scheduledFollowups.get(existing.id)
    if (scheduled) {
      clearTimeout(scheduled.timer)
      scheduledFollowups.delete(existing.id)
    }
    scheduledFollowupByDedupe.delete(dedupeKey)
  }
  const followUpId = genId()
  const sendAt = Date.now() + delayMs

  const timer = setTimeout(() => {
    void sendConnectorMessage({
      connectorId: params.connectorId,
      platform: params.platform,
      channelId: params.channelId,
      text: params.text,
      sessionId: params.sessionId,
      imageUrl: params.imageUrl,
      fileUrl: params.fileUrl,
      mediaPath: params.mediaPath,
      mimeType: params.mimeType,
      fileName: params.fileName,
      caption: params.caption,
      replyToMessageId: params.replyToMessageId,
      threadId: params.threadId,
      ptt: params.ptt,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[connector] Scheduled follow-up ${followUpId} failed: ${msg}`)
    }).finally(() => {
      scheduledFollowups.delete(followUpId)
      if (scheduledFollowupByDedupe.get(dedupeKey)?.id === followUpId) {
        scheduledFollowupByDedupe.delete(dedupeKey)
      }
    })
  }, delayMs)

  scheduledFollowups.set(followUpId, {
    id: followUpId,
    connectorId: params.connectorId,
    platform: params.platform,
    channelId: params.channelId,
    sendAt,
    timer,
  })
  scheduledFollowupByDedupe.set(dedupeKey, { id: followUpId, sendAt })

  return { followUpId, sendAt }
}

/**
 * Check health of all running connectors via `isAlive()`.
 * Dead connectors that are still enabled get automatic reconnection with exponential backoff.
 * After RECONNECT_MAX_ATTEMPTS, the connector is marked as error and retries stop.
 */
export async function checkConnectorHealth(): Promise<void> {
  const connectors = loadConnectors()
  let connectorsDirty = false

  for (const [id, instance] of running.entries()) {
    // If the instance has no isAlive method, skip (e.g. OpenClaw, BlueBubbles)
    if (typeof instance.isAlive !== 'function') continue

    if (instance.isAlive()) {
      // Connector is healthy — clear any reconnect state
      if (reconnectState.has(id)) {
        console.log(`[connector-health] Connector "${instance.connector.name}" recovered`)
        clearReconnectState(id)
      }
      continue
    }

    // Connector is dead but still in the running Map
    console.warn(`[connector-health] Connector "${instance.connector.name}" (${id}) isAlive=false — removing from running`)
    recordHealthEvent(id, 'disconnected', `Connector "${instance.connector.name}" detected as dead (isAlive=false)`)

    // Clean up the dead instance
    try { await instance.stop() } catch { /* ignore */ }
    running.delete(id)

    const connector = connectors[id] as Connector | undefined
    if (!connector) continue

    // If the connector is not enabled, don't attempt reconnect
    if (!connector.isEnabled) {
      clearReconnectState(id)
      continue
    }

    connector.status = 'error'
    connector.lastError = connector.lastError || 'Connection lost'
    connector.updatedAt = Date.now()
    connectors[id] = connector
    connectorsDirty = true
    if (!reconnectState.has(id)) {
      setReconnectState(id, createConnectorReconnectState({
        error: connector.lastError || 'Connection lost',
      }))
    }
  }

  if (connectorsDirty) {
    saveConnectors(connectors)
    notify('connectors')
  }

  // Purge reconnect state for connectors that no longer exist
  for (const id of reconnectState.keys()) {
    if (!connectors[id] || connectors[id]?.isEnabled !== true || running.has(id)) clearReconnectState(id)
  }
}

/** Get the reconnect state for a specific connector (null if not in reconnect cycle) */
export function getReconnectState(connectorId: string): ConnectorReconnectState | null {
  return reconnectState.get(connectorId) ?? null
}

/** Get all reconnect states (for dashboard/API) */
export function getAllReconnectStates(): Record<string, ConnectorReconnectState> {
  const result: Record<string, ConnectorReconnectState> = {}
  for (const [id, state] of reconnectState.entries()) {
    result[id] = { ...state }
  }
  return result
}
