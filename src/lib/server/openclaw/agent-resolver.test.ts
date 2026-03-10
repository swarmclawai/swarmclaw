import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@/types'
import {
  resolveOpenClawGatewayAgentIdFromList,
  type OpenClawGatewayAgentSummary,
} from './agent-resolver'

function makeOpenClawAgent(overrides: Partial<Agent> = {}): Agent {
  const now = Date.now()
  return {
    id: 'f4535f26',
    name: 'OpenClaw Ops',
    description: '',
    systemPrompt: '',
    provider: 'openclaw',
    model: 'openclaw-default',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

test('resolveOpenClawGatewayAgentIdFromList matches a local OpenClaw agent by normalized name', () => {
  const gatewayAgents: OpenClawGatewayAgentSummary[] = [
    { id: 'main', name: 'Main' },
    { id: 'openclaw-ops', name: 'OpenClaw Ops' },
  ]
  const resolved = resolveOpenClawGatewayAgentIdFromList({
    agentRef: 'f4535f26',
    gatewayAgents,
    localAgent: makeOpenClawAgent(),
  })
  assert.equal(resolved, 'openclaw-ops')
})

test('resolveOpenClawGatewayAgentIdFromList preserves direct gateway ids', () => {
  const gatewayAgents: OpenClawGatewayAgentSummary[] = [
    { id: 'main', name: 'Main' },
  ]
  const resolved = resolveOpenClawGatewayAgentIdFromList({
    agentRef: 'main',
    gatewayAgents,
  })
  assert.equal(resolved, 'main')
})

test('resolveOpenClawGatewayAgentIdFromList can match identity names when display names differ', () => {
  const gatewayAgents: OpenClawGatewayAgentSummary[] = [
    { id: 'research-ops', identity: { name: 'Research Ops' } },
  ]
  const resolved = resolveOpenClawGatewayAgentIdFromList({
    agentRef: 'agent-123',
    gatewayAgents,
    localAgent: makeOpenClawAgent({ id: 'agent-123', name: 'Research Ops' }),
  })
  assert.equal(resolved, 'research-ops')
})

test('single-agent gateway can back a local OpenClaw provider agent without an explicit name match', async () => {
  const gatewayAgents: OpenClawGatewayAgentSummary[] = [
    { id: 'main', name: 'Main' },
  ]
  const resolved = resolveOpenClawGatewayAgentIdFromList({
    agentRef: 'f4535f26',
    gatewayAgents,
    localAgent: makeOpenClawAgent({ name: 'OpenClaw-2' }),
  })
  assert.equal(resolved, 'main')
})
