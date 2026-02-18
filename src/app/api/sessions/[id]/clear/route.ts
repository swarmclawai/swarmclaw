import { NextResponse } from 'next/server'
import { loadSessions, saveSessions } from '@/lib/server/storage'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return new NextResponse(null, { status: 404 })
  sessions[id].messages = []
  sessions[id].claudeSessionId = null
  saveSessions(sessions)
  return new NextResponse('OK')
}
