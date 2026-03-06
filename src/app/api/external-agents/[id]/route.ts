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
  const result = mutateItem(ops, id, (runtime) => ({
    ...runtime,
    ...body,
    id,
    updatedAt: Date.now(),
  }))
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
