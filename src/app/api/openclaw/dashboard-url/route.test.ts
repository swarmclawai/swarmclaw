import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { Agent } from '@/types'
import {
  encryptKey,
  loadAgents,
  loadCredentials,
  loadGatewayProfiles,
  saveAgents,
  saveCredentials,
  saveGatewayProfiles,
} from '@/lib/server/storage'
import type { GatewayProfile } from '@/types'

const originalAgents = loadAgents({ includeTrashed: true })
const originalCredentials = loadCredentials()
const originalGateways = loadGatewayProfiles()

afterEach(() => {
  saveAgents(originalAgents)
  saveCredentials(originalCredentials)
  saveGatewayProfiles(originalGateways)
})

// ---------------------------------------------------------------------------
// Helper: call the route handler directly
// ---------------------------------------------------------------------------

async function callDashboardUrl(agentId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import('./route')
  const req = new Request(`http://localhost:3456/api/openclaw/dashboard-url?agentId=${agentId}`)
  const res = await GET(req)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function createAgent(id: string, overrides: Partial<Agent> = {}): void {
  const agents = loadAgents({ includeTrashed: true })
  agents[id] = {
    id,
    name: `Agent ${id}`,
    systemPrompt: '',
    provider: 'openclaw',
    model: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Agent
  saveAgents(agents)
}

function createCredential(id: string, token: string): void {
  const creds = loadCredentials()
  creds[id] = {
    id,
    provider: 'openclaw',
    name: `Cred ${id}`,
    encryptedKey: encryptKey(token),
    createdAt: Date.now(),
  }
  saveCredentials(creds)
}

function createGateway(id: string, overrides: Partial<GatewayProfile> = {}): void {
  const gateways = loadGatewayProfiles()
  gateways[id] = {
    id,
    name: `Gateway ${id}`,
    provider: 'openclaw',
    endpoint: 'http://10.0.0.5:18789',
    status: 'healthy',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as GatewayProfile
  saveGatewayProfiles(gateways)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('dashboard-url returns 400 for missing agentId', async () => {
  const { GET } = await import('./route')
  const req = new Request('http://localhost:3456/api/openclaw/dashboard-url')
  const res = await GET(req)
  assert.equal(res.status, 400)
})

test('dashboard-url returns 404 for unknown agent', async () => {
  const { status } = await callDashboardUrl('nonexistent')
  assert.equal(status, 404)
})

test('dashboard-url returns 400 for non-OpenClaw agent', async () => {
  createAgent('oai-agent', { provider: 'openai' as Agent['provider'] })
  const { status } = await callDashboardUrl('oai-agent')
  assert.equal(status, 400)
})

test('dashboard-url returns base URL when no credential', async () => {
  createAgent('oc-no-cred', { apiEndpoint: 'http://192.168.1.10:18789' })
  const { status, body } = await callDashboardUrl('oc-no-cred')
  assert.equal(status, 200)
  assert.equal(body.url, 'http://192.168.1.10:18789')
})

test('dashboard-url includes token from agent credential', async () => {
  createCredential('cred-tok-1', 'my-gateway-token')
  createAgent('oc-with-cred', {
    apiEndpoint: 'http://localhost:18789',
    credentialId: 'cred-tok-1',
  })
  const { status, body } = await callDashboardUrl('oc-with-cred')
  assert.equal(status, 200)
  assert.equal(body.url, 'http://localhost:18789?token=my-gateway-token')
})

test('dashboard-url uses gateway profile endpoint and credential', async () => {
  createCredential('gw-cred-1', 'gw-token-1')
  createGateway('gw-prof-1', {
    endpoint: 'http://10.0.0.5:19000',
    credentialId: 'gw-cred-1',
  })
  createAgent('oc-with-gw', {
    apiEndpoint: 'http://localhost:18789',
    gatewayProfileId: 'gw-prof-1',
  })
  const { status, body } = await callDashboardUrl('oc-with-gw')
  assert.equal(status, 200)
  // Should use gateway profile endpoint, not agent's apiEndpoint
  assert.ok(typeof body.url === 'string')
  assert.ok((body.url as string).startsWith('http://10.0.0.5:19000'))
  assert.ok((body.url as string).includes('token=gw-token-1'))
})

test('dashboard-url defaults to localhost when no endpoint', async () => {
  createAgent('oc-no-ep', { apiEndpoint: undefined })
  const { status, body } = await callDashboardUrl('oc-no-ep')
  assert.equal(status, 200)
  assert.equal(body.url, 'http://localhost:18789')
})

test('dashboard-url strips path from endpoint', async () => {
  createAgent('oc-with-path', { apiEndpoint: 'http://localhost:18789/v1' })
  const { status, body } = await callDashboardUrl('oc-with-path')
  assert.equal(status, 200)
  assert.equal(body.url, 'http://localhost:18789')
})

test('dashboard-url URL-encodes special characters in token', async () => {
  createCredential('cred-special', 'tok/with spaces&chars=yes')
  createAgent('oc-special-tok', {
    apiEndpoint: 'http://localhost:18789',
    credentialId: 'cred-special',
  })
  const { status, body } = await callDashboardUrl('oc-special-tok')
  assert.equal(status, 200)
  const url = body.url as string
  assert.ok(url.includes('token='))
  // Token should be URL-encoded
  assert.ok(!url.includes(' '), 'spaces should be encoded')
  // Decode and verify the token
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('token'), 'tok/with spaces&chars=yes')
})
