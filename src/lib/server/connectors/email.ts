import fs from 'fs'
import path from 'path'
import { ImapFlow } from 'imapflow'
import { createTransport, type Transporter } from 'nodemailer'
import { simpleParser } from 'mailparser'
import type { Connector } from '@/types'
import type { PlatformConnector, ConnectorInstance, InboundMessage, OutboundSendOptions } from './types'
import { resolveConnectorIngressReply } from './ingress-delivery'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '@/lib/server/logger'

const TAG = 'email'

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
  tlsRejectUnauthorized: boolean
}

interface MailAttachment {
  path: string
  filename: string
  contentType?: string
}

interface ImapErrorEmitter {
  on(event: 'error', listener: (err: unknown) => void): unknown
}

export function buildAttachments(options?: OutboundSendOptions): MailAttachment[] {
  const source = options?.mediaPath
  if (!source) return []
  if (!fs.existsSync(source)) {
    log.warn(TAG, `Attachment file not found: ${source}`)
    return []
  }
  return [{
    path: source,
    filename: options?.fileName || path.basename(source),
    ...(options?.mimeType ? { contentType: options.mimeType } : {}),
  }]
}

export function parseTlsRejectUnauthorized(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return true

  const normalized = value.trim().toLowerCase()
  if (!normalized) return true
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
  return true
}

export function buildEmailTlsOptions(config: Pick<EmailConfig, 'tlsRejectUnauthorized'>): { rejectUnauthorized: boolean; checkServerIdentity?: () => undefined } {
  const reject = config.tlsRejectUnauthorized !== false
  // When the user opts out of cert verification, also bypass hostname/altname
  // matching. Otherwise self-signed-cert servers like Proton Mail Bridge still
  // fail with "Hostname/IP does not match certificate's altnames" even though
  // rejectUnauthorized:false is set — defeating the purpose of the option.
  return reject ? { rejectUnauthorized: true } : { rejectUnauthorized: false, checkServerIdentity: () => undefined }
}

export function attachImapErrorHandler(imap: ImapErrorEmitter, onDisconnected: () => void): void {
  imap.on('error', (err: unknown) => {
    onDisconnected()
    log.error(TAG, `IMAP socket error: ${errorMessage(err)}`)
  })
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
    tlsRejectUnauthorized: parseTlsRejectUnauthorized(c.tlsRejectUnauthorized),
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
    const tls = buildEmailTlsOptions(config)
    let connected = false

    // IMAP client for inbound
    const imap = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort || 993,
      secure: (config.imapPort || 993) === 993,
      tls,
      auth: {
        user: config.user,
        pass: config.password,
      },
      logger: false,
    })
    attachImapErrorHandler(imap, () => {
      connected = false
    })

    // SMTP transport for outbound
    const smtp: Transporter = createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: (config.smtpPort || 587) === 465,
      tls,
      auth: {
        user: config.user,
        pass: config.password,
      },
    })

    // Track last seen UID to only process new messages
    let highwaterUid = 0
    let pollTimer: ReturnType<typeof setInterval> | null = null

    // Map to track original sender per channelId (email address) for replies
    const senderMap = new Map<string, { address: string; subject: string; messageId?: string }>()

    async function connectImap(): Promise<void> {
      try {
        await imap.connect()
        connected = true
        log.info(TAG, `IMAP connected to ${config.imapHost}`)

        // Get the current highest UID as highwater mark (don't process old messages)
        const lock = await imap.getMailboxLock(folder)
        try {
          const status = await imap.status(folder, { uidNext: true })
          // uidNext is the next UID that will be assigned; current highest is uidNext - 1
          highwaterUid = typeof status.uidNext === 'number' ? status.uidNext - 1 : 0
          log.info(TAG, `Initial highwater UID: ${highwaterUid} in ${folder}`)
        } finally {
          lock.release()
        }
      } catch (err: unknown) {
        connected = false
        const msg = errorMessage(err)
        log.error(TAG, `IMAP connection failed: ${msg}`)
        throw err
      }
    }

    async function pollForNewMessages(): Promise<void> {
      if (!connected) return

      let lock
      try {
        lock = await imap.getMailboxLock(folder)
      } catch (err: unknown) {
        const msg = errorMessage(err)
        log.error(TAG, `Failed to acquire mailbox lock: ${msg}`)
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
            const errMsg = errorMessage(err)
            log.error(TAG, `Error processing message UID ${msg.uid}: ${errMsg}`)
          }
          if (msg.uid > highwaterUid) {
            highwaterUid = msg.uid
          }
        }
      } catch (err: unknown) {
        const errMsg = errorMessage(err)
        // A fetch on an empty range can throw; that's normal
        if (!errMsg.includes('Nothing to fetch')) {
          log.error(TAG, `Poll error: ${errMsg}`)
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
        log.info(TAG, `Skipping message from ${fromAddr} — subject "${subject}" doesn't match prefix "${config.subjectPrefix}"`)
        return
      }

      // Parse the email body for text content
      let bodyText = ''
      if (msg.source) {
        const parsed = await simpleParser(msg.source)
        bodyText = parsed.text || ''
      }

      if (!bodyText.trim()) {
        log.info(TAG, `Skipping empty message from ${fromAddr}`)
        return
      }

      log.info(TAG, `New message from ${fromName} <${fromAddr}>: ${subject}`)

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
        const reply = await resolveConnectorIngressReply(onMessage, inbound)
        if (!reply) return

        // Reply via SMTP
        await sendReply(channelId, reply.visibleText)
      } catch (err: unknown) {
        const errMsg = errorMessage(err)
        log.error(TAG, `Error handling message from ${fromAddr}: ${errMsg}`)
      }
    }

    async function sendReply(
      channelId: string,
      text: string,
      options?: OutboundSendOptions,
    ): Promise<void> {
      const sender = senderMap.get(channelId)
      const to = sender?.address || channelId
      const subject = sender?.subject ? `Re: ${sender.subject.replace(/^Re:\s*/i, '')}` : 'Re: SwarmClaw'

      const mailOptions: Record<string, unknown> = {
        from: config.user,
        to,
        subject,
        text: options?.caption || text,
      }

      // Thread the reply using In-Reply-To header
      if (sender?.messageId) {
        mailOptions['inReplyTo'] = sender.messageId
        mailOptions['references'] = sender.messageId
      }

      const attachments = buildAttachments(options)
      if (attachments.length > 0) mailOptions['attachments'] = attachments

      await smtp.sendMail(mailOptions)
      log.info(TAG, `Reply sent to ${to}${attachments.length ? ` with ${attachments.length} attachment(s)` : ''}`)
    }

    // Connect and start polling
    await connectImap()

    pollTimer = setInterval(() => {
      pollForNewMessages().catch((err: unknown) => {
        const msg = errorMessage(err)
        log.error(TAG, `Poll interval error: ${msg}`)
      })
    }, pollMs)

    log.info(TAG, `Connector started — polling every ${config.pollIntervalSec || 60}s`)

    return {
      connector,

      isAlive() {
        return connected && imap.usable
      },

      async sendMessage(channelId, text, options) {
        await sendReply(channelId, text, options)
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
        log.info(TAG, `Connector stopped`)
      },
    }
  },
}

export default email
