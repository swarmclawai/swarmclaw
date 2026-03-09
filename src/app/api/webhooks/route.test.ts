import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { GET as getWebhookHistory } from './[id]/history/route'
import { handleWebhookPost } from './[id]/route'
import {
  loadAgents,
  loadSessions,
  loadWebhookLogs,
  loadWebhookRetryQueue,
  loadWebhooks,
  saveAgents,
  saveSessions,
  saveWebhookLogs,
  saveWebhookRetryQueue,
  saveWebhooks,
} from '@/lib/server/storage'

const originalAgents = loadAgents()
const originalSessions = loadSessions()
const originalWebhooks = loadWebhooks()
const originalWebhookLogs = loadWebhookLogs()
const originalWebhookRetryQueue = loadWebhookRetryQueue()

afterEach(() => {
  saveAgents(originalAgents)
  saveSessions(originalSessions)
  saveWebhooks(originalWebhooks)
  saveWebhookLogs(originalWebhookLogs)
  saveWebhookRetryQueue(originalWebhookRetryQueue)
})

function seedAgent(agentId: string) {
  const agents = loadAgents()
  agents[agentId] = {
    id: agentId,
    name: 'Webhook Agent',
    description: 'Test agent for webhook delivery',
    systemPrompt: 'Handle inbound webhooks.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    credentialId: null,
    apiEndpoint: null,
    tools: ['manage_webhooks'],
    createdAt: 1,
    updatedAt: 1,
  }
  saveAgents(agents)
}

