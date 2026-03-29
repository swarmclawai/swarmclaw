import { NextResponse } from 'next/server'
import { perf } from '@/lib/server/runtime/perf'
import { listAgentsForApi, createAgent } from '@/lib/server/agents/agent-service'
import { AgentCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { ensureDaemonProcessRunning } from '@/lib/server/daemon/controller'
import { z } from 'zod'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { loadSettings } from '@/lib/server/storage'
import { requestApproval } from '@/lib/server/approvals'
export const dynamic = 'force-dynamic'


export async function GET(req: Request) {
  const endPerf = perf.start('api', 'GET /api/agents')
  const agents = listAgentsForApi()

  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  if (!limitParam) {
    endPerf({ count: Object.keys(agents).length })
    return NextResponse.json(agents)
  }

  const limit = Math.max(1, Number(limitParam) || 50)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const all = Object.values(agents).sort((a, b) => b.updatedAt - a.updatedAt)
  const items = all.slice(offset, offset + limit)
  endPerf({ count: items.length, total: all.length })
  return NextResponse.json({ items, total: all.length, hasMore: offset + limit < all.length })
}

export async function POST(req: Request) {
  await ensureDaemonProcessRunning('api/agents:post')
  const { data: raw, error } = await safeParseBody(req)
  if (error) return error
  const rawRecord = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  const parsed = AgentCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = parsed.data as unknown as Record<string, unknown>

  // Check approval policy — if enabled, create an approval request instead of the agent
  const settings = loadSettings()
  if (settings.approvalPolicies?.requireApprovalForAgentCreate) {
    const approval = requestApproval({
      category: 'agent_create',
      title: `Create agent: ${body.name}`,
      description: `Request to create agent "${body.name}" with provider ${body.provider}`,
      data: { pendingAgentConfig: body, agentName: String(body.name || ''), provider: String(body.provider || '') },
    })
    return NextResponse.json({ pendingApproval: true, approvalId: approval.id }, { status: 202 })
  }

  const agent = createAgent({ body, rawRecord })
  return NextResponse.json(agent)
}
