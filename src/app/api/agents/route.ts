import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadAgents, saveAgents, logActivity } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  return NextResponse.json(loadAgents())
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = genId()
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
    thinkingLevel: body.thinkingLevel || undefined,
    createdAt: now,
    updatedAt: now,
  }
  saveAgents(agents)
  logActivity({ entityType: 'agent', entityId: id, action: 'created', actor: 'user', summary: `Agent created: "${agents[id].name}"` })
  notify('agents')
  return NextResponse.json(agents[id])
}
