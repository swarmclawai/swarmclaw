import { genId } from '@/lib/id'
import type { MailboxEnvelope } from '@/types'
import { loadSessions, saveSessions } from '@/lib/server/storage'

interface MailboxOptions {
  limit?: number
  includeAcked?: boolean
}

interface HumanRequestPayload {
  question: string
  options: string[]
  expectedFormat: string | null
  notes: string | null
}

function normalizeMailboxList(raw: unknown): MailboxEnvelope[] {
  if (!Array.isArray(raw)) return []
  const out: MailboxEnvelope[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = item as MailboxEnvelope
    if (!v.id || !v.toSessionId) continue
    out.push(v)
  }
  return out
}

function pruneExpired(envelopes: MailboxEnvelope[], now = Date.now()): MailboxEnvelope[] {
  return envelopes.filter((env) => !env.expiresAt || env.expiresAt > now)
}

function normalizeHumanRequestValue(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

function parseHumanRequestPayload(payload: string): HumanRequestPayload | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : ''
    if (!question) return null
    return {
      question,
      options: Array.isArray(parsed.options)
        ? parsed.options.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
      expectedFormat: typeof parsed.expectedFormat === 'string' && parsed.expectedFormat.trim()
        ? parsed.expectedFormat.trim()
        : null,
      notes: typeof parsed.notes === 'string' && parsed.notes.trim()
        ? parsed.notes.trim()
        : null,
    }
  } catch {
    return null
  }
}

function normalizeHumanRequestSignature(input: {
  question: string
  options?: string[]
  expectedFormat?: string | null
  notes?: string | null
  fromSessionId?: string | null
  fromAgentId?: string | null
}): string {
  return JSON.stringify({
    question: normalizeHumanRequestValue(input.question),
    options: (input.options || []).map((value) => normalizeHumanRequestValue(value)).filter(Boolean),
    expectedFormat: normalizeHumanRequestValue(input.expectedFormat),
    notes: normalizeHumanRequestValue(input.notes),
    fromSessionId: normalizeHumanRequestValue(input.fromSessionId),
    fromAgentId: normalizeHumanRequestValue(input.fromAgentId),
  })
}

function normalizeMailbox(target: { mailbox?: MailboxEnvelope[] | null }, now = Date.now()): MailboxEnvelope[] {
  return pruneExpired(normalizeMailboxList(target.mailbox || []), now)
}

function findLatestPendingHumanRequestEnvelope(
  sessionId: string,
  sessions = loadSessions(),
): MailboxEnvelope | null {
  const target = sessions[sessionId]
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  const envelopes = normalizeMailbox(target)
  const repliedCorrelationIds = new Set(
    envelopes
      .filter((envelope) => envelope.type === 'human_reply' && envelope.status !== 'ack' && envelope.correlationId)
      .map((envelope) => envelope.correlationId as string),
  )
  return envelopes
    .filter((envelope) => envelope.type === 'human_request' && envelope.status !== 'ack')
    .filter((envelope) => !envelope.correlationId || !repliedCorrelationIds.has(envelope.correlationId))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null
}

export function findPendingHumanRequestEnvelope(params: {
  sessionId: string
  question: string
  options?: string[]
  expectedFormat?: string | null
  notes?: string | null
  fromSessionId?: string | null
  fromAgentId?: string | null
}): MailboxEnvelope | null {
  const sessions = loadSessions()
  const target = sessions[params.sessionId]
  if (!target) throw new Error(`Session not found: ${params.sessionId}`)
  const expectedSignature = normalizeHumanRequestSignature(params)
  const envelopes = normalizeMailbox(target)
  return envelopes
    .filter((envelope) => envelope.type === 'human_request' && envelope.status !== 'ack')
    .find((envelope) => {
      const parsed = parseHumanRequestPayload(envelope.payload)
      if (!parsed) return false
      return normalizeHumanRequestSignature({
        question: parsed.question,
        options: parsed.options,
        expectedFormat: parsed.expectedFormat,
        notes: parsed.notes,
        fromSessionId: envelope.fromSessionId || null,
        fromAgentId: envelope.fromAgentId || null,
      }) === expectedSignature
    }) || null
}

