import { NextResponse } from 'next/server'
import { loadSession, upsertSession } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = loadSession(id)
  if (!session) return notFound()
  session.messages = []
  session.claudeSessionId = null
  session.codexThreadId = null
  session.opencodeSessionId = null
  session.delegateResumeIds = {
    claudeCode: null,
    codex: null,
    opencode: null,
  }
  upsertSession(id, session)
  return new NextResponse('OK')
}
