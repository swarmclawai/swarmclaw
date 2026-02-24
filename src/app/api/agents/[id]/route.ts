import { NextResponse } from 'next/server'
import { loadAgents, saveAgents, deleteAgent } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const agents = loadAgents()
  if (!agents[id]) return new NextResponse(null, { status: 404 })

  Object.assign(agents[id], body, { updatedAt: Date.now() })
  if (body.apiEndpoint !== undefined) {
    agents[id].apiEndpoint = normalizeProviderEndpoint(
      body.provider || agents[id].provider,
      body.apiEndpoint,
    )
  }
  delete (agents[id] as Record<string, unknown>).id // prevent id overwrite
  agents[id].id = id
  saveAgents(agents)
  return NextResponse.json(agents[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const agents = loadAgents()
  if (!agents[id]) return new NextResponse(null, { status: 404 })
  deleteAgent(id)
  return NextResponse.json('ok')
}
