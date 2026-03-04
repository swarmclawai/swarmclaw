import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadAgents, saveAgents, logActivity } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { notify } from '@/lib/server/ws-hub'
import { getAgentMonthlySpend } from '@/lib/server/cost'
import { AgentCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
export const dynamic = 'force-dynamic'


export async function GET(req: Request) {
  const agents = loadAgents()
  // Enrich agents that have a monthly budget with current spend
  for (const agent of Object.values(agents)) {
    if (typeof agent.monthlyBudget === 'number' && agent.monthlyBudget > 0) {
      agent.monthlySpend = getAgentMonthlySpend(agent.id)
    }
  }

  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  if (!limitParam) return NextResponse.json(agents)

  const limit = Math.max(1, Number(limitParam) || 50)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const all = Object.values(agents).sort((a, b) => b.updatedAt - a.updatedAt)
  const items = all.slice(offset, offset + limit)
  return NextResponse.json({ items, total: all.length, hasMore: offset + limit < all.length })
}

export async function POST(req: Request) {
  const raw = await req.json()
  const parsed = AgentCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = parsed.data
  const id = genId()
  const now = Date.now()
  const agents = loadAgents()
  agents[id] = {
    id,
    name: body.name,
    description: body.description,
    systemPrompt: body.systemPrompt,
    provider: body.provider,
    model: body.model,
    credentialId: body.credentialId,
    apiEndpoint: normalizeProviderEndpoint(body.provider, body.apiEndpoint || null),
    isOrchestrator: body.isOrchestrator,
    subAgentIds: body.subAgentIds,
    tools: body.tools,
    capabilities: body.capabilities,
    thinkingLevel: body.thinkingLevel || undefined,
    autoRecovery: body.autoRecovery || false,
    soul: body.soul || undefined,
    createdAt: now,
    updatedAt: now,
  }
  saveAgents(agents)
  logActivity({ entityType: 'agent', entityId: id, action: 'created', actor: 'user', summary: `Agent created: "${agents[id].name}"` })
  notify('agents')
  return NextResponse.json(agents[id])
}