function seedWebhook(webhookId: string, overrides: Record<string, unknown> = {}) {
  const webhooks = loadWebhooks()
  webhooks[webhookId] = {
    id: webhookId,
    name: 'Webhook Smoke',
    source: 'custom',
    events: ['build.completed'],
    agentId: 'agent-webhook-smoke',
    secret: 'secret-smoke',
    isEnabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
  saveWebhooks(webhooks)
}

test('handleWebhookPost creates a session, records success history, and triggers follow-up wiring', async () => {
  const webhookId = 'wh-success-smoke'
  seedAgent('agent-webhook-smoke')
  seedWebhook(webhookId)

  const calls = {
    runs: [] as Array<Record<string, unknown>>,
    events: [] as Array<[string, string]>,
    heartbeats: [] as Array<Record<string, unknown>>,
  }

  const response = await handleWebhookPost(
    new Request(`http://local/api/webhooks/${webhookId}?event=build.completed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': 'secret-smoke',
      },
      body: JSON.stringify({ event: 'build.completed', payload: { ok: true } }),
    }),
    webhookId,
    {
      enqueueRun(input) {
        calls.runs.push(input as any)
        return {
          runId: 'run-success-smoke',
          position: 0,
          promise: Promise.resolve({} as never),
          abort: () => {},
          unsubscribe: () => {},
        }
      },
      enqueueEvent(sessionId, text) {
        calls.events.push([sessionId, text])
      },
      requestHeartbeat(opts) {
        calls.heartbeats.push(opts as Record<string, unknown>)
      },
    },
  )

  assert.equal(response.status, 200)
  const payload = await response.json() as Record<string, unknown>
  assert.equal(payload.ok, true)
  assert.equal(payload.event, 'build.completed')
  assert.equal(payload.runId, 'run-success-smoke')

  const sessionId = String(payload.sessionId)
  const session = loadSessions()[sessionId]
  assert.ok(session)
  assert.equal(session.name, `webhook:${webhookId}`)
  assert.equal(session.agentId, 'agent-webhook-smoke')

  assert.equal(calls.runs.length, 1)
  assert.equal(calls.runs[0].sessionId, sessionId)
  assert.equal(calls.runs[0].source, 'webhook')
  assert.equal(calls.runs[0].mode, 'followup')
  assert.match(String(calls.runs[0].message), /Webhook event received\./)
  assert.match(String(calls.runs[0].message), /Event: build\.completed/)

  assert.deepEqual(calls.events, [[sessionId, 'Webhook received: Webhook Smoke (build.completed)']])
  assert.deepEqual(calls.heartbeats, [{ agentId: 'agent-webhook-smoke', reason: 'webhook' }])

  const logEntries = Object.values(loadWebhookLogs()) as Array<Record<string, unknown>>
  const successEntry = logEntries.find((entry) => entry.webhookId === webhookId && entry.status === 'success')
  assert.ok(successEntry)
  assert.equal(successEntry?.sessionId, sessionId)
  assert.equal(successEntry?.runId, 'run-success-smoke')

  const historyResponse = await getWebhookHistory(new Request(`http://local/api/webhooks/${webhookId}/history`), {
    params: Promise.resolve({ id: webhookId }),
  })
  assert.equal(historyResponse.status, 200)
  const history = await historyResponse.json() as Array<Record<string, unknown>>
  assert.equal(history[0]?.status, 'success')
  assert.equal(history[0]?.webhookId, webhookId)
})

test('handleWebhookPost ignores filtered events without dispatching or logging delivery', async () => {
  const webhookId = 'wh-ignored-smoke'
  seedAgent('agent-webhook-smoke')
  seedWebhook(webhookId, { events: ['build.completed'] })

  let runCalls = 0
  const response = await handleWebhookPost(
    new Request(`http://local/api/webhooks/${webhookId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': 'secret-smoke',
      },
      body: JSON.stringify({ event: 'build.started' }),
    }),
    webhookId,
    {
      enqueueRun() {
        runCalls += 1
        return {
          runId: 'should-not-run',
          position: 0,
          promise: Promise.resolve({} as never),
          abort: () => {},
          unsubscribe: () => {},
        }
      },
      enqueueEvent() {},
      requestHeartbeat() {},
    },
  )

  assert.equal(response.status, 200)
  const payload = await response.json() as Record<string, unknown>
  assert.equal(payload.ignored, true)
  assert.equal(payload.event, 'build.started')
  assert.equal(runCalls, 0)
  assert.equal(Object.values(loadSessions()).some((session: any) => session?.name === `webhook:${webhookId}`), false)
  assert.equal(Object.values(loadWebhookLogs()).some((entry: any) => entry?.webhookId === webhookId), false)
})

test('handleWebhookPost rejects disabled webhooks and invalid secrets with error history', async () => {
  const disabledId = 'wh-disabled-smoke'
  seedWebhook(disabledId, { isEnabled: false, secret: '' })

  const disabledResponse = await handleWebhookPost(
    new Request(`http://local/api/webhooks/${disabledId}`, { method: 'POST' }),
    disabledId,
    {
      enqueueRun() {
        throw new Error('should not dispatch')
      },
      enqueueEvent() {},
      requestHeartbeat() {},
    },
  )
  assert.equal(disabledResponse.status, 409)

  const invalidSecretId = 'wh-secret-smoke'
  seedAgent('agent-webhook-smoke')
  seedWebhook(invalidSecretId, { secret: 'top-secret' })

  const invalidSecretResponse = await handleWebhookPost(
    new Request(`http://local/api/webhooks/${invalidSecretId}`, {
      method: 'POST',
      headers: { 'x-webhook-secret': 'wrong-secret' },
    }),
    invalidSecretId,
    {
      enqueueRun() {
        throw new Error('should not dispatch')
      },
      enqueueEvent() {},
      requestHeartbeat() {},
    },
  )
  assert.equal(invalidSecretResponse.status, 401)

  const errors = Object.values(loadWebhookLogs()) as Array<Record<string, unknown>>
  const disabledEntry = errors.find((entry) => entry.webhookId === disabledId)
  const invalidSecretEntry = errors.find((entry) => entry.webhookId === invalidSecretId)
  assert.equal(disabledEntry?.error, 'Webhook is disabled')
  assert.equal(invalidSecretEntry?.error, 'Invalid webhook secret')
})

test('handleWebhookPost queues retries when run dispatch throws', async () => {
  const webhookId = 'wh-retry-smoke'
  seedAgent('agent-webhook-smoke')
  seedWebhook(webhookId)

  const heartbeats: Array<Record<string, unknown>> = []
  const response = await handleWebhookPost(
    new Request(`http://local/api/webhooks/${webhookId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': 'secret-smoke',
      },
      body: JSON.stringify({ event: 'build.completed', payload: { ok: false } }),
    }),
    webhookId,
    {
      enqueueRun() {
        throw new Error('dispatch exploded')
      },
      enqueueEvent() {},
      requestHeartbeat(opts) {
        heartbeats.push(opts as Record<string, unknown>)
      },
    },
  )

  assert.equal(response.status, 200)
  const payload = await response.json() as Record<string, unknown>
  assert.equal(payload.retryQueued, true)
  assert.equal(payload.error, 'dispatch exploded')
  assert.equal(heartbeats.length, 0)

  const retries = Object.values(loadWebhookRetryQueue()) as Array<Record<string, unknown>>
  const retryEntry = retries.find((entry) => entry.webhookId === webhookId)
  assert.ok(retryEntry)
  assert.equal(retryEntry?.attempts, 1)
  assert.equal(retryEntry?.deadLettered, false)

  const errorLogs = Object.values(loadWebhookLogs()) as Array<Record<string, unknown>>
  const retryLog = errorLogs.find((entry) => entry.webhookId === webhookId)
  assert.ok(retryLog)
  assert.match(String(retryLog?.error), /Dispatch failed, queued for retry: dispatch exploded/)
})
