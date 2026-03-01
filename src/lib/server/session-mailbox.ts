import { genId } from '@/lib/id'
import { loadSessions, saveSessions } from './storage'

export type MailboxStatus = 'new' | 'ack'

export interface MailboxEnvelope {
  id: string
  type: string
  payload: string
  fromSessionId?: string | null
  fromAgentId?: string | null
  toSessionId: string
  toAgentId?: string | null
  correlationId?: string | null
  status: MailboxStatus
  createdAt: number
  expiresAt?: number | null
  ackAt?: number | null
}

interface MailboxOptions {
  limit?: number
  includeAcked?: boolean
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

  const existing = pruneExpired(normalizeMailboxList(target.mailbox || []), now)
  existing.push(envelope)
  target.mailbox = existing
  target.lastActiveAt = now
  sessions[input.toSessionId] = target
  saveSessions(sessions)
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
  const list = pruneExpired(normalizeMailboxList(target.mailbox || []))
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
  const list = pruneExpired(normalizeMailboxList(target.mailbox || []))
  const before = list.length
  const afterList = includeAcked ? [] : list.filter((env) => env.status !== 'ack')
  target.mailbox = afterList
  target.lastActiveAt = Date.now()
  sessions[sessionId] = target
  saveSessions(sessions)
  return { before, after: afterList.length }
}

