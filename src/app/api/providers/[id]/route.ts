import { NextResponse } from 'next/server'
import { loadProviderConfigs, saveProviderConfigs } from '@/lib/server/storage'
import { mutateItem, deleteItem, notFound, badRequest, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadProviderConfigs, save: saveProviderConfigs, topic: 'providers' }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const configs = loadProviderConfigs()
  const config = configs[id]
  if (!config) return notFound()
  return NextResponse.json(config)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (existing) => ({
    ...existing, ...body, id, updatedAt: Date.now(),
  }))
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const configs = loadProviderConfigs()
  if (!configs[id]) return notFound()
  if (configs[id].type === 'builtin') {
    return badRequest('Cannot delete built-in providers')
  }
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ ok: true })
}
