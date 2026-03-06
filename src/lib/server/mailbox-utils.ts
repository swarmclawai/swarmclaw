import fs from 'fs'
import path from 'path'
import { ImapFlow } from 'imapflow'
import { createTransport } from 'nodemailer'
import { simpleParser } from 'mailparser'
import { UPLOAD_DIR, loadConnectors } from './storage'
import { getPluginManager } from './plugins'

export interface MailboxConfig {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  user: string
  password: string
  smtpUsername: string
  smtpPassword: string
  folder: string
  subjectPrefix?: string
  fromAddress: string
  fromName: string
}

export interface MailboxAttachment {
  id: string
  filename: string
  contentType: string | null
  sizeBytes: number
}

export interface MailboxMessage {
  id: string
  uid: number
  messageId: string | null
  subject: string
  from: string
  fromName: string
  date: string | null
  snippet: string
  text: string
  html: string | null
  threadKey: string
  references: string[]
  hasAttachments: boolean
  attachments: MailboxAttachment[]
  flags: string[]
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function pickNumber(fallback: number, ...values: unknown[]): number {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed)
  }
  return fallback
}

function normalizeThreadKey(subject: string, references: string[]): string {
  if (references.length > 0) return references[references.length - 1]
  return subject.replace(/^re:\s*/i, '').trim().toLowerCase()
}

function sanitizeAttachmentName(value: string | undefined, fallback: string): string {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || fallback
}

export function getMailboxConfig(): MailboxConfig {
  const pluginManager = getPluginManager()
  const mailboxSettings = pluginManager.getPluginSettings('mailbox') as Record<string, unknown>
  const emailSettings = pluginManager.getPluginSettings('email') as Record<string, unknown>
  const connectors = loadConnectors()
  const emailConnector = Object.values(connectors)
    .find((entry) => entry && typeof entry === 'object' && String((entry as Record<string, unknown>).platform || '').toLowerCase() === 'email') as Record<string, unknown> | undefined
  const connectorConfig = emailConnector && typeof emailConnector.config === 'object' && emailConnector.config
    ? emailConnector.config as Record<string, unknown>
    : {}

  const user = pickString(mailboxSettings.user, connectorConfig.user)
  const password = pickString(mailboxSettings.password, connectorConfig.password)

  return {
    imapHost: pickString(mailboxSettings.imapHost, connectorConfig.imapHost),
    imapPort: pickNumber(993, mailboxSettings.imapPort, connectorConfig.imapPort),
    smtpHost: pickString(mailboxSettings.smtpHost, emailSettings.host, connectorConfig.smtpHost),
    smtpPort: pickNumber(587, mailboxSettings.smtpPort, emailSettings.port, connectorConfig.smtpPort),
    user,
    password,
    smtpUsername: pickString(mailboxSettings.smtpUsername, emailSettings.username, connectorConfig.user, user),
    smtpPassword: pickString(mailboxSettings.smtpPassword, emailSettings.password, connectorConfig.password, password),
    folder: pickString(mailboxSettings.folder, connectorConfig.folder, 'INBOX') || 'INBOX',
    subjectPrefix: pickString(mailboxSettings.subjectPrefix, connectorConfig.subjectPrefix) || undefined,
    fromAddress: pickString(mailboxSettings.fromAddress, emailSettings.fromAddress, connectorConfig.user, user),
    fromName: pickString(mailboxSettings.fromName, emailSettings.fromName, 'SwarmClaw Agent'),
  }
}

function ensureMailboxConfigured(config: MailboxConfig): void {
  if (!config.imapHost || !config.user || !config.password) {
    throw new Error('Mailbox plugin requires IMAP host, user, and password.')
  }
}

async function withImapClient<T>(config: MailboxConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  ensureMailboxConfigured(config)
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapPort === 993,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    try { await client.logout() } catch { /* ignore */ }
  }
}

