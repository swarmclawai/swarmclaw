import crypto from 'node:crypto'
import type { PlatformConnector, ConnectorInstance, InboundMessage, InboundMedia } from './types'
import { isNoMessage } from './manager'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_WEBHOOK_PATH = '/api/connectors/{id}/webhook'

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumberLike(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) return undefined
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function extractPayloadMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const parseRecord = (value: unknown): Record<string, unknown> | null => {
    const record = asRecord(value)
    if (record) return record
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = parseRecord(item)
        if (nested) return nested
      }
      return null
    }
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      return parseRecord(JSON.parse(trimmed))
    } catch {
      return null
    }
  }

  const dataRaw = payload.data ?? payload.payload ?? payload.event
  const data = parseRecord(dataRaw)
  const messageRaw = payload.message ?? data?.message ?? data
  return parseRecord(messageRaw)
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase()
}

function extractHandleFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(';')
  if (parts.length < 3) return null
  const handle = parts[2]?.trim()
  return handle || null
}

function resolveGroupFlagFromChatGuid(chatGuid?: string): boolean | undefined {
  const guid = chatGuid?.trim()
  if (!guid) return undefined
  const parts = guid.split(';')
  if (parts.length >= 3) {
    if (parts[1] === '+') return true
    if (parts[1] === '-') return false
  }
  if (guid.includes(';+;')) return true
  if (guid.includes(';-;')) return false
  return undefined
}

function normalizeAttachmentType(mimeType?: string): InboundMedia['type'] {
  const mime = (mimeType || '').trim().toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('application/')) return 'document'
  return 'file'
}

function normalizeAttachments(message: Record<string, unknown>): InboundMedia[] {
  const raw = message.attachments
  if (!Array.isArray(raw)) return []

  const output: InboundMedia[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue

    const mimeType = readString(record, 'mimeType') || readString(record, 'mime_type')
    const fileName = readString(record, 'transferName') || readString(record, 'transfer_name')
    const sizeBytes = readNumberLike(record, 'totalBytes') || readNumberLike(record, 'total_bytes')

    output.push({
      type: normalizeAttachmentType(mimeType),
      mimeType,
      fileName,
      sizeBytes,
    })
  }

  return output
}

function parseInboundMessage(payload: Record<string, unknown>): InboundMessage | null {
  const eventType = readString(payload, 'type')?.trim().toLowerCase() || ''
  if (eventType && !['new-message', 'created-message', 'message'].includes(eventType)) {
    return null
  }

  const message = extractPayloadMessage(payload)
  if (!message) return null

  const fromMe = readBoolean(message, 'isFromMe') ?? readBoolean(message, 'is_from_me') ?? false
  if (fromMe) return null

  const text = (
    readString(message, 'text')
    || readString(message, 'body')
    || readString(message, 'subject')
    || ''
  ).trim()

  const handle = asRecord(message.handle) || asRecord(message.sender)
  const rawSenderId = (
    readString(handle, 'address')
    || readString(handle, 'handle')
    || readString(handle, 'id')
    || readString(message, 'senderId')
    || readString(message, 'sender')
    || readString(message, 'from')
    || ''
  ).trim()

  const chatGuid = (
    readString(message, 'chatGuid')
    || readString(message, 'chat_guid')
    || ''
  ).trim()

  const inferredSender = !rawSenderId && chatGuid ? (extractHandleFromChatGuid(chatGuid) || '') : ''
  const senderId = normalizeHandle(rawSenderId || inferredSender)
  if (!senderId) return null

  const chatIdentifier = (
    readString(message, 'chatIdentifier')
    || readString(message, 'chat_identifier')
    || ''
  ).trim()
  const chatIdNum = readNumberLike(message, 'chatId') || readNumberLike(message, 'chat_id')
  const chatId = chatGuid || chatIdentifier || (Number.isFinite(chatIdNum) ? String(chatIdNum) : senderId)
  const channelName = (
    readString(message, 'chatName')
    || readString(message, 'displayName')
    || chatId
  ).trim()

  const senderName = (
    readString(handle, 'displayName')
    || readString(handle, 'name')
    || readString(message, 'senderName')
    || senderId
  ).trim()

  const media = normalizeAttachments(message)
  const fallbackText = media.length > 0 ? '<media:attachment>' : ''

  const groupFlag = (
    readBoolean(message, 'isGroup')
    ?? readBoolean(message, 'is_group')
    ?? resolveGroupFlagFromChatGuid(chatGuid)
    ?? false
  )

  return {
    platform: 'bluebubbles',
    channelId: chatId,
    channelName,
    senderId,
    senderName,
    text: text || fallbackText,
    media,
    isGroup: groupFlag,
  }
}

