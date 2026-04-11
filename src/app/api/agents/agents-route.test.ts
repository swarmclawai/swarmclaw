import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

// Disable daemon autostart during tests
process.env.SWARMCLAW_DAEMON_AUTOSTART = '0'

import { GET as getAgent } from './[id]/route'
import { POST as createAgent } from './route'
import { loadAgents, saveAgents } from '@/lib/server/storage'

const originalAgents = loadAgents()

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function seedAgent(id: string, overrides: Record<string, unknown> = {}) {
  const agents = loadAgents()
  const now = Date.now()
  agents[id] = {
    id,
    name: 'Test Agent',
    description: 'Route test',
    systemPrompt: '',
    provider: 'ollama',
    model: 'qwen3.5',
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: null,
    gatewayProfileId: null,
    extensions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  saveAgents(agents)
}

afterEach(() => {
  saveAgents(originalAgents)
})

// --- GET /api/agents/:id ---

test('GET /api/agents/:id returns the agent when it exists', async () => {
  seedAgent('agent-get-test', { name: 'GetMe' })

  const response = await getAgent(
    new Request('http://local/api/agents/agent-get-test'),
    routeParams('agent-get-test'),
  )

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.id, 'agent-get-test')
  assert.equal(body.name, 'GetMe')
})

test('GET /api/agents/:id returns 404 for a non-existent agent', async () => {
  const response = await getAgent(
    new Request('http://local/api/agents/does-not-exist'),
    routeParams('does-not-exist'),
  )

  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error, 'Not found')
})

// --- POST /api/agents (provider validation) ---

test('POST /api/agents rejects an unknown provider with a 400', async () => {
  const response = await createAgent(new Request('http://local/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad Provider Agent', provider: 'nonexistent_provider', model: 'x' }),
  }))

  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error, 'Validation failed')
  assert.ok(body.issues.some((i: { path: string; message: string }) => i.path === 'provider'))
})

test('POST /api/agents accepts a valid provider and creates the agent', async () => {
  const response = await createAgent(new Request('http://local/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Good Agent', provider: 'ollama', model: 'qwen3.5' }),
  }))

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.name, 'Good Agent')
  assert.equal(body.provider, 'ollama')
  assert.ok(body.id)

  // Clean up
  const agents = loadAgents()
  delete agents[body.id]
  saveAgents(agents)
})

test('POST /api/agents rejects missing required fields with a 400', async () => {
  const response = await createAgent(new Request('http://local/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }))

  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error, 'Validation failed')
})
