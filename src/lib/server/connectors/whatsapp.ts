import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import path from 'path'
import fs from 'fs'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'

const AUTH_DIR = path.join(process.cwd(), 'data', 'whatsapp-auth')

const whatsapp: PlatformConnector = {
  async start(connector, _botToken, onMessage): Promise<ConnectorInstance> {
    // Each connector gets its own auth directory
    const authDir = path.join(AUTH_DIR, connector.id)
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    let sock: ReturnType<typeof makeWASocket> | null = null
    let stopped = false

    const instance: ConnectorInstance = {
      connector,
      qrDataUrl: null,
      async stop() {
        stopped = true
        sock?.end(undefined)
        sock = null
        console.log(`[whatsapp] Stopped connector: ${connector.name}`)
      },
    }

    // Optional: restrict to specific numbers/group JIDs
    const allowedJids = connector.config.allowedJids
      ? connector.config.allowedJids.split(',').map((s) => s.trim()).filter(Boolean)
      : null

    const startSocket = () => {
      sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: ['SwarmClaw', 'Chrome', '120.0'],
      })

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
          console.log(`[whatsapp] Scan QR code to connect ${connector.name}`)
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
          if (reason !== DisconnectReason.loggedOut && !stopped) {
            console.log(`[whatsapp] Connection closed (${reason}), reconnecting...`)
            setTimeout(startSocket, 3000)
          } else {
            console.log(`[whatsapp] Disconnected permanently`)
          }
        } else if (connection === 'open') {
          instance.qrDataUrl = null
          console.log(`[whatsapp] Connected as ${sock?.user?.id}`)
        }
      })

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
          if (msg.key.fromMe) continue
          if (msg.key.remoteJid === 'status@broadcast') continue

          const jid = msg.key.remoteJid || ''
          if (allowedJids && !allowedJids.some((j) => jid.includes(j))) continue

          const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || ''
          if (!text) continue

          const senderName = msg.pushName || jid.split('@')[0]
          const isGroup = jid.endsWith('@g.us')

          const inbound: InboundMessage = {
            platform: 'whatsapp',
            channelId: jid,
            channelName: isGroup ? jid : `DM:${senderName}`,
            senderId: msg.key.participant || jid,
            senderName,
            text,
          }

          try {
            await sock!.sendPresenceUpdate('composing', jid)
            const response = await onMessage(inbound)
            await sock!.sendPresenceUpdate('paused', jid)
            await sock!.sendMessage(jid, { text: response })
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
