import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import path from 'path'
import fs from 'fs'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { saveInboundMediaBuffer } from './media'

const AUTH_DIR = path.join(process.cwd(), 'data', 'whatsapp-auth')

/** Normalize a phone number for JID matching — strip leading 0 or + */
function normalizeNumber(num: string): string {
  let n = num.replace(/[\s\-()]/g, '')
  // UK local: 07xxx → 447xxx
  if (n.startsWith('0') && n.length >= 10) {
    n = '44' + n.slice(1)
  }
  // Strip leading +
  if (n.startsWith('+')) n = n.slice(1)
  return n
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

    const instance: ConnectorInstance = {
      connector,
      qrDataUrl: null,
      authenticated: false,
      hasCredentials: hasStoredCreds(authDir),
      async sendMessage(channelId, text, options) {
        if (!sock) throw new Error('WhatsApp connector is not connected')
        if (options?.imageUrl) {
          const sent = await sock.sendMessage(channelId, {
            image: { url: options.imageUrl },
            caption: options.caption || text || undefined,
          })
          if (sent?.key?.id) sentMessageIds.add(sent.key.id)
          return { messageId: sent?.key?.id || undefined }
        }
        if (options?.fileUrl) {
          const sent = await sock.sendMessage(channelId, {
            document: { url: options.fileUrl },
            fileName: options.fileName || 'attachment',
            mimetype: options.mimeType || 'application/octet-stream',
            caption: options.caption || text || undefined,
          })
          if (sent?.key?.id) sentMessageIds.add(sent.key.id)
          return { messageId: sent?.key?.id || undefined }
        }

        const payload = text || options?.caption || ''
        const chunks = payload.length <= 4096 ? [payload] : (payload.match(/[\s\S]{1,4000}/g) || [payload])
        let lastMessageId: string | undefined
        for (const chunk of chunks) {
          const sent = await sock.sendMessage(channelId, { text: chunk })
          if (sent?.key?.id) {
            lastMessageId = sent.key.id
            sentMessageIds.add(sent.key.id)
          }
        }
        return { messageId: lastMessageId }
      },
      async stop() {
        stopped = true
        try { sock?.end(undefined) } catch { /* ignore */ }
        sock = null
        console.log(`[whatsapp] Stopped connector: ${connector.name}`)
      },
    }

    // Normalize allowed JIDs for matching
    const allowedJids = connector.config.allowedJids
      ? connector.config.allowedJids.split(',').map((s) => normalizeNumber(s.trim())).filter(Boolean)
      : null

    // Track message IDs sent by the bot to avoid infinite loops in self-chat
    const sentMessageIds = new Set<string>()

    if (allowedJids) {
      console.log(`[whatsapp] Allowed JIDs (normalized): ${allowedJids.join(', ')}`)
    }

    const startSocket = () => {
      // Close previous socket to prevent stale event handlers
      if (sock) {
        try { sock.ev.removeAllListeners('connection.update') } catch { /* ignore */ }
        try { sock.ev.removeAllListeners('messages.upsert') } catch { /* ignore */ }
        try { sock.ev.removeAllListeners('creds.update') } catch { /* ignore */ }
        try { sock.end(undefined) } catch { /* ignore */ }
        sock = null
      }

      const gen = ++socketGen // Capture generation for stale detection
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
              setTimeout(startSocket, 1000)
            }
          } else if (reason === 440) {
            // Conflict — another session replaced this one. Do NOT reconnect
            // (reconnecting would create a ping-pong loop with the other session)
            console.log(`[whatsapp] Session conflict (replaced by another connection) — stopping`)
            instance.authenticated = false
          } else if (!stopped) {
            console.log(`[whatsapp] Reconnecting in 3s...`)
            setTimeout(startSocket, 3000)
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

          // Match allowed JIDs using normalized numbers
          // Self-chat always passes the filter (it's the bot's own account)
          if (allowedJids && !isSelfChat) {
            const jidNumber = jid.split('@')[0]
            const matched = allowedJids.some((n) => jidNumber.includes(n) || n.includes(jidNumber))
            console.log(`[whatsapp] JID filter: jidNumber=${jidNumber}, allowedJids=${allowedJids.join(',')}, matched=${matched}`)
            if (!matched) {
              console.log(`[whatsapp] Skipping message from non-allowed JID: ${jid}`)
              continue
            }
          }

          const content: any = normalizeMessageContent(msg.message as any) || msg.message || {}
          const text = content?.conversation
            || content?.extendedTextMessage?.text
            || content?.imageMessage?.caption
            || content?.videoMessage?.caption
            || content?.documentMessage?.caption
            || ''

          const media: NonNullable<InboundMessage['media']> = []
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

          if (!text && media.length === 0) continue

          const senderName = msg.pushName || jid.split('@')[0]
          const isGroup = jid.endsWith('@g.us')

          console.log(`[whatsapp] Message from ${senderName} (${jid}): ${text.slice(0, 80)}`)

          const inbound: InboundMessage = {
            platform: 'whatsapp',
            channelId: jid,
            channelName: isGroup ? jid : `DM:${senderName}`,
            senderId: msg.key.participant || jid,
            senderName,
            text: text || '(media message)',
            imageUrl: media.find((m) => m.type === 'image')?.url,
            media,
          }

          try {
            await sock!.sendPresenceUpdate('composing', jid)
            const response = await onMessage(inbound)
            await sock!.sendPresenceUpdate('paused', jid)

            // NO_MESSAGE means the agent chose not to reply — skip outbound send
            if (response !== 'NO_MESSAGE') {
              await instance.sendMessage?.(jid, response)
            }
          } catch (err: any) {
            console.error(`[whatsapp] Error handling message:`, err.message)
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
