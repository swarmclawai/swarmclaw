import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  computeWakePriority,
  createJobContext,
  resolveRunAt,
  sourceToWakeMode,
  wakeModeToSource,
} from '@/lib/server/runtime/wake-mode'
import type { WakeModeRequest } from '@/lib/server/runtime/wake-mode'

describe('WakeMode', () => {
  describe('computeWakePriority', () => {
    it('returns mode-based default priority when none specified', () => {
      assert.equal(computeWakePriority({ mode: 'immediate' }), 80)
      assert.equal(computeWakePriority({ mode: 'next_heartbeat' }), 40)
      assert.equal(computeWakePriority({ mode: 'scheduled' }), 60)
    })

    it('uses explicit priority when provided', () => {
      assert.equal(computeWakePriority({ mode: 'immediate', priority: 95 }), 95)
      assert.equal(computeWakePriority({ mode: 'next_heartbeat', priority: 10 }), 10)
    })

    it('clamps priority to [0, 100]', () => {
      assert.equal(computeWakePriority({ mode: 'immediate', priority: 150 }), 100)
      assert.equal(computeWakePriority({ mode: 'immediate', priority: -5 }), 0)
    })

    it('ignores non-finite priority values', () => {
      assert.equal(computeWakePriority({ mode: 'immediate', priority: NaN }), 80)
      assert.equal(computeWakePriority({ mode: 'immediate', priority: Infinity }), 80)
    })
  })

  describe('resolveRunAt', () => {
    const NOW = 1_700_000_000_000

    it('returns now for immediate mode', () => {
      assert.equal(resolveRunAt({ mode: 'immediate' }, NOW), NOW)
    })

    it('returns null for next_heartbeat mode (deferred)', () => {
      assert.equal(resolveRunAt({ mode: 'next_heartbeat' }, NOW), null)
    })

    it('returns absolute runAt for scheduled mode', () => {
      const target = NOW + 60_000
      assert.equal(resolveRunAt({ mode: 'scheduled', runAt: target }, NOW), target)
    })

    it('computes runAt from delayMs for scheduled mode', () => {
      assert.equal(resolveRunAt({ mode: 'scheduled', delayMs: 5_000 }, NOW), NOW + 5_000)
    })

    it('clamps scheduled runAt to at least now', () => {
      const pastTime = NOW - 10_000
      assert.equal(resolveRunAt({ mode: 'scheduled', runAt: pastTime }, NOW), NOW)
    })

    it('falls back to now for scheduled mode without runAt or delayMs', () => {
      assert.equal(resolveRunAt({ mode: 'scheduled' }, NOW), NOW)
    })
  })

  describe('wakeModeToSource (backward compat)', () => {
    it('maps immediate to heartbeat-wake', () => {
      assert.equal(wakeModeToSource('immediate'), 'heartbeat-wake')
    })

    it('maps next_heartbeat to heartbeat', () => {
      assert.equal(wakeModeToSource('next_heartbeat'), 'heartbeat')
    })

    it('maps scheduled to heartbeat-wake', () => {
      assert.equal(wakeModeToSource('scheduled'), 'heartbeat-wake')
    })
  })

  describe('sourceToWakeMode (legacy migration)', () => {
    it('infers next_heartbeat from heartbeat source', () => {
      assert.equal(sourceToWakeMode('heartbeat'), 'next_heartbeat')
    })

    it('infers immediate from heartbeat-wake source', () => {
      assert.equal(sourceToWakeMode('heartbeat-wake'), 'immediate')
    })

    it('infers scheduled from schedule-prefixed source', () => {
      assert.equal(sourceToWakeMode('schedule:nightly'), 'scheduled')
    })

    it('defaults to immediate for unknown sources', () => {
      assert.equal(sourceToWakeMode('connector:slack'), 'immediate')
    })
  })

  describe('createJobContext', () => {
    it('creates an isolated context with scratchpad', () => {
      const controller = new AbortController()
      const ctx = createJobContext({
        jobId: 'job-1',
        sessionId: 'sess-1',
        agentId: 'agent-1',
        mode: 'immediate',
        signal: controller.signal,
        source: 'connector:slack',
        reason: 'New message arrived',
      })

      assert.equal(ctx.jobId, 'job-1')
      assert.equal(ctx.sessionId, 'sess-1')
      assert.equal(ctx.agentId, 'agent-1')
      assert.equal(ctx.mode, 'immediate')
      assert.equal(ctx.source, 'connector:slack')
      assert.equal(ctx.reason, 'New message arrived')
      assert.ok(ctx.createdAt > 0)
      assert.equal(ctx.startedAt, undefined)
      assert.equal(ctx.endedAt, undefined)
      assert.ok(ctx.scratchpad instanceof Map)
      assert.equal(ctx.scratchpad.size, 0)
    })

    it('scratchpad isolates state between jobs', () => {
      const controller = new AbortController()
      const ctx1 = createJobContext({
        jobId: 'job-a',
        sessionId: 'sess-1',
        mode: 'immediate',
        signal: controller.signal,
      })
      const ctx2 = createJobContext({
        jobId: 'job-b',
        sessionId: 'sess-1',
        mode: 'next_heartbeat',
        signal: controller.signal,
      })

      ctx1.scratchpad.set('key', 'value-a')
      ctx2.scratchpad.set('key', 'value-b')

      assert.equal(ctx1.scratchpad.get('key'), 'value-a')
      assert.equal(ctx2.scratchpad.get('key'), 'value-b')
    })

    it('captures heartbeat snapshot for isolation', () => {
      const controller = new AbortController()
      const snapshot = '# Heartbeat Tasks\n## Active\n- [ ] Send report'
      const ctx = createJobContext({
        jobId: 'job-snap',
        sessionId: 'sess-1',
        mode: 'next_heartbeat',
        signal: controller.signal,
        heartbeatSnapshot: snapshot,
      })

      assert.equal(ctx.heartbeatSnapshot, snapshot)
    })
  })
})
