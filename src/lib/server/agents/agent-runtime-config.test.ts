import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, GatewayProfile } from '@/types'
import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import {
  applyResolvedRoute,
  resolveAgentRouteCandidatesWithProfiles,
} from '@/lib/server/agents/agent-runtime-config'

function makeGateway(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  const now = Date.now()
  return {
    id: 'gateway-default',
    name: 'Gateway Default',
    provider: 'openclaw',
    endpoint: 'https://gateway.example.com/v1',
    wsUrl: 'wss://gateway.example.com',
    credentialId: 'cred-gateway',
    status: 'healthy',
    tags: [],
    isDefault: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = Date.now()
  return {
    id: 'agent-1',
    name: 'OpenClaw Ops',
    description: '',
    systemPrompt: '',
    provider: 'openclaw',
    model: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

test('resolveAgentRouteCandidatesWithProfiles applies the default OpenClaw gateway profile to base agents', () => {
  const gateways = [
    makeGateway(),
    makeGateway({
      id: 'gateway-secondary',
      name: 'Gateway Secondary',
      endpoint: 'https://secondary.example.com/v1',
      wsUrl: 'wss://secondary.example.com',
      credentialId: 'cred-secondary',
      isDefault: false,
    }),
  ]

  const [route] = resolveAgentRouteCandidatesWithProfiles(makeAgent(), gateways)
  assert.ok(route)
  assert.equal(route.provider, 'openclaw')
  assert.equal(route.model, 'default')
  assert.equal(route.gatewayProfileId, 'gateway-default')
  assert.equal(route.credentialId, 'cred-gateway')
  assert.equal(route.apiEndpoint, normalizeProviderEndpoint('openclaw', 'https://gateway.example.com/v1'))
})

test('resolveAgentRouteCandidatesWithProfiles respects routing strategy but deprioritizes cooling providers', () => {
  const gateways = [
    makeGateway({
      id: 'gateway-economy',
      name: 'Economy Gateway',
      endpoint: 'https://economy.example.com/v1',
      wsUrl: 'wss://economy.example.com',
      credentialId: 'cred-economy',
      isDefault: false,
    }),
  ]

  const agent = makeAgent({
    provider: 'openai',
    model: 'gpt-4o',
    gatewayProfileId: null,
    routingStrategy: 'economy',
    routingTargets: [
      {
        id: 'economy-route',
        label: 'Economy',
        provider: 'openclaw',
        model: 'default',
        gatewayProfileId: 'gateway-economy',
        role: 'economy',
      },
      {
        id: 'premium-route',
        label: 'Premium',
        provider: 'openai',
        model: 'gpt-5',
        role: 'premium',
      },
    ],
  })

  const preferred = resolveAgentRouteCandidatesWithProfiles(agent, gateways)
  assert.equal(preferred[0]?.id, 'economy-route')
  assert.equal(preferred[0]?.apiEndpoint, normalizeProviderEndpoint('openclaw', 'https://economy.example.com/v1'))

  const cooled = resolveAgentRouteCandidatesWithProfiles(agent, gateways, undefined, (providerId) => providerId === 'openclaw')
  assert.equal(cooled[0]?.id, 'base')
  assert.equal(cooled[0]?.provider, 'openai')
})

test('applyResolvedRoute copies gateway, endpoint, and fallback credentials onto a target session-like object', () => {
  const target = {
    provider: 'claude-cli' as const,
    model: 'claude-sonnet-4-5',
    credentialId: null,
    fallbackCredentialIds: [] as string[],
    apiEndpoint: null,
    gatewayProfileId: null,
  }

  const next = applyResolvedRoute(target, {
    id: 'route-1',
    label: 'Gateway route',
    provider: 'openclaw',
    model: 'default',
    credentialId: 'cred-1',
    fallbackCredentialIds: ['cred-2', 'cred-3'],
    apiEndpoint: 'https://gateway.example.com/v1',
    gatewayProfileId: 'gateway-1',
    priority: 0,
    source: 'routing-target',
  })

  assert.deepEqual(next, {
    provider: 'openclaw',
    model: 'default',
    credentialId: 'cred-1',
    fallbackCredentialIds: ['cred-2', 'cred-3'],
    apiEndpoint: 'https://gateway.example.com/v1',
    gatewayProfileId: 'gateway-1',
  })
})
