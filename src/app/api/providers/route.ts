import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { getProviderList } from '@/lib/providers'
import { loadProviderConfigs, saveProviderConfigs } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json(getProviderList())
}

export async function POST(req: Request) {
  const body = await req.json()
  const configs = loadProviderConfigs()
  const id = body.id || `custom-${crypto.randomBytes(4).toString('hex')}`
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
  return NextResponse.json(configs[id])
}
