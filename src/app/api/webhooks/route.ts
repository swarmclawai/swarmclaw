import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { loadWebhooks, saveWebhooks } from '@/lib/server/storage'

function normalizeEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
}

export async function GET() {
  return NextResponse.json(loadWebhooks())
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const webhooks = loadWebhooks()
  const id = crypto.randomBytes(4).toString('hex')
  const now = Date.now()

  webhooks[id] = {
    id,
    name: typeof body.name === 'string' ? body.name : 'Unnamed Webhook',
    source: typeof body.source === 'string' ? body.source : 'custom',
    events: normalizeEvents(body.events),
    agentId: typeof body.agentId === 'string' ? body.agentId : null,
    secret: typeof body.secret === 'string' ? body.secret : '',
    isEnabled: body.isEnabled !== false,
    createdAt: now,
    updatedAt: now,
  }

  saveWebhooks(webhooks)
  return NextResponse.json(webhooks[id])
}
