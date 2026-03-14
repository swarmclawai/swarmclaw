import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import path from 'path'
import fs from 'fs'
import { loadConnectors, loadSettings, UPLOAD_DIR } from '../storage'
import type { ToolBuildContext } from './context'
import type { Connector, Plugin, PluginHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { safeJsonParseObject } from '../json-utils'
import { tryResolvePathWithinBaseDir } from '../path-utils'
import { dedup, errorMessage } from '@/lib/shared-utils'
import { isDirectConnectorSession } from '../connectors/session-kind'
import {
  prepareConnectorVoiceNotePayload,
  resolveConnectorVoiceId,
} from '../connectors/voice-note'

export { resolveConnectorVoiceId } from '../connectors/voice-note'

const CONNECTOR_ACTION_DEDUPE_TTL_MS = 30_000
const CONNECTOR_TURN_SEND_TTL_MS = 180_000
const AUTONOMOUS_OUTREACH_COOLDOWN_MS = 2 * 60 * 60 * 1000
const recentConnectorActionCache = new Map<string, { at: number; result: string }>()
const connectorTurnReplayCache = new Map<string, { at: number; result: string }>()
const connectorTurnRecipientReplayCache = new Map<string, { at: number; result: string }>()
const autonomousOutreachBudget = new Map<string, { at: number; result?: string }>()

export const CONNECTOR_MESSAGE_TOOL_ACTIONS = [
  'list_running',
  'list_targets',
  'start',
  'stop',
  'send',
  'send_voice_note',
  'schedule_followup',
  'react',
  'edit',
  'delete',
  'pin',
  'message_react',
  'message_edit',
  'message_delete',
  'message_pin',
] as const

export const CONNECTOR_MESSAGE_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...CONNECTOR_MESSAGE_TOOL_ACTIONS] },
    connectorId: { type: 'string' },
    connector: { type: 'string' },
    connector_id: { type: 'string' },
    runningConnectorId: { type: 'string' },
    id: { type: 'string' },
    platform: { type: 'string' },
    to: { type: 'string' },
    channel: { type: 'string' },
    channelId: { type: 'string' },
    recipientId: { type: 'string' },
    phoneNumber: { type: 'string' },
    configuredTarget: { type: 'string' },
    target: { type: 'string' },
    recipient: { type: 'string' },
    path: { type: 'string' },
    targets: { type: 'string' },
    message: { type: 'string' },
    text: { type: 'string' },
    content: { type: 'string' },
    body: { type: 'string' },
    messageId: { type: 'string' },
    targetMessage: { type: 'string', enum: ['last_inbound', 'last_outbound'] },
    emoji: { type: 'string' },
    voiceText: { type: 'string' },
    voiceId: { type: 'string' },
    imageUrl: { type: 'string' },
    fileUrl: { type: 'string' },
    mediaPath: { type: 'string' },
    mimeType: { type: 'string' },
    fileName: { type: 'string' },
    caption: { type: 'string' },
    replyToMessageId: { type: 'string' },
    threadId: { type: 'string' },
    delaySec: { type: 'number' },
    followUpMessage: { type: 'string' },
    followupMessage: { type: 'string' },
    followUpDelaySec: { type: 'number' },
    dedupeKey: { type: 'string' },
    approved: { type: 'boolean' },
    ptt: { type: 'boolean' },
  },
} as const

function buildConnectorMessageToolSchema() {
  const shape = Object.fromEntries(
    Object.entries(CONNECTOR_MESSAGE_TOOL_PARAMETERS.properties).map(([key, definition]) => {
      const enumValues = 'enum' in definition && Array.isArray(definition.enum)
        ? definition.enum
        : null
      if (enumValues && enumValues.length > 0) {
        const tuple = enumValues as unknown as [string, ...string[]]
        return [key, z.enum(tuple).optional()]
      }
      if (definition.type === 'number') return [key, z.number().optional()]
      if (definition.type === 'boolean') return [key, z.boolean().optional()]
      return [key, z.string().optional()]
    }),
  ) as Record<string, z.ZodTypeAny>

  return z.object(shape).passthrough()
}

export const CONNECTOR_MESSAGE_TOOL_SCHEMA = buildConnectorMessageToolSchema()

const LEGACY_CONNECTOR_ACTION_ALIASES: Record<string, string> = {
  message_react: 'react',
  message_edit: 'edit',
  message_delete: 'delete',
  message_pin: 'pin',
}

