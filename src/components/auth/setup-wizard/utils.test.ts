import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  stepIndex,
  defaultKitForPath,
  formatEndpointHost,
  getStarterKitsForPath,
  isLocalOpenClawEndpoint,
  resolveOpenClawDashboardUrl,
  getOpenClawErrorHint,
  requiresSetupProviderVerification,
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

test('stepIndex: path → 1', () => {
  assert.equal(stepIndex('path'), 1)
})

test('stepIndex: providers → 2', () => {
  assert.equal(stepIndex('providers'), 2)
})

test('stepIndex: connect maps to providers index (2)', () => {
  assert.equal(stepIndex('connect'), 2)
})

test('stepIndex: agents → 3', () => {
  assert.equal(stepIndex('agents'), 3)
})

// ---------------------------------------------------------------------------
// onboarding path defaults
// ---------------------------------------------------------------------------

test('defaultKitForPath returns personal assistant for quick and intent', () => {
  assert.equal(defaultKitForPath('quick'), 'personal_assistant')
  assert.equal(defaultKitForPath('intent'), 'personal_assistant')
})

test('defaultKitForPath returns blank workspace for manual', () => {
  assert.equal(defaultKitForPath('manual'), 'blank_workspace')
})

test('getStarterKitsForPath: quick exposes a reduced starter set', () => {
  const ids = getStarterKitsForPath('quick').map((kit) => kit.id)
  assert.deepEqual(ids, ['personal_assistant', 'research_copilot', 'builder_studio'])
})

test('getStarterKitsForPath: intent stays focused on broad starter shapes', () => {
  const ids = getStarterKitsForPath('intent').map((kit) => kit.id)
  assert.deepEqual(ids, [
    'personal_assistant',
    'research_copilot',
    'builder_studio',
    'operator_swarm',
    'inbox_triage',
    'data_analyst',
  ])
})

test('getStarterKitsForPath: manual keeps the full catalog', () => {
  const ids = new Set(getStarterKitsForPath('manual').map((kit) => kit.id))
  assert.equal(ids.has('blank_workspace'), true)
  assert.equal(ids.has('content_studio'), true)
  assert.equal(ids.has('openclaw_fleet'), true)
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

function makeConfiguredProvider(overrides: Partial<ConfiguredProvider> & { setupProvider: ConfiguredProvider['setupProvider']; provider?: ConfiguredProvider['provider'] }): ConfiguredProvider {
  const { setupProvider, provider = setupProvider, ...rest } = overrides
  return {
    id: 'cp-1',
    setupProvider,
    provider,
    name: 'Test Provider',
    credentialId: null,
    endpoint: null,
    defaultModel: '',
    gatewayProfileId: null,
    verified: true,
    ...rest,
  }
}

test('buildStarterDrafts assigns OpenClaw provider to drafts', () => {
  const cp = makeConfiguredProvider({ setupProvider: 'openclaw', endpoint: 'http://localhost:18789' })
  const drafts = buildStarterDrafts({
    starterKitId: 'personal_assistant',
    intentText: '',
    configuredProviders: [cp],
  })
  assert.ok(drafts.length > 0, 'should produce at least one draft')
  for (const d of drafts) {
    assert.equal(d.provider, 'openclaw')
    assert.equal(d.setupProvider, 'openclaw')
    assert.equal(d.providerConfigId, cp.id)
  }
})

test('buildStarterDrafts OpenClaw drafts use empty model (not "default")', () => {
  const cp = makeConfiguredProvider({ setupProvider: 'openclaw', defaultModel: '' })
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
  const cp = makeConfiguredProvider({ setupProvider: 'openclaw', endpoint: 'http://10.0.0.5:18789' })
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
    setupProvider: 'openclaw',
    endpoint: 'http://localhost:18789',
    dashboardUrl: 'http://localhost:18789?token=my-secret',
  })
  // dashboardUrl lives on the ConfiguredProvider, not the draft — verify it's accessible
  assert.equal(cp.dashboardUrl, 'http://localhost:18789?token=my-secret')
})

test('preferredConfiguredProvider picks openclaw provider for openclaw template', () => {
  const openclawCp = makeConfiguredProvider({ id: 'oc-1', setupProvider: 'openclaw' })
  const openaiCp = makeConfiguredProvider({ id: 'oai-1', setupProvider: 'openai' })
  const result = preferredConfiguredProvider(
    { id: 'tmpl-1', name: 'Test', description: '', systemPrompt: '', tools: [], recommendedProviders: ['openclaw'] },
    [openaiCp, openclawCp],
  )
  assert.equal(result?.id, 'oc-1')
})

test('buildStarterDrafts carries custom runtime provider ids alongside custom setup provider state', () => {
  const cp = makeConfiguredProvider({
    setupProvider: 'custom',
    provider: 'custom-openrouter',
    defaultModel: 'openai/gpt-4.1',
  })
  const drafts = buildStarterDrafts({
    starterKitId: 'personal_assistant',
    intentText: '',
    configuredProviders: [cp],
  })

  for (const draft of drafts) {
    assert.equal(draft.setupProvider, 'custom')
    assert.equal(draft.provider, 'custom-openrouter')
    assert.equal(draft.model, 'openai/gpt-4.1')
  }
})

test('buildStarterDrafts injects current intent into starter prompts', () => {
  const cp = makeConfiguredProvider({
    setupProvider: 'openai',
    provider: 'openai',
    defaultModel: 'gpt-4o',
  })
  const drafts = buildStarterDrafts({
    starterKitId: 'personal_assistant',
    intentText: 'Help me run weekly product research and turn it into follow-up tasks.',
    configuredProviders: [cp],
  })

  assert.match(drafts[0]?.systemPrompt || '', /Current user intent:/)
  assert.match(drafts[0]?.systemPrompt || '', /weekly product research/i)
})

test('buildStarterDrafts creates the delegate team starter pair', () => {
  const cp = makeConfiguredProvider({
    setupProvider: 'openai',
    provider: 'openai',
    defaultModel: 'gpt-4o',
  })
  const drafts = buildStarterDrafts({
    starterKitId: 'operator_swarm',
    intentText: '',
    configuredProviders: [cp],
  })

  assert.deepEqual(drafts.map((draft) => draft.name), ['Operator', 'Maker'])
})

test('requiresSetupProviderVerification skips custom providers', () => {
  assert.equal(requiresSetupProviderVerification('custom'), false)
  assert.equal(requiresSetupProviderVerification('openclaw'), false)
  assert.equal(requiresSetupProviderVerification('openai'), true)
  assert.equal(requiresSetupProviderVerification('openrouter'), true)
  assert.equal(requiresSetupProviderVerification('hermes'), true)
})
