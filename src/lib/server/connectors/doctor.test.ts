import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connector } from '@/types'
import { buildConnectorDoctorPreview, buildConnectorDoctorReport } from './doctor'

test('buildConnectorDoctorPreview merges overrides onto an existing connector', () => {
  const base: Connector = {
    id: 'connector-1',
    name: 'Existing Connector',
    platform: 'slack',
    agentId: 'agent-1',
    chatroomId: null,
    credentialId: 'cred-1',
    config: { replyMode: 'first', threadBinding: 'prefer' },
    isEnabled: true,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  }

  const preview = buildConnectorDoctorPreview({
    baseConnector: base,
    input: {
      name: 'Preview Connector',
      agentId: null,
      chatroomId: 'chatroom-9',
      config: { replyMode: 'off', sessionScope: 'main' },
    },
  })

  assert.equal(preview.name, 'Preview Connector')
  assert.equal(preview.agentId, null)
  assert.equal(preview.chatroomId, 'chatroom-9')
  assert.deepEqual(preview.config, { replyMode: 'off', sessionScope: 'main' })
})

test('buildConnectorDoctorReport returns effective warnings and policy for preview connectors', () => {
  const connector = buildConnectorDoctorPreview({
    input: {
      platform: 'telegram',
      config: {
        sessionScope: 'main',
        replyMode: 'off',
        threadBinding: 'off',
        idleTimeoutSec: '0',
        maxAgeSec: '0',
      },
    },
  })

  const report = buildConnectorDoctorReport(connector)

  assert.equal(report.policy.scope, 'main')
  assert.equal(report.policy.replyMode, 'off')
  assert.ok(report.warnings.some((item) => item.includes('blend unrelated connector conversations')))
  assert.ok(report.warnings.some((item) => item.includes('freshness reset is disabled')))
})

test('buildConnectorDoctorReport includes runtime warning for stopped existing connectors', () => {
  const connector = buildConnectorDoctorPreview({
    baseConnector: {
      id: 'connector-2',
      name: 'Existing Connector',
      platform: 'slack',
      agentId: 'agent-1',
      chatroomId: null,
      credentialId: 'cred-1',
      config: {},
      isEnabled: true,
      status: 'stopped',
      createdAt: 1,
      updatedAt: 1,
    },
    input: {},
  })

  const report = buildConnectorDoctorReport(connector, null, { baseConnector: connector })

  assert.ok(report.warnings.some((item) => item.includes('not currently connected')))
})
