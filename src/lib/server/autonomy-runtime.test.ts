import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-autonomy-test-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: tempDir,
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('browser session persistence', () => {
  it('isolates browser profiles by default and stores observations', () => {
    const output = runWithTempDataDir(`
      const storage = (await import('./src/lib/server/storage')).default
      const browserState = (await import('./src/lib/server/browser-state')).default

      const now = Date.now()
      storage.saveSessions({
        parent: {
          id: 'parent',
          name: 'parent',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          browserProfileId: 'shared-profile',
        },
        child: {
          id: 'child',
          name: 'child',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          parentSessionId: 'parent',
        },
      })

      const resolved = browserState.ensureSessionBrowserProfileId('child')
      browserState.upsertBrowserSessionRecord({ sessionId: 'child', status: 'active', lastAction: 'navigate' })
      browserState.recordBrowserObservation('child', {
        capturedAt: now,
        url: 'https://example.com',
        title: 'Example',
        textPreview: 'hello world',
        links: [],
        forms: [],
        tables: [],
      })
      browserState.markBrowserSessionClosed('child', 'finished')

      console.log(JSON.stringify({
        resolved,
        session: storage.loadSessions().child,
        state: browserState.loadBrowserSessionRecord('child'),
      }))
    `)

    assert.equal(output.resolved.profileId, 'child')
    assert.equal(output.resolved.inheritedFromSessionId, null)
    assert.equal(output.session.browserProfileId, 'child')
    assert.equal(output.state.currentUrl, 'https://example.com')
    assert.equal(output.state.pageTitle, 'Example')
    assert.equal(output.state.status, 'error')
    assert.equal(output.state.lastError, 'finished')
  })

  it('isolates subagent browser profiles by default unless sharing is explicitly requested', () => {
    const output = runWithTempDataDir(`
      const mod = await import('./src/lib/server/session-tools/subagent')
      const { resolveSubagentBrowserProfileId } = mod.default || mod['module.exports'] || mod

      const parent = {
        id: 'parent-session',
        browserProfileId: 'shared-profile',
      }

      console.log(JSON.stringify({
        isolated: resolveSubagentBrowserProfileId(parent, 'child-session', false),
        shared: resolveSubagentBrowserProfileId(parent, 'child-session', true),
      }))
    `)

    assert.equal(output.isolated, 'child-session')
    assert.equal(output.shared, 'shared-profile')
  })
})

describe('durable watch jobs', () => {
  it('triggers time, file, task, http, and webhook watches', () => {
    const output = runWithTempDataDir(`
      import fs from 'node:fs'
      import path from 'node:path'
      const storage = (await import('./src/lib/server/storage')).default
      const watchJobs = (await import('./src/lib/server/watch-jobs')).default

      const watchFile = path.join(process.env.DATA_DIR, 'watch.txt')
      fs.writeFileSync(watchFile, 'build succeeded')

      storage.saveTasks({
        task_done: {
          id: 'task_done',
          title: 'Done',
          status: 'completed',
          result: 'ok',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })

      globalThis.fetch = async () => new Response('service healthy', { status: 200 })

      const timeJob = await watchJobs.createWatchJob({
        type: 'time',
        resumeMessage: 'time wake',
        target: {},
        condition: {},
        runAt: Date.now() - 1000,
      })
      const fileJob = await watchJobs.createWatchJob({
        type: 'file',
        resumeMessage: 'file wake',
        target: { path: watchFile },
        condition: { containsText: 'succeeded' },
      })
      const taskJob = await watchJobs.createWatchJob({
        type: 'task',
        resumeMessage: 'task wake',
        target: { taskId: 'task_done' },
        condition: { statusIn: ['completed'] },
      })
      const httpJob = await watchJobs.createWatchJob({
        type: 'http',
        resumeMessage: 'http wake',
        target: { url: 'https://example.com/health' },
        condition: { regex: 'healthy', threshold: 0 },
      })
      const webhookJob = await watchJobs.createWatchJob({
        type: 'webhook',
        resumeMessage: 'webhook wake',
        target: { webhookId: 'wh_test' },
        condition: { event: 'deploy.finished' },
      })

      const summary = await watchJobs.processDueWatchJobs(Date.now())
      const webhookTriggered = watchJobs.triggerWebhookWatchJobs({
        webhookId: 'wh_test',
        event: 'deploy.finished',
        payloadPreview: '{"ok":true}',
      })

      console.log(JSON.stringify({
        summary,
        time: watchJobs.getWatchJob(timeJob.id),
        file: watchJobs.getWatchJob(fileJob.id),
        task: watchJobs.getWatchJob(taskJob.id),
        http: watchJobs.getWatchJob(httpJob.id),
        webhook: watchJobs.getWatchJob(webhookJob.id),
        webhookTriggeredCount: webhookTriggered.length,
      }))
    `)

    assert.equal(output.summary.triggered >= 4, true)
    assert.equal(output.time.status, 'triggered')
    assert.equal(output.file.status, 'triggered')
    assert.equal(output.task.status, 'triggered')
    assert.equal(output.http.status, 'triggered')
    assert.equal(output.http.result.regex, 'healthy')
    assert.equal(output.webhook.status, 'triggered')
    assert.equal(output.webhookTriggeredCount, 1)
  })

  it('triggers mailbox and approval waits from human-loop events', () => {
    const output = runWithTempDataDir(`
      const storage = (await import('./src/lib/server/storage')).default
      const watchJobs = (await import('./src/lib/server/watch-jobs')).default
      const mailboxMod = await import('./src/lib/server/session-mailbox')
      const approvalsMod = await import('./src/lib/server/approvals')
      const mailbox = mailboxMod.default || mailboxMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSessions({
        human: {
          id: 'human',
          name: 'Human Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          mailbox: [],
          createdAt: now,
          lastActiveAt: now,
        },
      })

      const mailboxJob = await watchJobs.createWatchJob({
        type: 'mailbox',
        resumeMessage: 'mailbox wake',
        target: { sessionId: 'human' },
        condition: { type: 'human_reply', correlationId: 'corr-1' },
      })

      const approval = approvals.requestApproval({
        category: 'human_loop',
        sessionId: 'human',
        title: 'Approve deployment',
        data: { env: 'prod' },
      })

      const approvalJob = await watchJobs.createWatchJob({
        type: 'approval',
        resumeMessage: 'approval wake',
        target: { approvalId: approval.id },
        condition: { statusIn: ['approved'] },
      })

      const envelope = mailbox.sendMailboxEnvelope({
        toSessionId: 'human',
        type: 'human_reply',
        payload: 'ship it',
        correlationId: 'corr-1',
      })

      await approvals.submitDecision(approval.id, true)
      await new Promise((resolve) => setTimeout(resolve, 25))

      console.log(JSON.stringify({
        envelope,
        mailboxJob: watchJobs.getWatchJob(mailboxJob.id),
        approvalJob: watchJobs.getWatchJob(approvalJob.id),
        approval: storage.loadApprovals()[approval.id],
        mailboxState: storage.loadSessions().human.mailbox,
      }))
    `)

    assert.equal(output.envelope.type, 'human_reply')
    assert.equal(output.mailboxJob.status, 'triggered')
    assert.equal(output.mailboxJob.result.type, 'human_reply')
    assert.equal(output.approvalJob.status, 'triggered')
    assert.equal(output.approvalJob.result.status, 'approved')
    assert.equal(output.approval.status, 'approved')
    assert.equal(Array.isArray(output.mailboxState), true)
    assert.equal(output.mailboxState.length, 1)
  })
})

