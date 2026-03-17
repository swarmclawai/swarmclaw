import { NextResponse } from 'next/server'
import { materializeStreamingAssistantArtifacts } from '@/lib/chat/chat-streaming-state'
import { cancelSessionRuns } from '@/lib/server/runtime/session-run-manager'
import { stopActiveSessionProcess } from '@/lib/server/runtime/runtime-state'
import { getSession, saveSession } from '@/lib/server/sessions/session-repository'
import type { Session } from '@/types'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const cancel = cancelSessionRuns(id, 'Stopped by user')
  const session = getSession(id) as Session | null
  if (session && Array.isArray(session.messages) && materializeStreamingAssistantArtifacts(session.messages)) {
    saveSession(id, session)
  }
  stopActiveSessionProcess(id)
  return NextResponse.json({ ok: true, ...cancel })
}
