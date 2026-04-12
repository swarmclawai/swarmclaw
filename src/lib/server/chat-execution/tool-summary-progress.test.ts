import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_SUMMARY_PROGRESS_MIN_DELTA,
  toolSummaryHasMeaningfulProgress,
} from '@/lib/server/chat-execution/tool-summary-progress'

describe('toolSummaryHasMeaningfulProgress (no-progress guard for tool_summary retries)', () => {
  it('allows the first retry even when fullText is empty (sentinel priorLen = -1)', () => {
    assert.equal(toolSummaryHasMeaningfulProgress(-1, 0), true)
  })

  it('allows the first retry even when some text already exists (sentinel priorLen = -1)', () => {
    assert.equal(toolSummaryHasMeaningfulProgress(-1, 9999), true)
  })

  it('skips subsequent retries when the delta is below the minimum', () => {
    assert.equal(toolSummaryHasMeaningfulProgress(100, 105), false)
    assert.equal(toolSummaryHasMeaningfulProgress(100, 100), false)
    // The boundary: exactly MIN_DELTA - 1 still skips.
    assert.equal(
      toolSummaryHasMeaningfulProgress(100, 100 + TOOL_SUMMARY_PROGRESS_MIN_DELTA - 1),
      false,
    )
  })

  it('allows a retry when the delta meets or exceeds the minimum', () => {
    assert.equal(
      toolSummaryHasMeaningfulProgress(100, 100 + TOOL_SUMMARY_PROGRESS_MIN_DELTA),
      true,
    )
    assert.equal(toolSummaryHasMeaningfulProgress(100, 1000), true)
  })

  it('skips retry when fullText SHRANK after a restore — protects against stale priorLen post-rollback', () => {
    // This scenario was the real reason we also added lastToolSummaryTextLen to
    // ChatTurnState snapshot/restore. Here we just verify the math: if priorLen
    // is ahead of currentLen (e.g., rollback happened without syncing the
    // counter), the delta is negative, so the guard correctly skips retry.
    assert.equal(toolSummaryHasMeaningfulProgress(500, 200), false)
  })
})
