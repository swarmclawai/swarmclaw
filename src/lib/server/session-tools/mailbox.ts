import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import type { ToolBuildContext } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import {
  downloadMailboxAttachment,
  fetchMailboxMessageByUid,
  fetchMailboxMessages,
  getMailboxConfig,
  replyMailboxMessage,
} from '../mailbox-utils'
import { createWatchJob } from '../watch-jobs'

function parseMessageUid(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

async function executeMailboxAction(args: Record<string, unknown>, bctx: { cwd: string; sessionId?: string | null; agentId?: string | null }) {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'status').trim().toLowerCase()
  const folder = typeof normalized.folder === 'string' ? normalized.folder.trim() : undefined

  try {
    if (action === 'status') {
      const config = getMailboxConfig()
      return JSON.stringify({
        configured: !!(config.imapHost && config.user && config.password),
        imapHost: config.imapHost || null,
        smtpHost: config.smtpHost || null,
        folder: config.folder || 'INBOX',
        fromAddress: config.fromAddress || null,
        subjectPrefix: config.subjectPrefix || null,
      })
    }

    if (action === 'list_messages' || action === 'search_messages') {
      const messages = await fetchMailboxMessages({
        folder,
        query: typeof normalized.query === 'string' ? normalized.query : undefined,
        from: typeof normalized.from === 'string' ? normalized.from : undefined,
        subjectContains: typeof normalized.subjectContains === 'string' ? normalized.subjectContains : undefined,
        bodyContains: typeof normalized.containsText === 'string' ? normalized.containsText : undefined,
        unreadOnly: normalized.unreadOnly === true,
        hasAttachments: normalized.hasAttachments === true,
        limit: typeof normalized.limit === 'number' ? normalized.limit : undefined,
      })
      return JSON.stringify(messages.map((message) => ({
        uid: message.uid,
        messageId: message.messageId,
        subject: message.subject,
        from: message.from,
        fromName: message.fromName,
        date: message.date,
        snippet: message.snippet,
        hasAttachments: message.hasAttachments,
        attachmentCount: message.attachments.length,
        threadKey: message.threadKey,
      })))
    }

    if (action === 'list_threads') {
      const messages = await fetchMailboxMessages({
        folder,
        limit: typeof normalized.limit === 'number' ? Math.max(10, normalized.limit * 4) : 80,
      })
      const threads = new Map<string, {
        threadKey: string
        subject: string
        participants: Set<string>
        latestUid: number
        latestDate: string | null
        messageCount: number
        unreadCount: number
        snippet: string
      }>()
      for (const message of messages) {
        const current = threads.get(message.threadKey) || {
          threadKey: message.threadKey,
          subject: message.subject,
          participants: new Set<string>(),
          latestUid: message.uid,
          latestDate: message.date,
          messageCount: 0,
          unreadCount: 0,
          snippet: message.snippet,
        }
        current.messageCount += 1
        current.participants.add(message.from)
        if (!message.flags.includes('\\Seen')) current.unreadCount += 1
        if (message.uid >= current.latestUid) {
          current.latestUid = message.uid
          current.latestDate = message.date
          current.subject = message.subject
          current.snippet = message.snippet
        }
        threads.set(message.threadKey, current)
      }
      return JSON.stringify(Array.from(threads.values())
        .map((thread) => ({
          threadKey: thread.threadKey,
          subject: thread.subject,
          participants: Array.from(thread.participants),
          latestUid: thread.latestUid,
          latestDate: thread.latestDate,
          messageCount: thread.messageCount,
          unreadCount: thread.unreadCount,
          snippet: thread.snippet,
        }))
        .sort((a, b) => b.latestUid - a.latestUid)
        .slice(0, Math.max(1, Math.min(typeof normalized.limit === 'number' ? normalized.limit : 20, 100))))
    }

    if (action === 'read_message') {
      const uid = parseMessageUid(normalized.uid ?? normalized.id)
      if (!uid) return 'Error: uid is required.'
      const message = await fetchMailboxMessageByUid(uid, folder)
      if (!message) return `Error: mailbox message "${uid}" not found.`
      return JSON.stringify(message)
    }

    if (action === 'download_attachment') {
      const uid = parseMessageUid(normalized.uid ?? normalized.id)
      if (!uid) return 'Error: uid is required.'
      const result = await downloadMailboxAttachment({
        uid,
        folder,
        attachmentId: typeof normalized.attachmentId === 'string' ? normalized.attachmentId : undefined,
        attachmentName: typeof normalized.attachmentName === 'string' ? normalized.attachmentName : undefined,
        saveTo: typeof normalized.saveTo === 'string' ? normalized.saveTo : undefined,
        cwd: bctx.cwd,
      })
      return JSON.stringify(result)
    }

    if (action === 'reply') {
      const uid = parseMessageUid(normalized.uid ?? normalized.id)
      if (!uid) return 'Error: uid is required.'
      const text = typeof normalized.text === 'string'
        ? normalized.text
        : typeof normalized.body === 'string'
          ? normalized.body
          : ''
      if (!text.trim()) return 'Error: text is required.'
      const result = await replyMailboxMessage({
        uid,
        folder,
        text,
        html: typeof normalized.html === 'string' ? normalized.html : undefined,
        subject: typeof normalized.subject === 'string' ? normalized.subject : undefined,
      })
      return JSON.stringify({ ok: true, ...result, uid })
    }

    if (action === 'wait_for_email') {
      if (!bctx.sessionId && !bctx.agentId) return 'Error: email waits require a session or agent context.'
      const resumeMessage = typeof normalized.resumeMessage === 'string' && normalized.resumeMessage.trim()
        ? normalized.resumeMessage.trim()
        : 'A matching email arrived. Read it, decide what to do next, and continue the task.'
      const intervalMs = typeof normalized.intervalSec === 'number'
        ? Math.max(30, normalized.intervalSec) * 1000
        : 60_000
      const timeoutAt = typeof normalized.timeoutMinutes === 'number'
        ? Date.now() + Math.max(1, normalized.timeoutMinutes) * 60_000
        : undefined
      const job = await createWatchJob({
        type: 'email',
        sessionId: bctx.sessionId || null,
        agentId: bctx.agentId || null,
        createdByAgentId: bctx.agentId || null,
        resumeMessage,
        description: typeof normalized.description === 'string' ? normalized.description : 'Wait for email',
        intervalMs,
        timeoutAt,
        target: {
          folder: folder || getMailboxConfig().folder || 'INBOX',
        },
        condition: {
          from: typeof normalized.from === 'string' ? normalized.from : undefined,
          subjectContains: typeof normalized.subjectContains === 'string' ? normalized.subjectContains : undefined,
          containsText: typeof normalized.containsText === 'string' ? normalized.containsText : undefined,
          query: typeof normalized.query === 'string' ? normalized.query : undefined,
          unreadOnly: normalized.unreadOnly === true,
          hasAttachments: normalized.hasAttachments === true,
        },
      })
      return JSON.stringify(job)
    }

    return `Error: Unknown action "${action}".`
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

const MailboxPlugin: Plugin = {
  name: 'Mailbox',
  enabledByDefault: false,
  description: 'Read/search/reply to inbox messages over IMAP/SMTP, download attachments, and wait for matching inbound email.',
  hooks: {
    getCapabilityDescription: () =>
      'I can inspect inboxes with `mailbox`, read and search messages, download attachments, reply to emails, and wait for specific inbound messages.',
  } as PluginHooks,
  tools: [
    {
      name: 'mailbox',
      description: 'Work with email inboxes. Actions: status, list_messages, list_threads, search_messages, read_message, download_attachment, reply, wait_for_email.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'list_messages', 'list_threads', 'search_messages', 'read_message', 'download_attachment', 'reply', 'wait_for_email'] },
          uid: { type: 'number' },
          query: { type: 'string' },
          from: { type: 'string' },
          subjectContains: { type: 'string' },
          containsText: { type: 'string' },
          attachmentId: { type: 'string' },
          attachmentName: { type: 'string' },
          text: { type: 'string' },
          body: { type: 'string' },
          html: { type: 'string' },
          subject: { type: 'string' },
          folder: { type: 'string' },
          unreadOnly: { type: 'boolean' },
          hasAttachments: { type: 'boolean' },
          limit: { type: 'number' },
          saveTo: { type: 'string' },
          resumeMessage: { type: 'string' },
          intervalSec: { type: 'number' },
          timeoutMinutes: { type: 'number' },
        },
        required: ['action'],
      },
      execute: async (args, context) => executeMailboxAction(args, {
        cwd: context.session.cwd || process.cwd(),
        sessionId: context.session.id,
        agentId: context.session.agentId || null,
      }),
    },
  ],
  ui: {
    settingsFields: [
      { key: 'imapHost', label: 'IMAP Host', type: 'text', placeholder: 'imap.gmail.com', help: 'Inbound mailbox host.' },
      { key: 'imapPort', label: 'IMAP Port', type: 'number', defaultValue: 993, help: '993 for TLS IMAP.' },
      { key: 'smtpHost', label: 'SMTP Host', type: 'text', placeholder: 'smtp.gmail.com', help: 'Outbound mail host for replies.' },
      { key: 'smtpPort', label: 'SMTP Port', type: 'number', defaultValue: 587, help: '587 for STARTTLS, 465 for SSL.' },
      { key: 'user', label: 'Mailbox Username', type: 'text', placeholder: 'agent@example.com' },
      { key: 'password', label: 'Mailbox Password', type: 'secret', help: 'IMAP password or app password.' },
      { key: 'folder', label: 'Folder', type: 'text', defaultValue: 'INBOX', placeholder: 'INBOX' },
      { key: 'fromAddress', label: 'Reply From Address', type: 'text', placeholder: 'agent@example.com' },
      { key: 'fromName', label: 'Reply From Name', type: 'text', defaultValue: 'SwarmClaw Agent' },
    ],
  },
}

getPluginManager().registerBuiltin('mailbox', MailboxPlugin)

export function buildMailboxTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('mailbox')) return []
  return [
    tool(
      async (args) => executeMailboxAction(args, {
        cwd: bctx.cwd,
        sessionId: bctx.ctx?.sessionId || null,
        agentId: bctx.ctx?.agentId || null,
      }),
      {
        name: 'mailbox',
        description: MailboxPlugin.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