function pruneOldConnectorToolState(now: number): void {
  for (const [key, entry] of recentConnectorActionCache.entries()) {
    if (now - entry.at > CONNECTOR_ACTION_DEDUPE_TTL_MS) recentConnectorActionCache.delete(key)
  }
  for (const [key, entry] of connectorTurnReplayCache.entries()) {
    if (now - entry.at > CONNECTOR_TURN_SEND_TTL_MS) connectorTurnReplayCache.delete(key)
  }
  for (const [key, entry] of connectorTurnRecipientReplayCache.entries()) {
    if (now - entry.at > CONNECTOR_TURN_SEND_TTL_MS) connectorTurnRecipientReplayCache.delete(key)
  }
  for (const [key, entry] of autonomousOutreachBudget.entries()) {
    if (now - entry.at > AUTONOMOUS_OUTREACH_COOLDOWN_MS) autonomousOutreachBudget.delete(key)
  }
}

function parseLatestUserTurn(
  session: { messages?: Array<Record<string, unknown>> } | null | undefined,
): { text: string; time: number } {
  const msgs = Array.isArray(session?.messages) ? session.messages : []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i]
    if (String(msg?.role || '') !== 'user') continue
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    const time = typeof msg.time === 'number' ? msg.time : 0
    return { text, time }
  }
  return { text: '', time: 0 }
}

function userExplicitlyRequestedFollowup(userText: string): boolean {
  if (!userText) return false
  const text = userText.toLowerCase()
  if (/connector_message_tool/.test(text) && /(schedule_followup|followupmessage|followup|delaysec|follow.?up)/.test(text)) return true
  return /\b(follow[ -]?up|check[ -]?in|remind(?: me)?|later|tomorrow|in \d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days))\b/.test(text)
}

function isAutonomousSystemTurn(userText: string): boolean {
  if (!userText) return false
  const text = userText.toUpperCase()
  return text.includes('AGENT_HEARTBEAT_WAKE')
    || text.includes('SWARM_HEARTBEAT_CHECK')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _isSignificantOutreachText(raw: string): boolean {
  const text = (raw || '').trim().toLowerCase()
  if (text.length < 12) return false
  if (/\b(just checking in|checking in|touching base|quick check-in|hope you'?re well|any updates\??)\b/.test(text)) {
    return false
  }
  return /\b(completed|complete|done|finished|failed|failure|error|blocked|urgent|important|deadline|overdue|incident|warning|reminder|birthday|anniversary|milestone|congrats|congratulations|celebrate|payment|invoice|appointment|meeting)\b/.test(text)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _isUrgentOutreachText(raw: string): boolean {
  const text = (raw || '').toLowerCase()
  return /\b(urgent|immediately|asap|critical|incident|outage|failed|failure|blocked|overdue|deadline)\b/.test(text)
}

function buildConnectorActionKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => String(part ?? '')).join('|')
}

export function buildConnectorTurnReplayKey(parts: {
  turnKey: string
  actionName: string
  connectorId: string
  channelId: string
  message?: string
  voiceText?: string
  mediaPath?: string
  imageUrl?: string
  fileUrl?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  followUpMessage?: string
  followUpDelaySec?: number
  delaySec?: number
  dedupeKey?: string
  ptt?: boolean
  voiceId?: string
}): string {
  return buildConnectorActionKey([
    parts.turnKey,
    parts.actionName,
    parts.connectorId,
    parts.channelId,
    parts.message?.trim() || '',
    parts.voiceText?.trim() || '',
    parts.mediaPath?.trim() || '',
    parts.imageUrl?.trim() || '',
    parts.fileUrl?.trim() || '',
    parts.mimeType?.trim() || '',
    parts.fileName?.trim() || '',
    parts.caption?.trim() || '',
    parts.replyToMessageId?.trim() || '',
    parts.threadId?.trim() || '',
    parts.followUpMessage?.trim() || '',
    Number.isFinite(parts.followUpDelaySec) ? Number(parts.followUpDelaySec) : '',
    Number.isFinite(parts.delaySec) ? Number(parts.delaySec) : '',
    parts.dedupeKey?.trim() || '',
    parts.ptt === undefined ? '' : String(parts.ptt),
    parts.voiceId?.trim() || '',
  ])
}

export function buildConnectorTurnRecipientReplayKey(parts: {
  turnKey: string
  actionName: string
  connectorId: string
  channelId?: string
  replyToMessageId?: string
  threadId?: string
  dedupeKey?: string
}): string {
  return buildConnectorActionKey([
    parts.turnKey,
    parts.actionName,
    parts.connectorId,
    parts.channelId?.trim() || '',
    parts.replyToMessageId?.trim() || '',
    parts.threadId?.trim() || '',
    parts.dedupeKey?.trim() || '',
  ])
}

function normalizeDedupedReplayResult(raw: string, fallback: {
  connectorId: string
  platform: string
  to: string
  status?: string
}): string {
  const record = safeJsonParseObject(raw)
  if (record) {
    return JSON.stringify({
      ...record,
      status: typeof record.status === 'string' && record.status.trim() ? record.status : (fallback.status || 'sent'),
      connectorId: String(record.connectorId || fallback.connectorId),
      platform: String(record.platform || fallback.platform),
      to: String(record.to || fallback.to),
      deduped: true,
    })
  }
  return JSON.stringify({
    status: fallback.status || 'sent',
    connectorId: fallback.connectorId,
    platform: fallback.platform,
    to: fallback.to,
    deduped: true,
  })
}

export function normalizeConnectorActionName(action: string): string {
  const normalized = String(action || '').trim()
  return LEGACY_CONNECTOR_ACTION_ALIASES[normalized] || normalized
}

export function inferConnectorActionName(input: Record<string, unknown>): string | null {
  const explicit = typeof input.action === 'string' ? input.action.trim() : ''
  if (explicit) return explicit
  if (typeof input.voiceText === 'string' && input.voiceText.trim()) return 'send_voice_note'
  if (
    typeof input.followUpMessage === 'string'
    || typeof input.followupMessage === 'string'
    || typeof input.followUpDelaySec === 'number'
    || typeof input.delaySec === 'number'
  ) return 'schedule_followup'
  if (
    typeof input.message === 'string'
    || typeof input.text === 'string'
    || typeof input.content === 'string'
    || typeof input.body === 'string'
    || typeof input.mediaPath === 'string'
    || typeof input.imageUrl === 'string'
    || typeof input.fileUrl === 'string'
  ) return 'send'
  return null
}

function pickConnectorString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const picked = pickConnectorString(entry)
      if (picked) return picked
    }
  }
  return null
}

