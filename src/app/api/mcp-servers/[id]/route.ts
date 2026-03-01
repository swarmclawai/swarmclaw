import { NextResponse } from 'next/server'
import { loadMcpServers, saveMcpServers, deleteMcpServer } from '@/lib/server/storage'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadMcpServers, save: saveMcpServers, deleteFn: deleteMcpServer }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  if (!servers[id]) return notFound()
  return NextResponse.json(servers[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (server) => ({
    ...server, ...body, id, updatedAt: Date.now(),
  }))
  if (!result) return notFound()
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ deleted: id })
}
