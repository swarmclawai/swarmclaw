import { NextResponse } from 'next/server'
import { loadAgents, saveAgents, deleteAgent } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadAgents, save: saveAgents, deleteFn: deleteAgent, topic: 'agents' }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (agent) => {
    Object.assign(agent, body, { updatedAt: Date.now() })
    if (body.apiEndpoint !== undefined) {
      agent.apiEndpoint = normalizeProviderEndpoint(
        body.provider || agent.provider,
        body.apiEndpoint,
      )
    }
    delete (agent as Record<string, unknown>).id
    agent.id = id
    return agent
  })
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ ok: true })
}