function resolveRunningConnectorId(
  running: Array<{ id?: string; name?: string }>,
  value: unknown,
): string | null {
  const candidate = pickConnectorString(value)
  if (!candidate) return null
  const matched = running.find((connector) => (
    String(connector.id || '').trim() === candidate
    || String(connector.name || '').trim() === candidate
  ))
  return matched ? String(matched.id || '').trim() || null : null
}

export function normalizeConnectorActionInputAliases(
  input: Record<string, unknown>,
  running: Array<{ id?: string; name?: string }> = [],
): Record<string, unknown> {
  const normalized = { ...input }
  const actionName = normalizeConnectorActionName(inferConnectorActionName(normalized) || String(normalized.action || ''))
  const messageActionUsesRawId = actionName === 'react'
    || actionName === 'edit'
    || actionName === 'delete'
    || actionName === 'pin'
  const messageAlias = pickConnectorString(
    normalized.message
    ?? normalized.text
    ?? normalized.content
    ?? normalized.body,
  )
  if (!pickConnectorString(normalized.message) && messageAlias) {
    normalized.message = messageAlias
  }

  const followUpAlias = pickConnectorString(
    normalized.followUpMessage
    ?? normalized.followupMessage,
  )
  if (!pickConnectorString(normalized.followUpMessage) && followUpAlias) {
    normalized.followUpMessage = followUpAlias
  }

  const rawId = pickConnectorString(normalized.id)
  const explicitConnectorId = pickConnectorString(
    normalized.connectorId
    ?? normalized.runningConnectorId
    ?? normalized.connector
    ?? normalized.connector_id,
  )
  const aliasConnectorId = explicitConnectorId
    ? resolveRunningConnectorId(running, explicitConnectorId) || explicitConnectorId
    : resolveRunningConnectorId(running, normalized.channel) || resolveRunningConnectorId(running, rawId)

  if (!pickConnectorString(normalized.connectorId) && aliasConnectorId) {
    normalized.connectorId = aliasConnectorId
  }

  const rawIdIsConnector = !!(rawId && resolveRunningConnectorId(running, rawId))
  if (!pickConnectorString(normalized.messageId) && rawId && !rawIdIsConnector && messageActionUsesRawId) {
    normalized.messageId = rawId
  }
  const targetAlias = pickConnectorString(
    normalized.to
    ?? normalized.channelId
    ?? normalized.recipientId
    ?? normalized.phoneNumber
    ?? normalized.configuredTarget
    ?? normalized.target
    ?? normalized.recipient
    ?? normalized.path
    ?? normalized.targets,
  )

  if (!pickConnectorString(normalized.to)) {
    if (targetAlias) {
      normalized.to = targetAlias
    } else if (rawId && !rawIdIsConnector && !messageActionUsesRawId) {
      normalized.to = rawId
    }
  }

  return normalized
}

