import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildToolEventAssistantSummary } from './tool-event-summary'

describe('buildToolEventAssistantSummary', () => {
  it('summarizes completed tool-only runs', () => {
    const summary = buildToolEventAssistantSummary([
      { name: 'browser', input: '{"action":"screenshot"}', output: '/api/uploads/wiki.png' },
      { name: 'send_file', input: '{"filePath":"wiki.png"}', output: '[wiki](/api/uploads/wiki.png)' },
    ])

    assert.equal(
      summary,
      'Used 2 tool calls (`browser`, `send_file`). See tool output above for details.',
    )
  })

  it('summarizes interrupted in-flight tool runs', () => {
    const summary = buildToolEventAssistantSummary(
      [{ name: 'browser', input: '{"action":"navigate"}' }],
      { interrupted: true },
    )

    assert.equal(
      summary,
      'Started 1 tool call (`browser`). Progress was interrupted before completion.',
    )
  })
})
