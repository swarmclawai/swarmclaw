import { NextResponse } from 'next/server'
import { loadExternalAgents, saveExternalAgents } from '@/lib/server/storage'
import { mutateItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadExternalAgents, save: saveExternalAgents, topic: 'external_agents' }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const now = Date.now()
  const result = mutateItem(ops, id, (runtime) => {
    const action = typeof body.action === 'string' ? body.action : ''
    const nextMetadata = body.metadata && typeof body.metadata === 'object'
      ? { ...(runtime.metadata || {}), ...body.metadata }
      : runtime.metadata

    const next = {
      ...runtime,
      ...body,
      id,
      metadata: nextMetadata,
      updatedAt: now,
    }

    if (action === 'activate') {
      next.lifecycleState = 'active'
      next.lastHealthNote = body.lastHealthNote || 'Runtime returned to active service.'
    } else if (action === 'drain') {
      next.lifecycleState = 'draining'
      next.lastHealthNote = body.lastHealthNote || 'Runtime draining after current work.'
    } else if (action === 'cordon') {
      next.lifecycleState = 'cordoned'
      next.lastHealthNote = body.lastHealthNote || 'Runtime cordoned from new work.'
    } else if (action === 'restart') {
      next.metadata = {
        ...(next.metadata || {}),
        controlRequest: {
          action: 'restart',
          requestedAt: now,
          source: 'swarmclaw',
        },
      }
      next.lastHealthNote = body.lastHealthNote || 'Restart requested from SwarmClaw.'
    }

    return next
  })
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const items = loadExternalAgents()
  if (!items[id]) return notFound()
  delete items[id]
  saveExternalAgents(items)
  notify('external_agents')
  return NextResponse.json({ ok: true })
}
