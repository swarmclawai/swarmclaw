import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { persistGatewayHealthResult } from '@/lib/server/openclaw/health'
import { loadGatewayProfiles, saveGatewayProfiles } from '@/lib/server/storage'

const originalGateways = loadGatewayProfiles()

afterEach(() => {
  saveGatewayProfiles(originalGateways)
})

test('persistGatewayHealthResult stores healthy verification details', () => {
  const gateways = loadGatewayProfiles()
  gateways['gateway-health-test'] = {
    id: 'gateway-health-test',
    name: 'Gateway Health Test',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:18789/v1',
    wsUrl: 'ws://127.0.0.1:18789',
    credentialId: 'credential-1',
    status: 'unknown',
    notes: null,
    tags: ['smoke'],
    lastError: 'previous error',
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: '127.0.0.1',
    discoveredPort: 18789,
    deployment: {
      method: 'imported',
      useCase: 'single-vps',
    },
    stats: null,
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  }
  saveGatewayProfiles(gateways)

  const now = 1_777_777_777_000
  const updated = persistGatewayHealthResult('gateway-health-test', {
    ok: true,
    endpoint: 'http://127.0.0.1:18789/v1',
    wsUrl: 'ws://127.0.0.1:18789',
    wsConnected: true,
    httpCompatible: true,
    authProvided: true,
    model: 'default',
    models: ['default', 'glm-5:cloud'],
    modelsStatus: 200,
    chatStatus: 200,
    message: 'Gateway verified successfully.',
  }, now)

  const saved = loadGatewayProfiles()['gateway-health-test']
  assert.ok(updated)
  assert.equal(saved.status, 'healthy')
  assert.equal(saved.lastCheckedAt, now)
  assert.equal(saved.lastError, null)
  assert.equal(saved.lastModelCount, 2)
  assert.equal(saved.updatedAt, now)
  assert.equal(saved.deployment?.method, 'imported')
  assert.equal(saved.deployment?.lastVerifiedAt, now)
  assert.equal(saved.deployment?.lastVerifiedOk, true)
  assert.equal(saved.deployment?.lastVerifiedMessage, 'Gateway verified successfully.')
})

test('persistGatewayHealthResult stores degraded/offline failures with the right message', () => {
  const gateways = loadGatewayProfiles()
  gateways['gateway-health-failure-test'] = {
    id: 'gateway-health-failure-test',
    name: 'Gateway Health Failure Test',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:18888/v1',
    wsUrl: 'ws://127.0.0.1:18888',
    credentialId: null,
    status: 'unknown',
    notes: null,
    tags: [],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: '127.0.0.1',
    discoveredPort: 18888,
    deployment: null,
    stats: null,
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  }
  saveGatewayProfiles(gateways)

  const degraded = persistGatewayHealthResult('gateway-health-failure-test', {
    ok: false,
    endpoint: 'http://127.0.0.1:18888/v1',
    wsUrl: 'ws://127.0.0.1:18888',
    wsConnected: false,
    httpCompatible: null,
    authProvided: true,
    model: null,
    models: [],
    modelsStatus: null,
    chatStatus: null,
    message: 'ignored',
    error: 'Token rejected.',
  }, 2_000)
  assert.ok(degraded)
  let saved = loadGatewayProfiles()['gateway-health-failure-test']
  assert.equal(saved.status, 'degraded')
  assert.equal(saved.lastError, 'Token rejected.')
  assert.equal(saved.deployment?.lastVerifiedOk, false)
  assert.equal(saved.deployment?.lastVerifiedMessage, 'Token rejected.')

  const offline = persistGatewayHealthResult('gateway-health-failure-test', {
    ok: false,
    endpoint: 'http://127.0.0.1:18888/v1',
    wsUrl: 'ws://127.0.0.1:18888',
    wsConnected: false,
    httpCompatible: null,
    authProvided: false,
    model: null,
    models: [],
    modelsStatus: null,
    chatStatus: null,
    message: 'ignored',
    hint: 'Gateway unreachable.',
  }, 3_000)
  assert.ok(offline)
  saved = loadGatewayProfiles()['gateway-health-failure-test']
  assert.equal(saved.status, 'offline')
  assert.equal(saved.lastError, 'Gateway unreachable.')
  assert.equal(saved.deployment?.lastVerifiedOk, false)
  assert.equal(saved.deployment?.lastVerifiedMessage, 'Gateway unreachable.')
})
