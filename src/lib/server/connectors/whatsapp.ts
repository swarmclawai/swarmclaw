import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  downloadMediaMessage,
  type WAMessage,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawnSync } from 'child_process'
import type { Connector } from '@/types'
import { dedup, errorMessage } from '@/lib/shared-utils'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { resolveConnectorIngressReply } from './ingress-delivery'
import { saveInboundMediaBuffer, mimeFromPath, isImageMime, isAudioMime } from './media'
import { recordConnectorOutboundDelivery } from './delivery'
import { formatTextForWhatsApp } from './whatsapp-text'
import { getWhatsAppApprovedSenderIds } from './pairing'

import { DATA_DIR } from '../data-dir'
import { loadConnectors, loadSettings } from '../storage'

const AUTH_DIR = path.join(DATA_DIR, 'whatsapp-auth')
const INBOUND_DEDUPE_TTL_MS = 2 * 60 * 1000
const WHATSAPP_SINGLE_MESSAGE_MAX = 4096
const WHATSAPP_TEXT_CHUNK_MAX = 4000
const WHATSAPP_VOICE_NOTE_MIME = 'audio/ogg; codecs=opus'
const WHATSAPP_VOICE_NOTE_EXTS = new Set(['.ogg', '.opus'])

let cachedFfmpegBinary: string | null | undefined

type WhatsAppSocketState = {
  ws?: {
    isOpen?: boolean
    isClosed?: boolean
    isClosing?: boolean
    isConnecting?: boolean
  } | null
} | null

type WhatsAppPresenceSocket = {
  sendPresenceUpdate?: (state: 'composing' | 'paused', jid: string) => Promise<unknown>
} | null

export function buildWhatsAppTextPayloads(text: string): Array<{ text: string; linkPreview: null }> {
  const chunks = text.length <= WHATSAPP_SINGLE_MESSAGE_MAX
    ? [text]
    : (text.match(new RegExp(`[\\s\\S]{1,${WHATSAPP_TEXT_CHUNK_MAX}}`, 'g')) || [text])
  return chunks.map((chunk) => ({ text: chunk, linkPreview: null }))
}

export function isWhatsAppSocketAlive(params: {
  stopped: boolean
  socket: WhatsAppSocketState
  connectionState?: string | null
}): boolean {
  if (params.stopped) return false
  if (!params.socket) return false

  const ws = params.socket.ws
  if (!ws) return false
  if (params.connectionState === 'close') return false
  if (ws.isClosed || ws.isClosing) return false
  if (ws.isOpen || ws.isConnecting) return true
  if (params.connectionState === 'open' || params.connectionState === 'connecting') return true

  // Treat an existing socket with no explicit close signal as live while QR/auth
  // negotiation is still in progress.
  return params.connectionState == null
}

export async function sendWhatsAppTypingPresence(params: {
  socket: WhatsAppPresenceSocket
  channelId: string
}): Promise<void> {
  const channelId = String(params.channelId || '').trim()
  if (!channelId) return
  const sendPresenceUpdate = params.socket?.sendPresenceUpdate
  if (typeof sendPresenceUpdate !== 'function') return
  await sendPresenceUpdate('composing', channelId)
}

function normalizeMimeType(mimeType?: string): string {
  return String(mimeType || '').toLowerCase().split(';')[0].trim()
}

function looksLikeWhatsAppVoiceNote(params: { mimeType?: string; fileName?: string }): boolean {
  const mime = normalizeMimeType(params.mimeType)
  if (mime === 'audio/ogg' || mime === 'audio/opus') return true
  const ext = path.extname(String(params.fileName || '')).toLowerCase()
  return WHATSAPP_VOICE_NOTE_EXTS.has(ext)
}

function resolveAudioExt(params: { mimeType?: string; fileName?: string }): string {
  const ext = path.extname(String(params.fileName || '')).toLowerCase()
  if (ext) return ext
  const mime = normalizeMimeType(params.mimeType)
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return '.mp3'
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return '.wav'
  if (mime === 'audio/mp4' || mime === 'audio/m4a' || mime === 'audio/x-m4a') return '.m4a'
  if (mime === 'audio/ogg' || mime === 'audio/opus') return '.ogg'
  return '.bin'
}

function resolveFfmpegBinary(): string | null {
  if (cachedFfmpegBinary !== undefined) return cachedFfmpegBinary
  const candidates = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf-8', timeout: 2_000 })
    if ((probe.status ?? 1) === 0) {
      cachedFfmpegBinary = candidate
      return candidate
    }
  }
  cachedFfmpegBinary = null
  return null
}

