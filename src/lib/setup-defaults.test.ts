import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLI_PROVIDER_METADATA } from './providers/cli-provider-metadata'
import { DEFAULT_AGENTS, SETUP_PROVIDERS, getDefaultModelForProvider } from './setup-defaults'

// ---------------------------------------------------------------------------
// OpenClaw default model is empty (not 'default')
// ---------------------------------------------------------------------------

test('OpenClaw default agent model is empty string', () => {
  assert.equal(DEFAULT_AGENTS.openclaw.model, '')
})

test('getDefaultModelForProvider returns empty for openclaw', () => {
  assert.equal(getDefaultModelForProvider('openclaw'), '')
})

test('OpenClaw default model is falsy so UI does not render a suggested model', () => {
  assert.ok(!DEFAULT_AGENTS.openclaw.model, 'model should be falsy')
})

// ---------------------------------------------------------------------------
// Other providers still have their expected models
// ---------------------------------------------------------------------------

test('getDefaultModelForProvider returns non-empty for openai', () => {
  const model = getDefaultModelForProvider('openai')
  assert.ok(model, 'openai model should be truthy')
})

test('getDefaultModelForProvider returns non-empty for openrouter', () => {
  const model = getDefaultModelForProvider('openrouter')
  assert.ok(model, 'openrouter model should be truthy')
})

test('TokenMix has setup metadata and a default agent model', () => {
  const provider = SETUP_PROVIDERS.find((candidate) => candidate.id === 'tokenmix')
  assert.ok(provider, 'tokenmix should appear in setup providers')
  assert.equal(provider.defaultEndpoint, 'https://api.tokenmix.ai/v1')
  assert.equal(provider.supportsEndpoint, false)
  assert.equal(provider.requiresKey, true)
  assert.equal(getDefaultModelForProvider('tokenmix'), 'claude-sonnet-4-6')
})

test('getDefaultModelForProvider returns non-empty for anthropic', () => {
  const model = getDefaultModelForProvider('anthropic')
  assert.ok(model, 'anthropic model should be truthy')
})

test('getDefaultModelForProvider returns non-empty for hermes', () => {
  const model = getDefaultModelForProvider('hermes')
  assert.ok(model, 'hermes model should be truthy')
})

test('getDefaultModelForProvider returns expected defaults for cursor, qwen, and goose', () => {
  assert.equal(getDefaultModelForProvider('cursor-cli'), 'auto')
  assert.equal(getDefaultModelForProvider('qwen-code-cli'), 'default')
  assert.equal(getDefaultModelForProvider('goose'), 'default')
})

test('every CLI provider has setup default agent coverage', () => {
  for (const provider of CLI_PROVIDER_METADATA) {
    assert.equal(getDefaultModelForProvider(provider.id), provider.defaultModel)
    assert.ok(DEFAULT_AGENTS[provider.id].description.includes(provider.displayName))
  }
})

test('getDefaultModelForProvider returns non-empty for ollama', () => {
  const model = getDefaultModelForProvider('ollama')
  assert.ok(model, 'ollama model should be truthy')
})

test('custom provider default model is empty (like openclaw)', () => {
  assert.equal(DEFAULT_AGENTS.custom.model, '')
})
