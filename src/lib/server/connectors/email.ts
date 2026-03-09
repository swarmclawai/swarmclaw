import { ImapFlow } from 'imapflow'
import { createTransport, type Transporter } from 'nodemailer'
import { simpleParser } from 'mailparser'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'
import { normalizeConnectorIngressResult } from './types'
import { isNoMessage } from './manager'

interface EmailConfig {
  imapHost: string
  imapPort?: number
  smtpHost: string
  smtpPort?: number
  user: string
  password: string
  folder?: string
  pollIntervalSec?: number
  subjectPrefix?: string
}

function getConfig(connector: Connector): EmailConfig {
  const c = connector.config as Record<string, unknown>
  return {
    imapHost: String(c.imapHost ?? ''),
    imapPort: Number(c.imapPort ?? 993),
    smtpHost: String(c.smtpHost ?? ''),
    smtpPort: Number(c.smtpPort ?? 587),
    user: String(c.user ?? ''),
    password: String(c.password ?? ''),
    folder: String(c.folder ?? 'INBOX'),
    pollIntervalSec: Number(c.pollIntervalSec ?? 60),
    subjectPrefix: c.subjectPrefix ? String(c.subjectPrefix) : undefined,
  }
}

const email: PlatformConnector = {
  async start(connector, _botToken, onMessage): Promise<ConnectorInstance> {
    const config = getConfig(connector)

    if (!config.imapHost || !config.smtpHost || !config.user || !config.password) {
      throw new Error('Email connector requires imapHost, smtpHost, user, and password')
    }

    const folder = config.folder || 'INBOX'
    const pollMs = (config.pollIntervalSec || 60) * 1000

    // IMAP client for inbound
    const imap = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort || 993,
      secure: (config.imapPort || 993) === 993,
      auth: {
        user: config.user,
        pass: config.password,
      },
      logger: false,
    })

    // SMTP transport for outbound
    const smtp: Transporter = createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: (config.smtpPort || 587) === 465,
      auth: {
        user: config.user,
        pass: config.password,
      },
    })

    // Track last seen UID to only process new messages
    let highwaterUid = 0
    let connected = false
    let pollTimer: ReturnType<typeof setInterval> | null = null

    // Map to track original sender per channelId (email address) for replies
    const senderMap = new Map<string, { address: string; subject: string; messageId?: string }>()

    async function connectImap(): Promise<void> {
      try {
        await imap.connect()
        connected = true
        console.log(`[email] IMAP connected to ${config.imapHost}`)

        // Get the current highest UID as highwater mark (don't process old messages)
        const lock = await imap.getMailboxLock(folder)
        try {
          const status = await imap.status(folder, { uidNext: true })
          // uidNext is the next UID that will be assigned; current highest is uidNext - 1
          highwaterUid = typeof status.uidNext === 'number' ? status.uidNext - 1 : 0
          console.log(`[email] Initial highwater UID: ${highwaterUid} in ${folder}`)
        } finally {
          lock.release()
        }
      } catch (err: unknown) {
        connected = false
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[email] IMAP connection failed: ${msg}`)
        throw err
      }
    }

    async function pollForNewMessages(): Promise<void> {
      if (!connected) return

      let lock
      try {
        lock = await imap.getMailboxLock(folder)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[email] Failed to acquire mailbox lock: ${msg}`)
        connected = false
        return
      }

      try {
        // Fetch messages with UID > highwaterUid
        const range = `${highwaterUid + 1}:*`
        const messages = []

        for await (const msg of imap.fetch(range, { envelope: true, source: true, uid: true }, { uid: true })) {
          if (msg.uid <= highwaterUid) continue
          messages.push(msg)
        }

        for (const msg of messages) {
          try {
            await processMessage(msg)
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error(`[email] Error processing message UID ${msg.uid}: ${errMsg}`)
          }
          if (msg.uid > highwaterUid) {
            highwaterUid = msg.uid
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // A fetch on an empty range can throw; that's normal
        if (!errMsg.includes('Nothing to fetch')) {
          console.error(`[email] Poll error: ${errMsg}`)
        }
      } finally {
        lock.release()
      }
    }

    async function processMessage(msg: { uid: number; envelope?: { from?: Array<{ name?: string; address?: string }>; subject?: string; messageId?: string }; source?: Buffer }): Promise<void> {
      const envelope = msg.envelope
      if (!envelope) return

      const fromAddr = envelope.from?.[0]?.address || 'unknown'
      const fromName = envelope.from?.[0]?.name || fromAddr
      const subject = envelope.subject || '(no subject)'

      // Filter by subject prefix if configured
      if (config.subjectPrefix && !subject.startsWith(config.subjectPrefix)) {
        console.log(`[email] Skipping message from ${fromAddr} — subject "${subject}" doesn't match prefix "${config.subjectPrefix}"`)
        return
      }

      // Parse the email body for text content
      let bodyText = ''
      if (msg.source) {
        const parsed = await simpleParser(msg.source)
        bodyText = parsed.text || ''
      }

      if (!bodyText.trim()) {
        console.log(`[email] Skipping empty message from ${fromAddr}`)
        return
      }

      console.log(`[email] New message from ${fromName} <${fromAddr}>: ${subject}`)

      // Use the sender's email as channelId
      const channelId = fromAddr

      // Store sender info for replies
      senderMap.set(channelId, {
        address: fromAddr,
        subject,
        messageId: envelope.messageId,
      })

      const inbound: InboundMessage = {
        platform: 'email',
        channelId,
        channelName: `Email: ${fromName}`,
        senderId: fromAddr,
        senderName: fromName,
        text: bodyText.trim(),
      }

      try {
        const routeResult = normalizeConnectorIngressResult(await onMessage(inbound))
        if (routeResult.managerHandled || routeResult.delivery === 'silent') return
        const response = routeResult.visibleText
        if (isNoMessage(response)) return

        // Reply via SMTP
        await sendReply(channelId, response)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[email] Error handling message from ${fromAddr}: ${errMsg}`)
      }
    }

    async function sendReply(channelId: string, text: string): Promise<void> {
      const sender = senderMap.get(channelId)
      const to = sender?.address || channelId
      const subject = sender?.subject ? `Re: ${sender.subject.replace(/^Re:\s*/i, '')}` : 'Re: SwarmClaw'

      const mailOptions: Record<string, unknown> = {
        from: config.user,
        to,
        subject,
        text,
      }

      // Thread the reply using In-Reply-To header
      if (sender?.messageId) {
        mailOptions['inReplyTo'] = sender.messageId
        mailOptions['references'] = sender.messageId
      }

      await smtp.sendMail(mailOptions)
      console.log(`[email] Reply sent to ${to}`)
    }

    // Connect and start polling
    await connectImap()

    pollTimer = setInterval(() => {
      pollForNewMessages().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[email] Poll interval error: ${msg}`)
      })
    }, pollMs)

    console.log(`[email] Connector started — polling every ${config.pollIntervalSec || 60}s`)

    return {
      connector,

      isAlive() {
        return connected && imap.usable
      },

      async sendMessage(channelId, text) {
        await sendReply(channelId, text)
      },

      async stop() {
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        try {
          await imap.logout()
        } catch {
          // Connection may already be closed
        }
        connected = false
        console.log(`[email] Connector stopped`)
      },
    }
  },
}

export default email
