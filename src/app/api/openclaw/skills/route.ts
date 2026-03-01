import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'
import { loadAgents, saveAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { OpenClawSkillEntry, SkillAllowlistMode } from '@/types'

/** GET ?agentId=X — fetch skills from gateway with eligibility */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  if (!agentId) {
    return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'OpenClaw gateway not connected' }, { status: 503 })
  }

  try {
    const result = await gw.rpc('skills.status', { agentId }) as OpenClawSkillEntry[] | undefined
    return NextResponse.json(result ?? [])
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/** PATCH { skillKey, enabled?, apiKey? } — update a skill's config on gateway */
export async function PATCH(req: Request) {
  const body = await req.json()
  const { skillKey, enabled, apiKey } = body as {
    skillKey?: string
    enabled?: boolean
    apiKey?: string
  }
  if (!skillKey) {
    return NextResponse.json({ error: 'Missing skillKey' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'Gateway not connected' }, { status: 503 })
  }

  try {
    await gw.rpc('skills.update', { skillKey, enabled, apiKey })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/** PUT { agentId, mode, allowedSkills } — save skill allowlist config to agent */
export async function PUT(req: Request) {
  const body = await req.json()
  const { agentId, mode, allowedSkills } = body as {
    agentId?: string
    mode?: SkillAllowlistMode
    allowedSkills?: string[]
  }

  if (!agentId || !mode) {
    return NextResponse.json({ error: 'Missing agentId or mode' }, { status: 400 })
  }

  const agents = loadAgents({ includeTrashed: true })
  const agent = agents[agentId]
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  agent.openclawSkillMode = mode
  agent.openclawAllowedSkills = mode === 'selected' ? (allowedSkills ?? []) : undefined
  agent.updatedAt = Date.now()
  agents[agentId] = agent
  saveAgents(agents)
  notify('agents')

  return NextResponse.json({ ok: true })
}
