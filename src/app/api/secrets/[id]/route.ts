import { NextResponse } from 'next/server'
import { loadSecrets, saveSecrets } from '@/lib/server/storage'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { SecretUpdateSchema, formatZodError } from '@/lib/validation/schemas'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadSecrets, save: saveSecrets }

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const secrets = loadSecrets()
  const secret = secrets[id]
  if (!secret) return notFound()
  // Never expose the encrypted value
  const safe = { ...(secret as Record<string, unknown>) }
  delete safe.encryptedValue
  return NextResponse.json(safe)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound()
  return NextResponse.json({ ok: true })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = SecretUpdateSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })
  const rawKeys = new Set(Object.keys(raw ?? {}))
  const body = parsed.data

  const result = mutateItem(ops, id, (secret) => {
    if (rawKeys.has('name') && body.name !== undefined) secret.name = body.name
    if (rawKeys.has('service') && body.service !== undefined) secret.service = body.service
    if (rawKeys.has('scope') && body.scope !== undefined) secret.scope = body.scope
    if (rawKeys.has('agentIds') && body.agentIds !== undefined) secret.agentIds = body.agentIds
    if (rawKeys.has('projectId')) secret.projectId = body.projectId || undefined
    secret.updatedAt = Date.now()
    return secret
  })
  if (!result) return notFound()
  const safe = { ...(result as Record<string, unknown>) }
  delete safe.encryptedValue
  return NextResponse.json(safe)
}
