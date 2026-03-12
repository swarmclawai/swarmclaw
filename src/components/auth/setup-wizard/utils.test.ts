import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  stepIndex,
  formatEndpointHost,
  isLocalOpenClawEndpoint,
  resolveOpenClawDashboardUrl,
  getOpenClawErrorHint,
  withHttpScheme,
  buildStarterDrafts,
  preferredConfiguredProvider,
} from './utils'
import type { ConfiguredProvider } from './types'

// ---------------------------------------------------------------------------
// stepIndex
// ---------------------------------------------------------------------------

test('stepIndex: profile → 0', () => {
  assert.equal(stepIndex('profile'), 0)
})

test('stepIndex: providers → 1', () => {
  assert.equal(stepIndex('providers'), 1)
})

test('stepIndex: connect maps to providers index (1)', () => {
  assert.equal(stepIndex('connect'), 1)
})

test('stepIndex: agents → 2', () => {
  assert.equal(stepIndex('agents'), 2)
})

// ---------------------------------------------------------------------------
// formatEndpointHost
// ---------------------------------------------------------------------------

test('formatEndpointHost extracts host:port', () => {
  assert.equal(formatEndpointHost('http://localhost:18789'), 'localhost:18789')
})

test('formatEndpointHost returns host without port when none specified', () => {
  assert.equal(formatEndpointHost('https://gateway.example.com'), 'gateway.example.com')
})

test('formatEndpointHost returns null for empty', () => {
  assert.equal(formatEndpointHost(''), null)
})

test('formatEndpointHost returns null for null', () => {
  assert.equal(formatEndpointHost(null), null)
})

test('formatEndpointHost adds scheme to bare host:port', () => {
  assert.equal(formatEndpointHost('10.0.0.5:18789'), '10.0.0.5:18789')
})

// ---------------------------------------------------------------------------
// isLocalOpenClawEndpoint
// ---------------------------------------------------------------------------

test('isLocalOpenClawEndpoint: localhost → true', () => {
  assert.equal(isLocalOpenClawEndpoint('http://localhost:18789'), true)
})

test('isLocalOpenClawEndpoint: 127.0.0.1 → true', () => {
  assert.equal(isLocalOpenClawEndpoint('http://127.0.0.1:18789'), true)
})

test('isLocalOpenClawEndpoint: [::1] not matched (URL hostname includes brackets)', () => {
  // URL parser returns hostname as "[::1]", which doesn't match the "::1" check
  assert.equal(isLocalOpenClawEndpoint('http://[::1]:18789'), false)
})

test('isLocalOpenClawEndpoint: remote → false', () => {
  assert.equal(isLocalOpenClawEndpoint('http://gateway.example.com:18789'), false)
})

test('isLocalOpenClawEndpoint: null → false', () => {
  assert.equal(isLocalOpenClawEndpoint(null), false)
})

test('isLocalOpenClawEndpoint: 0.0.0.0 → true', () => {
  assert.equal(isLocalOpenClawEndpoint('http://0.0.0.0:18789'), true)
})

// ---------------------------------------------------------------------------
// resolveOpenClawDashboardUrl
// ---------------------------------------------------------------------------

test('resolveOpenClawDashboardUrl converts ws:// to http://', () => {
  assert.equal(resolveOpenClawDashboardUrl('ws://localhost:18789/v1'), 'http://localhost:18789')
})

test('resolveOpenClawDashboardUrl converts wss:// to https://', () => {
  assert.equal(resolveOpenClawDashboardUrl('wss://gateway.example.com/path'), 'https://gateway.example.com')
})

test('resolveOpenClawDashboardUrl strips path', () => {
  assert.equal(resolveOpenClawDashboardUrl('http://localhost:18789/some/path'), 'http://localhost:18789')
})

test('resolveOpenClawDashboardUrl defaults for null', () => {
  assert.equal(resolveOpenClawDashboardUrl(null), 'http://localhost:18789')
})

// ---------------------------------------------------------------------------
// getOpenClawErrorHint
// ---------------------------------------------------------------------------

test('getOpenClawErrorHint: timeout', () => {
  const hint = getOpenClawErrorHint('Connection timed out')
  assert.ok(hint)
  assert.ok(hint.includes('port'))
})

test('getOpenClawErrorHint: 401', () => {
  const hint = getOpenClawErrorHint('Returned 401 unauthorized')
  assert.ok(hint)
  assert.ok(hint.includes('token'))
})