function transcodeToWhatsAppVoiceNote(params: {
  buffer: Buffer
  mimeType?: string
  fileName?: string
}): { buffer: Buffer; mimeType: string } | null {
  const ffmpeg = resolveFfmpegBinary()
  if (!ffmpeg) return null

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-wa-voice-'))
  const inputPath = path.join(tempDir, `input${resolveAudioExt(params)}`)
  const outputPath = path.join(tempDir, 'voice-note.ogg')

  try {
    fs.writeFileSync(inputPath, params.buffer)
    const result = spawnSync(ffmpeg, [
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-vbr', 'on',
      '-compression_level', '10',
      '-application', 'voip',
      '-f', 'ogg',
      outputPath,
    ], {
      encoding: 'utf-8',
      timeout: 20_000,
    })
    if ((result.status ?? 1) !== 0 || !fs.existsSync(outputPath)) {
      const stderr = (result.stderr || '').trim()
      console.warn(`[whatsapp] Failed to transcode voice note to opus/ogg${stderr ? `: ${stderr}` : ''}`)
      return null
    }
    return {
      buffer: fs.readFileSync(outputPath),
      mimeType: WHATSAPP_VOICE_NOTE_MIME,
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export function normalizeWhatsAppAudioForSend(params: {
  buffer: Buffer
  mimeType?: string
  fileName?: string
  ptt?: boolean
  transcode?: (params: { buffer: Buffer; mimeType?: string; fileName?: string }) => { buffer: Buffer; mimeType: string } | null
}): { buffer: Buffer; mimeType: string } {
  const mimeType = params.mimeType || 'application/octet-stream'
  if (params.ptt === false) return { buffer: params.buffer, mimeType }
  if (looksLikeWhatsAppVoiceNote(params)) {
    return {
      buffer: params.buffer,
      mimeType: normalizeMimeType(mimeType) === 'audio/ogg' ? WHATSAPP_VOICE_NOTE_MIME : mimeType,
    }
  }
  const transcode = params.transcode || transcodeToWhatsAppVoiceNote
  const converted = transcode({
    buffer: params.buffer,
    mimeType: params.mimeType,
    fileName: params.fileName,
  })
  return converted || { buffer: params.buffer, mimeType }
}

/** Extract the user part from a JID, stripping the server and device suffix */
function jidUserPart(raw: string): string {
  const trimmed = String(raw || '').trim().toLowerCase()
  if (!trimmed) return ''
  const withoutServer = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  return withoutServer.split(':')[0]
}

/**
 * Normalize a phone number or JID to a bare-digit identifier for matching.
 * Works for all country codes — strips formatting, `whatsapp:` prefixes,
 * JID suffixes (`@s.whatsapp.net`, `@lid`), and device suffixes (`:0`).
 * Returns bare digits (no `+` prefix) for comparison.
 */
export function normalizeWhatsAppIdentifier(raw: string): string {
  const withoutPrefix = String(raw || '').replace(/^whatsapp:/i, '').trim()
  return jidUserPart(withoutPrefix).replace(/[^\da-z]/g, '')
}

function parseAllowedIdentifiers(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null
  const out = raw
    .split(',')
    .map((entry) => normalizeWhatsAppIdentifier(entry))
    .filter(Boolean)
  return out.length ? out : null
}

export function resolveWhatsAppAllowedIdentifiers(params: {
  configuredAllowedJids?: unknown
  settingsContacts?: unknown
}): string[] | null {
  const configured = parseAllowedIdentifiers(params.configuredAllowedJids)
  if (!configured?.length) return null
  const settings = getWhatsAppApprovedSenderIds(params.settingsContacts)
    .map((entry) => normalizeWhatsAppIdentifier(entry))
    .filter(Boolean)
  const merged = dedup([...configured, ...settings])
  return merged.length ? merged : null
}

function messageContextInfo(content: any): any {
  return content?.extendedTextMessage?.contextInfo
    || content?.imageMessage?.contextInfo
    || content?.videoMessage?.contextInfo
    || content?.documentMessage?.contextInfo
    || content?.audioMessage?.contextInfo
    || content?.stickerMessage?.contextInfo
    || null
}

export function collectWhatsAppAddressCandidates(msg: Pick<WAMessage, 'key'>): string[] {
  const key = msg?.key || {}
  const raw = [
    key.remoteJid,
    key.remoteJidAlt,
    key.participant,
    key.participantAlt,
  ]
  const normalized = raw
    .map((entry) => normalizeWhatsAppIdentifier(String(entry || '')))
    .filter(Boolean)
  return dedup(normalized)
}

export function isWhatsAppInboundAllowed(params: {
  allowedJids: string[] | null
  msg: Pick<WAMessage, 'key'>
  isSelfChat?: boolean
}): boolean {
  if (!params.allowedJids?.length || params.isSelfChat) return true
  const candidates = collectWhatsAppAddressCandidates(params.msg)
  return candidates.some((candidate) =>
    params.allowedJids!.some((allowed) => candidate.includes(allowed) || allowed.includes(candidate)),
  )
}

export function buildWhatsAppInboundMessage(params: {
  msg: WAMessage
  media?: NonNullable<InboundMessage['media']>
  selfJids?: string[]
}): InboundMessage | null {
  const { msg } = params
  const media = Array.isArray(params.media) ? params.media : []
  const jid = msg.key.remoteJid || ''
  if (!jid) return null

  const content: any = normalizeMessageContent(msg.message as any) || msg.message || {}
  const text = content?.conversation
    || content?.extendedTextMessage?.text
    || content?.imageMessage?.caption
    || content?.videoMessage?.caption
    || content?.documentMessage?.caption
    || ''
  if (!text && media.length === 0) return null

  const isGroup = jid.endsWith('@g.us')
  const channelIdAlt = typeof msg.key.remoteJidAlt === 'string' && msg.key.remoteJidAlt.trim()
    ? msg.key.remoteJidAlt.trim()
    : undefined
  const senderId = isGroup
    ? (msg.key.participant || jid)
    : jid
  const senderIdAlt = isGroup
    ? (msg.key.participantAlt || undefined)
    : channelIdAlt
  const senderName = msg.pushName || jidUserPart(senderIdAlt || senderId) || jidUserPart(jid)
  const contextInfo = messageContextInfo(content)
  const mentionedJids = Array.isArray(contextInfo?.mentionedJid)
    ? contextInfo.mentionedJid.map((entry: unknown) => String(entry || '')).filter(Boolean)
    : []
  const selfIds = Array.isArray(params.selfJids) ? params.selfJids.map((entry: unknown) => normalizeWhatsAppIdentifier(String(entry || ''))).filter(Boolean) : []
  const mentionsBot = selfIds.length > 0
    ? mentionedJids.some((entry: string) => selfIds.includes(normalizeWhatsAppIdentifier(entry)))
    : false

  return {
    platform: 'whatsapp',
    channelId: jid,
    channelIdAlt,
    channelName: isGroup ? (channelIdAlt || jid) : `DM:${senderName}`,
    senderId,
    senderIdAlt,
    senderName,
    text: text || '(media message)',
    isGroup,
    messageId: msg.key.id || undefined,
    imageUrl: media.find((item) => item.type === 'image')?.url,
    media,
    replyToMessageId: typeof contextInfo?.stanzaId === 'string' && contextInfo.stanzaId.trim()
      ? contextInfo.stanzaId.trim()
      : undefined,
    mentionsBot,
  }
}

/** Check if auth directory has saved credentials */
function hasStoredCreds(authDir: string): boolean {
  try {
    return fs.existsSync(path.join(authDir, 'creds.json'))
  } catch { return false }
}

/** Clear auth directory to force fresh QR pairing */
export function clearAuthDir(connectorId: string): void {
  const authDir = path.join(AUTH_DIR, connectorId)
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true })
    console.log(`[whatsapp] Cleared auth state for connector ${connectorId}`)
  }
}

