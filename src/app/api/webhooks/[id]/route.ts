import { genId } from '@/lib/id'
import { NextResponse } from 'next/server'
import { loadAgents, loadSessions, loadWebhooks, saveSessions, saveWebhooks, appendWebhookLog } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { enqueueSessionRun } from '@/lib/server/session-run-manager'
import { mutateItem, deleteItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: loadWebhooks, save: saveWebhooks }

function normalizeEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
}

function eventMatches(registered: string[], incoming: string): boolean {
  if (registered.length === 0) return true
  if (registered.includes('*')) return true
  return registered.includes(incoming)
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
  const webhooks = loadWebhooks()
  const webhook = webhooks[id]
  if (!webhook) return notFound('Webhook not found')
  if (webhook.isEnabled === false) {
    appendWebhookLog(genId(8), {
      id: genId(8), webhookId: id, event: 'unknown',
      payload: '', status: 'error', error: 'Webhook is disabled', timestamp: Date.now(),
    })
    return NextResponse.json({ error: 'Webhook is disabled' }, { status: 409 })
  }

  const secret = typeof webhook.secret === 'string' ? webhook.secret.trim() : ''
  if (secret) {
    const url = new URL(req.url)
    const provided = req.headers.get('x-webhook-secret') || url.searchParams.get('secret') || ''
    if (provided !== secret) {
      appendWebhookLog(genId(8), {
        id: genId(8), webhookId: id, event: 'unknown',
        payload: '', status: 'error', error: 'Invalid webhook secret', timestamp: Date.now(),
      })
      return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 401 })
    }
  }

  let payload: unknown = null
  let rawBody = ''
  const contentType = req.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      payload = await req.json()
      rawBody = JSON.stringify(payload)
    } catch {
      payload = {}
      rawBody = '{}'
    }
  } else {
    rawBody = await req.text()
    try {
      payload = JSON.parse(rawBody)
    } catch {
      payload = { raw: rawBody }
    }
  }

  const url = new URL(req.url)
  const incomingEvent = String(
    (payload as Record<string, unknown> | null)?.type
      || (payload as Record<string, unknown> | null)?.event
      || req.headers.get('x-event-type')
      || url.searchParams.get('event')
      || 'unknown',
  )
  const registeredEvents = normalizeEvents(webhook.events)
  if (!eventMatches(registeredEvents, incomingEvent)) {
    return NextResponse.json({
      ok: true,
      ignored: true,
      reason: 'Event does not match webhook filters',
      event: incomingEvent,
    })
  }

  const agents = loadAgents()
  const agent = webhook.agentId ? agents[webhook.agentId] : null
  if (!agent) {
    appendWebhookLog(genId(8), {
      id: genId(8), webhookId: id, event: incomingEvent,
      payload: (rawBody || '').slice(0, 2000), status: 'error', error: 'Webhook agent is not configured or missing', timestamp: Date.now(),
    })
    return NextResponse.json({ error: 'Webhook agent is not configured or missing' }, { status: 400 })
  }

  const sessions = loadSessions()
  const sessionName = `webhook:${id}`
  let session = Object.values(sessions).find((s: any) => s.name === sessionName && s.agentId === agent.id) as any
  if (!session) {
    const sessionId = genId()
    const now = Date.now()
    session = {
      id: sessionId,
      name: sessionName,
      cwd: WORKSPACE_DIR,
      user: 'system',
      provider: agent.provider || 'claude-cli',
      model: agent.model || '',
      credentialId: agent.credentialId || null,
      apiEndpoint: agent.apiEndpoint || null,
      claudeSessionId: null,
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: {
        claudeCode: null,
        codex: null,
        opencode: null,
      },
      messages: [],
      createdAt: now,
      lastActiveAt: now,
      sessionType: 'orchestrated',
      agentId: agent.id,
      parentSessionId: null,
      tools: agent.tools || [],
      heartbeatEnabled: agent.heartbeatEnabled ?? true,
      heartbeatIntervalSec: agent.heartbeatIntervalSec ?? null,
    }
    sessions[session.id] = session
    saveSessions(sessions)
  }

  const payloadPreview = (rawBody || '').slice(0, 12_000)
  const prompt = [
    'Webhook event received.',
    `Webhook ID: ${id}`,
    `Webhook Name: ${webhook.name || id}`,
    `Source: ${webhook.source || 'custom'}`,
    `Event: ${incomingEvent}`,
    `Received At: ${new Date().toISOString()}`,
    '',
    'Payload:',
    payloadPreview || '(empty payload)',
    '',
    'Handle this event now. If this requires notifying the user, use configured connector tools.',
  ].join('\n')

  const run = enqueueSessionRun({
    sessionId: session.id,
    message: prompt,
    source: 'webhook',
    internal: false,
    mode: 'followup',
  })

  appendWebhookLog(genId(8), {
    id: genId(8), webhookId: id, event: incomingEvent,
    payload: (rawBody || '').slice(0, 2000), status: 'success',
    sessionId: session.id, runId: run.runId, timestamp: Date.now(),
  })

  return NextResponse.json({
    ok: true,
    webhookId: id,
    event: incomingEvent,
    sessionId: session.id,
    runId: run.runId,
  })
}
