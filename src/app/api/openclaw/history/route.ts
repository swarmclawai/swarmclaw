import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'
import { mergeHistoryMessages, isValidSessionKey } from '@/lib/server/openclaw-history-merge'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { GatewaySessionPreview } from '@/types'

/**
 * Extract a single session preview from the gateway response.
 * The gateway may return:
 *  - A map: { [sessionKey]: preview }
 *  - An array: [preview, ...]
 *  - A single object with sessionKey field
 */
function extractPreview(
  raw: unknown,
  sessionKey: string,
): GatewaySessionPreview | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  // Direct object with messages array
  if ('messages' in (raw as Record<string, unknown>)) {
    return raw as GatewaySessionPreview
  }

  // Map keyed by session key
  const asMap = raw as Record<string, unknown>
  if (asMap[sessionKey] && typeof asMap[sessionKey] === 'object') {
    return asMap[sessionKey] as GatewaySessionPreview
  }

  // Array — find matching session
  if (Array.isArray(raw)) {
    return raw.find(
      (p: unknown) =>
        p && typeof p === 'object' && (p as GatewaySessionPreview).sessionKey === sessionKey,
    ) as GatewaySessionPreview | undefined
  }

  return undefined
}

/** GET ?sessionKey=X — preview gateway session history */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sessionKey = searchParams.get('sessionKey')
  if (!sessionKey || !isValidSessionKey(sessionKey)) {
    return NextResponse.json({ error: 'Missing or invalid sessionKey' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    const raw = await gw.rpc('sessions.preview', { keys: [sessionKey], limit: 100 })
    const preview = extractPreview(raw, sessionKey)
    return NextResponse.json(preview ?? { sessionKey, epoch: 0, messages: [] })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/** POST { sessionKey, epoch, localSessionId } — merge gateway history into local session */
export async function POST(req: Request) {
  const body = await req.json()
  const { sessionKey, localSessionId } = body as {
    sessionKey?: string
    epoch?: number
    localSessionId?: string
  }
  if (!sessionKey || !localSessionId) {
    return NextResponse.json({ error: 'Missing sessionKey or localSessionId' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    const raw = await gw.rpc('sessions.preview', { keys: [sessionKey], limit: 100 })
    const preview = extractPreview(raw, sessionKey)
    if (!preview?.messages?.length) {
      return NextResponse.json({ ok: true, merged: 0 })
    }

    const sessions = loadSessions()
    const session = sessions[localSessionId]
    if (!session) {
      return NextResponse.json({ error: 'Local session not found' }, { status: 404 })
    }

    const merged = mergeHistoryMessages(session.messages, preview)
    const newCount = merged.length - session.messages.length
    session.messages = merged
    session.lastActiveAt = Date.now()
    sessions[localSessionId] = session
    saveSessions(sessions)
    notify('sessions')

    return NextResponse.json({ ok: true, merged: newCount })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
