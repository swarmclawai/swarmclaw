import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadCredentials, saveCredentials, encryptKey } from '@/lib/server/storage'

export async function GET() {
  const creds = loadCredentials()
  const safe: Record<string, any> = {}
  for (const [id, c] of Object.entries(creds) as [string, any][]) {
    safe[id] = { id: c.id, provider: c.provider, name: c.name, createdAt: c.createdAt }
  }
  return NextResponse.json(safe)
}

export async function POST(req: Request) {
  const { provider, name, apiKey } = await req.json()
  if (!provider || !apiKey) {
    return NextResponse.json({ error: 'provider and apiKey are required' }, { status: 400 })
  }
  const id = 'cred_' + crypto.randomBytes(6).toString('hex')
  const creds = loadCredentials()
  creds[id] = {
    id,
    provider,
    name: name || `${provider} key`,
    encryptedKey: encryptKey(apiKey),
    createdAt: Date.now(),
  }
  saveCredentials(creds)
  console.log(`[credentials] stored ${id} for ${provider}`)
  return NextResponse.json({ id, provider, name: creds[id].name, createdAt: creds[id].createdAt })
}