function messageMatchesFilters(message: MailboxMessage, filters: {
  query?: string
  from?: string
  subjectContains?: string
  bodyContains?: string
  unreadOnly?: boolean
  hasAttachments?: boolean
  uidGreaterThan?: number
}) {
  if (typeof filters.uidGreaterThan === 'number' && message.uid <= filters.uidGreaterThan) return false
  if (filters.unreadOnly === true && message.flags.includes('\\Seen')) return false
  if (filters.hasAttachments === true && !message.hasAttachments) return false
  const from = filters.from?.trim().toLowerCase()
  if (from && !message.from.toLowerCase().includes(from) && !message.fromName.toLowerCase().includes(from)) return false
  const subjectContains = filters.subjectContains?.trim().toLowerCase()
  if (subjectContains && !message.subject.toLowerCase().includes(subjectContains)) return false
  const bodyContains = filters.bodyContains?.trim().toLowerCase()
  if (bodyContains && !message.text.toLowerCase().includes(bodyContains)) return false
  const query = filters.query?.trim().toLowerCase()
  if (query) {
    const hay = `${message.subject}\n${message.from}\n${message.fromName}\n${message.text}`.toLowerCase()
    if (!hay.includes(query)) return false
  }
  return true
}

function toMailboxMessage(raw: {
  uid: number
  envelope?: {
    from?: Array<{ name?: string; address?: string }>
    subject?: string
    messageId?: string
    date?: Date
    inReplyTo?: string
    references?: string[]
  }
  flags?: Set<string>
  source?: Buffer
}, parsed: Awaited<ReturnType<typeof simpleParser>>): MailboxMessage {
  const fromAddress = raw.envelope?.from?.[0]?.address || parsed.from?.value?.[0]?.address || 'unknown'
  const fromName = raw.envelope?.from?.[0]?.name || parsed.from?.value?.[0]?.name || fromAddress
  const references = [
    ...(Array.isArray(raw.envelope?.references) ? raw.envelope?.references : []),
    ...(parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  return {
    id: String(raw.uid),
    uid: raw.uid,
    messageId: raw.envelope?.messageId || parsed.messageId || null,
    subject: raw.envelope?.subject || parsed.subject || '(no subject)',
    from: fromAddress,
    fromName,
    date: raw.envelope?.date ? raw.envelope.date.toISOString() : (parsed.date ? parsed.date.toISOString() : null),
    snippet: (parsed.text || parsed.html || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    text: (parsed.text || '').trim(),
    html: typeof parsed.html === 'string' ? parsed.html : null,
    threadKey: normalizeThreadKey(raw.envelope?.subject || parsed.subject || '', references),
    references,
    hasAttachments: parsed.attachments.length > 0,
    attachments: parsed.attachments.map((attachment, index) => ({
      id: `${raw.uid}:${index}`,
      filename: sanitizeAttachmentName(attachment.filename || undefined, `attachment-${index + 1}`),
      contentType: attachment.contentType || null,
      sizeBytes: attachment.size || 0,
    })),
    flags: Array.from(raw.flags || new Set<string>()),
  }
}

export async function getMailboxHighwaterUid(config = getMailboxConfig(), folder?: string): Promise<number> {
  return withImapClient(config, async (client) => {
    const targetFolder = folder || config.folder || 'INBOX'
    const lock = await client.getMailboxLock(targetFolder)
    try {
      const status = await client.status(targetFolder, { uidNext: true })
      return typeof status.uidNext === 'number' ? Math.max(0, status.uidNext - 1) : 0
    } finally {
      lock.release()
    }
  })
}

export async function fetchMailboxMessages(filters?: {
  folder?: string
  query?: string
  from?: string
  subjectContains?: string
  bodyContains?: string
  unreadOnly?: boolean
  hasAttachments?: boolean
  uidGreaterThan?: number
  limit?: number
}): Promise<MailboxMessage[]> {
  const config = getMailboxConfig()
  return withImapClient(config, async (client) => {
    const folder = filters?.folder || config.folder || 'INBOX'
    const limit = Math.max(1, Math.min(filters?.limit || 20, 100))
    const lock = await client.getMailboxLock(folder)
    try {
      const status = await client.status(folder, { uidNext: true })
      const endUid = typeof status.uidNext === 'number' ? Math.max(0, status.uidNext - 1) : 0
      if (endUid <= 0) return []
      const startUid = Math.max(1, endUid - Math.max(limit * 4, 60) + 1)
      const messages: MailboxMessage[] = []
      for await (const raw of client.fetch(`${startUid}:${endUid}`, {
        uid: true,
        envelope: true,
        flags: true,
        source: true,
      }, { uid: true })) {
        if (!raw.source) continue
        const parsed = await simpleParser(raw.source)
        const message = toMailboxMessage(raw, parsed)
        if (!messageMatchesFilters(message, filters || {})) continue
        if (config.subjectPrefix && !message.subject.startsWith(config.subjectPrefix)) continue
        messages.push(message)
      }
      return messages.sort((a, b) => b.uid - a.uid).slice(0, limit)
    } finally {
      lock.release()
    }
  })
}

export async function fetchMailboxMessageByUid(uid: number, folder?: string): Promise<MailboxMessage | null> {
  const messages = await fetchMailboxMessages({ folder, uidGreaterThan: uid - 1, limit: 100 })
  return messages.find((message) => message.uid === uid) || null
}

export async function downloadMailboxAttachment(params: {
  uid: number
  attachmentId?: string
  attachmentName?: string
  folder?: string
  saveTo?: string
  cwd?: string
}): Promise<{ filePath: string; fileName: string; url: string | null }> {
  const config = getMailboxConfig()
  return withImapClient(config, async (client) => {
    const folder = params.folder || config.folder || 'INBOX'
    const lock = await client.getMailboxLock(folder)
    try {
      for await (const raw of client.fetch(String(params.uid), { uid: true, source: true }, { uid: true })) {
        if (!raw.source) continue
        const parsed = await simpleParser(raw.source)
        const selected = parsed.attachments.find((attachment, index) => {
          const generatedId = `${params.uid}:${index}`
          if (params.attachmentId && generatedId === params.attachmentId) return true
          if (params.attachmentName && attachment.filename === params.attachmentName) return true
          return !params.attachmentId && !params.attachmentName && index === 0
        })
        if (!selected) throw new Error('Attachment not found.')

        const fileName = sanitizeAttachmentName(selected.filename || undefined, `attachment-${params.uid}`)
        const targetPath = params.saveTo
          ? path.resolve(params.cwd || process.cwd(), params.saveTo)
          : path.join(UPLOAD_DIR, `${Date.now()}-${fileName}`)
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.writeFileSync(targetPath, selected.content)

        const publicPath = targetPath.startsWith(UPLOAD_DIR)
          ? targetPath
          : path.join(UPLOAD_DIR, `${Date.now()}-${path.basename(targetPath)}`)
        if (publicPath !== targetPath) fs.copyFileSync(targetPath, publicPath)
        return {
          filePath: targetPath,
          fileName,
          url: `/api/uploads/${path.basename(publicPath)}`,
        }
      }
      throw new Error(`Mailbox message not found: ${params.uid}`)
    } finally {
      lock.release()
    }
  })
}

export async function replyMailboxMessage(params: {
  uid: number
  text: string
  html?: string
  subject?: string
  folder?: string
}): Promise<{ to: string; subject: string }> {
  const config = getMailboxConfig()
  if (!config.smtpHost || !config.fromAddress) {
    throw new Error('Mailbox reply requires SMTP host and fromAddress configuration.')
  }

  const message = await fetchMailboxMessageByUid(params.uid, params.folder)
  if (!message) throw new Error(`Mailbox message not found: ${params.uid}`)

  const transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUsername || config.user,
      pass: config.smtpPassword || config.password,
    },
  })

  const subject = params.subject?.trim() || `Re: ${message.subject.replace(/^Re:\s*/i, '')}`
  await transport.sendMail({
    from: config.fromName ? `"${config.fromName}" <${config.fromAddress}>` : config.fromAddress,
    to: message.from,
    subject,
    text: params.text,
    html: params.html,
    inReplyTo: message.messageId || undefined,
    references: message.messageId || undefined,
  })

  return { to: message.from, subject }
}
