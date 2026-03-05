import { NextResponse } from 'next/server'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()
  sessions[id].messages = []
  sessions[id].claudeSessionId = null
  sessions[id].codexThreadId = null
  sessions[id].opencodeSessionId = null
  sessions[id].delegateResumeIds = {
    claudeCode: null,
    codex: null,
    opencode: null,
  }
  saveSessions(sessions)
  return new NextResponse('OK')
}
