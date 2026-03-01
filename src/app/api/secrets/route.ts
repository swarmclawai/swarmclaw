import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadSecrets, saveSecrets, encryptKey } from '@/lib/server/storage'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  // Return secrets WITHOUT the encrypted values (just metadata)
  const secrets = loadSecrets()
  const safe = Object.fromEntries(
    Object.entries(secrets).map(([id, s]: [string, any]) => [
      id,
      { id: s.id, name: s.name, service: s.service, scope: s.scope, agentIds: s.agentIds, createdAt: s.createdAt, updatedAt: s.updatedAt },
    ])
  )
  return NextResponse.json(safe)
}

export async function POST(req: Request) {
  const body = await req.json()
  const id = genId()
  const now = Date.now()
  const secrets = loadSecrets()

  if (!body.value?.trim()) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 })
  }

  secrets[id] = {
    id,
    name: body.name || 'Unnamed Secret',
    service: body.service || 'custom',
    encryptedValue: encryptKey(body.value),
    scope: body.scope || 'global',
    agentIds: body.agentIds || [],
    createdAt: now,
    updatedAt: now,
  }
  saveSecrets(secrets)

  // Return without encrypted value
  const { encryptedValue, ...safe } = secrets[id]
  return NextResponse.json(safe)
}
