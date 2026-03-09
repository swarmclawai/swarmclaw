import { NextResponse } from 'next/server'
import { getCheckpointSaver } from '@/lib/server/langgraph-checkpoint'
import { loadSession, upsertSession } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'

export const dynamic = 'force-dynamic'

/** POST /api/chats/[id]/restore — restores thread to a specific checkpoint */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params
  const { checkpointId, timestamp } = await req.json()

  if (!checkpointId || !timestamp) {
    return NextResponse.json({ error: 'checkpointId and timestamp are required' }, { status: 400 })
  }

  const saver = getCheckpointSaver()

  // 1. Delete all checkpoints after the target one
  await saver.deleteCheckpointsAfter(sessionId, timestamp)

  // 2. Truncate messages in the session to match the timestamp
  // Both timestamp (from checkpoint.ts → getTime()) and Message.time use epoch milliseconds
  const session = loadSession(sessionId)
  if (session) {
    session.messages = session.messages.filter((m: { time: number }) => m.time <= timestamp)
    session.lastActiveAt = Date.now()
    upsertSession(sessionId, session)
  }

  notify(`messages:${sessionId}`)
  notify('sessions')

  return NextResponse.json({ ok: true, restoredTo: checkpointId })
}
