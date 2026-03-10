import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  cancelScheduledWake,
  dispatchWake,
  drainDeferredWakes,
  endJobExecution,
  getActiveJob,
  getActiveJobsForSession,
  getWakeDispatcherStatus,
  hasDeferredWakes,
  resetWakeDispatcherForTests,
  startJobExecution,
} from '@/lib/server/runtime/wake-dispatcher'
import { resetHeartbeatWakeStateForTests, snapshotPendingHeartbeatWakesForTests } from '@/lib/server/runtime/heartbeat-wake'

describe('wake-dispatcher', () => {
  afterEach(() => {
    resetWakeDispatcherForTests()
    resetHeartbeatWakeStateForTests()
  })

  describe('dispatchWake — immediate mode', () => {
    it('dispatches to heartbeat-wake pending queue', () => {
      const result = dispatchWake({
        mode: 'immediate',
        sessionId: 'sess-1',
        reason: 'connector-message',
        source: 'connector:slack',
        resumeMessage: 'New message from Slack.',
      })

      assert.equal(result.mode, 'immediate')
      assert.equal(result.priority, 80)
      assert.ok(result.runAt !== null)
      assert.ok(result.jobId.length > 0)

      // Should appear in heartbeat-wake pending state
      const pending = snapshotPendingHeartbeatWakesForTests()
      assert.equal(pending.length, 1)
      assert.equal(pending[0].sessionId, 'sess-1')
      assert.equal(pending[0].events[0].reason, 'connector-message')
    })

    it('respects explicit priority override', () => {
      const result = dispatchWake({
        mode: 'immediate',
        sessionId: 'sess-1',
        reason: 'approval',
        priority: 95,
      })

      assert.equal(result.priority, 95)
    })
  })

  describe('dispatchWake — next_heartbeat mode', () => {
    it('queues in the deferred queue instead of firing immediately', () => {
      const result = dispatchWake({
        mode: 'next_heartbeat',
        agentId: 'agent-1',
        sessionId: 'sess-1',
        reason: 'low-priority-poll',
      })

      assert.equal(result.mode, 'next_heartbeat')
      assert.equal(result.priority, 40)
      assert.equal(result.runAt, null)

      // Should NOT appear in heartbeat-wake pending state
      const pending = snapshotPendingHeartbeatWakesForTests()
      assert.equal(pending.length, 0)

      // Should be in the deferred queue
      assert.equal(hasDeferredWakes('agent-1', 'sess-1'), true)
    })

    it('deduplicates by reason+source', () => {
      dispatchWake({
        mode: 'next_heartbeat',
        agentId: 'a1',
        sessionId: 's1',
        reason: 'poll',
        source: 'system',
      })
      dispatchWake({
        mode: 'next_heartbeat',
        agentId: 'a1',
        sessionId: 's1',
        reason: 'poll',
        source: 'system',
      })

      const drained = drainDeferredWakes('a1', 's1')
      assert.equal(drained.length, 1)
    })

    it('preserves distinct reasons', () => {
      dispatchWake({
        mode: 'next_heartbeat',
        agentId: 'a1',
        sessionId: 's1',
        reason: 'poll',
        source: 'system',
      })
      dispatchWake({
        mode: 'next_heartbeat',
        agentId: 'a1',
        sessionId: 's1',
        reason: 'check-email',
        source: 'system',
      })

      const drained = drainDeferredWakes('a1', 's1')
      assert.equal(drained.length, 2)
      assert.deepEqual(drained.map((d) => d.reason).sort(), ['check-email', 'poll'])
    })

    it('drainDeferredWakes clears the queue', () => {
      dispatchWake({
        mode: 'next_heartbeat',
        agentId: 'a1',
        sessionId: 's1',
        reason: 'poll',
      })

      assert.equal(hasDeferredWakes('a1', 's1'), true)
      const first = drainDeferredWakes('a1', 's1')
      assert.equal(first.length, 1)

      // Second drain returns empty
      assert.equal(hasDeferredWakes('a1', 's1'), false)
      const second = drainDeferredWakes('a1', 's1')
      assert.equal(second.length, 0)
    })
  })

  describe('dispatchWake — scheduled mode', () => {
    it('fires immediately when target time is in the past', () => {
      const result = dispatchWake({
        mode: 'scheduled',
        sessionId: 'sess-1',
        reason: 'overdue-schedule',
        runAt: Date.now() - 1000,
      })

      assert.equal(result.mode, 'scheduled')

      // Should have dispatched as immediate (appears in heartbeat-wake queue)
      const pending = snapshotPendingHeartbeatWakesForTests()
      assert.equal(pending.length, 1)
    })

    it('creates a scheduled timer for future execution', () => {
      const result = dispatchWake({
        mode: 'scheduled',
        sessionId: 'sess-1',
        reason: 'future-task',
        delayMs: 60_000,
      })

      assert.equal(result.mode, 'scheduled')
      assert.ok(result.runAt !== null && result.runAt > Date.now())

      const status = getWakeDispatcherStatus()
      assert.equal(status.scheduledTimerCount, 1)

      // Not yet in heartbeat-wake queue
      const pending = snapshotPendingHeartbeatWakesForTests()
      assert.equal(pending.length, 0)
    })

    it('cancelScheduledWake removes the timer', () => {
      const result = dispatchWake({
        mode: 'scheduled',
        sessionId: 'sess-1',
        reason: 'cancellable',
        delayMs: 300_000,
      })

      assert.equal(getWakeDispatcherStatus().scheduledTimerCount, 1)
      const cancelled = cancelScheduledWake(result.jobId)
      assert.equal(cancelled, true)
      assert.equal(getWakeDispatcherStatus().scheduledTimerCount, 0)
    })
  })

  describe('job context management', () => {
    it('startJobExecution creates an isolated context', () => {
      const controller = new AbortController()
      const ctx = startJobExecution({
        sessionId: 'sess-1',
        agentId: 'agent-1',
        mode: 'immediate',
        signal: controller.signal,
        source: 'connector:slack',
        reason: 'New message',
        heartbeatSnapshot: '# Tasks\n- [ ] Check weather',
      })

      assert.ok(ctx.jobId.length > 0)
      assert.equal(ctx.sessionId, 'sess-1')
      assert.equal(ctx.mode, 'immediate')
      assert.ok(ctx.startedAt! > 0)
      assert.equal(ctx.heartbeatSnapshot, '# Tasks\n- [ ] Check weather')

      // Verify it's registered
      const retrieved = getActiveJob(ctx.jobId)
      assert.ok(retrieved)
      assert.equal(retrieved!.jobId, ctx.jobId)
    })

    it('endJobExecution removes from active tracking', () => {
      const controller = new AbortController()
      const ctx = startJobExecution({
        sessionId: 'sess-1',
        mode: 'immediate',
        signal: controller.signal,
      })

      const ended = endJobExecution(ctx.jobId)
      assert.ok(ended)
      assert.ok(ended!.endedAt! > 0)

      // No longer active
      assert.equal(getActiveJob(ctx.jobId), null)
    })

    it('getActiveJobsForSession lists jobs for a session', () => {
      const controller = new AbortController()
      startJobExecution({
        sessionId: 'sess-1',
        mode: 'immediate',
        signal: controller.signal,
      })
      startJobExecution({
        sessionId: 'sess-1',
        mode: 'next_heartbeat',
        signal: controller.signal,
      })
      startJobExecution({
        sessionId: 'sess-2',
        mode: 'immediate',
        signal: controller.signal,
      })

      const jobs = getActiveJobsForSession('sess-1')
      assert.equal(jobs.length, 2)
      assert.ok(jobs.every((j) => j.sessionId === 'sess-1'))
    })

    it('scratchpad provides per-job isolation', () => {
      const controller = new AbortController()
      const job1 = startJobExecution({
        sessionId: 'sess-1',
        mode: 'immediate',
        signal: controller.signal,
      })
      const job2 = startJobExecution({
        sessionId: 'sess-1',
        mode: 'immediate',
        signal: controller.signal,
      })

      job1.scratchpad.set('result', 'job1-data')
      job2.scratchpad.set('result', 'job2-data')

      assert.equal(getActiveJob(job1.jobId)!.scratchpad.get('result'), 'job1-data')
      assert.equal(getActiveJob(job2.jobId)!.scratchpad.get('result'), 'job2-data')
    })
  })

  describe('diagnostics', () => {
    it('getWakeDispatcherStatus reports queue depths', () => {
      const controller = new AbortController()

      dispatchWake({ mode: 'next_heartbeat', agentId: 'a1', sessionId: 's1', reason: 'poll' })
      dispatchWake({ mode: 'next_heartbeat', agentId: 'a1', sessionId: 's1', reason: 'check' })
      dispatchWake({ mode: 'scheduled', sessionId: 's2', reason: 'future', delayMs: 60_000 })
      startJobExecution({ sessionId: 's1', mode: 'immediate', signal: controller.signal })

      const status = getWakeDispatcherStatus()
      assert.equal(status.deferredQueueCount, 2)
      assert.equal(status.scheduledTimerCount, 1)
      assert.equal(status.activeJobCount, 1)
    })

    it('resetWakeDispatcherForTests clears all state', () => {
      const controller = new AbortController()
      dispatchWake({ mode: 'next_heartbeat', agentId: 'a1', sessionId: 's1', reason: 'poll' })
      dispatchWake({ mode: 'scheduled', sessionId: 's2', reason: 'future', delayMs: 60_000 })
      startJobExecution({ sessionId: 's1', mode: 'immediate', signal: controller.signal })

      resetWakeDispatcherForTests()

      const status = getWakeDispatcherStatus()
      assert.equal(status.deferredQueueCount, 0)
      assert.equal(status.scheduledTimerCount, 0)
      assert.equal(status.activeJobCount, 0)
    })
  })
})
