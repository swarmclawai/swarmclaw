import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveConcreteToolPolicyBlock,
  resolveSessionToolPolicy,
} from './tool-capability-policy.ts'

test('capability policy permissive mode allows non-blocked tools', () => {
  const decision = resolveSessionToolPolicy(['shell', 'web_search'], { capabilityPolicyMode: 'permissive' })
  assert.deepEqual(decision.enabledPlugins, ['shell', 'web_search'])
  assert.equal(decision.blockedPlugins.length, 0)
})

test('capability policy balanced mode blocks destructive delete_file', () => {
  const decision = resolveSessionToolPolicy(['files', 'delete_file'], { capabilityPolicyMode: 'balanced' })
  assert.deepEqual(decision.enabledPlugins, ['files'])
  assert.equal(decision.blockedPlugins.length, 1)
  assert.equal(decision.blockedPlugins[0].tool, 'delete_file')
})

test('capability policy strict mode blocks execution/platform families', () => {
  const decision = resolveSessionToolPolicy(
    ['shell', 'manage_tasks', 'web_search', 'memory'],
    { capabilityPolicyMode: 'strict' },
  )
  assert.deepEqual(decision.enabledPlugins, ['web_search', 'memory'])
  assert.equal(decision.blockedPlugins.some((entry) => entry.tool === 'shell'), true)
  assert.equal(decision.blockedPlugins.some((entry) => entry.tool === 'manage_tasks'), true)
})

test('capability policy respects explicit allow overrides', () => {
  const decision = resolveSessionToolPolicy(
    ['shell', 'web_search'],
    {
      capabilityPolicyMode: 'strict',
      capabilityAllowedTools: ['shell'],
    },
  )
  assert.deepEqual(decision.enabledPlugins, ['shell', 'web_search'])
})

test('concrete tool checks inherit blocked family rules', () => {
  const decision = resolveSessionToolPolicy(
    ['claude_code', 'codex_cli'],
    {
      safetyBlockedTools: ['delegate_to_codex_cli'],
    },
  )

  assert.equal(
    resolveConcreteToolPolicyBlock('delegate_to_codex_cli', decision, { safetyBlockedTools: ['delegate_to_codex_cli'] }),
    'blocked by safety policy',
  )
  assert.equal(
    resolveConcreteToolPolicyBlock('delegate_to_claude_code', decision, { safetyBlockedTools: ['delegate_to_codex_cli'] }),
    null,
  )
})
