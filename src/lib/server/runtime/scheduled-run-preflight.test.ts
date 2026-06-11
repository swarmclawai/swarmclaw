import test from 'node:test'
import assert from 'node:assert/strict'

import {
  preflightProviderCredential,
  type ProviderCredentialPreflightDeps,
} from './scheduled-run-preflight'

function makeDeps(overrides: Partial<ProviderCredentialPreflightDeps> = {}): ProviderCredentialPreflightDeps {
  return {
    getProvider: () => ({ requiresApiKey: true }),
    resolveProviderCredentialId: (input) => input.credentialId || null,
    resolveCredentialSecret: () => null,
    ...overrides,
  }
}

test('passes when the provider does not require an API key', () => {
  const result = preflightProviderCredential(
    { provider: 'ollama' },
    makeDeps({ getProvider: () => ({ requiresApiKey: false }) }),
  )
  assert.deepEqual(result, { ok: true })
})

test('passes when the provider is unknown', () => {
  const result = preflightProviderCredential(
    { provider: 'mystery' },
    makeDeps({ getProvider: () => null }),
  )
  assert.deepEqual(result, { ok: true })
})

test('passes when no provider is set', () => {
  assert.deepEqual(preflightProviderCredential({ provider: '' }, makeDeps()), { ok: true })
})

test('passes when the resolved credential has a secret', () => {
  const result = preflightProviderCredential(
    { provider: 'openai', credentialId: 'cred-1' },
    makeDeps({ resolveCredentialSecret: (id) => (id === 'cred-1' ? 'sk-test' : null) }),
  )
  assert.deepEqual(result, { ok: true })
})

test('passes when a fallback credential rescues a dead primary', () => {
  const result = preflightProviderCredential(
    { provider: 'openai', credentialId: 'cred-dead', fallbackCredentialIds: ['cred-live'] },
    makeDeps({ resolveCredentialSecret: (id) => (id === 'cred-live' ? 'sk-test' : null) }),
  )
  assert.deepEqual(result, { ok: true })
})

test('passes when auto-matching finds another credential for the provider', () => {
  const result = preflightProviderCredential(
    { provider: 'openai', credentialId: 'cred-dead' },
    makeDeps({
      resolveProviderCredentialId: (input) => (input.credentialId ? input.credentialId : 'cred-auto'),
      resolveCredentialSecret: (id) => (id === 'cred-auto' ? 'sk-test' : null),
    }),
  )
  assert.deepEqual(result, { ok: true })
})

test('fails with an actionable error naming the provider when nothing resolves', () => {
  const result = preflightProviderCredential({ provider: 'openai', credentialId: 'cred-dead' }, makeDeps())
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /Provider authentication preflight failed/)
    assert.match(result.error, /"openai"/)
    assert.match(result.error, /Settings/)
  }
})
