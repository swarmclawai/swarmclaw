import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_AGENTS, getDefaultModelForProvider } from './setup-defaults'

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

test('getDefaultModelForProvider returns non-empty for anthropic', () => {
  const model = getDefaultModelForProvider('anthropic')
  assert.ok(model, 'anthropic model should be truthy')
})

test('getDefaultModelForProvider returns non-empty for ollama', () => {
  const model = getDefaultModelForProvider('ollama')
  assert.ok(model, 'ollama model should be truthy')
})

test('custom provider default model is empty (like openclaw)', () => {
  assert.equal(DEFAULT_AGENTS.custom.model, '')
})
