import { NextResponse } from 'next/server'
import { loadSecrets, saveSecrets } from '@/lib/server/storage'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const secrets = loadSecrets()
  if (!secrets[id]) return new NextResponse(null, { status: 404 })
  delete secrets[id]
  saveSecrets(secrets)
  return NextResponse.json('ok')
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const secrets = loadSecrets()
  if (!secrets[id]) return new NextResponse(null, { status: 404 })

  // Update metadata only (not the encrypted value unless a new value is provided)
  if (body.name !== undefined) secrets[id].name = body.name
  if (body.service !== undefined) secrets[id].service = body.service
  if (body.scope !== undefined) secrets[id].scope = body.scope
  if (body.agentIds !== undefined) secrets[id].agentIds = body.agentIds
  secrets[id].updatedAt = Date.now()
  saveSecrets(secrets)

  const { encryptedValue, ...safe } = secrets[id]
  return NextResponse.json(safe)
}
