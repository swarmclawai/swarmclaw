import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

// Suppress unhandled rejections from background drainExecution() calls
// that fail because executeSessionChatTurn has no real LLM provider.
const _suppressedErrors: unknown[] = []
function suppressionHandler(err: unknown) { _suppressedErrors.push(err) }
process.on('unhandledRejection', suppressionHandler)

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let mgr: typeof import('@/lib/server/runtime/session-run-manager')
let storage: typeof import('@/lib/server/storage')

const globalKey = '__swarmclaw_session_run_manager__' as const
type RuntimeState = {
  runningByExecution: Map<string, unknown>
  queueByExecution: Map<string, unknown[]>
  runs: Map<string, unknown>
  recentRunIds: string[]
  promises: Map<string, unknown>
  deferredDrainTimers?: Map<string, ReturnType<typeof setTimeout>>
  activityLeaseRenewTimers?: Map<string, ReturnType<typeof setInterval>>
}

type ManualQueueEntry = {
  executionKey: string
  run: {
    id: string
    sessionId: string
    source: string
    internal: boolean
    mode: 'followup' | 'steer' | 'collect'
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    messagePreview: string
    queuedAt: number
    startedAt?: number
    endedAt?: number
    error?: string
  }
  message: string
  onEvents: Array<(event: unknown) => void>
  signalController: AbortController
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  promise: Promise<unknown>
}

/** Pending promises from fire-and-forget drain calls. We suppress their
 *  rejections and await them in afterEach so node:test doesn't see
 *  "asynchronous activity after the test ended" warnings. */
const pendingPromises: Promise<unknown>[] = []

function resetState() {
  if (mgr && 'resetSessionRunManagerForTests' in mgr && typeof mgr.resetSessionRunManagerForTests === 'function') {
    mgr.resetSessionRunManagerForTests()
    return
  }
  const state = (globalThis as Record<string, unknown>)[globalKey] as RuntimeState | undefined
  if (state) {
    state.runningByExecution.clear()
    state.queueByExecution.clear()
    state.runs.clear()
    state.recentRunIds.length = 0
    state.promises.clear()
    state.deferredDrainTimers?.clear()
    state.activityLeaseRenewTimers?.clear()
  }
}

function getRuntimeState(): RuntimeState {
  return (globalThis as Record<string, unknown>)[globalKey] as RuntimeState
}

function makeManualQueuedEntry(input: {
  sessionId: string
  runId: string
  message: string
  source?: string
  internal?: boolean
  queuedAt?: number
}): { entry: ManualQueueEntry; promise: Promise<unknown> } {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  const entry: ManualQueueEntry = {
    executionKey: `session:${input.sessionId}`,
    run: {
      id: input.runId,
      sessionId: input.sessionId,
      source: input.source || 'chat',
      internal: input.internal === true,
      mode: input.internal ? 'collect' : 'followup',
      status: 'queued',
      messagePreview: input.message,
      queuedAt: input.queuedAt ?? Date.now(),
    },
    message: input.message,
    onEvents: [],
    signalController: new AbortController(),
    resolve,
    reject,
    promise,
  }
  return { entry, promise }
}

function insertManualQueuedEntry(entry: ManualQueueEntry, promise: Promise<unknown>) {
  const state = getRuntimeState()
  state.queueByExecution.set(entry.executionKey, [entry as unknown])
  state.runs.set(entry.run.id, entry.run)
  state.recentRunIds.push(entry.run.id)
  state.promises.set(entry.run.id, promise)
}

/** Wrapper around enqueueSessionRun that captures the run promise to
 *  prevent async-after-test warnings from node:test. */
function enqueue(input: Parameters<typeof mgr.enqueueSessionRun>[0]) {
  const result = mgr.enqueueSessionRun(input)
  const suppressed = result.promise.catch(() => {})
  pendingPromises.push(suppressed)
  return result
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-session-run-mgr-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'

  storage = await import('@/lib/server/storage')
  mgr = await import('@/lib/server/runtime/session-run-manager')
})

function seedSession(id: string) {
  const sessions = storage.loadSessions()
  sessions[id] = {
    id,
    agentId: 'test-agent',
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  }
  storage.saveSessions(sessions)
  const agents = storage.loadAgents()
  if (!agents['test-agent']) {
    agents['test-agent'] = {
      id: 'test-agent',
      name: 'Test Agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a test agent.',
    }
    storage.saveAgents(agents)
  }
}

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
  process.removeListener('unhandledRejection', suppressionHandler)
})

