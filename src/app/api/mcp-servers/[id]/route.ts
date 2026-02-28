import { NextResponse } from 'next/server'
import { loadMcpServers, saveMcpServers, deleteMcpServer } from '@/lib/server/storage'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  if (!servers[id]) return new NextResponse(null, { status: 404 })
  return NextResponse.json(servers[id])
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const servers = loadMcpServers()
  if (!servers[id]) return new NextResponse(null, { status: 404 })
  servers[id] = {
    ...servers[id],
    ...body,
    id,
    updatedAt: Date.now(),
  }
  saveMcpServers(servers)
  return NextResponse.json(servers[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  if (!servers[id]) return new NextResponse(null, { status: 404 })
  deleteMcpServer(id)
  return NextResponse.json({ deleted: id })
}
