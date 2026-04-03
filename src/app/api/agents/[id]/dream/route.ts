import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { log } from '@/lib/server/logger'

const TAG = 'api-agent-dream'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { loadAgents } = await import('@/lib/server/storage')
    const agents = loadAgents()
    const agent = agents[id]
    if (!agent) return notFound()
    const { resolveDreamConfig } = await import('@/lib/server/memory/dream-service')
    const { listDreamCycles } = await import('@/lib/server/memory/dream-cycles')
    return NextResponse.json({
      ok: true,
      config: resolveDreamConfig(agent),
      recentCycles: listDreamCycles(id, 10),
    })
  } catch (err: unknown) {
    log.error(TAG, 'GET failed:', err)
    return NextResponse.json({ ok: false, error: String((err as Error)?.message || err) }, { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { data: body, error } = await safeParseBody(req)
    if (error) return error
    const { updateAgent } = await import('@/lib/server/agents/agent-service')
    const patch: Record<string, unknown> = {}
    if ('dreamEnabled' in body) patch.dreamEnabled = body.dreamEnabled
    if ('dreamConfig' in body) patch.dreamConfig = body.dreamConfig
    const updated = updateAgent(id, patch)
    if (!updated) return notFound()
    const { resolveDreamConfig } = await import('@/lib/server/memory/dream-service')
    return NextResponse.json({ ok: true, config: resolveDreamConfig(updated) })
  } catch (err: unknown) {
    log.error(TAG, 'PATCH failed:', err)
    return NextResponse.json({ ok: false, error: String((err as Error)?.message || err) }, { status: 500 })
  }
}
