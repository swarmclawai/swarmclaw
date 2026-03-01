import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadAgents, saveAgents } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
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
    apiEndpoint: normalizeProviderEndpoint(body.provider || 'claude-cli', body.apiEndpoint || null),
    isOrchestrator: body.isOrchestrator || false,
    subAgentIds: body.subAgentIds || [],
    tools: body.tools || [],
    capabilities: body.capabilities || [],
    createdAt: now,
    updatedAt: now,
  }
  saveAgents(agents)
  notify('agents')
  return NextResponse.json(agents[id])
}
