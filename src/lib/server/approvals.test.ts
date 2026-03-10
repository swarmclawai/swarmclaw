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

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-approvals-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
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
  it('creates a pending approval with correct fields', () => {
    const result = approvals.requestApproval({
      category: 'human_loop',
      title: 'Confirm deployment',
      data: { question: 'Deploy to prod?' },
      agentId: 'agent-1',
      sessionId: 'session-1',
    })

    assert.equal(result.status, 'pending')
    assert.equal(result.category, 'human_loop')
    assert.equal(result.agentId, 'agent-1')
    assert.equal(result.sessionId, 'session-1')
    assert.ok(result.id.length > 0)
    assert.ok(result.createdAt > 0)
    assert.equal(result.createdAt, result.updatedAt)
  })

  it('lists only pending approvals and can filter by category', async () => {
    const human = approvals.requestApproval({
      category: 'human_loop',
      title: 'Human approval',
      data: { question: 'Proceed?' },
    })
    const wallet = approvals.requestApproval({
      category: 'wallet_action',
      title: 'Legacy wallet approval',
      data: { action: 'sign_message' },
    })

    await approvals.submitDecision(wallet.id, true)

    const pending = approvals.listPendingApprovals()
    const humanPending = approvals.listPendingApprovals('human_loop')

    assert.equal(pending.some((entry) => entry.id === human.id), true)
    assert.equal(pending.some((entry) => entry.id === wallet.id), false)
    assert.equal(humanPending.some((entry) => entry.id === human.id), true)
    assert.equal(humanPending.every((entry) => entry.category === 'human_loop'), true)
  })

  it('approves a pending request', async () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Confirm deployment',
      data: { question: 'Deploy to prod?' },
      sessionId: null,
      agentId: null,
    })

    const updated = await approvals.submitDecision(req.id, true)

    assert.equal(updated.status, 'approved')
    assert.equal(approvals.listPendingApprovals().some((entry) => entry.id === req.id), false)
  })

  it('rejects a pending request', async () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Confirm deletion',
      data: { question: 'Delete everything?' },
      sessionId: null,
      agentId: null,
    })

    const updated = await approvals.submitDecision(req.id, false)

    assert.equal(updated.status, 'rejected')
    assert.equal(approvals.listPendingApprovals().some((entry) => entry.id === req.id), false)
  })

  it('throws for non-existent approval id', async () => {
    await assert.rejects(
      () => approvals.submitDecision('nonexistent-xyz', true),
      /not found/i,
    )
  })

  it('is idempotent for repeated decisions', async () => {
    const req = approvals.requestApproval({
      category: 'human_loop',
      title: 'Idempotent test',
      data: { question: 'yes?' },
    })

    const approved = await approvals.submitDecision(req.id, true)
    const repeated = await approvals.submitDecision(req.id, true)

    assert.equal(approved.status, 'approved')
    assert.equal(repeated.status, 'approved')
  })
})
