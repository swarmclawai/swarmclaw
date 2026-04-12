import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LangGraphToolEventTracker, isLangGraphToolNodeMetadata } from '@/lib/server/chat-execution/tool-event-tracker'

describe('tool-event-tracker', () => {
  it('accepts only LangGraph tool-node events', () => {
    assert.equal(isLangGraphToolNodeMetadata(undefined), false)
    assert.equal(isLangGraphToolNodeMetadata({}), false)
    assert.equal(isLangGraphToolNodeMetadata({ langgraph_node: 'tools' }), true)
    assert.equal(isLangGraphToolNodeMetadata({ __pregel_task_id: 'task_123' }), true)
  })

  it('tracks distinct accepted run ids without collapsing repeated tool inputs', () => {
    const tracker = new LangGraphToolEventTracker()
    const metadata = { langgraph_node: 'tools', __pregel_task_id: 'task_123' }

    assert.equal(tracker.acceptStart({ run_id: 'run_1', metadata }), true)
    assert.equal(tracker.acceptStart({ run_id: 'run_2', metadata }), true)
    assert.equal(tracker.pendingCount, 2)

    assert.equal(tracker.complete('run_1'), true)
    assert.equal(tracker.pendingCount, 1)
    assert.deepEqual(tracker.listPendingRunIds(), ['run_2'])

    assert.equal(tracker.complete('run_2'), true)
    assert.equal(tracker.pendingCount, 0)
  })

  it('ignores nested wrapper events that lack LangGraph tool metadata', () => {
    const tracker = new LangGraphToolEventTracker()

    assert.equal(tracker.acceptStart({ run_id: 'nested_1', metadata: {} }), false)
    assert.equal(tracker.complete('nested_1'), false)
    assert.equal(tracker.pendingCount, 0)
  })

  it('suppresses duplicate parallel tool_calls with identical name+input in the same turn', () => {
    const tracker = new LangGraphToolEventTracker()
    const metadata = { langgraph_node: 'tools' }
    const event = { name: 'files', data: { input: { action: 'write', path: '/tmp/x' } }, metadata }

    // First acceptance emits; second identical call is swallowed.
    assert.equal(tracker.acceptStart({ run_id: 'r1', ...event }), true)
    assert.equal(tracker.acceptStart({ run_id: 'r2', ...event }), false)
    assert.equal(tracker.pendingCount, 1)

    // complete() returns false for the suppressed one so the caller skips its result too.
    assert.equal(tracker.complete('r2'), false)
    assert.equal(tracker.complete('r1'), true)
    assert.equal(tracker.pendingCount, 0)

    // After the first call fully completes, a legitimately later identical call is accepted.
    assert.equal(tracker.acceptStart({ run_id: 'r3', ...event }), true)
    assert.equal(tracker.complete('r3'), true)
  })

  it('does not leak the accepted run if the same run_id re-enters acceptStart', () => {
    // Guards against replayed start events (e.g., HMR, graph retries) causing
    // the same run_id to be recorded both as accepted and suppressed, which
    // would leave pendingCount > 0 after complete().
    const tracker = new LangGraphToolEventTracker()
    const metadata = { langgraph_node: 'tools' }
    const event = { name: 'shell', data: { input: { cmd: 'ls' } }, metadata }

    assert.equal(tracker.acceptStart({ run_id: 'same', ...event }), true)
    assert.equal(tracker.acceptStart({ run_id: 'same', ...event }), false)
    assert.equal(tracker.pendingCount, 1)
    assert.equal(tracker.complete('same'), true)
    assert.equal(tracker.pendingCount, 0)
  })

  it('handles triple-duplicate (2 suppressed) parallel tool_calls cleanly', () => {
    const tracker = new LangGraphToolEventTracker()
    const metadata = { langgraph_node: 'tools' }
    const event = { name: 'files', data: { input: { action: 'read', path: '/a' } }, metadata }

    assert.equal(tracker.acceptStart({ run_id: 'r1', ...event }), true)
    assert.equal(tracker.acceptStart({ run_id: 'r2', ...event }), false)
    assert.equal(tracker.acceptStart({ run_id: 'r3', ...event }), false)
    assert.equal(tracker.pendingCount, 1)

    // Out-of-order completions still settle correctly.
    assert.equal(tracker.complete('r3'), false)
    assert.equal(tracker.complete('r1'), true)
    assert.equal(tracker.complete('r2'), false)
    assert.equal(tracker.pendingCount, 0)
  })

  it('distinct inputs produce distinct signatures and both are accepted', () => {
    const tracker = new LangGraphToolEventTracker()
    const metadata = { langgraph_node: 'tools' }

    assert.equal(tracker.acceptStart({
      run_id: 'a', name: 'files', data: { input: { path: '/a' } }, metadata,
    }), true)
    assert.equal(tracker.acceptStart({
      run_id: 'b', name: 'files', data: { input: { path: '/b' } }, metadata,
    }), true)
    assert.equal(tracker.pendingCount, 2)
    assert.equal(tracker.complete('a'), true)
    assert.equal(tracker.complete('b'), true)
  })
})
