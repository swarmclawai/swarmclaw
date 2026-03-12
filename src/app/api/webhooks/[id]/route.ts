import { NextResponse } from 'next/server'
import { loadWebhooks, saveWebhooks } from '@/lib/server/storage'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import { handleWebhookPost } from './helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadWebhooks, save: saveWebhooks }

function normalizeEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const webhooks = loadWebhooks()
  const webhook = webhooks[id]
  if (!webhook) return notFound('Webhook not found')
  return NextResponse.json(webhook)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const result = mutateItem(ops, id, (webhook) => {
    if (body.name !== undefined) webhook.name = body.name
    if (body.source !== undefined) webhook.source = body.source
    if (body.events !== undefined) webhook.events = normalizeEvents(body.events)
    if (body.agentId !== undefined) webhook.agentId = body.agentId
    if (body.secret !== undefined) webhook.secret = body.secret
    if (body.isEnabled !== undefined) webhook.isEnabled = !!body.isEnabled
    webhook.updatedAt = Date.now()
    return webhook
  })
  if (!result) return notFound('Webhook not found')
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!deleteItem(ops, id)) return notFound('Webhook not found')
  return NextResponse.json({ ok: true })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWebhookPost(req, id)
}
