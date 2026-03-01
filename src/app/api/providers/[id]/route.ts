import { NextResponse } from 'next/server'
import { loadProviderConfigs, saveProviderConfigs } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const configs = loadProviderConfigs()
  const config = configs[id]
  if (!config) return new NextResponse(null, { status: 404 })
  return NextResponse.json(config)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const configs = loadProviderConfigs()
  const existing = configs[id]
  if (!existing) return new NextResponse(null, { status: 404 })
  configs[id] = { ...existing, ...body, id, updatedAt: Date.now() }
  saveProviderConfigs(configs)
  notify('providers')
  return NextResponse.json(configs[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const configs = loadProviderConfigs()
  if (!configs[id]) return new NextResponse(null, { status: 404 })
  // Only allow deleting custom providers
  if (configs[id].type === 'builtin') {
    return NextResponse.json({ error: 'Cannot delete built-in providers' }, { status: 400 })
  }
  delete configs[id]
  saveProviderConfigs(configs)
  notify('providers')
  return NextResponse.json({ ok: true })
}
