import { NextResponse } from 'next/server'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { ensureAgentThreadSession } from '@/lib/server/agents/agent-thread-session'
import { loadAgents } from '@/lib/server/storage'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params
  const body = await req.json().catch(() => ({}))
  const user = body.user || 'default'
  const agent = loadAgents()[agentId]
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  const session = ensureAgentThreadSession(agentId, user)
  if (!session) {
    if (isAgentDisabled(agent)) {
      return NextResponse.json({ error: buildAgentDisabledMessage(agent, 'start new chats') }, { status: 409 })
    }
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  return NextResponse.json(session)
}
