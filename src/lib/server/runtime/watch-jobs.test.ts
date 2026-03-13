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
let watchJobs: typeof import('@/lib/server/runtime/watch-jobs')
let storage: typeof import('@/lib/server/storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-watch-jobs-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  watchJobs = await import('@/lib/server/runtime/watch-jobs')
  storage = await import('@/lib/server/storage')
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

describe('watch-jobs', () => {
  it('validates required targets for durable watches', async () => {
    await assert.rejects(
      watchJobs.createWatchJob({
        type: 'http',
        resumeMessage: 'resume',
        target: {},
        condition: {},
      }),
      /url target/,
    )

    await assert.rejects(
      watchJobs.createWatchJob({
        type: 'time',
        resumeMessage: 'resume',
        target: { source: 'test' },
        condition: {},
      }),
      /runAt or delayMinutes/,
    )
  })

  it('triggers time and task watches durably', async () => {
    const tasks = storage.loadTasks()
    tasks.task_done = {
      id: 'task_done',
      title: 'done',
      status: 'completed',
      result: 'ok',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    storage.saveTasks(tasks)

    const timeJob = await watchJobs.createWatchJob({
      type: 'time',
      resumeMessage: 'wake up',
      target: { source: 'schedule_wake' },
      condition: {},
      runAt: Date.now() - 1000,
    })
    const taskJob = await watchJobs.createWatchJob({
      type: 'task',
      resumeMessage: 'task finished',
      target: { taskId: 'task_done' },
      condition: { statusIn: ['completed'] },
    })

    const outcome = await watchJobs.processDueWatchJobs(Date.now())

    assert.equal(outcome.triggered >= 2, true)
    assert.equal(watchJobs.getWatchJob(timeJob.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(taskJob.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(taskJob.id)?.result?.status, 'completed')
  })

  it('captures file changes and webhook triggers', async () => {
    const watchedFile = path.join(tempDir, 'watch.txt')
    fs.writeFileSync(watchedFile, 'alpha')

    const fileJob = await watchJobs.createWatchJob({
      type: 'file',
      resumeMessage: 'file changed',
      target: { path: watchedFile },
      condition: { changed: true },
    })
    const webhookJob = await watchJobs.createWatchJob({
      type: 'webhook',
      resumeMessage: 'webhook arrived',
      target: { webhookId: 'wh_1' },
      condition: { event: 'build.finished' },
    })

    fs.writeFileSync(watchedFile, 'beta')
    await watchJobs.processDueWatchJobs(Date.now())
    const webhookMatches = watchJobs.triggerWebhookWatchJobs({
      webhookId: 'wh_1',
      event: 'build.finished',
      payloadPreview: '{"ok":true}',
    })

    assert.equal(watchJobs.getWatchJob(fileJob.id)?.status, 'triggered')
    assert.match(String(watchJobs.getWatchJob(fileJob.id)?.result?.preview || ''), /beta/)
    assert.equal(webhookMatches.length, 1)
    assert.equal(watchJobs.getWatchJob(webhookJob.id)?.status, 'triggered')
  })

  it('wakes mailbox and approval watches from event triggers', async () => {
    storage.upsertApproval('approval_1', {
      id: 'approval_1',
      category: 'human_loop',
      title: 'Need approval',
      description: 'Approve the action',
      data: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'pending',
    })

    const mailboxJob = await watchJobs.createWatchJob({
      type: 'mailbox',
      resumeMessage: 'human replied',
      target: { sessionId: 'session_1' },
      condition: { type: 'human_reply', correlationId: 'corr_1' },
    })
    const approvalJob = await watchJobs.createWatchJob({
      type: 'approval',
      resumeMessage: 'approval updated',
      target: { approvalId: 'approval_1' },
      condition: { statusIn: ['approved'] },
    })

    const mailboxMatches = watchJobs.triggerMailboxWatchJobs({
      sessionId: 'session_1',
      envelope: {
        id: 'env_1',
        type: 'human_reply',
        payload: 'approved',
        toSessionId: 'session_1',
        correlationId: 'corr_1',
        status: 'new',
        createdAt: Date.now(),
      },
    })
    const approvalMatches = watchJobs.triggerApprovalWatchJobs({
      approvalId: 'approval_1',
      status: 'approved',
    })

    assert.equal(mailboxMatches.length, 1)
    assert.equal(approvalMatches.length, 1)
    assert.equal(watchJobs.getWatchJob(mailboxJob.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(approvalJob.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(mailboxJob.id)?.result?.correlationId, 'corr_1')
    assert.equal(watchJobs.getWatchJob(approvalJob.id)?.result?.status, 'approved')
  })

  it('reuses an existing active mailbox watch for the same wait condition', async () => {
    const first = await watchJobs.createWatchJob({
      type: 'mailbox',
      sessionId: 'session_dup',
      agentId: 'agent_dup',
      createdByAgentId: 'agent_dup',
      resumeMessage: 'human replied',
      target: { sessionId: 'session_dup' },
      condition: { type: 'human_reply', correlationId: 'corr_dup' },
    })
    const second = await watchJobs.createWatchJob({
      type: 'mailbox',
      sessionId: 'session_dup',
      agentId: 'agent_dup',
      createdByAgentId: 'agent_dup',
      resumeMessage: 'human replied again',
      target: { sessionId: 'session_dup' },
      condition: { type: 'human_reply', correlationId: 'corr_dup' },
    })

    assert.equal(second.id, first.id)
    assert.equal(watchJobs.listWatchJobs({ sessionId: 'session_dup', status: 'active' }).length, 1)
  })
})
