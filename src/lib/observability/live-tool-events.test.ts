import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { applyStreamingToolCall, applyStreamingToolResult, isLikelyToolErrorOutput } from '@/lib/observability/live-tool-events'

describe('live tool events', () => {
  it('dedupes consecutive identical pending tool calls', () => {
    const first = applyStreamingToolCall([], {
      toolName: 'browser',
      toolInput: '{"action":"navigate","url":"https://example.com"}',
      toolCallId: 'call-1',
    }, 'fallback-1')

    const second = applyStreamingToolCall(first, {
      toolName: 'browser',
      toolInput: '{"action":"navigate","url":"https://example.com"}',
      toolCallId: 'call-1',
    }, 'fallback-2')

    assert.equal(second.length, 1)
    assert.equal(second[0]?.id, 'call-1')
  })

  it('matches parallel same-tool results by toolCallId', () => {
    const withCalls = applyStreamingToolCall(
      applyStreamingToolCall([], {
        toolName: 'read_file',
        toolInput: '{"path":"a.txt"}',
        toolCallId: 'call-a',
      }, 'fallback-a'),
      {
        toolName: 'read_file',
        toolInput: '{"path":"b.txt"}',
        toolCallId: 'call-b',
      },
      'fallback-b',
    )

    const withFirstResult = applyStreamingToolResult(withCalls, {
      toolName: 'read_file',
      toolOutput: 'contents of b',
      toolCallId: 'call-b',
    })
    const withBothResults = applyStreamingToolResult(withFirstResult, {
      toolName: 'read_file',
      toolOutput: 'contents of a',
      toolCallId: 'call-a',
    })

    assert.equal(withBothResults[0]?.output, 'contents of a')
    assert.equal(withBothResults[0]?.status, 'done')
    assert.equal(withBothResults[1]?.output, 'contents of b')
    assert.equal(withBothResults[1]?.status, 'done')
  })

  it('uses fallback matching when toolCallId is missing', () => {
    const withCall = applyStreamingToolCall([], {
      toolName: 'browser',
      toolInput: '{"action":"navigate","url":"https://example.com"}',
    }, 'fallback-nav')

    const withResult = applyStreamingToolResult(withCall, {
      toolName: 'browser',
      toolOutput: 'navigated successfully',
    })

    assert.equal(withResult[0]?.id, 'fallback-nav')
    assert.equal(withResult[0]?.status, 'done')
    assert.equal(withResult[0]?.output, 'navigated successfully')
  })

  it('detects common tool error outputs', () => {
    assert.equal(isLikelyToolErrorOutput('Error: command failed'), true)
    assert.equal(isLikelyToolErrorOutput('timeout waiting for response'), true)
    assert.equal(isLikelyToolErrorOutput('File written successfully'), false)
  })
})
