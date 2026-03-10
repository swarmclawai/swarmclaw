import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-watch-adv-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  watchJobs = await import('@/lib/server/runtime/watch-jobs')
  storage = await import('@/lib/server/storage')
  // When run after another test file, modules are cached and DATA_DIR is the
  // old (deleted) path. Ensure the cached DATA_DIR directory exists so the
  // shared DB connection works.
  const dataDir = await import('@/lib/server/data-dir')
  fs.mkdirSync(dataDir.DATA_DIR, { recursive: true })
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

describe('watch-jobs advanced', () => {
  it('1. time watch triggers at exact boundary', async () => {
    const now = Date.now()
    const job = await watchJobs.createWatchJob({
      type: 'time',
      resumeMessage: 'wake up',
      target: { source: 'boundary-test' },
      condition: {},
      runAt: now - 1000,
    })
    const outcome = await watchJobs.processDueWatchJobs(now)
    const afterJob = watchJobs.getWatchJob(job.id)

    assert.ok(outcome.triggered >= 1)
    assert.equal(afterJob?.status, 'triggered')
  })

  it('2. time watch does not fire early', async () => {
    const now = Date.now()
    const job = await watchJobs.createWatchJob({
      type: 'time',
      resumeMessage: 'too early',
      target: { source: 'early-test' },
      condition: {},
      runAt: now + 60000,
    })
    await watchJobs.processDueWatchJobs(now)
    const afterJob = watchJobs.getWatchJob(job.id)

    assert.equal(afterJob?.status, 'active')
  })

  it('3. task status watch chain — mixed triggers', async () => {
    const now = Date.now()
    const tasks = storage.loadTasks()
    tasks['task-adv-1'] = { id: 'task-adv-1', title: 'T1', status: 'completed', result: 'ok', createdAt: now, updatedAt: now }
    tasks['task-adv-2'] = { id: 'task-adv-2', title: 'T2', status: 'queued', result: null, createdAt: now, updatedAt: now }
    tasks['task-adv-3'] = { id: 'task-adv-3', title: 'T3', status: 'failed', result: null, createdAt: now, updatedAt: now }
    storage.saveTasks(tasks)

    const watchA = await watchJobs.createWatchJob({
      type: 'task',
      resumeMessage: 'task-1 done',
      target: { taskId: 'task-adv-1' },
      condition: { statusIn: ['completed'] },
    })
    const watchB = await watchJobs.createWatchJob({
      type: 'task',
      resumeMessage: 'task-2 running',
      target: { taskId: 'task-adv-2' },
      condition: { statusIn: ['running'] },
    })
    const watchC = await watchJobs.createWatchJob({
      type: 'task',
      resumeMessage: 'task-3 terminal',
      target: { taskId: 'task-adv-3' },
      condition: { statusIn: ['completed', 'failed'] },
    })

    await watchJobs.processDueWatchJobs(Date.now())

    assert.equal(watchJobs.getWatchJob(watchA.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(watchB.id)?.status, 'active')
    assert.equal(watchJobs.getWatchJob(watchC.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(watchA.id)?.result?.status, 'completed')
    assert.equal(watchJobs.getWatchJob(watchC.id)?.result?.status, 'failed')
  })

  it('4. file existence watch — not exists then exists', async () => {
    const tmpFile = path.join(tempDir, 'exist-test-' + Date.now() + '.txt')
    const now = Date.now()

    const job = await watchJobs.createWatchJob({
      type: 'file',
      resumeMessage: 'file appeared',
      target: { path: tmpFile },
      condition: { exists: true },
    })

    await watchJobs.processDueWatchJobs(now)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')

    fs.writeFileSync(tmpFile, 'hello')
    await watchJobs.processDueWatchJobs(now + 120_000)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
  })

  it('5. file change detection — baseline then mutation', async () => {
    const tmpFile = path.join(tempDir, 'change-test-' + Date.now() + '.txt')
    const now = Date.now()

    fs.writeFileSync(tmpFile, 'initial content')

    const job = await watchJobs.createWatchJob({
      type: 'file',
      resumeMessage: 'file changed',
      target: { path: tmpFile },
      condition: { changed: true },
    })

    assert.ok(typeof job.target.baselineHash === 'string' && job.target.baselineHash.length > 0)

    await watchJobs.processDueWatchJobs(now)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')

    fs.writeFileSync(tmpFile, 'modified content')
    await watchJobs.processDueWatchJobs(now + 120_000)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
  })

  it('6. HTTP status code watch — 500 then 200', async () => {
    let statusCode = 500
    const server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' })
      res.end('status: ' + statusCode)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    const url = 'http://127.0.0.1:' + port + '/health'
    const now = Date.now()

    try {
      const job = await watchJobs.createWatchJob({
        type: 'http',
        resumeMessage: 'health ok',
        target: { url },
        condition: { status: 200 },
      })

      await watchJobs.processDueWatchJobs(now)
      assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')

      statusCode = 200
      await watchJobs.processDueWatchJobs(now + 120_000)
      assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
    } finally {
      server.close()
    }
  })

  it('7. multiple watches, mixed results', async () => {
    const now = Date.now()

    const tasks = storage.loadTasks()
    tasks['task-mix-adv'] = { id: 'task-mix-adv', title: 'Mix', status: 'completed', result: 'ok', createdAt: now, updatedAt: now }
    storage.saveTasks(tasks)

    const w1 = await watchJobs.createWatchJob({
      type: 'time', resumeMessage: 'w1-adv', target: { source: 'w1-adv' }, condition: {}, runAt: now - 5000,
    })
    const w2 = await watchJobs.createWatchJob({
      type: 'time', resumeMessage: 'w2-adv', target: { source: 'w2-adv' }, condition: {}, runAt: now - 1000,
    })
    const w3 = await watchJobs.createWatchJob({
      type: 'file', resumeMessage: 'w3-adv', target: { path: path.join(tempDir, 'nonexistent-' + now + '.txt') }, condition: { exists: true },
    })
    const w4 = await watchJobs.createWatchJob({
      type: 'task', resumeMessage: 'w4-adv', target: { taskId: 'task-mix-adv' }, condition: { statusIn: ['completed'] },
    })
    const w5 = await watchJobs.createWatchJob({
      type: 'time', resumeMessage: 'w5-adv', target: { source: 'w5-adv' }, condition: {}, runAt: now + 60000,
    })

    await watchJobs.processDueWatchJobs(Date.now())

    assert.equal(watchJobs.getWatchJob(w1.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(w2.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(w3.id)?.status, 'active')
    assert.equal(watchJobs.getWatchJob(w4.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(w5.id)?.status, 'active')
  })

  it('8. triggered watch is terminal — does not re-trigger', async () => {
    const now = Date.now()

    const job = await watchJobs.createWatchJob({
      type: 'time', resumeMessage: 'once only adv', target: { source: 'terminal-test-adv' }, condition: {}, runAt: now - 1000,
    })

    await watchJobs.processDueWatchJobs(now)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')

    await watchJobs.processDueWatchJobs(now + 120_000)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
  })

  it('9. validation rejects bad targets', async () => {
    await assert.rejects(
      watchJobs.createWatchJob({ type: 'time', resumeMessage: 'x', target: { source: 'v' }, condition: {} }),
      /runAt/,
    )
    await assert.rejects(
      watchJobs.createWatchJob({ type: 'task', resumeMessage: 'x', target: {}, condition: {} }),
      /taskId/,
    )
    await assert.rejects(
      watchJobs.createWatchJob({ type: 'file', resumeMessage: 'x', target: {}, condition: {} }),
      /path/,
    )
    await assert.rejects(
      watchJobs.createWatchJob({ type: 'http', resumeMessage: 'x', target: {}, condition: {} }),
      /url/,
    )
    await assert.rejects(
      watchJobs.createWatchJob({ type: 'webhook', resumeMessage: 'x', target: {}, condition: {} }),
      /webhookId/,
    )
    await assert.rejects(
      watchJobs.createWatchJob({ type: 'mailbox', resumeMessage: 'x', target: {}, condition: {} }),
      /sessionId/,
    )
    await assert.rejects(
      watchJobs.createWatchJob({ type: 'approval', resumeMessage: 'x', target: {}, condition: {} }),
      /approvalId/,
    )
  })

  it('10. mailbox watch triggers on matching envelope', async () => {
    const now = Date.now()

    const job = await watchJobs.createWatchJob({
      type: 'mailbox',
      resumeMessage: 'got mail adv',
      target: { sessionId: 'session-inbox-adv-1' },
      condition: { type: 'human_reply', correlationId: 'corr-adv-42' },
    })

    const matches = watchJobs.triggerMailboxWatchJobs({
      sessionId: 'session-inbox-adv-1',
      envelope: {
        id: 'env-adv-1',
        type: 'human_reply',
        payload: 'looks good',
        toSessionId: 'session-inbox-adv-1',
        correlationId: 'corr-adv-42',
        status: 'new',
        createdAt: now,
      },
    })
    const afterJob = watchJobs.getWatchJob(job.id)

    assert.equal(matches.length, 1)
    assert.equal(afterJob?.status, 'triggered')
    assert.equal(afterJob?.result?.correlationId, 'corr-adv-42')
    assert.equal(afterJob?.result?.payload, 'looks good')
  })

  it('11. mailbox watch ignores non-matching envelope', async () => {
    const now = Date.now()

    const job = await watchJobs.createWatchJob({
      type: 'mailbox',
      resumeMessage: 'got mail adv-2',
      target: { sessionId: 'session-inbox-adv-2' },
      condition: { type: 'human_reply', correlationId: 'corr-adv-99' },
    })

    const matches1 = watchJobs.triggerMailboxWatchJobs({
      sessionId: 'session-inbox-WRONG',
      envelope: {
        id: 'env-adv-2', type: 'human_reply', payload: 'wrong session',
        toSessionId: 'session-inbox-WRONG', correlationId: 'corr-adv-99', status: 'new', createdAt: now,
      },
    })

    const matches2 = watchJobs.triggerMailboxWatchJobs({
      sessionId: 'session-inbox-adv-2',
      envelope: {
        id: 'env-adv-3', type: 'human_reply', payload: 'wrong corr',
        toSessionId: 'session-inbox-adv-2', correlationId: 'corr-adv-WRONG', status: 'new', createdAt: now,
      },
    })

    assert.equal(matches1.length, 0)
    assert.equal(matches2.length, 0)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')
  })

  it('12. approval watch triggers on matching approval status', async () => {
    const now = Date.now()

    storage.upsertApproval('appr-adv-1', {
      id: 'appr-adv-1',
      category: 'human_loop',
      title: 'Deploy approval adv',
      description: 'Approve deploy?',
      data: {},
      createdAt: now,
      updatedAt: now,
      status: 'pending',
    })

    const job = await watchJobs.createWatchJob({
      type: 'approval',
      resumeMessage: 'approved adv',
      target: { approvalId: 'appr-adv-1' },
      condition: { statusIn: ['approved'] },
    })

    const matches = watchJobs.triggerApprovalWatchJobs({
      approvalId: 'appr-adv-1',
      status: 'approved',
    })
    const afterJob = watchJobs.getWatchJob(job.id)

    assert.equal(matches.length, 1)
    assert.equal(afterJob?.status, 'triggered')
    assert.equal(afterJob?.result?.status, 'approved')
    assert.equal(afterJob?.result?.approvalId, 'appr-adv-1')
  })

  it('13. approval watch ignores non-matching status', async () => {
    const now = Date.now()

    storage.upsertApproval('appr-adv-2', {
      id: 'appr-adv-2', category: 'human_loop', title: 'Test adv',
      description: 'Test', data: {}, createdAt: now, updatedAt: now, status: 'pending',
    })

    const job = await watchJobs.createWatchJob({
      type: 'approval',
      resumeMessage: 'approved only adv',
      target: { approvalId: 'appr-adv-2' },
      condition: { statusIn: ['approved'] },
    })

    const matches = watchJobs.triggerApprovalWatchJobs({
      approvalId: 'appr-adv-2',
      status: 'rejected',
    })

    assert.equal(matches.length, 0)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')
  })

  it('14. timeout expires a watch as failed', async () => {
    const now = Date.now()
    const tmpFile = path.join(tempDir, 'timeout-file-' + now + '.txt')

    const job = await watchJobs.createWatchJob({
      type: 'file',
      resumeMessage: 'never arrives',
      target: { path: tmpFile },
      condition: { exists: true },
      timeoutAt: now + 5000,
    })

    const outcome = await watchJobs.processDueWatchJobs(now + 10_000)
    const afterJob = watchJobs.getWatchJob(job.id)

    assert.ok(outcome.failed >= 1)
    assert.equal(afterJob?.status, 'failed')
    assert.match(String(afterJob?.lastError), /timed out/)
  })

  it('15. cancel prevents future processing', async () => {
    const now = Date.now()

    const job = await watchJobs.createWatchJob({
      type: 'time',
      resumeMessage: 'cancelled adv',
      target: { source: 'cancel-test-adv' },
      condition: {},
      runAt: now - 1000,
    })

    watchJobs.cancelWatchJob(job.id)
    await watchJobs.processDueWatchJobs(now)
    const afterJob = watchJobs.getWatchJob(job.id)

    assert.equal(afterJob?.status, 'cancelled')
  })

  it('16. HTTP content-contains watch', async () => {
    let body = 'status: deploying'
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(body)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    const url = 'http://127.0.0.1:' + port + '/status'
    const now = Date.now()

    try {
      const job = await watchJobs.createWatchJob({
        type: 'http',
        resumeMessage: 'deploy done adv',
        target: { url },
        condition: { containsText: 'deployed successfully' },
      })

      await watchJobs.processDueWatchJobs(now)
      assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')

      body = 'status: deployed successfully at 12:00'
      await watchJobs.processDueWatchJobs(now + 120_000)
      assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
    } finally {
      server.close()
    }
  })

  it('17. webhook watch triggers only for matching webhookId and event', async () => {
    const job = await watchJobs.createWatchJob({
      type: 'webhook',
      resumeMessage: 'build done adv',
      target: { webhookId: 'wh-build-adv-1' },
      condition: { event: 'build.completed' },
    })

    const m1 = watchJobs.triggerWebhookWatchJobs({ webhookId: 'wh-other', event: 'build.completed' })
    const m2 = watchJobs.triggerWebhookWatchJobs({ webhookId: 'wh-build-adv-1', event: 'build.started' })
    const m3 = watchJobs.triggerWebhookWatchJobs({ webhookId: 'wh-build-adv-1', event: 'build.completed', payloadPreview: '{"ok":true}' })

    assert.equal(m1.length, 0)
    assert.equal(m2.length, 0)
    assert.equal(m3.length, 1)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
    assert.equal(watchJobs.getWatchJob(job.id)?.result?.event, 'build.completed')
  })

  it('18. list and filter watch jobs by status and sessionId', async () => {
    const now = Date.now()

    await watchJobs.createWatchJob({
      type: 'time', resumeMessage: 'a-adv', target: { source: 'a-adv' }, condition: {},
      runAt: now - 1000, sessionId: 'sess-adv-A',
    })
    await watchJobs.createWatchJob({
      type: 'time', resumeMessage: 'b-adv', target: { source: 'b-adv' }, condition: {},
      runAt: now + 600_000, sessionId: 'sess-adv-A',
    })
    await watchJobs.createWatchJob({
      type: 'time', resumeMessage: 'c-adv', target: { source: 'c-adv' }, condition: {},
      runAt: now - 500, sessionId: 'sess-adv-B',
    })

    await watchJobs.processDueWatchJobs(now)

    const sessAAll = watchJobs.listWatchJobs({ sessionId: 'sess-adv-A' })
    const sessATriggered = watchJobs.listWatchJobs({ sessionId: 'sess-adv-A', status: 'triggered' })
    const sessBAll = watchJobs.listWatchJobs({ sessionId: 'sess-adv-B' })

    assert.equal(sessAAll.length, 2)
    assert.equal(sessATriggered.length, 1)
    assert.equal(sessBAll.length, 1)
  })

  it('19. concurrent batch — many watches processed in single pass', async () => {
    const now = Date.now()
    const ids: string[] = []

    for (let i = 0; i < 20; i++) {
      const job = await watchJobs.createWatchJob({
        type: 'time',
        resumeMessage: 'batch-adv-' + i,
        target: { source: 'batch-adv-' + i },
        condition: {},
        runAt: i < 15 ? now - 1000 : now + 60000,
      })
      ids.push(job.id)
    }

    const outcome = await watchJobs.processDueWatchJobs(now)

    assert.ok(outcome.triggered >= 15)

    for (let i = 0; i < 15; i++) {
      assert.equal(watchJobs.getWatchJob(ids[i])?.status, 'triggered', 'batch item ' + i + ' should be triggered')
    }
    for (let i = 15; i < 20; i++) {
      assert.equal(watchJobs.getWatchJob(ids[i])?.status, 'active', 'batch item ' + i + ' should be active')
    }
  })

  it('20. HTTP change detection via baseline hash', async () => {
    let body = 'version: 1.0.0'
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(body)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    const url = 'http://127.0.0.1:' + port + '/version'
    const now = Date.now()

    try {
      const job = await watchJobs.createWatchJob({
        type: 'http',
        resumeMessage: 'version changed adv',
        target: { url },
        condition: { changed: true },
      })
      assert.ok(typeof job.target.baselineHash === 'string' && job.target.baselineHash.length > 0)

      await watchJobs.processDueWatchJobs(now)
      assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')

      body = 'version: 2.0.0'
      await watchJobs.processDueWatchJobs(now + 120_000)
      assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
    } finally {
      server.close()
    }
  })

  it('21. file watch with regex condition', async () => {
    const tmpFile = path.join(tempDir, 'regex-test-' + Date.now() + '.txt')
    const now = Date.now()

    fs.writeFileSync(tmpFile, 'status: pending')

    const job = await watchJobs.createWatchJob({
      type: 'file',
      resumeMessage: 'pattern matched adv',
      target: { path: tmpFile },
      condition: { regex: 'status:\\s+completed' },
    })

    await watchJobs.processDueWatchJobs(now)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'active')

    fs.writeFileSync(tmpFile, 'status: completed')
    await watchJobs.processDueWatchJobs(now + 120_000)
    assert.equal(watchJobs.getWatchJob(job.id)?.status, 'triggered')
  })

  it('22. interval rescheduling — nextCheckAt advances by intervalMs', async () => {
    const now = Date.now()
    const missingFile = path.join(tempDir, 'resched-' + now + '.txt')

    const job = await watchJobs.createWatchJob({
      type: 'file',
      resumeMessage: 'resched test adv',
      target: { path: missingFile },
      condition: { exists: true },
      intervalMs: 60_000,
    })

    await watchJobs.processDueWatchJobs(now)
    const afterJob = watchJobs.getWatchJob(job.id)

    assert.equal(afterJob?.status, 'active')
    assert.equal(afterJob?.nextCheckAt, now + 60_000)
  })
})