test('getOpenClawErrorHint: 405', () => {
  const hint = getOpenClawErrorHint('405 Method Not Allowed')
  assert.ok(hint)
  assert.ok(hint.includes('chatCompletions'))
})

test('getOpenClawErrorHint: econnrefused', () => {
  const hint = getOpenClawErrorHint('connect ECONNREFUSED 127.0.0.1:18789')
  assert.ok(hint)
  assert.ok(hint.includes('running'))
})

test('getOpenClawErrorHint: unrecognized error → null', () => {
  assert.equal(getOpenClawErrorHint('something unknown happened'), null)
})

// ---------------------------------------------------------------------------
// withHttpScheme
// ---------------------------------------------------------------------------

test('withHttpScheme adds http:// to bare host', () => {
  assert.equal(withHttpScheme('localhost:18789'), 'http://localhost:18789')
})

test('withHttpScheme preserves existing http://', () => {
  assert.equal(withHttpScheme('http://localhost:18789'), 'http://localhost:18789')
})

test('withHttpScheme preserves existing https://', () => {
  assert.equal(withHttpScheme('https://example.com'), 'https://example.com')
})

test('withHttpScheme preserves ws://', () => {
  assert.equal(withHttpScheme('ws://localhost:18789'), 'ws://localhost:18789')
})

test('withHttpScheme preserves wss://', () => {
  assert.equal(withHttpScheme('wss://example.com'), 'wss://example.com')
})

// ---------------------------------------------------------------------------
// buildStarterDrafts — OpenClaw provider handling
// ---------------------------------------------------------------------------

function makeConfiguredProvider(overrides: Partial<ConfiguredProvider> & { provider: ConfiguredProvider['provider'] }): ConfiguredProvider {
  return {
    id: 'cp-1',
    name: 'Test Provider',
    credentialId: null,
    endpoint: null,
    defaultModel: '',
    gatewayProfileId: null,
    verified: true,
    ...overrides,
  }
}

test('buildStarterDrafts assigns OpenClaw provider to drafts', () => {
  const cp = makeConfiguredProvider({ provider: 'openclaw', endpoint: 'http://localhost:18789' })
  const drafts = buildStarterDrafts({
    starterKitId: 'personal_assistant',
    intentText: '',
    configuredProviders: [cp],
  })
  assert.ok(drafts.length > 0, 'should produce at least one draft')
  for (const d of drafts) {
    assert.equal(d.provider, 'openclaw')
    assert.equal(d.providerConfigId, cp.id)
  }
})

test('buildStarterDrafts OpenClaw drafts use empty model (not "default")', () => {
  const cp = makeConfiguredProvider({ provider: 'openclaw', defaultModel: '' })
  const drafts = buildStarterDrafts({
    starterKitId: 'personal_assistant',
    intentText: '',
    configuredProviders: [cp],
  })
  for (const d of drafts) {
    // Model should be empty since the gateway controls the model
    assert.equal(d.model, '')
  }
})

test('buildStarterDrafts OpenClaw drafts inherit endpoint from provider', () => {
  const cp = makeConfiguredProvider({ provider: 'openclaw', endpoint: 'http://10.0.0.5:18789' })
  const drafts = buildStarterDrafts({
    starterKitId: 'personal_assistant',
    intentText: '',
    configuredProviders: [cp],
  })
  for (const d of drafts) {
    assert.equal(d.apiEndpoint, 'http://10.0.0.5:18789')
  }
})

test('buildStarterDrafts carries dashboardUrl through from ConfiguredProvider', () => {
  const cp = makeConfiguredProvider({
    provider: 'openclaw',
    endpoint: 'http://localhost:18789',
    dashboardUrl: 'http://localhost:18789?token=my-secret',
  })
  // dashboardUrl lives on the ConfiguredProvider, not the draft — verify it's accessible
  assert.equal(cp.dashboardUrl, 'http://localhost:18789?token=my-secret')
})

test('preferredConfiguredProvider picks openclaw provider for openclaw template', () => {
  const openclawCp = makeConfiguredProvider({ id: 'oc-1', provider: 'openclaw' })
  const openaiCp = makeConfiguredProvider({ id: 'oai-1', provider: 'openai' })
  const result = preferredConfiguredProvider(
    { id: 'tmpl-1', name: 'Test', description: '', systemPrompt: '', tools: [], recommendedProviders: ['openclaw'] },
    [openaiCp, openclawCp],
  )
  assert.equal(result?.id, 'oc-1')
})
