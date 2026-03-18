import { NextResponse } from 'next/server'
import { getAgentThreadSession } from '@/lib/server/agents/agent-service'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params
  const body = await req.json().catch(() => ({}))
  const result = getAgentThreadSession(agentId, typeof body.user === 'string' ? body.user : 'default')
  if (!result.session) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.session, { status: result.status })
}
