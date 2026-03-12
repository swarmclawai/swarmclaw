import { genId } from '@/lib/id'
import { NextResponse } from 'next/server'
import { loadAgents, loadSessions, saveSessions, loadWebhooks, appendWebhookLog, upsertWebhookRetry } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { enqueueSessionRun } from '@/lib/server/runtime/session-run-manager'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { requestHeartbeatNow } from '@/lib/server/runtime/heartbeat-wake'
import { notFound } from '@/lib/server/collection-helpers'
import type { WebhookRetryEntry } from '@/types'
import { triggerWebhookWatchJobs } from '@/lib/server/runtime/watch-jobs'
import { errorMessage } from '@/lib/shared-utils'

export type WebhookPostDeps = {
  enqueueRun: typeof enqueueSessionRun
  enqueueEvent: typeof enqueueSystemEvent
  requestHeartbeat: typeof requestHeartbeatNow
}

export const defaultWebhookPostDeps: WebhookPostDeps = {
  enqueueRun: enqueueSessionRun,
  enqueueEvent: enqueueSystemEvent,
  requestHeartbeat: requestHeartbeatNow,
}

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

export async function handleWebhookPost(
  req: Request,
  id: string,
  deps: WebhookPostDeps = defaultWebhookPostDeps,
) {
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

  const { timingSafeEqual } = await import('node:crypto')
  const secret = typeof webhook.secret === 'string' ? webhook.secret.trim() : ''
  if (secret) {
    const url = new URL(req.url)
    const provided = req.headers.get('x-webhook-secret') || url.searchParams.get('secret') || ''
    const secretBuf = Buffer.from(secret)
    const providedBuf = Buffer.from(provided)
    // timingSafeEqual requires equal lengths; compare against secretBuf if lengths differ
    const compareBuf = providedBuf.length === secretBuf.length ? providedBuf : secretBuf
    const isInvalid = providedBuf.length !== secretBuf.length || !timingSafeEqual(secretBuf, compareBuf)
    if (isInvalid) {
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

  triggerWebhookWatchJobs({
    webhookId: id,
    event: incomingEvent,
    payloadPreview: rawBody,
  })

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
  let session = Object.values(sessions).find((s: unknown) => {
    const rec = s as Record<string, unknown>
    return rec.name === sessionName && rec.agentId === agent.id
  }) as Record<string, unknown> | undefined
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
      sessionType: 'human',
      agentId: agent.id,
      parentSessionId: null,
      tools: agent.tools || [],
      heartbeatEnabled: agent.heartbeatEnabled ?? false,
      heartbeatIntervalSec: agent.heartbeatIntervalSec ?? null,
    }
    sessions[session.id as string] = session
    saveSessions(sessions)
  }

  const sid = session.id as string
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

  try {
    const run = deps.enqueueRun({
      sessionId: sid,
      message: prompt,
      source: 'webhook',
      internal: false,
      mode: 'followup',
    })

    // Enqueue system event + heartbeat wake
    deps.enqueueEvent(sid, `Webhook received: ${webhook.name || id} (${incomingEvent})`)
    if (webhook.agentId) {
      deps.requestHeartbeat({
        agentId: webhook.agentId,
        eventId: `webhook:${id}:${incomingEvent}:${Date.now()}`,
        reason: 'webhook',
        source: `webhook:${id}`,
        resumeMessage: `Webhook received: ${webhook.name || id} (${incomingEvent})`,
        detail: payloadPreview || '(empty payload)',
      })
    }

    appendWebhookLog(genId(8), {
      id: genId(8), webhookId: id, event: incomingEvent,
      payload: (rawBody || '').slice(0, 2000), status: 'success',
      sessionId: sid, runId: run.runId, timestamp: Date.now(),
    })

    return NextResponse.json({
      ok: true,
      webhookId: id,
      event: incomingEvent,
      sessionId: sid,
      runId: run.runId,
    })
  } catch (err: unknown) {
    const errorMsg = errorMessage(err)

    // Enqueue for retry with exponential backoff
    const retryId = genId()
    const now = Date.now()
    const retryEntry: WebhookRetryEntry = {
      id: retryId,
      webhookId: id,
      event: incomingEvent,
      payload: (rawBody || '').slice(0, 12_000),
      attempts: 1,
      maxAttempts: 3,
      nextRetryAt: now + 30_000,
      deadLettered: false,
      createdAt: now,
    }
    upsertWebhookRetry(retryId, retryEntry)

    appendWebhookLog(genId(8), {
      id: genId(8), webhookId: id, event: incomingEvent,
      payload: (rawBody || '').slice(0, 2000), status: 'error',
      error: `Dispatch failed, queued for retry: ${errorMsg}`, timestamp: Date.now(),
    })

    return NextResponse.json({
      ok: true,
      webhookId: id,
      event: incomingEvent,
      retryQueued: true,
      retryId,
      error: errorMsg,
    })
  }
}
