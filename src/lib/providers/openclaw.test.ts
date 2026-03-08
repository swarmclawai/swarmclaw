import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { resolveGatewayAgentId } from './openclaw'
import { loadAgents, saveAgents } from '../server/storage'
import type { Agent } from '@/types'

const originalAgents = loadAgents({ includeTrashed: true })

afterEach(() => {
  saveAgents(originalAgents)
})

test('resolveGatewayAgentId prefers the matching OpenClaw agent name from storage', () => {
  const agents = loadAgents({ includeTrashed: true })
  agents['openclaw-agent-test'] = {
    id: 'openclaw-agent-test',
    name: 'Research Operator',
    systemPrompt: '',
    provider: 'openclaw',
    model: 'default',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
  saveAgents(agents)

  const resolved = resolveGatewayAgentId({
    id: 'session-1',
    agentId: 'openclaw-agent-test',
    shortcutForAgentId: 'openclaw-agent-test',
    name: 'Some Other Name',
  })

  assert.equal(resolved, 'research-operator')
})

test('resolveGatewayAgentId honors explicit OpenClaw agent ids when provided', () => {
  const resolved = resolveGatewayAgentId({
    id: 'session-2',
    openclawAgentId: 'Custom Gateway Agent',
    name: 'Ignored',
  })

  assert.equal(resolved, 'custom-gateway-agent')
})

test('resolveGatewayAgentId falls back to the session name when no OpenClaw agent is available', () => {
  const resolved = resolveGatewayAgentId({
    id: 'session-3',
    name: 'Fallback Agent Name',
  })

  assert.equal(resolved, 'fallback-agent-name')
})