/** Resolve /api/uploads/filename URLs to actual disk paths */
function resolveUploadUrl(url: string | undefined): { mediaPath: string; mimeType?: string } | null {
  if (!url) return null
  const match = url.match(/^\/api\/uploads\/([^?#]+)/)
  if (!match) return null
  let decoded: string
  try { decoded = decodeURIComponent(match[1]) } catch { decoded = match[1] }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  const filePath = path.join(UPLOAD_DIR, safeName)
  if (!fs.existsSync(filePath)) return null
  return { mediaPath: filePath }
}

function normalizeWhatsAppTarget(input: string): string {
  const raw = input.trim()
  if (!raw) return raw
  if (raw.includes('@')) return raw
  let cleaned = raw.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
  if (cleaned.startsWith('0') && cleaned.length >= 10) {
    cleaned = `44${cleaned.slice(1)}`
  }
  cleaned = cleaned.replace(/[^\d]/g, '')
  return cleaned ? `${cleaned}@s.whatsapp.net` : raw
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function trimToString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveSessionConnectorTargets(
  session: {
    user?: string
    name?: string
    connectorContext?: Record<string, unknown>
    messages?: Array<Record<string, unknown>>
  } | null | undefined,
  connectorId: string,
): Array<{ channelId: string; senderId?: string; senderName?: string }> {
  if (!isDirectConnectorSession(session)) return []
  const targets: Array<{ channelId: string; senderId?: string; senderName?: string }> = []
  const seen = new Set<string>()
  const pushTarget = (target: { channelId: string; senderId?: string; senderName?: string } | null) => {
    if (!target?.channelId || seen.has(target.channelId)) return
    seen.add(target.channelId)
    targets.push(target)
  }

  const context = session?.connectorContext
  if (trimToString(context?.connectorId) === connectorId) {
    const channelId = trimToString(context?.channelId)
    pushTarget(channelId
      ? {
          channelId,
          senderId: trimToString(context?.senderId) || undefined,
          senderName: trimToString(context?.senderName) || undefined,
        }
      : null)
  }

  const messages = Array.isArray(session?.messages) ? session.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.historyExcluded === true) continue
    const source = messages[i]?.source as Record<string, unknown> | undefined
    if (!source || trimToString(source.connectorId) !== connectorId) continue
    const channelId = trimToString(source.channelId)
    if (!channelId) continue
    pushTarget({
      channelId,
      senderId: trimToString(source.senderId) || undefined,
      senderName: trimToString(source.senderName) || undefined,
    })
  }

  return targets
}

function pickChannelTarget(params: {
  connector: { config?: Record<string, string> }
  connectorId: string
  to?: string
  currentSession?: {
    user?: string
    name?: string
    connectorContext?: Record<string, unknown>
    messages?: Array<Record<string, unknown>>
  } | null
}): { channelId: string; error?: string } {
  let channelId = params.to?.trim() || ''
  const connector = params.connector
  const sessionTargets = resolveSessionConnectorTargets(params.currentSession, params.connectorId)

  if (!channelId && sessionTargets.length === 1) {
    channelId = sessionTargets[0].channelId
  }
  if (!channelId && sessionTargets.length > 1) {
    const choices = sessionTargets.map((target) => (
      target.senderName
        ? `${target.senderName} (${target.channelId})`
        : target.senderId
          ? `${target.senderId} (${target.channelId})`
          : target.channelId
    ))
    return {
      channelId: '',
      error: `Error: this chat currently references multiple connector recipients for this connector: ${JSON.stringify(choices)}. Re-call with the "to" parameter so the message goes to the right person.`,
    }
  }

  if (!channelId) {
    const outbound = connector.config?.outboundJid?.trim()
    if (outbound) channelId = outbound
  }
  if (!channelId) {
    const outbound = connector.config?.outboundTarget?.trim()
    if (outbound) channelId = outbound
  }
  if (!channelId) {
    const allowed = parseCsv(connector.config?.allowedJids)
    if (allowed.length) channelId = allowed[0]
  }
  if (!channelId) {
    const allowed = parseCsv(connector.config?.allowFrom)
    if (allowed.length) channelId = allowed[0]
  }
  if (!channelId) {
    const knownTargets = [
      connector.config?.outboundJid?.trim(),
      connector.config?.outboundTarget?.trim(),
      ...parseCsv(connector.config?.allowedJids),
      ...parseCsv(connector.config?.allowFrom),
    ].filter(Boolean) as string[]
    const unique = dedup(knownTargets)
    if (unique.length) {
      return {
        channelId: '',
        error: `Error: no default outbound target is set, but the connector has ${unique.length} configured number(s)/target(s): ${JSON.stringify(unique)}. Ask the user which one to send to, then re-call with the "to" parameter set to their choice.`,
      }
    }
    return {
      channelId: '',
      error: 'Error: no target recipient configured and no known contacts on this connector. Ask the user for the recipient number/ID, then re-call with the "to" parameter. They can also configure "allowedJids" or "outboundJid" in the connector settings.',
    }
  }
  return { channelId }
}

export function resolveConnectorMediaInput(params: {
  cwd: string
  mediaPath?: string
  imageUrl?: string
  fileUrl?: string
}): { mediaPath?: string; imageUrl?: string; fileUrl?: string; error?: string } {
  let resolvedMediaPath = params.mediaPath?.trim() || undefined
  let resolvedImageUrl = params.imageUrl?.trim() || undefined
  let resolvedFileUrl = params.fileUrl?.trim() || undefined

  // Be forgiving when the model passes a served upload URL or remote URL in mediaPath.
  if (resolvedMediaPath?.startsWith('/api/uploads/')) {
    const fromUpload = resolveUploadUrl(resolvedMediaPath)
    if (fromUpload) {
      resolvedMediaPath = fromUpload.mediaPath
    } else {
      return { error: `Error: File not found: ${resolvedMediaPath}` }
    }
  } else if (resolvedMediaPath && /^https?:\/\//i.test(resolvedMediaPath)) {
    if (/\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(resolvedMediaPath)) {
      resolvedImageUrl = resolvedMediaPath
    } else {
      resolvedFileUrl = resolvedMediaPath
    }
    resolvedMediaPath = undefined
  }

  if (resolvedMediaPath && !path.isAbsolute(resolvedMediaPath) && !resolvedMediaPath.startsWith('/api/uploads/')) {
    const candidatePaths = [
      path.resolve(params.cwd, resolvedMediaPath),
      path.resolve(params.cwd, 'uploads', resolvedMediaPath),
      tryResolvePathWithinBaseDir(UPLOAD_DIR, resolvedMediaPath),
      tryResolvePathWithinBaseDir(UPLOAD_DIR, path.basename(resolvedMediaPath)),
    ].filter((candidate): candidate is string => !!candidate)
    const found = candidatePaths.find((p) => fs.existsSync(p))
    if (found) {
      resolvedMediaPath = found
    } else {
      return {
        error: `Error: File not found. Tried: ${candidatePaths.join(', ')}. Use an absolute path or ensure the file exists in the session workspace.`,
      }
    }
  }

  if (!resolvedMediaPath) {
    const fromImage = resolveUploadUrl(resolvedImageUrl)
    if (fromImage) {
      resolvedMediaPath = fromImage.mediaPath
      resolvedImageUrl = undefined
    }
    const fromFile = resolveUploadUrl(resolvedFileUrl)
    if (fromFile) {
      resolvedMediaPath = fromFile.mediaPath
      resolvedFileUrl = undefined
    }
  }

  return {
    mediaPath: resolvedMediaPath,
    imageUrl: resolvedImageUrl,
    fileUrl: resolvedFileUrl,
  }
}

/**
 * Core Connector Execution Logic
 */
interface ConnectorActionInput {
  action?: string
  connectorId?: string
  platform?: string
  to?: string
  message?: string
  messageId?: string
  targetMessage?: 'last_inbound' | 'last_outbound'
  emoji?: string
  voiceText?: string
  voiceId?: string
  imageUrl?: string
  fileUrl?: string
  mediaPath?: string
  mimeType?: string
  fileName?: string
  caption?: string
  replyToMessageId?: string
  threadId?: string
  delaySec?: number
  followUpMessage?: string
  followUpDelaySec?: number
  dedupeKey?: string
  approved?: boolean
  ptt?: boolean
}

interface ConnectorActionContext {
  cwd: string
  agentId?: string | null
  resolveCurrentSession?: () => { messages?: Array<Record<string, unknown>>; id?: string; agentId?: string | null } | null
  ctx?: { sessionId?: string | null; agentId?: string | null }
}

async function executeConnectorAction(input: ConnectorActionInput, bctx: ConnectorActionContext) {
  const baseNormalized = normalizeToolInputArgs((input ?? {}) as Record<string, unknown>)

  try {
    const tentativePlatform = pickConnectorString(baseNormalized.platform)
    const {
      listRunningConnectors,
      sendConnectorMessage,
      scheduleConnectorFollowUp,
      performConnectorMessageAction,
    } = await import('../connectors/manager')
    const running = listRunningConnectors(tentativePlatform || undefined)
    const normalized = normalizeConnectorActionInputAliases(baseNormalized, running)
    const inferredAction = inferConnectorActionName(normalized)
    const {
      action,
      connectorId,
      platform,
      to,
      message,
      voiceText,
      voiceId,
      imageUrl,
      fileUrl,
      mediaPath,
      mimeType,
      fileName,
      caption,
      messageId,
      targetMessage,
      emoji,
      replyToMessageId,
      threadId,
      dedupeKey,
      approved,
      ptt,
    } = normalized as ConnectorActionInput
    const actionName = normalizeConnectorActionName(String(inferredAction || action || ''))
    if (!actionName) return 'Error: action is required.'

    const currentSession = bctx.resolveCurrentSession?.()
    const sessionId = bctx.ctx?.sessionId || currentSession?.id || undefined
    const connectorScopedSessionId = isDirectConnectorSession(currentSession) ? sessionId : undefined
    const latestUserTurn = parseLatestUserTurn(currentSession)
    const turnKey = buildConnectorActionKey([sessionId, latestUserTurn.time || 'no-user-turn'])

    if (actionName === 'list_running' || actionName === 'list_targets') {
      return JSON.stringify(running)
    }

    if (actionName === 'start') {
      if (!connectorId) {
        const allConnectors = Object.values(loadConnectors()) as Connector[]
        const stopped = allConnectors
          .filter((connector) => !platform || connector.platform === platform)
          .filter((connector) => !running.find((runningConnector) => runningConnector.id === connector.id))
          .map((connector) => ({ id: connector.id, name: connector.name, platform: connector.platform }))
        if (!stopped.length) return 'All connectors are already running.'
        return `Error: connectorId is required. Stopped connectors available to start: ${JSON.stringify(stopped)}`
      }
      const connectors = loadConnectors()
      const connector = connectors[connectorId] as Connector | undefined
      if (!connector) return `Error: connector not found: ${connectorId}`
      const now = Date.now()
      pruneOldConnectorToolState(now)
      let startChannelId = (to || '').trim()
      if (startChannelId && connector.platform === 'whatsapp') startChannelId = normalizeWhatsAppTarget(startChannelId)
      const startReplayKey = buildConnectorTurnRecipientReplayKey({
        turnKey,
        actionName,
        connectorId,
        channelId: startChannelId,
        dedupeKey,
      })
      const cachedStart = connectorTurnRecipientReplayCache.get(startReplayKey)
      if (cachedStart && now - cachedStart.at <= CONNECTOR_TURN_SEND_TTL_MS) {
        return normalizeDedupedReplayResult(cachedStart.result, {
          connectorId,
          platform: connector.platform,
          to: startChannelId,
          status: 'started',
        })
      }
      const { startConnector: doStart } = await import('../connectors/manager')
      await doStart(connectorId)
      const result = JSON.stringify({ status: 'started', connectorId })
      connectorTurnRecipientReplayCache.set(startReplayKey, { at: now, result })
      return result
    }

    if (actionName === 'stop') {
      if (!connectorId) return 'Error: connectorId is required for stop action.'
      const { stopConnector: doStop } = await import('../connectors/manager')
      await doStop(connectorId)
      return JSON.stringify({ status: 'stopped', connectorId })
    }

    const resolveSelectedConnector = () => {
      if (!running.length) {
        const allConnectors = Object.values(loadConnectors()) as Connector[]
        const configured = allConnectors
          .filter((connector) => !platform || connector.platform === platform)
          .map((connector) => ({ id: connector.id, name: connector.name, platform: connector.platform, agentId: connector.agentId || null }))
        if (configured.length) {
          return {
            error: `Error: no running connectors found. Ask user to start one. Configured: ${JSON.stringify(configured)}`,
          }
        }
        return {
          error: `Error: no running connectors. User needs to set one up in the Connectors panel.`,
        }
      }
      const selected = connectorId ? running.find((c) => c.id === connectorId) : running[0]
      if (!selected) return { error: `Error: running connector not found: ${connectorId}` }
      const connectors = loadConnectors()
      const connector = connectors[selected.id]
      if (!connector) return { error: `Error: connector not found: ${selected.id}` }
      return { selected, connector }
    }

    if (actionName === 'send' || actionName === 'send_voice_note' || actionName === 'schedule_followup') {
      const settings = loadSettings()
      if (settings.safetyRequireApprovalForOutbound === true && approved !== true) {
        return 'Error: outbound connector sends require explicit approval. Re-run with approved=true after user confirmation.'
      }
      const now = Date.now()
      pruneOldConnectorToolState(now)
      const resolved = resolveSelectedConnector()
      if ('error' in resolved) return resolved.error
      const { selected, connector } = resolved

      const target = pickChannelTarget({
        connector,
        connectorId: selected.id,
        to,
        currentSession,
      })
      if (target.error) return target.error

      let channelId = target.channelId
      if (connector.platform === 'whatsapp') channelId = normalizeWhatsAppTarget(channelId)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _followupExplicitlyRequested = userExplicitlyRequestedFollowup(latestUserTurn.text)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _autonomousTurn = isAutonomousSystemTurn(latestUserTurn.text)
      const recipientReplayKey = actionName === 'schedule_followup'
        ? ''
        : buildConnectorTurnRecipientReplayKey({
            turnKey,
            actionName,
            connectorId: selected.id,
            channelId,
            replyToMessageId,
            threadId,
            dedupeKey,
          })
      if (recipientReplayKey) {
        const cachedRecipientReplay = connectorTurnRecipientReplayCache.get(recipientReplayKey)
        if (cachedRecipientReplay && now - cachedRecipientReplay.at <= CONNECTOR_TURN_SEND_TTL_MS) {
          return normalizeDedupedReplayResult(cachedRecipientReplay.result, {
            connectorId: selected.id,
            platform: selected.platform,
            to: channelId,
            status: actionName === 'send_voice_note' ? 'voice_sent' : 'sent',
          })
        }
      }

      if (actionName === 'send_voice_note') {
        const media = resolveConnectorMediaInput({ cwd: bctx.cwd, mediaPath, imageUrl, fileUrl })
        if (media.error) return media.error
        if (media.imageUrl || media.fileUrl) {
          return 'Error: send_voice_note requires an audio mediaPath or voiceText. Remote image/file URLs are not valid voice-note inputs.'
        }
        const ttsText = (voiceText || message || '').trim()
        if (!media.mediaPath && !ttsText) return 'Error: voiceText, message, or an audio mediaPath is required.'
        const effectiveVoiceId = resolveConnectorVoiceId({
          explicitVoiceId: voiceId,
          sessionAgentId: currentSession?.agentId,
          contextAgentId: bctx.agentId,
          nestedContextAgentId: bctx.ctx?.agentId,
        })
        const turnReplayKey = buildConnectorTurnReplayKey({
          turnKey,
          actionName,
          connectorId: selected.id,
          channelId,
          message,
          voiceText: ttsText,
          mediaPath: media.mediaPath,
          mimeType,
          fileName,
          caption,
          replyToMessageId,
          threadId,
          dedupeKey,
          ptt,
          voiceId: effectiveVoiceId,
        })
        const cachedTurnReplay = connectorTurnReplayCache.get(turnReplayKey)
        if (cachedTurnReplay && now - cachedTurnReplay.at <= CONNECTOR_TURN_SEND_TTL_MS) {
          return normalizeDedupedReplayResult(cachedTurnReplay.result, {
            connectorId: selected.id,
            platform: selected.platform,
            to: channelId,
          })
        }
        const voiceActionKey = buildConnectorActionKey([
          sessionId,
          actionName,
          selected.id,
          channelId,
          media.mediaPath || '',
          ttsText,
          effectiveVoiceId || '',
          fileName?.trim() || '',
          caption?.trim() || '',
          ptt ?? true,
          dedupeKey?.trim() || '',
        ])
        const cachedVoice = recentConnectorActionCache.get(voiceActionKey)
        if (cachedVoice && now - cachedVoice.at <= CONNECTOR_ACTION_DEDUPE_TTL_MS) {
          return cachedVoice.result
        }
        let voicePayload
        try {
          voicePayload = await prepareConnectorVoiceNotePayload({
            mediaPath: media.mediaPath,
            mimeType,
            voiceText: ttsText,
            voiceId,
            sessionAgentId: currentSession?.agentId,
            contextAgentId: bctx.agentId,
            nestedContextAgentId: bctx.ctx?.agentId,
            fileName,
          })
        } catch (err: unknown) {
          return `Error: ${errorMessage(err)}`
        }

        const sent = await sendConnectorMessage({
          connectorId: selected.id, channelId, text: '', mediaPath: voicePayload.mediaPath, mimeType: voicePayload.mimeType,
          fileName: voicePayload.fileName, caption: caption?.trim() || undefined, ptt: ptt ?? true,
          sessionId: connectorScopedSessionId,
          replyToMessageId: replyToMessageId?.trim() || undefined,
          threadId: threadId?.trim() || undefined,
          dedupeKey: recipientReplayKey || undefined,
        })
        const result = JSON.stringify({
          status: 'voice_sent',
          connectorId: sent.connectorId,
          platform: sent.platform,
          to: sent.channelId,
          messageId: sent.messageId || null,
          voiceFile: voicePayload.mediaPath,
        })
        connectorTurnReplayCache.set(turnReplayKey, { at: now, result })
        if (recipientReplayKey) connectorTurnRecipientReplayCache.set(recipientReplayKey, { at: now, result })
        recentConnectorActionCache.set(voiceActionKey, { at: now, result })
        return result
      }

      const media = resolveConnectorMediaInput({ cwd: bctx.cwd, mediaPath, imageUrl, fileUrl })
      if (media.error) return media.error

      if (actionName === 'send' && !message?.trim() && !media.mediaPath && !media.imageUrl && !media.fileUrl) {
        return 'Error: message or media required.'
      }

      const turnReplayKey = buildConnectorTurnReplayKey({
        turnKey,
        actionName,
        connectorId: selected.id,
        channelId,
        message,
        voiceText,
        mediaPath: media.mediaPath,
        imageUrl: media.imageUrl,
        fileUrl: media.fileUrl,
        mimeType,
        fileName,
        caption,
        replyToMessageId,
        threadId,
        followUpMessage: typeof normalized.followUpMessage === 'string' ? normalized.followUpMessage : undefined,
        followUpDelaySec: Number(normalized.followUpDelaySec),
        delaySec: Number(normalized.delaySec),
        dedupeKey,
        ptt,
      })
      const cachedTurnReplay = connectorTurnReplayCache.get(turnReplayKey)
      if (cachedTurnReplay && now - cachedTurnReplay.at <= CONNECTOR_TURN_SEND_TTL_MS) {
        return normalizeDedupedReplayResult(cachedTurnReplay.result, {
          connectorId: selected.id,
          platform: selected.platform,
          to: channelId,
        })
      }

      if (actionName === 'schedule_followup') {
        const followupText = (normalized.followUpMessage as string | undefined)?.trim() || message?.trim() || ''
        if (!followupText && !media.mediaPath && !media.imageUrl && !media.fileUrl) {
          return 'Error: follow-up message or media required.'
        }
        const followupDelay = (() => {
          const direct = Number(normalized.followUpDelaySec)
          if (Number.isFinite(direct) && direct >= 0) return direct
          const fallback = Number(normalized.delaySec)
          if (Number.isFinite(fallback) && fallback >= 0) return fallback
          return 300
        })()
        const scheduled = scheduleConnectorFollowUp({
          connectorId: selected.id,
          channelId,
          text: followupText,
          sessionId: connectorScopedSessionId,
          delaySec: followupDelay,
          dedupeKey: dedupeKey?.trim() || undefined,
          imageUrl: media.imageUrl,
          fileUrl: media.fileUrl,
          mediaPath: media.mediaPath,
          mimeType: mimeType?.trim() || undefined,
          fileName: fileName?.trim() || undefined,
          caption: caption?.trim() || undefined,
          replyToMessageId: replyToMessageId?.trim() || undefined,
          threadId: threadId?.trim() || undefined,
          ptt: ptt ?? undefined,
        })
        const result = JSON.stringify({
          status: 'scheduled',
          connectorId: selected.id,
          platform: selected.platform,
          to: channelId,
          followUpId: scheduled.followUpId,
          sendAt: scheduled.sendAt,
        })
        connectorTurnReplayCache.set(turnReplayKey, { at: now, result })
        return result
      }

      const sent = await sendConnectorMessage({
        connectorId: selected.id, channelId, text: message?.trim() || '',
        sessionId: connectorScopedSessionId,
        imageUrl: media.imageUrl, fileUrl: media.fileUrl, mediaPath: media.mediaPath,
        mimeType: mimeType?.trim() || undefined, fileName: fileName?.trim() || undefined,
        caption: caption?.trim() || undefined,
        replyToMessageId: replyToMessageId?.trim() || undefined,
        threadId: threadId?.trim() || undefined,
        ptt: ptt ?? undefined,
        dedupeKey: recipientReplayKey || undefined,
      })

      const result = JSON.stringify({ status: 'sent', connectorId: sent.connectorId, platform: sent.platform, to: sent.channelId, messageId: sent.messageId || null })
      connectorTurnReplayCache.set(turnReplayKey, { at: now, result })
      if (recipientReplayKey) connectorTurnRecipientReplayCache.set(recipientReplayKey, { at: now, result })
      return result
    }

    if (actionName === 'react' || actionName === 'edit' || actionName === 'delete' || actionName === 'pin') {
      const resolved = resolveSelectedConnector()
      if ('error' in resolved) return resolved.error
      const { selected } = resolved
      const target = pickChannelTarget({
        connector: resolved.connector,
        connectorId: selected.id,
        to,
        currentSession,
      })
      if (target.error) return target.error
      const result = await performConnectorMessageAction({
        connectorId: selected.id,
        channelId: selected.platform === 'whatsapp' ? normalizeWhatsAppTarget(target.channelId) : target.channelId,
        action: actionName,
        messageId: messageId?.trim() || undefined,
        emoji: emoji?.trim() || undefined,
        text: message?.trim() || undefined,
        sessionId,
        targetMessage,
      })
      return JSON.stringify({
        status: actionName,
        connectorId: result.connectorId,
        platform: result.platform,
        to: result.channelId,
        messageId: result.messageId || null,
      })
    }

    return 'Unknown action.'
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const ConnectorPlugin: Plugin = {
  name: 'Core Connectors',
  description: 'Manage and send messages through chat platform connectors (WhatsApp, Telegram, Slack, etc.).',
  hooks: {
    getCapabilityDescription: () => 'I can manage messaging channels (`manage_connectors`) — WhatsApp, Telegram, Slack, Discord — and send proactive messages via `connector_message_tool`.',
    getOperatingGuidance: () => 'Connectors: proactive outreach for significant events only. Keep messages concise, no duplicates.',
  } as PluginHooks,
  tools: [
    {
      name: 'connector_message_tool',
      description: 'Send and manage outbound messages across chat platforms.',
      parameters: CONNECTOR_MESSAGE_TOOL_PARAMETERS,
      execute: async (args, context) => executeConnectorAction(args as ConnectorActionInput, { ...context.session, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

registerNativeCapability('connectors', ConnectorPlugin)

/**
 * Legacy Bridge
 */
export function buildConnectorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('manage_connectors')) return []
  return [
    tool(
      async (args) => executeConnectorAction(args as ConnectorActionInput, bctx),
      {
        name: 'connector_message_tool',
        description: ConnectorPlugin.tools![0].description,
        schema: CONNECTOR_MESSAGE_TOOL_SCHEMA
      }
    )
  ]
}
