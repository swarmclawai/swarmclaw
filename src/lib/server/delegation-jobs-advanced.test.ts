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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-delegation-adv-'))
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

describe('delegation-jobs-advanced', () => {
  it('multi-agent delegation chain — parent→child→grandchild with ordered completions', () => {
    const parent = delegationJobs.createDelegationJob({
      kind: 'delegate',
      task: 'Orchestrate full pipeline',
      backend: 'claude',
      parentSessionId: 'chain-root',
      agentId: 'agent-orchestrator',
      agentName: 'Orchestrator',
      cwd: '/workspace',
    })
    const child = delegationJobs.createDelegationJob({
      kind: 'subagent',
      task: 'Implement feature X',
      backend: 'codex',
      parentSessionId: parent.id,
      agentId: 'agent-developer',
      agentName: 'Developer',
      cwd: '/workspace/src',
    })
    const grandchild = delegationJobs.createDelegationJob({
      kind: 'subagent',
      task: 'Write tests for feature X',
      parentSessionId: child.id,
      agentId: 'agent-tester',
      agentName: 'Tester',
      cwd: '/workspace/tests',
    })

    // Verify initial state
    assert.equal(parent.status, 'queued')
    assert.equal(child.status, 'queued')
    assert.equal(grandchild.status, 'queued')
    assert.ok(parent.createdAt > 0)
    assert.ok(child.createdAt >= parent.createdAt)
    assert.ok(grandchild.createdAt >= child.createdAt)

    // Start all three
    const parentStarted = delegationJobs.startDelegationJob(parent.id)
    const childStarted = delegationJobs.startDelegationJob(child.id)
    const grandchildStarted = delegationJobs.startDelegationJob(grandchild.id)

    assert.equal(parentStarted?.status, 'running')
    assert.equal(childStarted?.status, 'running')
    assert.equal(grandchildStarted?.status, 'running')
    assert.ok(parentStarted?.startedAt)
    assert.ok(childStarted?.startedAt)
    assert.ok(grandchildStarted?.startedAt)

    // Complete grandchild first, then child, then parent
    const grandchildDone = delegationJobs.completeDelegationJob(grandchild.id, 'Tests passing: 42/42')
    assert.equal(grandchildDone?.status, 'completed')
    assert.equal(grandchildDone?.result, 'Tests passing: 42/42')
    assert.ok(grandchildDone?.completedAt)

    const childDone = delegationJobs.completeDelegationJob(child.id, 'Feature X implemented')
    assert.equal(childDone?.status, 'completed')
    assert.ok(childDone?.completedAt)
    assert.ok(childDone.completedAt! >= grandchildDone!.completedAt!)

    const parentDone = delegationJobs.completeDelegationJob(parent.id, 'Pipeline complete')
    assert.equal(parentDone?.status, 'completed')
    assert.ok(parentDone?.completedAt)
    assert.ok(parentDone.completedAt! >= childDone!.completedAt!)

    // Verify all three are retrievable
    assert.equal(delegationJobs.getDelegationJob(parent.id)?.status, 'completed')
    assert.equal(delegationJobs.getDelegationJob(child.id)?.status, 'completed')
    assert.equal(delegationJobs.getDelegationJob(grandchild.id)?.status, 'completed')

    // Verify timestamps are monotonically increasing
    assert.ok(parentDone!.updatedAt >= childDone!.updatedAt)
    assert.ok(childDone!.updatedAt >= grandchildDone!.updatedAt)
  })

  it('concurrent delegation fan-out — 5 subagent jobs with mixed outcomes', () => {
    const parentId = 'fanout-parent'
    const jobs = Array.from({ length: 5 }, (_, i) =>
      delegationJobs.createDelegationJob({
        kind: 'subagent',
        task: `Subtask ${i}`,
        parentSessionId: parentId,
        agentId: `agent-worker-${i}`,
        agentName: `Worker ${i}`,
      }),
    )

    // Start all
    for (const job of jobs) {
      delegationJobs.startDelegationJob(job.id)
    }

    // Complete jobs 0 and 1
    delegationJobs.completeDelegationJob(jobs[0].id, 'Result 0')
    delegationJobs.completeDelegationJob(jobs[1].id, 'Result 1')

    // Fail job 2
    delegationJobs.failDelegationJob(jobs[2].id, 'Out of memory')

    // Cancel job 3
    delegationJobs.cancelDelegationJob(jobs[3].id)

    // Leave job 4 running

    // Verify individual statuses
    assert.equal(delegationJobs.getDelegationJob(jobs[0].id)?.status, 'completed')
    assert.equal(delegationJobs.getDelegationJob(jobs[1].id)?.status, 'completed')
    assert.equal(delegationJobs.getDelegationJob(jobs[2].id)?.status, 'failed')
    assert.equal(delegationJobs.getDelegationJob(jobs[3].id)?.status, 'cancelled')
    assert.equal(delegationJobs.getDelegationJob(jobs[4].id)?.status, 'running')

    // Verify filter by status
    const completedJobs = delegationJobs.listDelegationJobs({ parentSessionId: parentId, status: 'completed' })
    assert.equal(completedJobs.length, 2)

    const failedJobs = delegationJobs.listDelegationJobs({ parentSessionId: parentId, status: 'failed' })
    assert.equal(failedJobs.length, 1)
    assert.equal(failedJobs[0].error, 'Out of memory')

    const cancelledJobs = delegationJobs.listDelegationJobs({ parentSessionId: parentId, status: 'cancelled' })
    assert.equal(cancelledJobs.length, 1)

    const runningJobs = delegationJobs.listDelegationJobs({ parentSessionId: parentId, status: 'running' })
    assert.equal(runningJobs.length, 1)
    assert.equal(runningJobs[0].id, jobs[4].id)

    // Verify filter by parentSessionId only returns all 5
    const allForParent = delegationJobs.listDelegationJobs({ parentSessionId: parentId })
    assert.equal(allForParent.length, 5)
  })

  it('checkpoint accumulation caps at 24 most recent entries', () => {
    const job = delegationJobs.createDelegationJob({
      kind: 'delegate',
      task: 'Long running checkpoint test',
      parentSessionId: 'checkpoint-parent',
      backend: 'claude',
    })
    delegationJobs.startDelegationJob(job.id)

    // Append 30 checkpoints (job already has 1 from creation = 31 total before capping)
    for (let i = 0; i < 30; i++) {
      delegationJobs.appendDelegationCheckpoint(job.id, `Checkpoint ${i}`)
    }

    const final = delegationJobs.getDelegationJob(job.id)
    assert.ok(final)
    assert.ok(final.checkpoints)
    assert.equal(final.checkpoints.length, 24)

    // The most recent checkpoint should be the last one we appended
    const lastCheckpoint = final.checkpoints[final.checkpoints.length - 1]
    assert.equal(lastCheckpoint.note, 'Checkpoint 29')

    // The first checkpoint should NOT be the original "Job queued" since it was pushed off
    // With 31 total entries capped to 24, the first 7 are dropped
    // Entry 0: "Job queued", entries 1-30: "Checkpoint 0" through "Checkpoint 29"
    // Kept: entries 7-30, i.e. "Checkpoint 6" through "Checkpoint 29"
    const firstCheckpoint = final.checkpoints[0]
    assert.equal(firstCheckpoint.note, 'Checkpoint 6')
  })

  it('terminal status immutability — completed job resists state changes', () => {
    const job = delegationJobs.createDelegationJob({
      kind: 'delegate',
      task: 'Immutability test',
      parentSessionId: 'immutable-parent',
    })
    delegationJobs.startDelegationJob(job.id)
    const completed = delegationJobs.completeDelegationJob(job.id, 'Final result')
    assert.equal(completed?.status, 'completed')

    // Try to start a completed job
    const afterStart = delegationJobs.startDelegationJob(job.id)
    assert.equal(afterStart?.status, 'completed')

    // Try to fail a completed job
    const afterFail = delegationJobs.failDelegationJob(job.id, 'Should not work')
    assert.equal(afterFail?.status, 'completed')
    assert.equal(afterFail?.error, null) // error should remain null from completion

    // Try to cancel a completed job
    const afterCancel = delegationJobs.cancelDelegationJob(job.id)
    assert.equal(afterCancel?.status, 'completed')

    // Try to append checkpoint with a different status
    const afterCheckpoint = delegationJobs.appendDelegationCheckpoint(job.id, 'Sneaky', 'failed')
    assert.equal(afterCheckpoint?.status, 'completed')

    // Verify the result is still intact
    const latest = delegationJobs.getDelegationJob(job.id)
    assert.equal(latest?.status, 'completed')
    assert.equal(latest?.result, 'Final result')
  })

  it('artifact accumulation with 24-cap across multiple batches', () => {
    const job = delegationJobs.createDelegationJob({
      kind: 'subagent',
      task: 'Artifact accumulation test',
      parentSessionId: 'artifact-parent',
    })
    delegationJobs.startDelegationJob(job.id)

    // Batch 1: 10 artifacts
    const batch1 = Array.from({ length: 10 }, (_, i) => ({
      type: 'file' as const,
      value: `/output/file-${i}.ts`,
      label: `File ${i}`,
    }))
    delegationJobs.appendDelegationArtifacts(job.id, batch1)

    const afterBatch1 = delegationJobs.getDelegationJob(job.id)
    assert.ok(afterBatch1?.artifacts)
    assert.equal(afterBatch1.artifacts.length, 10)

    // Batch 2: 10 more artifacts (total 20, still under cap)
    const batch2 = Array.from({ length: 10 }, (_, i) => ({
      type: 'text' as const,
      value: `Log output ${i}`,
      label: `Log ${i}`,
    }))
    delegationJobs.appendDelegationArtifacts(job.id, batch2)

    const afterBatch2 = delegationJobs.getDelegationJob(job.id)
    assert.ok(afterBatch2?.artifacts)
    assert.equal(afterBatch2.artifacts.length, 20)

    // Batch 3: 10 more artifacts (total 30, should cap at 24)
    const batch3 = Array.from({ length: 10 }, (_, i) => ({
      type: 'image' as const,
      value: `/screenshots/screenshot-${i}.png`,
      label: `Screenshot ${i}`,
    }))
    delegationJobs.appendDelegationArtifacts(job.id, batch3)

    const afterBatch3 = delegationJobs.getDelegationJob(job.id)
    assert.ok(afterBatch3?.artifacts)
    assert.equal(afterBatch3.artifacts.length, 24)

    // Verify the 24 kept are the most recent (last 24 of 30)
    // Dropped: first 6 from batch1 (file-0 through file-5)
    // Kept: file-6..file-9 (4) + all batch2 (10) + all batch3 (10) = 24
    const first = afterBatch3.artifacts[0]
    assert.equal(first.type, 'file')
    assert.equal(first.value, '/output/file-6')

    const last = afterBatch3.artifacts[23]
    assert.equal(last.type, 'image')
    assert.equal(last.value, '/screenshots/screenshot-9.png')
  })

  it('stale job recovery skips jobs with registered runtime handles', () => {
    const staleSessions = ['stale-a', 'stale-b', 'stale-c']
    const staleJobs = staleSessions.map((sid) => {
      const job = delegationJobs.createDelegationJob({
        kind: 'delegate',
        task: `Stale task for ${sid}`,
        parentSessionId: sid,
        backend: 'claude',
      })
      delegationJobs.startDelegationJob(job.id)
      return job
    })

    // Register a runtime handle only for the first job
    let handleCancelCalled = false
    delegationJobs.registerDelegationRuntime(staleJobs[0].id, {
      cancel: () => { handleCancelCalled = true },
    })

    // Use maxAgeMs=-1 to make ALL jobs appear stale (threshold = now+1)
    // Only jobs without runtime handles should be recovered.
    // Note: other running jobs from previous tests may also be recovered,
    // so we check >= 2 rather than exactly 2.
    const recovered = delegationJobs.recoverStaleDelegationJobs(-1)

    // At least the 2 stale jobs without handles should be failed
    assert.ok(recovered >= 2, `Expected at least 2 recovered, got ${recovered}`)

    assert.equal(delegationJobs.getDelegationJob(staleJobs[0].id)?.status, 'running')
    assert.equal(delegationJobs.getDelegationJob(staleJobs[1].id)?.status, 'failed')
    assert.equal(delegationJobs.getDelegationJob(staleJobs[2].id)?.status, 'failed')

    // The handle's cancel should NOT have been called
    assert.equal(handleCancelCalled, false)

    // Verify error message on recovered jobs
    assert.match(
      delegationJobs.getDelegationJob(staleJobs[1].id)?.error ?? '',
      /interrupted/i,
    )
    assert.match(
      delegationJobs.getDelegationJob(staleJobs[2].id)?.error ?? '',
      /interrupted/i,
    )
  })

  it('parent session cancellation cascade — preserves completed jobs', () => {
    const parentId = 'cascade-parent'

    // Create 4 jobs under the same parent
    const runningA = delegationJobs.createDelegationJob({
      kind: 'delegate',
      task: 'Running task A',
      parentSessionId: parentId,
      backend: 'codex',
    })
    const runningB = delegationJobs.createDelegationJob({
      kind: 'subagent',
      task: 'Running task B',
      parentSessionId: parentId,
      agentId: 'agent-b',
    })
    const queued = delegationJobs.createDelegationJob({
      kind: 'subagent',
      task: 'Queued task',
      parentSessionId: parentId,
      agentId: 'agent-q',
    })
    const alreadyCompleted = delegationJobs.createDelegationJob({
      kind: 'delegate',
      task: 'Already completed task',
      parentSessionId: parentId,
      backend: 'claude',
    })

    // Set up states: 2 running, 1 queued, 1 completed
    delegationJobs.startDelegationJob(runningA.id)
    delegationJobs.startDelegationJob(runningB.id)
    // queued stays queued
    delegationJobs.startDelegationJob(alreadyCompleted.id)
    delegationJobs.completeDelegationJob(alreadyCompleted.id, 'Previously completed')

    // Verify pre-conditions
    assert.equal(delegationJobs.getDelegationJob(runningA.id)?.status, 'running')
    assert.equal(delegationJobs.getDelegationJob(runningB.id)?.status, 'running')
    assert.equal(delegationJobs.getDelegationJob(queued.id)?.status, 'queued')
    assert.equal(delegationJobs.getDelegationJob(alreadyCompleted.id)?.status, 'completed')

    // Cancel all for parent session
    const cancelledCount = delegationJobs.cancelDelegationJobsForParentSession(parentId, 'User aborted')

    // Should cancel the 2 running + 1 queued = 3
    assert.equal(cancelledCount, 3)

    assert.equal(delegationJobs.getDelegationJob(runningA.id)?.status, 'cancelled')
    assert.equal(delegationJobs.getDelegationJob(runningB.id)?.status, 'cancelled')
    assert.equal(delegationJobs.getDelegationJob(queued.id)?.status, 'cancelled')

    // Completed job must remain completed
    assert.equal(delegationJobs.getDelegationJob(alreadyCompleted.id)?.status, 'completed')
    assert.equal(delegationJobs.getDelegationJob(alreadyCompleted.id)?.result, 'Previously completed')

    // Verify the cancellation note appears in checkpoints
    const runningAFinal = delegationJobs.getDelegationJob(runningA.id)
    assert.ok(
      runningAFinal?.checkpoints?.some((cp) => cp.note === 'User aborted'),
      'Expected cancellation note in checkpoints',
    )
  })

  it('result preview truncation at 1000 characters', () => {
    const job = delegationJobs.createDelegationJob({
      kind: 'delegate',
      task: 'Truncation test',
      parentSessionId: 'truncation-parent',
    })
    delegationJobs.startDelegationJob(job.id)

    // Create a 2000-character result
    const longResult = 'A'.repeat(2000)
    const completed = delegationJobs.completeDelegationJob(job.id, longResult)

    assert.ok(completed)
    assert.equal(completed.result?.length, 2000)
    assert.equal(completed.resultPreview?.length, 1000)
    assert.equal(completed.resultPreview, 'A'.repeat(1000))

    // Verify via getDelegationJob too
    const fetched = delegationJobs.getDelegationJob(job.id)
    assert.equal(fetched?.resultPreview?.length, 1000)
    assert.equal(fetched?.result?.length, 2000)
  })

  it('rapid status transitions — create→start→fail cannot be restarted', () => {
    const job = delegationJobs.createDelegationJob({
      kind: 'subagent',
      task: 'Rapid transitions',
      parentSessionId: 'rapid-parent',
      agentId: 'agent-rapid',
    })

    assert.equal(job.status, 'queued')
    assert.equal(job.startedAt, null)

    const started = delegationJobs.startDelegationJob(job.id)
    assert.equal(started?.status, 'running')
    assert.ok(started?.startedAt)

    const failed = delegationJobs.failDelegationJob(job.id, 'Connection lost')
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.error, 'Connection lost')
    assert.ok(failed?.completedAt)

    // Try to start again — should be immutable since 'failed' is terminal
    const restartAttempt = delegationJobs.startDelegationJob(job.id)
    assert.equal(restartAttempt?.status, 'failed')
    assert.equal(restartAttempt?.error, 'Connection lost')

    // Try to complete — should also be immutable
    const completeAttempt = delegationJobs.completeDelegationJob(job.id, 'Late success')
    assert.equal(completeAttempt?.status, 'failed')

    // Try to cancel — should also be immutable
    const cancelAttempt = delegationJobs.cancelDelegationJob(job.id)
    assert.equal(cancelAttempt?.status, 'failed')

    // Verify final state
    const finalState = delegationJobs.getDelegationJob(job.id)
    assert.equal(finalState?.status, 'failed')
    assert.equal(finalState?.error, 'Connection lost')
  })

  it('mixed kind filtering — delegate and subagent jobs', () => {
    const mixedParent = 'mixed-kind-parent'

    const delegateJobs = Array.from({ length: 3 }, (_, i) =>
      delegationJobs.createDelegationJob({
        kind: 'delegate',
        task: `Delegate task ${i}`,
        parentSessionId: mixedParent,
        backend: 'codex',
      }),
    )
    const subagentJobs = Array.from({ length: 4 }, (_, i) =>
      delegationJobs.createDelegationJob({
        kind: 'subagent',
        task: `Subagent task ${i}`,
        parentSessionId: mixedParent,
        agentId: `agent-mixed-${i}`,
        agentName: `Mixed Agent ${i}`,
      }),
    )

    // Verify all 7 are listed under the parent
    const allJobs = delegationJobs.listDelegationJobs({ parentSessionId: mixedParent })
    assert.equal(allJobs.length, 7)

    // Verify kinds are correct
    const delegates = allJobs.filter((j) => j.kind === 'delegate')
    const subagents = allJobs.filter((j) => j.kind === 'subagent')
    assert.equal(delegates.length, 3)
    assert.equal(subagents.length, 4)

    // Start and complete one delegate, start and fail one subagent
    delegationJobs.startDelegationJob(delegateJobs[0].id)
    delegationJobs.completeDelegationJob(delegateJobs[0].id, 'Delegate 0 done')

    delegationJobs.startDelegationJob(subagentJobs[0].id)
    delegationJobs.failDelegationJob(subagentJobs[0].id, 'Subagent 0 crashed')

    // Verify status filtering works across kinds
    const completedMixed = delegationJobs.listDelegationJobs({ parentSessionId: mixedParent, status: 'completed' })
    assert.equal(completedMixed.length, 1)
    assert.equal(completedMixed[0].kind, 'delegate')

    const failedMixed = delegationJobs.listDelegationJobs({ parentSessionId: mixedParent, status: 'failed' })
    assert.equal(failedMixed.length, 1)
    assert.equal(failedMixed[0].kind, 'subagent')

    const queuedMixed = delegationJobs.listDelegationJobs({ parentSessionId: mixedParent, status: 'queued' })
    assert.equal(queuedMixed.length, 5)

    // Verify delegate vs subagent fields
    assert.ok(delegateJobs[0].backend)
    assert.equal(delegateJobs[0].agentId, null)
    assert.ok(subagentJobs[0].agentId)
    assert.ok(subagentJobs[0].agentName)
  })
})
