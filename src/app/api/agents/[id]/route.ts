import { NextResponse } from 'next/server'
import { loadAgents, saveAgents } from '@/lib/server/storage'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const agents = loadAgents()
  if (!agents[id]) return new NextResponse(null, { status: 404 })

  Object.assign(agents[id], body, { updatedAt: Date.now() })
  delete (agents[id] as Record<string, unknown>).id // prevent id overwrite
  agents[id].id = id
  saveAgents(agents)
  return NextResponse.json(agents[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const agents = loadAgents()
  if (!agents[id]) return new NextResponse(null, { status: 404 })
  delete agents[id]
  saveAgents(agents)
  return NextResponse.json('ok')
}
