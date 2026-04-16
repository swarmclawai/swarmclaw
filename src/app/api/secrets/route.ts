import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadSecrets, saveSecrets, encryptKey } from '@/lib/server/storage'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { SecretCreateSchema, formatZodError } from '@/lib/validation/schemas'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  // Return secrets WITHOUT the encrypted values (just metadata)
  const secrets = loadSecrets()
  const safe = Object.fromEntries(
    Object.entries(secrets).map(([id, s]: [string, any]) => [
      id,
      { id: s.id, name: s.name, service: s.service, scope: s.scope, agentIds: s.agentIds, projectId: s.projectId, createdAt: s.createdAt, updatedAt: s.updatedAt },
    ])
  )
  return NextResponse.json(safe)
}

export async function POST(req: Request) {
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = SecretCreateSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })
  const body = parsed.data

  if (!body.value.trim()) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 })
  }

  const id = genId()
  const now = Date.now()
  const secrets = loadSecrets()

  secrets[id] = {
    id,
    name: body.name || 'Unnamed Secret',
    service: body.service || 'custom',
    encryptedValue: encryptKey(body.value),
    scope: body.scope || 'global',
    agentIds: body.agentIds || [],
    projectId: typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined,
    createdAt: now,
    updatedAt: now,
  }
  saveSecrets(secrets)

  // Return without encrypted value
  const { encryptedValue, ...safe } = secrets[id]
  return NextResponse.json(safe)
}
