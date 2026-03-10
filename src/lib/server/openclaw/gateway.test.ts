import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { Agent, GatewayProfile } from '@/types'
import {
  encryptKey,
  loadAgents,
  loadCredentials,
  loadGatewayProfiles,
  saveAgents,
  saveCredentials,
  saveGatewayProfiles,
} from '../storage'
import { resolveGatewayConfig } from './gateway'

const originalCredentials = loadCredentials()
const originalGateways = loadGatewayProfiles()
const originalAgents = loadAgents({ includeTrashed: true })

afterEach(() => {
  saveCredentials(originalCredentials)
  saveGatewayProfiles(originalGateways)
  saveAgents(originalAgents)
})

function saveGatewayCredential(id: string, token: string) {
  const credentials = loadCredentials()
  credentials[id] = {
    id,
    provider: 'openclaw',
    name: `Credential ${id}`,
    encryptedKey: encryptKey(token),
    createdAt: Date.now(),
  }
  saveCredentials(credentials)
}

function saveGatewayProfile(profile: GatewayProfile) {
  const gateways = loadGatewayProfiles()
  gateways[profile.id] = profile
  saveGatewayProfiles(gateways)
}

test('resolveGatewayConfig uses the gateway profile wsUrl and decrypted token', () => {
  saveGatewayCredential('openclaw-cred-1', 'gateway-token-1')
  saveGatewayProfile({
    id: 'gateway-profile-1',
    name: 'Gateway 1',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:19161/v1',
    wsUrl: 'ws://127.0.0.1:19161',
    credentialId: 'openclaw-cred-1',
    status: 'healthy',
    notes: null,
    tags: ['smoke'],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: '127.0.0.1',
    discoveredPort: 19161,
    deployment: null,
    stats: null,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const resolved = resolveGatewayConfig({ profileId: 'gateway-profile-1' })
  assert.deepEqual(resolved, {
    key: 'profile:gateway-profile-1',
    profileId: 'gateway-profile-1',
    wsUrl: 'ws://127.0.0.1:19161',
    token: 'gateway-token-1',
  })
})

test('resolveGatewayConfig follows an OpenClaw agent route back to its gateway profile credential', () => {
  saveGatewayCredential('openclaw-cred-2', 'gateway-token-2')
  saveGatewayProfile({
    id: 'gateway-profile-2',
    name: 'Gateway 2',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:19181/v1',
    wsUrl: 'ws://127.0.0.1:19181',
    credentialId: 'openclaw-cred-2',
    status: 'healthy',
    notes: null,
    tags: ['smoke'],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: '127.0.0.1',
    discoveredPort: 19181,
    deployment: {
      method: 'local',
      managedBy: 'swarmclaw',
      useCase: 'local-dev',
      localInstanceId: 'smoke-app-b',
      localPort: 19181,
    },
    stats: null,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const agents = loadAgents({ includeTrashed: true })
  agents['openclaw-agent-1'] = {
    id: 'openclaw-agent-1',
    name: 'Gateway Agent',
    description: '',
    systemPrompt: '',
    provider: 'openclaw',
    model: 'default',
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: null,
    gatewayProfileId: 'gateway-profile-2',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
  saveAgents(agents)

  const resolved = resolveGatewayConfig({ agentId: 'openclaw-agent-1' })
  assert.deepEqual(resolved, {
    key: 'profile:gateway-profile-2',
    profileId: 'gateway-profile-2',
    wsUrl: 'ws://127.0.0.1:19181',
    token: 'gateway-token-2',
  })
})
