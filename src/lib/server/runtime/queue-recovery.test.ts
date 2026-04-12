import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir<T extends Record<string, unknown>>(script: string): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-queue-recovery-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        SWARMCLAW_BUILD_MODE: '1',
      },
      encoding: 'utf-8',
      timeout: 15000,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}') as T
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('queue recovery', () => {
  it('processNext recovers orphaned queued tasks and defers them when the agent is disabled', () => {
    const output = runWithTempDataDir<{
      status: string | null
      queued: string[]
      retryDelayMs: number | null
      error: string | null
      deferredReason: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      storage.saveAgents({
        'agent-disabled': {
          id: 'agent-disabled',
          name: 'Disabled Agent',
          provider: 'openai',
          model: 'gpt-test',
          disabled: true,
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveTasks({
        orphaned: {
          id: 'orphaned',
          title: 'Recover me',
          description: 'Queued task missing from the queue array',
          status: 'queued',
          agentId: 'agent-disabled',
          createdAt: now - 5_000,
          updatedAt: now - 5_000,
        },
      })
      storage.saveQueue([])

      await queue.processNext()

      const task = storage.loadTasks().orphaned
      const queueItems = storage.loadQueue()
      console.log(JSON.stringify({
        status: task?.status ?? null,
        queued: queueItems,
        retryDelayMs: typeof task?.retryScheduledAt === 'number' ? task.retryScheduledAt - now : null,
        error: task?.error ?? null,
        deferredReason: task?.deferredReason ?? null,
      }))
    `)

    assert.equal(output.status, 'deferred')
    assert.deepEqual(output.queued, [])
    assert.equal(output.retryDelayMs, null)
    assert.equal(output.error, null)
    assert.ok(output.deferredReason)
    assert.match(output.deferredReason, /disabled/i)
  })

  it('recoverStalledRunningTasks requeues tasks missing startedAt and records the recovery', () => {
    const output = runWithTempDataDir<{
      result: { recovered: number; deadLettered: number }
      status: string | null
      queued: string[]
      retryDelayMs: number | null
      error: string | null
      comment: string | null
      scheduledCalls: number
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      storage.saveTasks({
        broken: {
          id: 'broken',
          title: 'Broken running task',
          description: 'Missing startedAt should be recovered',
          status: 'running',
          agentId: 'agent-a',
          createdAt: now - 20_000,
          updatedAt: now - 15_000,
        },
      })
      storage.saveQueue([])

      const originalSetTimeout = globalThis.setTimeout
      const scheduled = []
      globalThis.setTimeout = (fn, delay, ...args) => {
        scheduled.push(delay)
        return 0
      }
      try {
        const result = queue.recoverStalledRunningTasks()
        const task = storage.loadTasks().broken
        console.log(JSON.stringify({
          result,
          status: task?.status ?? null,
          queued: storage.loadQueue(),
          retryDelayMs: typeof task?.retryScheduledAt === 'number' ? task.retryScheduledAt - now : null,
          error: task?.error ?? null,
          comment: task?.comments?.at(-1)?.text ?? null,
          scheduledCalls: scheduled.length,
        }))
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    `)

    assert.equal(output.result.recovered, 1)
    assert.equal(output.result.deadLettered, 0)
    assert.equal(output.status, 'queued')
    assert.deepEqual(output.queued, ['broken'])
    assert.equal(typeof output.retryDelayMs, 'number')
    assert.ok(output.retryDelayMs !== null)
    assert.ok(output.retryDelayMs >= 25_000 && output.retryDelayMs <= 35_000)
    assert.ok(output.error)
    assert.match(output.error, /missing startedAt/i)
    assert.ok(output.comment)
    assert.match(output.comment, /missing startedAt/i)
    assert.equal(output.scheduledCalls, 1)
  })

  it('recoverStalledRunningTasks preserves retry policy backoff for stalled tasks', () => {
    const output = runWithTempDataDir<{
      result: { recovered: number; deadLettered: number }
      status: string | null
      attempts: number | null
      queued: string[]
      retryDelayMs: number | null
      error: string | null
      heartbeatEnabled: boolean | null
      scheduledCalls: number
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      storage.saveSettings({
        ...storage.loadSettings(),
        taskStallTimeoutMin: 5,
        taskRetryBackoffSec: 90,
      })
      storage.saveSessions({
        'sess-stalled': {
          id: 'sess-stalled',
          agentId: 'agent-a',
          messages: [],
          createdAt: now - 100_000,
          lastActiveAt: now - 5_000,
          heartbeatEnabled: true,
        },
      })
      storage.saveTasks({
        stalled: {
          id: 'stalled',
          title: 'Stalled task',
          description: 'Should use configured backoff when recovered',
          status: 'running',
          agentId: 'agent-a',
          sessionId: 'sess-stalled',
          createdAt: now - 200_000,
          updatedAt: now - 420_000,
          startedAt: now - 420_000,
          maxAttempts: 3,
          attempts: 0,
        },
      })
      storage.saveQueue([])

      const originalSetTimeout = globalThis.setTimeout
      const scheduled = []
      globalThis.setTimeout = (fn, delay, ...args) => {
        scheduled.push(delay)
        return 0
      }
      try {
        const result = queue.recoverStalledRunningTasks()
        const task = storage.loadTasks().stalled
        const session = storage.loadSessions()['sess-stalled']
        console.log(JSON.stringify({
          result,
          status: task?.status ?? null,
          attempts: task?.attempts ?? null,
          queued: storage.loadQueue(),
          retryDelayMs: typeof task?.retryScheduledAt === 'number' ? task.retryScheduledAt - now : null,
          error: task?.error ?? null,
          heartbeatEnabled: session?.heartbeatEnabled ?? null,
          scheduledCalls: scheduled.length,
        }))
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    `)

    assert.equal(output.result.recovered, 1)
    assert.equal(output.result.deadLettered, 0)
    assert.equal(output.status, 'queued')
    assert.equal(output.attempts, 1)
    assert.deepEqual(output.queued, ['stalled'])
    assert.equal(typeof output.retryDelayMs, 'number')
    assert.ok(output.retryDelayMs !== null)
    assert.ok(output.retryDelayMs >= 85_000 && output.retryDelayMs <= 100_000)
    assert.ok(output.error)
    assert.match(output.error, /Retry scheduled after failure/i)
    assert.equal(output.heartbeatEnabled, false)
    assert.equal(output.scheduledCalls, 1)
  })

  it('scheduleRetryOrDeadLetter via stall recovery clears checkoutRunId so the next attempt can check out', () => {
    // Regression: a task transitioning running -> queued on retry must release its
    // prior checkout. Without this, checkoutTask() returns null on every attempt
    // and the orphan-recovery loop burns CPU re-queueing a task that can never run.
    const output = runWithTempDataDir<{
      status: string | null
      checkoutRunId: string | null
      queued: string[]
      attempts: number | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      storage.saveSettings({
        ...storage.loadSettings(),
        taskStallTimeoutMin: 5,
        taskRetryBackoffSec: 30,
      })
      storage.saveTasks({
        stuck: {
          id: 'stuck',
          title: 'Stuck with stale checkout',
          description: 'Running task that stalled and must release its checkout on retry',
          status: 'running',
          agentId: 'agent-a',
          startedAt: now - 600_000,
          updatedAt: now - 600_000,
          createdAt: now - 700_000,
          maxAttempts: 3,
          attempts: 0,
          checkoutRunId: 'stale-run-id',
        },
      })
      storage.saveQueue([])

      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = () => 0
      try {
        queue.recoverStalledRunningTasks()
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }

      const task = storage.loadTasks().stuck
      console.log(JSON.stringify({
        status: task?.status ?? null,
        checkoutRunId: task?.checkoutRunId ?? null,
        queued: storage.loadQueue(),
        attempts: task?.attempts ?? null,
      }))
    `)

    assert.equal(output.status, 'queued', 'task should be requeued for retry')
    assert.equal(output.checkoutRunId, null, 'stale checkoutRunId must be released so retry can check out')
    assert.deepEqual(output.queued, ['stuck'])
    assert.equal(output.attempts, 1)
  })

  it('dead-letter path clears checkoutRunId so terminal tasks do not appear checked-out', () => {
    const output = runWithTempDataDir<{
      status: string | null
      checkoutRunId: string | null
      attempts: number | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const now = Date.now()
      storage.saveSettings({
        ...storage.loadSettings(),
        taskStallTimeoutMin: 5,
      })
      storage.saveTasks({
        doomed: {
          id: 'doomed',
          title: 'Exhausted retries',
          description: 'Task at its last attempt that stalls should dead-letter and release checkout',
          status: 'running',
          agentId: 'agent-a',
          startedAt: now - 600_000,
          updatedAt: now - 600_000,
          createdAt: now - 700_000,
          maxAttempts: 2,
          attempts: 1,
          checkoutRunId: 'stale-run-id',
        },
      })
      storage.saveQueue([])

      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = () => 0
      try {
        queue.recoverStalledRunningTasks()
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }

      const task = storage.loadTasks().doomed
      console.log(JSON.stringify({
        status: task?.status ?? null,
        checkoutRunId: task?.checkoutRunId ?? null,
        attempts: task?.attempts ?? null,
      }))
    `)

    assert.equal(output.status, 'failed', 'task should be dead-lettered after exhausting retries')
    assert.equal(output.checkoutRunId, null, 'dead-lettered tasks must not retain a stale checkoutRunId')
    assert.equal(output.attempts, 2)
  })

  it('resumeQueue restores blocked queued tasks without clobbering their queuedAt timestamp', () => {
    const output = runWithTempDataDir<{
      queued: string[]
      queuedAt: number | null
      status: string | null
    }>(`
      const storageMod = await import('@/lib/server/storage')
      const queueMod = await import('@/lib/server/runtime/queue')
      const storage = storageMod.default || storageMod
      const queue = queueMod.default || queueMod

      const originalQueuedAt = Date.now() - 45_000
      storage.saveTasks({
        dep: {
          id: 'dep',
          title: 'Dependency',
          description: 'Still running',
          status: 'running',
          agentId: 'agent-a',
          createdAt: originalQueuedAt - 10_000,
          updatedAt: originalQueuedAt - 10_000,
          startedAt: originalQueuedAt - 10_000,
        },
        blocked: {
          id: 'blocked',
          title: 'Blocked task',
          description: 'Should be re-added to the queue on boot',
          status: 'queued',
          agentId: 'agent-a',
          blockedBy: ['dep'],
          queuedAt: originalQueuedAt,
          createdAt: originalQueuedAt - 20_000,
          updatedAt: originalQueuedAt - 5_000,
        },
      })
      storage.saveQueue([])

      queue.resumeQueue()

      const task = storage.loadTasks().blocked
      console.log(JSON.stringify({
        queued: storage.loadQueue(),
        queuedAt: task?.queuedAt ?? null,
        status: task?.status ?? null,
      }))
    `)

    assert.deepEqual(output.queued, ['blocked', 'dep'])
    assert.equal(output.status, 'queued')
    assert.equal(typeof output.queuedAt, 'number')
    assert.ok(output.queuedAt !== null)
    assert.ok(output.queuedAt < Date.now() - 30_000)
  })
})
