import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { getProviderList } from '@/lib/providers'
import { loadProviderConfigs, saveProviderConfigs } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  return NextResponse.json(getProviderList())
}

export async function POST(req: Request) {
  const body = await req.json()
  const configs = loadProviderConfigs()
  const id = body.id || `custom-${genId()}`
  configs[id] = {
    id,
    name: body.name || 'Custom Provider',
    type: 'custom',
    baseUrl: body.baseUrl || '',
    models: body.models || [],
    requiresApiKey: body.requiresApiKey ?? true,
    credentialId: body.credentialId || null,
    isEnabled: body.isEnabled ?? true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveProviderConfigs(configs)
  notify('providers')
  return NextResponse.json(configs[id])
}
