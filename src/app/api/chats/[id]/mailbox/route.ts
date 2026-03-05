import { NextResponse } from 'next/server'
import { ackMailboxEnvelope, clearMailbox, listMailbox, sendMailboxEnvelope } from '@/lib/server/session-mailbox'
import { loadSessions } from '@/lib/server/storage'

function parseIntParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const limit = parseIntParam(searchParams.get('limit'), 50, 1, 500)
  const includeAcked = searchParams.get('includeAcked') === 'true'
  try {
    const envelopes = listMailbox(id, { limit, includeAcked })
    return NextResponse.json({ sessionId: id, count: envelopes.length, envelopes })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to load mailbox.' }, { status: 404 })
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const action = typeof body?.action === 'string' ? body.action : 'send'
  const sessions = loadSessions()
  const current = sessions[id]
  if (!current) return NextResponse.json({ error: `Session not found: ${id}` }, { status: 404 })

  try {
    if (action === 'send') {
      const toSessionId = typeof body?.toSessionId === 'string' ? body.toSessionId : ''
      const payload = typeof body?.payload === 'string' ? body.payload : ''
      const type = typeof body?.type === 'string' ? body.type : 'message'
      if (!toSessionId) return NextResponse.json({ error: 'toSessionId is required for send.' }, { status: 400 })
      if (!payload.trim()) return NextResponse.json({ error: 'payload is required for send.' }, { status: 400 })
      const envelope = sendMailboxEnvelope({
        toSessionId,
        type,
        payload,
        fromSessionId: id,
        fromAgentId: current.agentId || null,
        correlationId: typeof body?.correlationId === 'string' ? body.correlationId : null,
        ttlSec: typeof body?.ttlSec === 'number' ? body.ttlSec : null,
      })
      return NextResponse.json({ ok: true, envelope })
    }

    if (action === 'ack') {
      const envelopeId = typeof body?.envelopeId === 'string' ? body.envelopeId : ''
      if (!envelopeId) return NextResponse.json({ error: 'envelopeId is required for ack.' }, { status: 400 })
      const envelope = ackMailboxEnvelope(id, envelopeId)
      if (!envelope) return NextResponse.json({ error: `Envelope not found: ${envelopeId}` }, { status: 404 })
      return NextResponse.json({ ok: true, envelope })
    }

    if (action === 'clear') {
      const includeAcked = body?.includeAcked !== false
      const result = clearMailbox(id, includeAcked)
      return NextResponse.json({ ok: true, ...result })
    }

    return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Mailbox operation failed.' }, { status: 500 })
  }
}

