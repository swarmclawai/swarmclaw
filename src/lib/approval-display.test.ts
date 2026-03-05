import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getApprovalTitle, getApprovalPayload, getApprovalPluginId } from './approval-display'
import type { ApprovalRequest } from '@/types'

function req(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'a1',
    category: 'tool_access',
    title: 'Enable Plugin: undefined',
    data: {},
    createdAt: 1,
    updatedAt: 1,
    status: 'pending',
    ...overrides,
  }
}

describe('approval display helpers', () => {
  it('normalizes plugin title from toolId/pluginId', () => {
    const approval = req({ data: { toolId: 'wikipedia' } })
    assert.equal(getApprovalPluginId(approval), 'wikipedia')
    assert.equal(getApprovalTitle(approval), 'Enable Plugin: wikipedia')
  })

  it('falls back with warning when plugin id is missing', () => {
    const approval = req({ data: {} })
    const payload = getApprovalPayload(approval)
    assert.equal(getApprovalTitle(approval), 'Enable Plugin')
    assert.equal(payload.warning, 'Missing plugin/tool identifier')
  })

  it('summarizes scaffold payload without dumping full code', () => {
    const approval = req({
      category: 'plugin_scaffold',
      title: 'Scaffold Plugin',
      data: { filename: 'wiki.js', code: 'x'.repeat(400) },
    })
    const payload = getApprovalPayload(approval)
    assert.equal(payload.filename, 'wiki.js')
    assert.equal(payload.codeLength, 400)
    assert.equal(typeof payload.codePreview, 'string')
    assert.ok(String(payload.codePreview).includes('(400 chars)'))
  })
})
