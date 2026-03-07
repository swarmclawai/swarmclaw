import { NextResponse } from 'next/server'
import { loadExternalAgents, saveExternalAgents } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const items = loadExternalAgents()
  const runtime = items[id]
  if (!runtime) return notFound()
  const now = Date.now()
  runtime.lastHeartbeatAt = now
  runtime.lastSeenAt = now
  runtime.updatedAt = now
  runtime.status = body.status || 'online'
  if (typeof body.lifecycleState === 'string' && body.lifecycleState) runtime.lifecycleState = body.lifecycleState
  if (typeof body.version === 'string') runtime.version = body.version || null
  if (typeof body.lastHealthNote === 'string') runtime.lastHealthNote = body.lastHealthNote || null
  if (body.tokenStats && typeof body.tokenStats === 'object') {
    runtime.tokenStats = {
      ...(runtime.tokenStats || {}),
      ...body.tokenStats,
    }
  }
  if (body.metadata && typeof body.metadata === 'object') {
    runtime.metadata = {
      ...(runtime.metadata || {}),
      ...body.metadata,
    }
  }
  saveExternalAgents(items)
  notify('external_agents')
  return NextResponse.json({ ok: true, id, lastHeartbeatAt: now })
}
