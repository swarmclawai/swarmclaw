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
let delegationJobs: typeof import('./delegation-jobs')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-delegation-jobs-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  delegationJobs = await import('./delegation-jobs')
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

describe('delegation-jobs', () => {
  it('tracks a queued job through running and completion', () => {
    const job = delegationJobs.createDelegationJob({
      kind: 'delegate',
      parentSessionId: 'session-1',
      backend: 'codex',
      task: 'Refactor the module',
      cwd: process.cwd(),
    })

    const started = delegationJobs.startDelegationJob(job.id, { backend: 'codex' })
    const completed = delegationJobs.completeDelegationJob(job.id, 'done')

    assert.equal(started?.status, 'running')
    assert.equal(completed?.status, 'completed')
    assert.equal(completed?.resultPreview, 'done')
    assert.equal(delegationJobs.listDelegationJobs({ parentSessionId: 'session-1' }).length >= 1, true)
  })

  it('keeps cancellation terminal even if late completions arrive', () => {
    const job = delegationJobs.createDelegationJob({
      kind: 'subagent',
      parentSessionId: 'session-2',
      agentId: 'agent-1',
      task: 'Do the background work',
      cwd: process.cwd(),
    })

    let cancelled = false
    delegationJobs.startDelegationJob(job.id, { agentId: 'agent-1' })
    delegationJobs.registerDelegationRuntime(job.id, {
      cancel: () => {
        cancelled = true
      },
    })

    const stopped = delegationJobs.cancelDelegationJob(job.id)
    const afterComplete = delegationJobs.completeDelegationJob(job.id, 'late success')
    const afterFail = delegationJobs.failDelegationJob(job.id, 'late failure')

    assert.equal(cancelled, true)
    assert.equal(stopped?.status, 'cancelled')
    assert.equal(afterComplete?.status, 'cancelled')
    assert.equal(afterFail?.status, 'cancelled')
  })

  it('recovers stale running jobs as failed', () => {
    const stale = delegationJobs.createDelegationJob({
      kind: 'delegate',
      parentSessionId: 'session-3',
      backend: 'claude',
      task: 'Stale job',
      cwd: process.cwd(),
    })

    delegationJobs.startDelegationJob(stale.id)
    delegationJobs.updateDelegationJob(stale.id, {
      startedAt: Date.now() - 60_000,
    })

    const recovered = delegationJobs.recoverStaleDelegationJobs(-1)
    const latest = delegationJobs.getDelegationJob(stale.id)

    assert.equal(recovered >= 1, true)
    assert.equal(latest?.status, 'failed')
    assert.match(String(latest?.error || ''), /interrupted/i)
  })

  it('cancels all running jobs for a parent session', () => {
    const jobA = delegationJobs.createDelegationJob({
      kind: 'delegate',
      parentSessionId: 'session-bulk',
      backend: 'codex',
      task: 'Task A',
      cwd: process.cwd(),
    })
    const jobB = delegationJobs.createDelegationJob({
      kind: 'subagent',
      parentSessionId: 'session-bulk',
      agentId: 'agent-2',
      task: 'Task B',
      cwd: process.cwd(),
    })
    const untouched = delegationJobs.createDelegationJob({
      kind: 'delegate',
      parentSessionId: 'other-session',
      backend: 'claude',
      task: 'Task C',
      cwd: process.cwd(),
    })

    delegationJobs.startDelegationJob(jobA.id)
    delegationJobs.startDelegationJob(jobB.id)
    delegationJobs.startDelegationJob(untouched.id)

    const cancelled = delegationJobs.cancelDelegationJobsForParentSession('session-bulk', 'Stopped by user')

    assert.equal(cancelled, 2)
    assert.equal(delegationJobs.getDelegationJob(jobA.id)?.status, 'cancelled')
    assert.equal(delegationJobs.getDelegationJob(jobB.id)?.status, 'cancelled')
    assert.equal(delegationJobs.getDelegationJob(untouched.id)?.status, 'running')
    assert.equal(
      delegationJobs.getDelegationJob(jobA.id)?.checkpoints?.some((entry) => entry.note === 'Stopped by user'),
      true,
    )
  })
})
