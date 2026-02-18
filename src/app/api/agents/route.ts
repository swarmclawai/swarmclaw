import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadAgents, saveAgents } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json(loadAgents())
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = crypto.randomBytes(4).toString('hex')
  const now = Date.now()
  const agents = loadAgents()
  agents[id] = {
    id,
    name: body.name || 'Unnamed Agent',
    description: body.description || '',
    systemPrompt: body.systemPrompt || '',
    provider: body.provider || 'claude-cli',
    model: body.model || '',
    credentialId: body.credentialId || null,
    apiEndpoint: body.apiEndpoint || null,
    isOrchestrator: body.isOrchestrator || false,
    subAgentIds: body.subAgentIds || [],
    tools: body.tools || [],
    createdAt: now,
    updatedAt: now,
  }
  saveAgents(agents)
  return NextResponse.json(agents[id])
}