export function sendMailboxEnvelope(input: {
  toSessionId: string
  type: string
  payload: string
  fromSessionId?: string | null
  fromAgentId?: string | null
  toAgentId?: string | null
  correlationId?: string | null
  ttlSec?: number | null
}): MailboxEnvelope {
  const sessions = loadSessions()
  const target = sessions[input.toSessionId]
  if (!target) throw new Error(`Target session not found: ${input.toSessionId}`)

  const now = Date.now()
  const ttl = typeof input.ttlSec === 'number' && Number.isFinite(input.ttlSec)
    ? Math.max(0, Math.min(7 * 24 * 3600, Math.trunc(input.ttlSec)))
    : null
  const envelope: MailboxEnvelope = {
    id: genId(6),
    type: (input.type || 'message').trim() || 'message',
    payload: String(input.payload || ''),
    fromSessionId: input.fromSessionId || null,
    fromAgentId: input.fromAgentId || null,
    toSessionId: input.toSessionId,
    toAgentId: input.toAgentId || null,
    correlationId: input.correlationId || null,
    status: 'new',
    createdAt: now,
    expiresAt: ttl ? now + ttl * 1000 : null,
    ackAt: null,
  }

  const existing = normalizeMailbox(target, now)
  existing.push(envelope)
  target.mailbox = existing
  target.lastActiveAt = now
  sessions[input.toSessionId] = target
  saveSessions(sessions)
  import('@/lib/server/runtime/watch-jobs')
    .then(({ triggerMailboxWatchJobs }) => {
      triggerMailboxWatchJobs({ sessionId: input.toSessionId, envelope })
    })
    .catch(() => {
      // best-effort trigger only
    })
  return envelope
}

export function listMailbox(sessionId: string, opts: MailboxOptions = {}): MailboxEnvelope[] {
  const sessions = loadSessions()
  const target = sessions[sessionId]
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  const list = pruneExpired(normalizeMailboxList(target.mailbox || []))
  const includeAcked = opts.includeAcked === true
  const filtered = includeAcked ? list : list.filter((env) => env.status !== 'ack')
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit || 50)))
  return filtered
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function ackMailboxEnvelope(sessionId: string, envelopeId: string): MailboxEnvelope | null {
  const sessions = loadSessions()
  const target = sessions[sessionId]
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  const list = normalizeMailbox(target)
  const idx = list.findIndex((env) => env.id === envelopeId)
  if (idx === -1) return null
  list[idx] = {
    ...list[idx],
    status: 'ack',
    ackAt: Date.now(),
  }
  target.mailbox = list
  target.lastActiveAt = Date.now()
  sessions[sessionId] = target
  saveSessions(sessions)
  return list[idx]
}

export function clearMailbox(sessionId: string, includeAcked = true): { before: number; after: number } {
  const sessions = loadSessions()
  const target = sessions[sessionId]
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  const list = normalizeMailbox(target)
  const before = list.length
  const afterList = includeAcked ? [] : list.filter((env) => env.status !== 'ack')
  target.mailbox = afterList
  target.lastActiveAt = Date.now()
  sessions[sessionId] = target
  saveSessions(sessions)
  return { before, after: afterList.length }
}

export function bridgeHumanReplyFromChat(input: {
  sessionId: string
  payload: string
  fromSessionId?: string | null
}): MailboxEnvelope | null {
  const payload = String(input.payload || '').trim()
  if (!payload) return null
  const pending = findLatestPendingHumanRequestEnvelope(input.sessionId)
  if (!pending) return null
  const envelope = sendMailboxEnvelope({
    toSessionId: input.sessionId,
    type: 'human_reply',
    payload,
    fromSessionId: input.fromSessionId || input.sessionId,
    correlationId: pending.correlationId || null,
  })
  ackMailboxEnvelope(input.sessionId, pending.id)
  return envelope
}
