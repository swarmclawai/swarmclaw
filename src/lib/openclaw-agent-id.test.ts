import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildOpenClawMainSessionKey, normalizeOpenClawAgentId } from './openclaw-agent-id'

test('normalizeOpenClawAgentId mirrors gateway-style normalization', () => {
  assert.equal(normalizeOpenClawAgentId('OpenClaw Ops'), 'openclaw-ops')
  assert.equal(normalizeOpenClawAgentId('  Agent / Research  '), 'agent-research')
  assert.equal(normalizeOpenClawAgentId('main'), 'main')
})

test('buildOpenClawMainSessionKey uses normalized OpenClaw agent ids', () => {
  assert.equal(buildOpenClawMainSessionKey('OpenClaw Ops'), 'agent:openclaw-ops:main')
  assert.equal(buildOpenClawMainSessionKey('   '), null)
})
