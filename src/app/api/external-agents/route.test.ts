import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { GET as listExternalAgents, POST as registerExternalAgent } from './route'
import { POST as heartbeatExternalAgent } from './[id]/heartbeat/route'
import { PUT as mutateExternalAgent, DELETE as deleteExternalAgent } from './[id]/route'
import {
  loadExternalAgents,
  loadGatewayProfiles,
  saveExternalAgents,
  saveGatewayProfiles,
} from '@/lib/server/storage'

const originalExternalAgents = loadExternalAgents()
const originalGatewayProfiles = loadGatewayProfiles()

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

afterEach(() => {
  saveExternalAgents(originalExternalAgents)
  saveGatewayProfiles(originalGatewayProfiles)
})

test('external agent register + heartbeat derives gateway metadata in listing', async () => {
  const gateways = loadGatewayProfiles()
  gateways['gateway-ext-test'] = {
    id: 'gateway-ext-test',
    name: 'Gateway Test',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:19999/v1',
    wsUrl: 'ws://127.0.0.1:19999',
    credentialId: null,
    status: 'healthy',
    notes: null,
    tags: ['lan-remote', 'smoke'],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: 1,
    discoveredHost: '127.0.0.1',
    discoveredPort: 19999,
    deployment: {
      method: 'imported',
      managedBy: "external" as any,
      useCase: 'single-vps',
      exposure: 'private-lan',
      targetHost: '127.0.0.1',
    },
    stats: null,
    isDefault: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveGatewayProfiles(gateways)

  const registerResponse = await registerExternalAgent(new Request('http://local/api/external-agents/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'runtime-ext-test',
      name: 'External Runtime',
      sourceType: 'openclaw',
      transport: 'gateway',
      endpoint: 'http://127.0.0.1:19999/v1',
      agentId: 'agent-ext-test',
      gatewayProfileId: 'gateway-ext-test',
    }),
  }))
  assert.equal(registerResponse.status, 200)

  const heartbeatResponse = await heartbeatExternalAgent(new Request('http://local/api/external-agents/runtime-ext-test/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'online',
      lastHealthNote: 'Heartbeat OK',
      version: '1.2.3',
      tokenStats: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    }),
  }), routeParams('runtime-ext-test'))
  assert.equal(heartbeatResponse.status, 200)

  const listResponse = await listExternalAgents()
  assert.equal(listResponse.status, 200)
  const listPayload = await listResponse.json() as Array<Record<string, unknown>>
  const runtime = listPayload.find((item) => item.id === 'runtime-ext-test')

  assert.ok(runtime)
  assert.equal(runtime?.status, 'online')
  assert.equal(runtime?.gatewayUseCase, 'single-vps')
  assert.deepEqual(runtime?.gatewayTags, ['lan-remote', 'smoke'])
  assert.equal(runtime?.lastHealthNote, 'Heartbeat OK')
  assert.equal((runtime?.tokenStats as { totalTokens?: number } | undefined)?.totalTokens, 12)
})

test('external agent lifecycle actions update state and delete removes the runtime', async () => {
  const items = loadExternalAgents()
  items['runtime-lifecycle-test'] = {
    id: 'runtime-lifecycle-test',
    name: 'Lifecycle Runtime',
    sourceType: 'openclaw',
    status: 'online',
    provider: 'openclaw',
    model: 'default',
    workspace: null,
    transport: 'gateway',
    endpoint: 'http://127.0.0.1:18888/v1',
    agentId: 'agent-lifecycle-test',
    gatewayProfileId: null,
    capabilities: [],
    labels: [],
    lifecycleState: 'active',
    gatewayTags: [],
    gatewayUseCase: null,
    version: null,
    lastHealthNote: null,
    metadata: null,
    tokenStats: null,
    lastHeartbeatAt: Date.now(),
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveExternalAgents(items)

  const drainResponse = await mutateExternalAgent(new Request('http://local/api/external-agents/runtime-lifecycle-test', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'drain' }),
  }), routeParams('runtime-lifecycle-test'))
  const drainPayload = await drainResponse.json() as Record<string, unknown>
  assert.equal(drainPayload.lifecycleState, 'draining')

  const cordonResponse = await mutateExternalAgent(new Request('http://local/api/external-agents/runtime-lifecycle-test', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'cordon' }),
  }), routeParams('runtime-lifecycle-test'))
  const cordonPayload = await cordonResponse.json() as Record<string, unknown>
  assert.equal(cordonPayload.lifecycleState, 'cordoned')

  const restartResponse = await mutateExternalAgent(new Request('http://local/api/external-agents/runtime-lifecycle-test', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restart' }),
  }), routeParams('runtime-lifecycle-test'))
  const restartPayload = await restartResponse.json() as Record<string, unknown>
  assert.equal((restartPayload.metadata as { controlRequest?: { action?: string } } | undefined)?.controlRequest?.action, 'restart')

  const activateResponse = await mutateExternalAgent(new Request('http://local/api/external-agents/runtime-lifecycle-test', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'activate' }),
  }), routeParams('runtime-lifecycle-test'))
  const activatePayload = await activateResponse.json() as Record<string, unknown>
  assert.equal(activatePayload.lifecycleState, 'active')

  const deleteResponse = await deleteExternalAgent(
    new Request('http://local/api/external-agents/runtime-lifecycle-test', { method: 'DELETE' }),
    routeParams('runtime-lifecycle-test'),
  )
  assert.equal(deleteResponse.status, 200)
  assert.equal(loadExternalAgents()['runtime-lifecycle-test'], undefined)
})
