import { NextResponse } from 'next/server'
import { getCheckpointSaver } from '@/lib/server/langgraph-checkpoint'

export const dynamic = 'force-dynamic'

/** GET /api/chats/[id]/checkpoints — returns checkpoint history for a thread */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params
  if (!threadId) return NextResponse.json({ error: 'Thread ID is required' }, { status: 400 })

  const saver = getCheckpointSaver()
  const checkpoints = []
  
  // LangGraph's list() is an async generator
  const iterator = saver.list({ configurable: { thread_id: threadId } })
  
  for await (const tuple of iterator) {
    checkpoints.push({
      checkpointId: tuple.config.configurable?.checkpoint_id,
      parentCheckpointId: tuple.parentConfig?.configurable?.checkpoint_id,
      metadata: tuple.metadata,
      createdAt: new Date(tuple.checkpoint.ts).getTime(),
      values: tuple.checkpoint.channel_values,
    })
  }

  // Sort by created_at descending (saver.list usually does this but we want to be sure)
  checkpoints.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  return NextResponse.json(checkpoints)
}
