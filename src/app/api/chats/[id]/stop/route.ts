import { NextResponse } from 'next/server'
import { pruneStreamingAssistantArtifacts } from '@/lib/chat-streaming-state'
import { active, loadStoredItem, upsertStoredItem } from '@/lib/server/storage'
import { cancelSessionRuns } from '@/lib/server/session-run-manager'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const cancel = cancelSessionRuns(id, 'Stopped by user')
  const session = loadStoredItem('sessions', id)
  if (session && Array.isArray(session.messages) && pruneStreamingAssistantArtifacts(session.messages)) {
    upsertStoredItem('sessions', id, session)
  }
  if (active.has(id)) {
    try { active.get(id).kill() } catch {}
    active.delete(id)
  }
  return NextResponse.json({ ok: true, ...cancel })
}