describe('delegation jobs', () => {
  it('preserves cancellation and recovers stale jobs', () => {
    const output = runWithTempDataDir(`
      const delegationJobs = (await import('./src/lib/server/delegation-jobs')).default
      const storage = (await import('./src/lib/server/storage')).default

      let cancelledCalls = 0
      const cancelledJob = delegationJobs.createDelegationJob({
        kind: 'delegate',
        backend: 'codex',
        parentSessionId: 'session-1',
        task: 'cancel me',
      })
      delegationJobs.startDelegationJob(cancelledJob.id, { backend: 'codex' })
      delegationJobs.registerDelegationRuntime(cancelledJob.id, {
        cancel: () => { cancelledCalls += 1 },
      })
      delegationJobs.cancelDelegationJob(cancelledJob.id)
      delegationJobs.completeDelegationJob(cancelledJob.id, 'should not override')
      delegationJobs.failDelegationJob(cancelledJob.id, 'should also not override')

      const completedJob = delegationJobs.createDelegationJob({
        kind: 'subagent',
        parentSessionId: 'session-1',
        task: 'complete me',
      })
      delegationJobs.startDelegationJob(completedJob.id, { childSessionId: 'session-2' })
      delegationJobs.completeDelegationJob(completedJob.id, 'done')

      const staleJob = delegationJobs.createDelegationJob({
        kind: 'delegate',
        parentSessionId: 'session-1',
        task: 'stale work',
      })
      delegationJobs.startDelegationJob(staleJob.id)
      const staleRecord = delegationJobs.getDelegationJob(staleJob.id)
      storage.upsertDelegationJob(staleJob.id, {
        ...staleRecord,
        updatedAt: Date.now() - 20 * 60_000,
      })
      const recovered = delegationJobs.recoverStaleDelegationJobs(15 * 60_000)

      console.log(JSON.stringify({
        cancelledCalls,
        cancelled: delegationJobs.getDelegationJob(cancelledJob.id),
        completed: delegationJobs.getDelegationJob(completedJob.id),
        stale: delegationJobs.getDelegationJob(staleJob.id),
        recovered,
      }))
    `)

    assert.equal(output.cancelledCalls, 1)
    assert.equal(output.cancelled.status, 'cancelled')
    assert.equal(output.cancelled.result, null)
    assert.equal(output.completed.status, 'completed')
    assert.equal(output.completed.resultPreview, 'done')
    assert.equal(output.stale.status, 'failed')
    assert.equal(output.recovered, 1)
  })
})
