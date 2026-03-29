import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { POST as createAgentThread } from './[id]/thread/route'
import { loadAgents, loadSessions, saveAgents, saveSessions } from '@/lib/server/storage'

const originalAgents = loadAgents()
const originalSessions = loadSessions()

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function seedAgent(id: string, overrides: Record<string, unknown> = {}) {
  const agents = loadAgents()
  const now = Date.now()
  agents[id] = {
    id,
    name: 'Thread Test Agent',
    description: 'Agent thread route smoke',
    systemPrompt: 'Be helpful.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: null,
    gatewayProfileId: null,
    extensions: ['memory'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  saveAgents(agents)
}

afterEach(() => {
  saveAgents(originalAgents)
  saveSessions(originalSessions)
})

test('POST /api/agents/[id]/thread returns 409 for a disabled agent without an existing thread', async () => {
  seedAgent('agent-thread-disabled', { disabled: true })

  const response = await createAgentThread(new Request('http://local/api/agents/agent-thread-disabled/thread', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'default' }),
  }), routeParams('agent-thread-disabled'))

  assert.equal(response.status, 409)
  const payload = await response.json() as Record<string, unknown>
  assert.match(String(payload.error || ''), /disabled/i)
})

test('POST /api/agents/[id]/thread reuses an existing thread for a disabled agent', async () => {
  seedAgent('agent-thread-disabled-existing', {
    disabled: true,
    threadSessionId: 'session-disabled-existing',
  })

  const sessions = loadSessions()
  sessions['session-disabled-existing'] = {
    id: 'session-disabled-existing',
    name: 'Thread Test Agent',
    shortcutForAgentId: 'agent-thread-disabled-existing',
    cwd: '/tmp',
    user: 'default',
    provider: 'openai',
    model: 'gpt-4o-mini',
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: null,
    gatewayProfileId: null,
    routePreferredGatewayTags: [],
    routePreferredGatewayUseCase: null,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
    messages: [],
    createdAt: 1,
    lastActiveAt: 1,
    active: false,
    sessionType: 'human',
    agentId: 'agent-thread-disabled-existing',
    parentSessionId: null,
    extensions: ['memory'],
    tools: ['memory'],
    heartbeatEnabled: false,
    heartbeatIntervalSec: null,
    heartbeatTarget: null,
    sessionResetMode: null,
    sessionIdleTimeoutSec: null,
    sessionMaxAgeSec: null,
    sessionDailyResetAt: null,
    sessionResetTimezone: null,
    thinkingLevel: null,
    browserProfileId: null,
    connectorThinkLevel: null,
    connectorSessionScope: null,
    connectorReplyMode: null,
    connectorThreadBinding: null,
    connectorGroupPolicy: null,
    connectorIdleTimeoutSec: null,
    connectorMaxAgeSec: null,
    mailbox: null,
    connectorContext: undefined,
    lastAutoMemoryAt: null,
    lastHeartbeatText: null,
    lastHeartbeatSentAt: null,
    lastSessionResetAt: null,
    lastSessionResetReason: null,
    identityState: null,
    sessionArchiveState: null,
    pinned: false,
    file: null,
    queuedCount: 0,
    currentRunId: null,
  }
  saveSessions(sessions)

  const response = await createAgentThread(new Request('http://local/api/agents/agent-thread-disabled-existing/thread', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'default' }),
  }), routeParams('agent-thread-disabled-existing'))

  assert.equal(response.status, 200)
  const payload = await response.json() as Record<string, unknown>
  assert.equal(payload.id, 'session-disabled-existing')
  assert.equal(payload.agentId, 'agent-thread-disabled-existing')
})