afterEach(async () => {
  // Wait for all background drain activity to settle before resetting state
  await Promise.allSettled(pendingPromises)
  pendingPromises.length = 0
  resetState()
})

describe('session-run-manager', () => {
  it('backfills missing timer maps when hot-reloading over an older singleton shape', () => {
    const output = runWithTempDataDir<{ ok: boolean }>(`
      globalThis.__swarmclaw_session_run_manager__ = {
        runningByExecution: new Map(),
        queueByExecution: new Map(),
        runs: new Map(),
        recentRunIds: [],
        promises: new Map(),
      }

      const mgrMod = await import('./src/lib/server/runtime/session-run-manager.ts')
      const mgr = mgrMod.default || mgrMod
      const result = mgr.enqueueSessionRun({
        sessionId: 'sess-hmr-backfill',
        message: 'hello',
      })
      await result.promise.catch(() => {})

      console.log(JSON.stringify({ ok: typeof result.runId === 'string' && result.runId.length > 0 }))
    `, { prefix: 'swarmclaw-session-run-hmr-' })

    assert.equal(output.ok, true)
  })

  describe('enqueueSessionRun', () => {
    it('returns a run ID and queued position', () => {
      const result = enqueue({
        sessionId: 'sess-1',
        message: 'Hello world',
      })

      assert.ok(result.runId, 'should have a run ID')
      assert.equal(typeof result.runId, 'string')
      assert.equal(typeof result.position, 'number')
      assert.ok(result.promise instanceof Promise, 'should return a promise')
      assert.equal(typeof result.abort, 'function')
      assert.equal(typeof result.unsubscribe, 'function')
    })

    it('registers the run record accessible via getRunById', () => {
      const result = enqueue({
        sessionId: 'sess-2',
        message: 'Test message',
        source: 'chat',
      })

      const run = mgr.getRunById(result.runId)
      assert.ok(run, 'run should exist')
      assert.equal(run.sessionId, 'sess-2')
      assert.equal(run.source, 'chat')
      assert.equal(run.messagePreview, 'Test message')
      assert.ok(run.queuedAt > 0)
    })

    it('truncates message preview to 140 chars', () => {
      const longMessage = 'A'.repeat(200)
      const result = enqueue({
        sessionId: 'sess-trunc',
        message: longMessage,
      })

      const run = mgr.getRunById(result.runId)
      assert.ok(run)
      assert.equal(run.messagePreview.length, 140)
    })

    it('defaults internal to false and source to chat', () => {
      const result = enqueue({
        sessionId: 'sess-defaults',
        message: 'test',
      })

      const run = mgr.getRunById(result.runId)
      assert.ok(run)
      assert.equal(run.internal, false)
      assert.equal(run.source, 'chat')
    })

    it('normalizes mode to followup for non-internal runs', () => {
      const result = enqueue({
        sessionId: 'sess-mode',
        message: 'test',
        internal: false,
      })

      const run = mgr.getRunById(result.runId)
      assert.ok(run)
      assert.equal(run.mode, 'followup')
    })

    it('normalizes mode to collect for internal runs without explicit mode', () => {
      const result = enqueue({
        sessionId: 'sess-mode-int',
        message: 'test',
        internal: true,
      })

      const run = mgr.getRunById(result.runId)
      assert.ok(run)
      assert.equal(run.mode, 'collect')
    })

    it('preserves explicit mode when provided', () => {
      const result = enqueue({
        sessionId: 'sess-explicit-mode',
        message: 'test',
        mode: 'steer',
      })

      const run = mgr.getRunById(result.runId)
      assert.ok(run)
      assert.equal(run.mode, 'steer')
    })
  })

  describe('deduplication', () => {
    it('deduplicates queued runs with the same dedupeKey', () => {
      const first = enqueue({
        sessionId: 'sess-dedup',
        message: 'first run',
      })

      const run1 = enqueue({
        sessionId: 'sess-dedup',
        message: 'deduped message',
        dedupeKey: 'key-1',
      })

      const run2 = enqueue({
        sessionId: 'sess-dedup',
        message: 'duplicate message',
        dedupeKey: 'key-1',
      })

      assert.equal(run2.deduped, true, 'second run should be deduped')
      assert.equal(run2.runId, run1.runId, 'deduped run should share the same run ID')
      assert.ok(first.runId !== run1.runId, 'first run should be different from deduped runs')
    })

    it('does not deduplicate runs without dedupeKey', () => {
      enqueue({ sessionId: 'sess-no-dedup', message: 'occupier' })

      const run1 = enqueue({ sessionId: 'sess-no-dedup', message: 'msg1' })
      const run2 = enqueue({ sessionId: 'sess-no-dedup', message: 'msg2' })

      assert.ok(run1.runId !== run2.runId, 'runs without dedupeKey should have different IDs')
      assert.equal(run2.deduped, undefined)
    })

    it('does not deduplicate runs with different dedupeKeys', () => {
      enqueue({ sessionId: 'sess-diff-keys', message: 'occupier' })

      const run1 = enqueue({
        sessionId: 'sess-diff-keys',
        message: 'msg1',
        dedupeKey: 'alpha',
      })

      const run2 = enqueue({
        sessionId: 'sess-diff-keys',
        message: 'msg2',
        dedupeKey: 'beta',
      })

      assert.ok(run1.runId !== run2.runId)
      assert.equal(run2.deduped, undefined)
    })
  })

  describe('collect mode coalescing', () => {
    it('coalesces internal collect-mode messages within the time window', () => {
      enqueue({ sessionId: 'sess-coalesce', message: 'occupier' })

      const run1 = enqueue({
        sessionId: 'sess-coalesce',
        message: 'first collect',
        internal: true,
        source: 'heartbeat',
        mode: 'collect',
      })

      const run2 = enqueue({
        sessionId: 'sess-coalesce',
        message: 'second collect',
        internal: true,
        source: 'heartbeat',
        mode: 'collect',
      })

      assert.equal(run2.coalesced, true, 'second collect should be coalesced')
      assert.equal(run2.runId, run1.runId, 'coalesced run should share the same run ID')
    })

    it('does not coalesce messages with different sources', () => {
      enqueue({ sessionId: 'sess-no-coalesce-src', message: 'occupier' })

      const run1 = enqueue({
        sessionId: 'sess-no-coalesce-src',
        message: 'first',
        internal: true,
        source: 'heartbeat',
        mode: 'collect',
      })

      const run2 = enqueue({
        sessionId: 'sess-no-coalesce-src',
        message: 'second',
        internal: true,
        source: 'other-source',
        mode: 'collect',
      })

      assert.ok(run1.runId !== run2.runId, 'different sources should not coalesce')
    })

    it('does not coalesce when there are image attachments', () => {
      enqueue({ sessionId: 'sess-no-coalesce-img', message: 'occupier' })

      const run1 = enqueue({
        sessionId: 'sess-no-coalesce-img',
        message: 'first',
        internal: true,
        source: 'heartbeat',
        mode: 'collect',
      })

      const run2 = enqueue({
        sessionId: 'sess-no-coalesce-img',
        message: 'second with image',
        internal: true,
        source: 'heartbeat',
        mode: 'collect',
        imagePath: '/path/to/image.png',
      })

      assert.ok(run1.runId !== run2.runId, 'image attachments should prevent coalescing')
    })
  })

  describe('getSessionRunState / getSessionExecutionState', () => {
    it('returns empty state for unknown session', () => {
      const state = mgr.getSessionRunState('unknown-session')
      assert.equal(state.runningRunId, undefined)
      assert.equal(state.queueLength, 0)
    })

    it('returns execution state with queue info', () => {
      enqueue({ sessionId: 'sess-state', message: 'running' })
      enqueue({ sessionId: 'sess-state', message: 'queued 1' })

      const state = mgr.getSessionExecutionState('sess-state')
      assert.equal(state.hasQueued, true)
      assert.ok(state.queueLength >= 1)
    })

    it('reports heartbeat vs non-heartbeat queued runs', () => {
      enqueue({ sessionId: 'sess-hb-state', message: 'occupier' })
      enqueue({
        sessionId: 'sess-hb-state',
        message: 'hb',
        internal: true,
        source: 'heartbeat',
      })
      enqueue({
        sessionId: 'sess-hb-state',
        message: 'user',
        internal: false,
        source: 'chat',
      })

      const state = mgr.getSessionExecutionState('sess-hb-state')
      assert.equal(state.hasQueuedHeartbeat, true)
      assert.equal(state.hasQueuedNonHeartbeat, true)
    })

    it('publishes a shared non-heartbeat activity lease for user work', () => {
      enqueue({ sessionId: 'sess-lease', message: 'user work', source: 'chat' })

      assert.equal(mgr.hasActiveNonHeartbeatSessionLease('sess-lease'), true)
    })

    it('does not publish the shared activity lease for heartbeat-only work', () => {
      enqueue({
        sessionId: 'sess-heartbeat-only',
        message: 'hb',
        internal: true,
        source: 'heartbeat-wake',
      })

      assert.equal(mgr.hasActiveNonHeartbeatSessionLease('sess-heartbeat-only'), false)
    })
  })

  describe('listRuns', () => {
    it('lists all runs in reverse chronological order', () => {
      enqueue({ sessionId: 'sess-list-a', message: 'msg a' })
      enqueue({ sessionId: 'sess-list-b', message: 'msg b' })

      const runs = mgr.listRuns()
      assert.ok(runs.length >= 2)
      const idxA = runs.findIndex(r => r.sessionId === 'sess-list-a')
      const idxB = runs.findIndex(r => r.sessionId === 'sess-list-b')
      assert.ok(idxB < idxA, 'more recent run should be first')
    })

    it('filters by sessionId', () => {
      enqueue({ sessionId: 'sess-filter-a', message: 'a' })
      enqueue({ sessionId: 'sess-filter-b', message: 'b' })

      const runs = mgr.listRuns({ sessionId: 'sess-filter-a' })
      assert.ok(runs.length >= 1)
      for (const run of runs) {
        assert.equal(run.sessionId, 'sess-filter-a')
      }
    })

    it('filters by status', () => {
      enqueue({ sessionId: 'sess-status-a', message: 'a' })
      enqueue({ sessionId: 'sess-status-b', message: 'b' })

      // At least one should be queued synchronously
      const queued = mgr.listRuns({ status: 'queued' })
      // We just verify the filter doesn't crash and returns consistent data
      for (const run of queued) {
        assert.equal(run.status, 'queued')
      }
    })

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        enqueue({ sessionId: `sess-limit-${i}`, message: `msg ${i}` })
      }

      const runs = mgr.listRuns({ limit: 2 })
      assert.equal(runs.length, 2)
    })
  })

  describe('cancelSessionRuns', () => {
    it('cancels queued runs for a session', () => {
      enqueue({ sessionId: 'sess-cancel', message: 'running' })
      enqueue({ sessionId: 'sess-cancel', message: 'queued 1' })
      enqueue({ sessionId: 'sess-cancel', message: 'queued 2' })

      const result = mgr.cancelSessionRuns('sess-cancel', 'User cancelled')
      assert.ok(result.cancelledQueued >= 2, `should cancel at least 2 queued runs, got ${result.cancelledQueued}`)
    })

    it('returns zero when no runs exist for session', () => {
      const result = mgr.cancelSessionRuns('nonexistent-session')
      assert.equal(result.cancelledQueued, 0)
      assert.equal(result.cancelledRunning, false)
    })

    it('does not cancel runs for other sessions', () => {
      enqueue({ sessionId: 'sess-keep', message: 'keep me' })
      enqueue({ sessionId: 'sess-cancel-other', message: 'cancel me' })

      mgr.cancelSessionRuns('sess-cancel-other', 'cancelled')

      const keepRuns = mgr.listRuns({ sessionId: 'sess-keep' })
      assert.ok(keepRuns.length >= 1, 'runs for other session should be preserved')
      const keptRun = keepRuns.find(r => r.status !== 'cancelled')
      assert.ok(keptRun, 'kept session run should not be cancelled')
    })
  })

  describe('steer mode', () => {
    it('cancels pending queued runs when steer mode is used', () => {
      enqueue({ sessionId: 'sess-steer', message: 'running' })
      enqueue({ sessionId: 'sess-steer', message: 'queued 1' })
      enqueue({ sessionId: 'sess-steer', message: 'queued 2' })

      const steer = enqueue({
        sessionId: 'sess-steer',
        message: 'steer message',
        mode: 'steer',
      })

      assert.ok(steer.runId)
      const steerRun = mgr.getRunById(steer.runId)
      assert.ok(steerRun)
      assert.notEqual(steerRun.status, 'cancelled')
    })

    it('steer marks previously queued runs as cancelled', () => {
      enqueue({ sessionId: 'sess-steer-verify', message: 'occupier' })
      const q1 = enqueue({ sessionId: 'sess-steer-verify', message: 'will be cancelled' })
      const q2 = enqueue({ sessionId: 'sess-steer-verify', message: 'also cancelled' })

      enqueue({
        sessionId: 'sess-steer-verify',
        message: 'steer',
        mode: 'steer',
      })

      const run1 = mgr.getRunById(q1.runId)
      const run2 = mgr.getRunById(q2.runId)
      assert.ok(run1)
      assert.ok(run2)
      assert.equal(run1.status, 'cancelled')
      assert.equal(run2.status, 'cancelled')
    })
  })

  describe('abort and unsubscribe', () => {
    it('abort function is callable without error', () => {
      const result = enqueue({
        sessionId: 'sess-abort',
        message: 'abort me',
      })
      assert.doesNotThrow(() => result.abort())
    })

    it('unsubscribe removes the event listener', () => {
      const events: unknown[] = []
      const result = enqueue({
        sessionId: 'sess-unsub',
        message: 'test',
        onEvent: (event) => events.push(event),
      })
      assert.doesNotThrow(() => result.unsubscribe())
    })
  })

  describe('callerSignal chaining', () => {
    it('propagates an already-aborted callerSignal', () => {
      const controller = new AbortController()
      controller.abort()

      const result = enqueue({
        sessionId: 'sess-pre-aborted',
        message: 'test',
        callerSignal: controller.signal,
      })

      assert.doesNotThrow(() => result.abort())
    })

    it('chains a live callerSignal to the run', () => {
      const controller = new AbortController()

      const result = enqueue({
        sessionId: 'sess-live-signal',
        message: 'test',
        callerSignal: controller.signal,
      })

      // Aborting the caller should work without throwing
      assert.doesNotThrow(() => controller.abort())
      assert.ok(result.runId)
    })
  })

  describe('run completion and drain', () => {
    it('run eventually transitions from queued to a terminal state', async () => {
      seedSession('sess-terminal')
      const result = enqueue({
        sessionId: 'sess-terminal',
        message: 'will fail in drain',
      })

      // Wait for drain to process
      await result.promise.catch(() => {})

      const run = mgr.getRunById(result.runId)
      assert.ok(run, 'run should still exist')
      const terminal = ['completed', 'failed', 'cancelled']
      assert.ok(
        terminal.includes(run.status),
        `run status should be terminal, got: ${run.status}`,
      )
    })

    it('drain processes next queued run after current completes', async () => {
      seedSession('sess-drain-chain')
      const result1 = enqueue({
        sessionId: 'sess-drain-chain',
        message: 'first',
      })
      const result2 = enqueue({
        sessionId: 'sess-drain-chain',
        message: 'second',
      })

      // Wait for both drains to process
      await Promise.allSettled([result1.promise, result2.promise])

      const run1 = mgr.getRunById(result1.runId)
      const run2 = mgr.getRunById(result2.runId)
      assert.ok(run1)
      assert.ok(run2)
      assert.notEqual(run1.status, 'queued', 'first run should not still be queued')
      assert.notEqual(run2.status, 'queued', 'second run should not still be queued')
    })

    it('failed run records error message', async () => {
      seedSession('sess-fail-error')
      const result = enqueue({
        sessionId: 'sess-fail-error',
        message: 'will error',
      })

      await result.promise.catch(() => {})

      const run = mgr.getRunById(result.runId)
      assert.ok(run)
      if (run.status === 'failed') {
        assert.ok(run.error, 'failed run should have an error message')
        assert.ok(run.endedAt, 'failed run should have endedAt timestamp')
      }
    })

    it('clears the shared activity lease after non-heartbeat work finishes', async () => {
      seedSession('sess-lease-clear')
      const result = enqueue({
        sessionId: 'sess-lease-clear',
        message: 'will fail in drain',
      })

      assert.equal(mgr.hasActiveNonHeartbeatSessionLease('sess-lease-clear'), true)
      await result.promise.catch(() => {})
      assert.equal(mgr.hasActiveNonHeartbeatSessionLease('sess-lease-clear'), false)
    })

    it('defers heartbeat runs while another worker advertises non-heartbeat activity', async () => {
      seedSession('sess-remote-busy')
      storage.tryAcquireRuntimeLock('session-non-heartbeat:sess-remote-busy', 'remote-worker', 60_000)

      const heartbeat = enqueue({
        sessionId: 'sess-remote-busy',
        message: 'hb',
        internal: true,
        source: 'heartbeat-wake',
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      const queued = mgr.getRunById(heartbeat.runId)
      assert.ok(queued)
      assert.equal(queued.status, 'queued')

      storage.releaseRuntimeLock('session-non-heartbeat:sess-remote-busy', 'remote-worker')
      await heartbeat.promise.catch(() => {})

      const finished = mgr.getRunById(heartbeat.runId)
      assert.ok(finished)
      assert.notEqual(finished.status, 'queued')
    })

    it('re-kicks a recent queued entry when the execution lane is idle', async () => {
      seedSession('sess-rekick')
      const runId = 'manual-rekick'
      const { entry, promise } = makeManualQueuedEntry({
        sessionId: 'sess-rekick',
        runId,
        message: 'recover me',
      })
      insertManualQueuedEntry(entry, promise)

      const repair = mgr.repairSessionRunQueue('sess-rekick')
      assert.equal(repair.recoveredQueuedRuns, 0)
      assert.equal(repair.kickedExecutionKeys, 1)

      await promise.catch(() => {})

      const run = mgr.getRunById(runId)
      assert.ok(run)
      assert.notEqual(run.status, 'queued')
    })

    it('recovers stale queued runs before a fresh enqueue can get wedged behind them', async () => {
      seedSession('sess-stale-recover')
      const staleRunId = 'manual-stale'
      const { entry, promise } = makeManualQueuedEntry({
        sessionId: 'sess-stale-recover',
        runId: staleRunId,
        message: 'ghost queued run',
        queuedAt: Date.now() - 60_000,
      })
      insertManualQueuedEntry(entry, promise)

      const fresh = enqueue({
        sessionId: 'sess-stale-recover',
        message: 'fresh message',
      })

      const staleResult = await promise
      assert.deepEqual(staleResult, {
        runId: staleRunId,
        sessionId: 'sess-stale-recover',
        text: '',
        persisted: false,
        toolEvents: [],
        error: 'Recovered stale queued run before enqueue',
      })

      const staleRun = mgr.getRunById(staleRunId)
      assert.ok(staleRun)
      assert.equal(staleRun.status, 'failed')

      const execution = mgr.getSessionExecutionState('sess-stale-recover')
      assert.ok(execution.queueLength <= 1, `expected stale run to be cleared, got queueLength=${execution.queueLength}`)

      await fresh.promise.catch(() => {})
      const freshRun = mgr.getRunById(fresh.runId)
      assert.ok(freshRun)
      assert.notEqual(freshRun.status, 'queued')
    })
  })

  describe('cancelAllHeartbeatRuns', () => {
    it('cancels queued heartbeat runs but keeps non-heartbeat runs', () => {
      enqueue({ sessionId: 'sess-hb-cancel', message: 'occupier' })

      enqueue({
        sessionId: 'sess-hb-cancel',
        message: 'heartbeat msg',
        internal: true,
        source: 'heartbeat',
      })

      enqueue({
        sessionId: 'sess-hb-cancel',
        message: 'user msg',
        internal: false,
        source: 'chat',
      })

      const result = mgr.cancelAllHeartbeatRuns('Test cancellation')
      assert.ok(result.cancelledQueued >= 1, 'should cancel at least 1 queued heartbeat')
    })

    it('returns zeros when no heartbeat runs exist', () => {
      const result = mgr.cancelAllHeartbeatRuns()
      assert.equal(result.cancelledQueued, 0)
      assert.equal(result.abortedRunning, 0)
    })

    it('preserves non-heartbeat queued runs', () => {
      enqueue({ sessionId: 'sess-hb-keep', message: 'occupier' })

      enqueue({
        sessionId: 'sess-hb-keep',
        message: 'heartbeat',
        internal: true,
        source: 'heartbeat',
      })

      const userRun = enqueue({
        sessionId: 'sess-hb-keep',
        message: 'user chat',
        internal: false,
        source: 'chat',
      })

      mgr.cancelAllHeartbeatRuns()

      const userRunRecord = mgr.getRunById(userRun.runId)
      assert.ok(userRunRecord)
      assert.notEqual(userRunRecord.status, 'cancelled', 'non-heartbeat run should not be cancelled')
    })
  })

  describe('getRunById', () => {
    it('returns null for non-existent run', () => {
      assert.equal(mgr.getRunById('nonexistent'), null)
    })
  })
})
