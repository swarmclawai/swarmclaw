import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let approvals: typeof import('./approvals')
let storage: typeof import('./storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-approvals-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  storage = await import('./storage')
  approvals = await import('./approvals')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('approvals', () => {
  // ---- requestApproval ----

  it('creates a pending approval with correct fields', () => {
    const result = approvals.requestApproval({
      category: 'tool_access',
      title: 'Enable web',
      data: { toolId: 'web' },
      agentId: 'agent-1',
      sessionId: 'session-1',
    })

    assert.equal(result.status, 'pending')
    assert.equal(result.category, 'tool_access')
    assert.equal(result.agentId, 'agent-1')
    assert.equal(result.sessionId, 'session-1')
    assert.ok(result.id.length > 0)
    assert.ok(result.createdAt > 0)
    assert.equal(result.createdAt, result.updatedAt)
  })

  it('normalizes tool_access title to "Enable Plugin: <id>"', () => {
    const result = approvals.requestApproval({
      category: 'tool_access',
      title: 'Whatever title',
      data: { toolId: 'shell' },
    })
    assert.equal(result.title, 'Enable Plugin: shell')
  })

  it('copies toolId to both toolId and pluginId for tool_access', () => {
    const result = approvals.requestApproval({
      category: 'tool_access',
      title: 'test',
      data: { toolId: 'browser' },
    })
    assert.equal(result.data.toolId, 'browser')
    assert.equal(result.data.pluginId, 'browser')
  })

  it('throws when tool_access has no toolId or pluginId', () => {
    assert.throws(() => {
      approvals.requestApproval({
        category: 'tool_access',
        title: 'bad',
        data: {},
      })
    }, /toolId or pluginId/)
  })

  it('allows non-tool_access categories without toolId', () => {
    const result = approvals.requestApproval({
      category: 'wallet_transfer',
      title: 'Send 1 SOL',
      data: { toAddress: 'abc', amountSol: 1 },
    })
    assert.equal(result.status, 'pending')
    assert.equal(result.category, 'wallet_transfer')
  })

  // ---- listAutoApprovableApprovalCategories ----

  it('returns a copy of auto-approvable categories', () => {
    const cats = approvals.listAutoApprovableApprovalCategories()
    assert.ok(cats.includes('tool_access'))
    assert.ok(cats.includes('wallet_transfer'))
    assert.ok(cats.includes('connector_sender'))
    // Mutating the returned array shouldn't affect future calls
    cats.push('fake' as never)
    const cats2 = approvals.listAutoApprovableApprovalCategories()
    assert.ok(!cats2.includes('fake' as never))
  })

  // ---- isApprovalCategoryAutoApproved ----

  it('returns false when no auto-approve categories configured', () => {
    assert.equal(approvals.isApprovalCategoryAutoApproved('tool_access'), false)
  })

  it('returns true when category is in the auto-approve list', () => {
    // Configure auto-approve categories in settings
    const settings = storage.loadSettings()
    settings.approvalAutoApproveCategories = ['tool_access', 'wallet_transfer']
    storage.saveSettings(settings)

    assert.equal(approvals.isApprovalCategoryAutoApproved('tool_access'), true)
    assert.equal(approvals.isApprovalCategoryAutoApproved('wallet_transfer'), true)
    assert.equal(approvals.isApprovalCategoryAutoApproved('plugin_scaffold'), false)

    // Clean up
    settings.approvalAutoApproveCategories = []
    storage.saveSettings(settings)
  })

  // ---- listPendingApprovals ----

  it('lists only pending approvals sorted by updatedAt desc', () => {
    // Create several approvals
    const a1 = approvals.requestApproval({
      category: 'tool_access',
      title: 'A',
      data: { toolId: 'a1tool' },
    })
    const a2 = approvals.requestApproval({
      category: 'tool_access',
      title: 'B',
      data: { toolId: 'a2tool' },
    })

    const pending = approvals.listPendingApprovals()
    const ids = pending.map((p) => p.id)
    assert.ok(ids.includes(a1.id))
    assert.ok(ids.includes(a2.id))
    // All returned should be pending
    for (const p of pending) {
      assert.equal(p.status, 'pending')
    }
    // Sorted desc by updatedAt
    for (let i = 1; i < pending.length; i++) {
      assert.ok(pending[i - 1].updatedAt >= pending[i].updatedAt)
    }
  })

  // ---- submitDecision ----

  it('approves a pending request', async () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Confirm deployment',
      data: { question: 'Deploy to prod?' },
      sessionId: null,
      agentId: null,
    })
    assert.equal(req.status, 'pending')

    await approvals.submitDecision(req.id, true)

    // Check it's no longer pending
    const pending = approvals.listPendingApprovals()
    assert.ok(!pending.some((p) => p.id === req.id))
  })

  it('rejects a pending request', async () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Confirm deletion',
      data: { question: 'Delete everything?' },
      sessionId: null,
      agentId: null,
    })

    await approvals.submitDecision(req.id, false)

    const pending = approvals.listPendingApprovals()
    assert.ok(!pending.some((p) => p.id === req.id))
  })

  it('throws for non-existent approval id', async () => {
    await assert.rejects(
      () => approvals.submitDecision('nonexistent-xyz', true),
      /not found/i,
    )
  })

  it('is idempotent — approving an already-approved request is a no-op', async () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Idempotent test',
      data: { question: 'yes?' },
    })
    await approvals.submitDecision(req.id, true)
    // Should not throw
    await approvals.submitDecision(req.id, true)
  })

  // ---- requestApprovalMaybeAutoApprove ----

  it('auto-approves when approvalsEnabled is false', async () => {
    const settings = storage.loadSettings()
    settings.approvalsEnabled = false
    storage.saveSettings(settings)

    const result = await approvals.requestApprovalMaybeAutoApprove({
      category: 'tool_access',
      title: 'Auto test',
      data: { toolId: 'auto_tool_1' },
    })
    assert.equal(result.status, 'approved')

    settings.approvalsEnabled = true
    storage.saveSettings(settings)
  })

  it('auto-approves when category is in auto-approve list', async () => {
    const settings = storage.loadSettings()
    settings.approvalAutoApproveCategories = ['wallet_transfer']
    storage.saveSettings(settings)

    const result = await approvals.requestApprovalMaybeAutoApprove({
      category: 'wallet_transfer',
      title: 'Auto transfer',
      data: { toAddress: 'xyz_auto', amountSol: 0.5 },
    })
    assert.equal(result.status, 'approved')

    settings.approvalAutoApproveCategories = []
    storage.saveSettings(settings)
  })

  it('stays pending when approvals enabled and category not auto-approved', async () => {
    const settings = storage.loadSettings()
    settings.approvalsEnabled = true
    settings.approvalAutoApproveCategories = []
    storage.saveSettings(settings)

    const result = await approvals.requestApprovalMaybeAutoApprove({
      category: 'plugin_scaffold',
      title: 'Manual scaffold',
      data: { filename: 'test.js', code: 'module.exports = {}' },
    })
    assert.equal(result.status, 'pending')
  })

  // ---- markApprovalConnectorNotificationAttempt / Sent ----

  it('records connector notification attempt', () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Notify test',
      data: { question: 'hello?' },
    })

    const updated = approvals.markApprovalConnectorNotificationAttempt(req.id, {
      at: 1000,
      connectorId: 'conn-1',
      channelId: 'ch-1',
    })
    assert.ok(updated)
    assert.equal(updated!.connectorNotification?.attemptedAt, 1000)
    assert.equal(updated!.connectorNotification?.connectorId, 'conn-1')
    assert.equal(updated!.connectorNotification?.sentAt, undefined)
  })

  it('records connector notification sent', () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Sent test',
      data: { question: 'done?' },
    })

    const updated = approvals.markApprovalConnectorNotificationSent(req.id, {
      at: 2000,
      connectorId: 'conn-2',
      channelId: 'ch-2',
      messageId: 'msg-123',
    })
    assert.ok(updated)
    assert.equal(updated!.connectorNotification?.sentAt, 2000)
    assert.equal(updated!.connectorNotification?.connectorId, 'conn-2')
    assert.equal(updated!.connectorNotification?.messageId, 'msg-123')
    assert.equal(updated!.connectorNotification?.lastError, null)
  })

  it('returns null for notification attempt on non-existent id', () => {
    const result = approvals.markApprovalConnectorNotificationAttempt('ghost-id', { at: 1 })
    assert.equal(result, null)
  })

  // ---- listPendingApprovalsNeedingConnectorNotification ----

  it('returns empty when notification is disabled', () => {
    const settings = storage.loadSettings()
    settings.approvalConnectorNotifyEnabled = false
    storage.saveSettings(settings)

    const result = approvals.listPendingApprovalsNeedingConnectorNotification()
    assert.deepEqual(result, [])

    settings.approvalConnectorNotifyEnabled = true
    storage.saveSettings(settings)
  })
})
