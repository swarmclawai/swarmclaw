import { NextResponse } from 'next/server'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'

export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  return NextResponse.json({
    sessionId,
    content: (session as Record<string, unknown>).canvasContent || null,
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  const body = await req.json()
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  ;(session as Record<string, unknown>).canvasContent = body.content || null
  session.lastActiveAt = Date.now()
  sessions[sessionId] = session
  saveSessions(sessions)

  notify(`canvas:${sessionId}`)
  return NextResponse.json({ ok: true, sessionId })
}
