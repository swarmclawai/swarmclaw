import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IterationTimers } from './iteration-timers'

function makeTimers(opts?: { streamIdleStallMs?: number; initialPrefillStallMs?: number }) {
  const controller = new AbortController()
  const timers = new IterationTimers(controller, {
    streamIdleStallMs: opts?.streamIdleStallMs ?? 100,
    initialPrefillStallMs: opts?.initialPrefillStallMs,
    requiredToolKickoffMs: 5000,
    shouldEnforceEarlyRequiredToolKickoff: false,
  })
  return { timers, controller }
}

describe('IterationTimers', () => {
  it('first arm uses initialPrefillStallMs when provided', async () => {
    const { timers, controller } = makeTimers({
      streamIdleStallMs: 50,
      initialPrefillStallMs: 200,
    })

    timers.armIdleWatchdog(false)

    // After 50ms (streamIdleStallMs), should NOT have timed out
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(timers.idleTimedOut, false, 'should not time out at streamIdleStallMs')

    // After 200ms (initialPrefillStallMs), should have timed out
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(timers.idleTimedOut, true, 'should time out at initialPrefillStallMs')
    assert.equal(controller.signal.aborted, true)

    timers.clearAll()
  })

  it('second arm uses streamIdleStallMs (not prefill)', async () => {
    const { timers, controller } = makeTimers({
      streamIdleStallMs: 50,
      initialPrefillStallMs: 500,
    })

    // First arm — uses prefill timeout
    timers.armIdleWatchdog(false)
    // Immediately re-arm (simulates receiving a stream token)
    timers.armIdleWatchdog(false)

    // After 80ms (> streamIdleStallMs), should have timed out
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(timers.idleTimedOut, true, 'second arm should use streamIdleStallMs')
    assert.equal(controller.signal.aborted, true)

    timers.clearAll()
  })

  it('defaults initialPrefillStallMs to 2x streamIdleStallMs when not set', async () => {
    const { timers } = makeTimers({
      streamIdleStallMs: 60,
      // initialPrefillStallMs not set — should default to 120
    })

    timers.armIdleWatchdog(false)

    // After 80ms (> 60ms but < 120ms), should NOT have timed out
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(timers.idleTimedOut, false, 'should not time out before 2x default')

    // After 60 more ms (total ~140ms, > 120ms), should have timed out
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(timers.idleTimedOut, true, 'should time out at 2x default')

    timers.clearAll()
  })

  it('does not arm when waitingForToolResult is true', () => {
    const { timers } = makeTimers({ streamIdleStallMs: 10 })

    timers.armIdleWatchdog(true)

    // Timer should not be set
    assert.equal(timers.idleTimedOut, false)
    timers.clearAll()
  })
})