const whatsapp: PlatformConnector = {
  async start(connector, _botToken, onMessage): Promise<ConnectorInstance> {
    // Each connector gets its own auth directory
    const authDir = path.join(AUTH_DIR, connector.id)
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    let sock: ReturnType<typeof makeWASocket> | null = null
    let stopped = false
    let socketGen = 0 // Track socket generation to ignore stale events
    let connectionState: string | null = 'connecting'
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    const seenInboundMessageIds = new Map<string, number>()

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const scheduleReconnect = (delayMs: number) => {
      if (stopped) return
      clearReconnectTimer()
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (stopped) return
        startSocket()
      }, delayMs)
      reconnectTimer.unref?.()
    }

    const instance: ConnectorInstance = {
      connector,
      qrDataUrl: null,
      authenticated: false,
      hasCredentials: hasStoredCreds(authDir),
      isAlive() {
        return isWhatsAppSocketAlive({
          stopped,
          socket: sock,
          connectionState,
        })
      },
      async sendMessage(channelId, text, options) {
        if (!sock) throw new Error('WhatsApp connector is not connected')
        const normalizedText = formatTextForWhatsApp(text || '')
        const normalizedCaption = formatTextForWhatsApp(options?.caption || normalizedText)
        // Local file path takes priority
        if (options?.mediaPath) {
          if (!fs.existsSync(options.mediaPath)) throw new Error(`File not found: ${options.mediaPath}`)
          const buf = fs.readFileSync(options.mediaPath)
          const mime = options.mimeType || mimeFromPath(options.mediaPath)
          const caption = normalizedCaption || undefined
          const fName = options.fileName || path.basename(options.mediaPath)
          let sent
          if (isImageMime(mime) || mime.startsWith('video/')) {
            try {
              sent = await sock.sendMessage(channelId, { image: buf, caption, mimetype: mime })
            } catch (err: unknown) {
              const errMsg = errorMessage(err)
              console.warn(`[whatsapp] Image send failed (${errMsg}); retrying as document: ${fName}`)
              sent = await sock.sendMessage(channelId, { document: buf, fileName: fName, mimetype: mime, caption })
            }
          } else if (isAudioMime(mime)) {
            const normalizedAudio = normalizeWhatsAppAudioForSend({
              buffer: buf,
              mimeType: mime,
              fileName: fName,
              ptt: options.ptt !== false,
            })
            sent = await sock.sendMessage(channelId, {
              audio: normalizedAudio.buffer,
              mimetype: normalizedAudio.mimeType,
              ptt: options.ptt !== false,
            })
          } else {
            sent = await sock.sendMessage(channelId, { document: buf, fileName: fName, mimetype: mime, caption })
          }
          if (sent?.key?.id) sentMessageIds.add(sent.key.id)
          return { messageId: sent?.key?.id || undefined }
        }
        if (options?.imageUrl) {
          const sent = await sock.sendMessage(channelId, {
            image: { url: options.imageUrl },
            caption: normalizedCaption || undefined,
          })
          if (sent?.key?.id) sentMessageIds.add(sent.key.id)
          return { messageId: sent?.key?.id || undefined }
        }
        if (options?.fileUrl) {
          const sent = await sock.sendMessage(channelId, {
            document: { url: options.fileUrl },
            fileName: options.fileName || 'attachment',
            mimetype: options.mimeType || 'application/octet-stream',
            caption: normalizedCaption || undefined,
          })
          if (sent?.key?.id) sentMessageIds.add(sent.key.id)
          return { messageId: sent?.key?.id || undefined }
        }

        const payload = normalizedText || normalizedCaption || ''
        let lastMessageId: string | undefined
        for (const chunk of buildWhatsAppTextPayloads(payload)) {
          const sent = await sock.sendMessage(channelId, chunk)
          if (sent?.key?.id) {
            lastMessageId = sent.key.id
            sentMessageIds.add(sent.key.id)
          }
        }
        return { messageId: lastMessageId }
      },
      async sendTyping(channelId) {
        await sendWhatsAppTypingPresence({ socket: sock as WhatsAppPresenceSocket, channelId })
      },
      async stop() {
        stopped = true
        connectionState = 'close'
        clearReconnectTimer()
        try { sock?.end(undefined) } catch { /* ignore */ }
        sock = null
        console.log(`[whatsapp] Stopped connector: ${connector.name}`)
      },
    }

    // Track message IDs sent by the bot to avoid infinite loops in self-chat
    const sentMessageIds = new Set<string>()

    const startSocket = () => {
      if (stopped) return
      clearReconnectTimer()

      // Close previous socket to prevent stale event handlers
      if (sock) {
        try { sock.ev.removeAllListeners('connection.update') } catch { /* ignore */ }
        try { sock.ev.removeAllListeners('messages.upsert') } catch { /* ignore */ }
        try { sock.ev.removeAllListeners('creds.update') } catch { /* ignore */ }
        try { sock.end(undefined) } catch { /* ignore */ }
        sock = null
      }

      const gen = ++socketGen // Capture generation for stale detection
      connectionState = 'connecting'
      console.log(`[whatsapp] Starting socket gen=${gen} for ${connector.name} (hasCreds=${instance.hasCredentials})`)

      sock = makeWASocket({
        version,
        auth: state,
        browser: ['SwarmClaw', 'Chrome', '120.0'],
      })

      sock.ev.on('creds.update', () => {
        saveCreds()
        // Update hasCredentials after first cred save
        instance.hasCredentials = true
      })

      sock.ev.on('connection.update', async (update) => {
        if (gen !== socketGen) return // Ignore events from stale sockets

        const { connection, lastDisconnect, qr } = update
        if (typeof connection === 'string' && connection) connectionState = connection
        console.log(`[whatsapp] Connection update gen=${gen}: connection=${connection}, hasQR=${!!qr}`)

        if (qr) {
          console.log(`[whatsapp] QR code generated for ${connector.name}`)
          try {
            instance.qrDataUrl = await QRCode.toDataURL(qr, {
              width: 280,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' },
            })
          } catch (err) {
            console.error('[whatsapp] Failed to generate QR data URL:', err)
          }
        }
        if (connection === 'close') {
          instance.qrDataUrl = null
          const reason = (lastDisconnect?.error as any)?.output?.statusCode
          console.log(`[whatsapp] Connection closed: reason=${reason} stopped=${stopped}`)

          if (reason === DisconnectReason.loggedOut) {
            // Session invalidated — clear auth and restart to get fresh QR
            console.log(`[whatsapp] Logged out — clearing auth and restarting for fresh QR`)
            instance.authenticated = false
            instance.hasCredentials = false
            clearAuthDir(connector.id)
            if (!stopped) {
              // Recreate auth dir and state for fresh start
              fs.mkdirSync(authDir, { recursive: true })
              scheduleReconnect(1000)
            }
          } else if (reason === 440) {
            // Conflict — another session replaced this one. Do NOT reconnect
            // (reconnecting would create a ping-pong loop with the other session)
            console.log(`[whatsapp] Session conflict (replaced by another connection) — stopping`)
            instance.authenticated = false
            instance.onCrash?.('Session conflict — replaced by another connection')
          } else if (!stopped) {
            console.log(`[whatsapp] Reconnecting in 3s...`)
            scheduleReconnect(3000)
          } else {
            console.log(`[whatsapp] Disconnected permanently`)
          }
        } else if (connection === 'open') {
          instance.authenticated = true
          instance.hasCredentials = true
          instance.qrDataUrl = null
          console.log(`[whatsapp] Connected as ${sock?.user?.id}`)
        }
      })

      sock.ev.on('messages.upsert', async (upsert) => {
        const { messages, type } = upsert
        console.log(`[whatsapp] messages.upsert gen=${gen}: type=${type}, count=${messages.length}`)

        if (gen !== socketGen) {
          console.log(`[whatsapp] Ignoring stale socket event (gen=${gen}, current=${socketGen})`)
          return
        }
        if (type !== 'notify') {
          console.log(`[whatsapp] Ignoring non-notify upsert type: ${type}`)
          return
        }

        for (const msg of messages) {
          console.log(`[whatsapp] Processing message: fromMe=${msg.key.fromMe}, jid=${msg.key.remoteJid}, hasConversation=${!!msg.message?.conversation}, hasExtended=${!!msg.message?.extendedTextMessage}`)

          if (msg.key.remoteJid === 'status@broadcast') continue

          const msgId = msg.key.id || ''
          if (msgId) {
            const now = Date.now()
            const seenAt = seenInboundMessageIds.get(msgId)
            if (typeof seenAt === 'number' && now - seenAt <= INBOUND_DEDUPE_TTL_MS) {
              console.log(`[whatsapp] Skipping duplicate inbound message id: ${msgId}`)
              continue
            }
            seenInboundMessageIds.set(msgId, now)
            if (seenInboundMessageIds.size > 5000) {
              for (const [id, ts] of seenInboundMessageIds.entries()) {
                if (now - ts > INBOUND_DEDUPE_TTL_MS) seenInboundMessageIds.delete(id)
              }
            }
          }

          // Skip messages sent by the bot itself (tracked by ID to prevent infinite loops)
          if (msg.key.id && sentMessageIds.has(msg.key.id)) {
            console.log(`[whatsapp] Skipping own bot reply: ${msg.key.id}`)
            sentMessageIds.delete(msg.key.id) // Clean up
            continue
          }

          // Handle self-chat (same number messaging itself for testing)
          // Self-chat JID can be phone format (447xxx@s.whatsapp.net) or LID format (185xxx@lid)
          const remoteNum = msg.key.remoteJid?.split('@')[0] || ''
          const remoteHost = msg.key.remoteJid?.split('@')[1] || ''
          const myPhoneNum = sock?.user?.id?.split(':')[0] || ''
          const myLid = sock?.user?.lid?.split(':')[0] || ''
          const isSelfChat = (remoteNum === myPhoneNum) || (remoteHost === 'lid' && (myLid ? remoteNum === myLid : true))
          console.log(`[whatsapp] Self-chat check: remote=${remoteNum}@${remoteHost}, myPhone=${myPhoneNum}, myLid=${myLid}, isSelf=${isSelfChat}`)
          if (msg.key.fromMe && !isSelfChat) continue

          const jid = msg.key.remoteJid || ''
          const latestConnector = (loadConnectors()[connector.id] as Connector | undefined) || connector
          const allowedJids = resolveWhatsAppAllowedIdentifiers({
            configuredAllowedJids: latestConnector.config?.allowedJids,
            settingsContacts: loadSettings().whatsappApprovedContacts,
          })

          // Match allowed JIDs using normalized numbers
          // Self-chat always passes the filter (it's the bot's own account)
          if (allowedJids?.length && !isSelfChat) {
            const matched = isWhatsAppInboundAllowed({ allowedJids, msg, isSelfChat })
            console.log(`[whatsapp] JID filter: candidates=${collectWhatsAppAddressCandidates(msg).join(',')}, allowedJids=${allowedJids.join(',')}, matched=${matched}`)
            if (!matched) {
              console.log(`[whatsapp] Skipping message from non-allowed JID: ${jid}`)
              continue
            }
          }

          const media: NonNullable<InboundMessage['media']> = []
          const content: any = normalizeMessageContent(msg.message as any) || msg.message || {}
          const mediaCandidate:
            | { kind: 'image' | 'video' | 'audio' | 'document' | 'file'; payload: any }
            | null =
            content?.imageMessage
              ? { kind: 'image', payload: content.imageMessage }
              : content?.videoMessage
                ? { kind: 'video', payload: content.videoMessage }
                : content?.audioMessage
                  ? { kind: 'audio', payload: content.audioMessage }
                  : content?.documentMessage
                    ? { kind: 'document', payload: content.documentMessage }
                    : content?.stickerMessage
                      ? { kind: 'image', payload: content.stickerMessage }
                      : null

          if (mediaCandidate) {
            try {
              const buffer = await downloadMediaMessage(msg as any, 'buffer', {})
              const saved = saveInboundMediaBuffer({
                connectorId: connector.id,
                buffer: buffer as Buffer,
                mediaType: mediaCandidate.kind,
                mimeType: mediaCandidate.payload?.mimetype || undefined,
                fileName: mediaCandidate.payload?.fileName || undefined,
              })
              media.push(saved)
            } catch (err: any) {
              console.error(`[whatsapp] Failed to decode media: ${err?.message || String(err)}`)
              media.push({
                type: mediaCandidate.kind,
                fileName: mediaCandidate.payload?.fileName || undefined,
                mimeType: mediaCandidate.payload?.mimetype || undefined,
              })
            }
          }

          const selfJids = [
            sock?.user?.id || '',
            sock?.user?.lid || '',
          ].filter(Boolean)
          const inbound = buildWhatsAppInboundMessage({ msg, media, selfJids })
          if (!inbound) continue

          console.log(`[whatsapp] Message from ${inbound.senderName} (${jid}): ${inbound.text.slice(0, 80)}`)

          try {
            const reply = await resolveConnectorIngressReply(onMessage, inbound)
            if (!reply) continue

            const sent = await instance.sendMessage?.(jid, reply.visibleText)
            // Response delivered — register in outbound dedup so sendConnectorMessage
            // won't re-send the same text via a parallel path
            try {
              const { registerOutboundSend } = await import('./manager')
              registerOutboundSend(connector.id, jid, reply.visibleText)
            } catch { /* best effort */ }
            // Record delivery metadata (best-effort — don't send error if this fails)
            try {
              await recordConnectorOutboundDelivery({
                connectorId: connector.id,
                inbound,
                messageId: sent?.messageId,
                state: 'sent',
              })
            } catch (recordErr: unknown) {
              console.warn(`[whatsapp] Delivery recording failed (response already sent):`, errorMessage(recordErr))
            }
          } catch (err: unknown) {
            console.error(`[whatsapp] Error handling message:`, errorMessage(err))
            try {
              await sock!.sendMessage(jid, { text: 'Sorry, I encountered an error processing your message.' })
            } catch { /* ignore */ }
          }
        }
      })
    }

    startSocket()

    return instance
  },
}

export default whatsapp
