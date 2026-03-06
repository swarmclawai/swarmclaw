import { NextResponse } from 'next/server'
import { ensureAgentThreadSession } from '@/lib/server/agent-thread-session'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params
  const body = await req.json().catch(() => ({}))
  const user = body.user || 'default'
  const session = ensureAgentThreadSession(agentId, user)
  if (!session) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  return NextResponse.json(session)
}
