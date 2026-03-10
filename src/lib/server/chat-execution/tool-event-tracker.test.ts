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
})
