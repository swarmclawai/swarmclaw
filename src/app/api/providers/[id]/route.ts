import { NextResponse } from 'next/server'
import { PROVIDERS } from '@/lib/providers'
import { loadProviderConfigs, saveProviderConfigs } from '@/lib/server/storage'
import { mutateItem, deleteItem, notFound, badRequest, type CollectionOps } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { notify } from '@/lib/server/ws-hub'
import { ProviderUpdateSchema, formatZodError } from '@/lib/validation/schemas'

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
  const { data: raw, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const parsed = ProviderUpdateSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 })

  const rawKeys = new Set(Object.keys(raw ?? {}))
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (rawKeys.has(key)) body[key] = value
  }

  if (!ops.load()[id]) {
    const builtin = PROVIDERS[id]
    if (!builtin) return notFound()

    const now = Date.now()
    const configs = loadProviderConfigs()
    configs[id] = {
      ...body,
      id,
      name: builtin.name,
      type: 'builtin',
      baseUrl: (typeof body.baseUrl === 'string' ? body.baseUrl : builtin.defaultEndpoint) || '',
      models: [...builtin.models],
      requiresApiKey: builtin.requiresApiKey,
      credentialId: null,
      isEnabled: body.isEnabled !== false,
      createdAt: now,
      updatedAt: now,
    }
    saveProviderConfigs(configs)
    notify('providers')
    return NextResponse.json(configs[id])
  }
  const result = mutateItem(ops, id, (existing) => ({
    ...existing,
    ...body,
    id,
    type: existing.type === 'builtin' ? 'builtin' : 'custom',
    updatedAt: Date.now(),
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
