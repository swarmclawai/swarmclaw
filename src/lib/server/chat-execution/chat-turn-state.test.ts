import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChatTurnState } from '@/lib/server/chat-execution/chat-turn-state'

describe('ChatTurnState snapshot/restore', () => {
  it('round-trips lastToolSummaryTextLen so a rollback does not skip a legitimate tool_summary retry', () => {
    // Regression: before this field was included in the snapshot, a transient
    // error + restore() would leave lastToolSummaryTextLen ahead of fullText.
    // The no-progress guard in checkToolSummary then saw a negative delta and
    // silently skipped the retry — the model lost its chance to summarize.
    const state = new ChatTurnState()
    state.fullText = 'initial prompt text'
    state.hasToolCalls = true
    const snap = state.snapshot()
    assert.equal(snap.lastToolSummaryTextLen, -1)

    // Simulate a tool_summary retry that advanced the guard counter, then a
    // rollback to the pre-iteration snapshot.
    state.lastToolSummaryTextLen = state.fullText.length
    state.fullText += ' partial speculative output that gets thrown away'
    state.restore(snap)

    assert.equal(state.lastToolSummaryTextLen, -1)
    assert.equal(state.fullText, 'initial prompt text')
  })

  it('preserves an already-advanced lastToolSummaryTextLen across a non-rollback snapshot cycle', () => {
    const state = new ChatTurnState()
    state.fullText = 'Here is the answer.'
    state.lastToolSummaryTextLen = state.fullText.length
    const snap = state.snapshot()

    state.fullText += ' Extended thought.'
    state.restore(snap)

    assert.equal(state.lastToolSummaryTextLen, 'Here is the answer.'.length)
    assert.equal(state.fullText, 'Here is the answer.')
  })
})
