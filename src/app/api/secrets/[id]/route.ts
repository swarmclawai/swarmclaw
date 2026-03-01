import { NextResponse } from 'next/server'
import { loadSecrets, saveSecrets } from '@/lib/server/storage'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadSecrets, save: saveSecrets }

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ ok: true })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (secret) => {
    if (body.name !== undefined) secret.name = body.name
    if (body.service !== undefined) secret.service = body.service
    if (body.scope !== undefined) secret.scope = body.scope
    if (body.agentIds !== undefined) secret.agentIds = body.agentIds
    secret.updatedAt = Date.now()
    return secret
  })
  if (!result) return notFound()
  const { encryptedValue, ...safe } = result as Record<string, unknown>
  return NextResponse.json(safe)
}
