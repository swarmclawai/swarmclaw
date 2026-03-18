import { NextResponse } from 'next/server'
import { cloneAgent } from '@/lib/server/agents/agent-service'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const cloned = cloneAgent(id)
  if (!cloned) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }
  return NextResponse.json(cloned)
}
