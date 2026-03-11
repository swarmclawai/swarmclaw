import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_AGENT_SANDBOX_CONFIG,
  normalizeAgentSandboxConfig,
} from '@/lib/agent-sandbox-defaults'

test('normalizeAgentSandboxConfig enables sandbox defaults when config is missing', () => {
  const normalized = normalizeAgentSandboxConfig(undefined)

  assert.equal(normalized.enabled, true)
  assert.equal(normalized.mode, 'all')
  assert.equal(normalized.network, 'bridge')
  assert.equal(normalized.browser?.enabled, true)
})

test('normalizeAgentSandboxConfig preserves an explicit disabled sandbox', () => {
  const normalized = normalizeAgentSandboxConfig({ enabled: false })

  assert.equal(normalized.enabled, false)
  assert.equal(normalized.mode, DEFAULT_AGENT_SANDBOX_CONFIG.mode)
  assert.equal(normalized.browser?.enabled, true)
})

test('normalizeAgentSandboxConfig merges partial browser overrides onto defaults', () => {
  const normalized = normalizeAgentSandboxConfig({
    enabled: true,
    browser: {
      enabled: false,
      noVncPort: 7000,
    },
  })

  assert.equal(normalized.browser?.enabled, false)
  assert.equal(normalized.browser?.noVncPort, 7000)
  assert.equal(normalized.browser?.image, DEFAULT_AGENT_SANDBOX_CONFIG.browser?.image)
})