function resolveRequestUrl(baseUrl: string, path: string, password: string): string {
  const base = new URL(baseUrl)
  const url = new URL(path, base)
  url.searchParams.set('password', password)
  return url.toString()
}

async function fetchJsonWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function parseCsvList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((value) => value.trim()).filter(Boolean)
}

const bluebubbles: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const serverUrl = connector.config.serverUrl?.trim()
    const password = (botToken || connector.config.password || '').trim()

    if (!serverUrl) throw new Error('Missing serverUrl in connector config')
    if (!password) throw new Error('Missing BlueBubbles password (credential/token)')

    const timeoutMsRaw = Number.parseInt(connector.config.timeoutMs || '', 10)
    const timeoutMs = Number.isFinite(timeoutMsRaw)
      ? Math.max(1_000, Math.min(60_000, timeoutMsRaw))
      : DEFAULT_TIMEOUT_MS

    const allowedChats = new Set(parseCsvList(connector.config.chatIds))

    let stopped = false

    const processWebhookEvent = async (payload: Record<string, unknown>) => {
      if (stopped) throw new Error('Connector is stopped')
      const inbound = parseInboundMessage(payload)
      if (!inbound) return {}

      if (allowedChats.size > 0) {
        const id = inbound.channelId
        const name = inbound.channelName || ''
        const allowed = Array.from(allowedChats).some((needle) => id.includes(needle) || name.includes(needle))
        if (!allowed) return {}
      }

      const response = await onMessage(inbound)
      if (!response || isNoMessage(response)) return {}

      await sendBlueBubblesText({
        serverUrl,
        password,
        channelId: inbound.channelId,
        text: response,
        timeoutMs,
      })
      return {}
    }

    const handlerKey = `__swarmclaw_bluebubbles_handler_${connector.id}__`
    ;(globalThis as any)[handlerKey] = processWebhookEvent

    const pingUrl = resolveRequestUrl(serverUrl, '/api/v1/ping', password)
    const pingRes = await fetchJsonWithTimeout(pingUrl, { method: 'GET' }, timeoutMs)
    if (!pingRes.ok) {
      throw new Error(`BlueBubbles ping failed (${pingRes.status})`)
    }

    console.log(`[bluebubbles] Connected to ${serverUrl}`)
    console.log(`[bluebubbles] Inbound webhook endpoint: ${DEFAULT_WEBHOOK_PATH.replace('{id}', connector.id)}`)

    return {
      connector,
      async sendMessage(channelId, text) {
        if (stopped) throw new Error('Connector is stopped')
        return await sendBlueBubblesText({
          serverUrl,
          password,
          channelId,
          text,
          timeoutMs,
        })
      },
      async stop() {
        stopped = true
        delete (globalThis as any)[handlerKey]
        console.log(`[bluebubbles] Connector stopped`)
      },
    }
  },
}

async function sendBlueBubblesText(params: {
  serverUrl: string
  password: string
  channelId: string
  text: string
  timeoutMs: number
}): Promise<{ messageId?: string }> {
  const message = params.text.trim()
  if (!message) return {}

  const channel = params.channelId.trim()
  if (!channel) throw new Error('BlueBubbles send requires channelId')

  const payload: Record<string, unknown> = {
    message,
    tempGuid: crypto.randomUUID(),
  }

  // For inbound-driven replies we store chat GUID in channelId. If callers pass a phone/email,
  // BlueBubbles can still attempt routing via chatGuid field when it already matches.
  payload.chatGuid = channel

  const url = resolveRequestUrl(params.serverUrl, '/api/v1/message/text', params.password)
  const res = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, params.timeoutMs)

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`BlueBubbles send failed (${res.status}): ${errBody || 'unknown'}`)
  }

  try {
    const body = await res.json() as any
    const id = body?.data?.guid || body?.guid || body?.data?.id || body?.id
    return { messageId: typeof id === 'string' ? id : undefined }
  } catch (err) {
    // BlueBubbles may return empty body on success in some setups.
    const message = getErrorMessage(err)
    if (!message.toLowerCase().includes('json')) {
      console.warn(`[bluebubbles] Unable to parse send response body: ${message}`)
    }
    return {}
  }
}

export default bluebubbles
