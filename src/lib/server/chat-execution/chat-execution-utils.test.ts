import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, MessageToolEvent } from '@/types'
import {
  applyContextClearBoundary,
  classifyHeartbeatResponse,
  estimateConversationTone,
  extractHeartbeatStatus,
  getPersistedAssistantText,
  getToolEventsSnapshotKey,
  hasPersistableAssistantPayload,
  parseUsdLimit,
  pruneOldHeartbeatMessages,
  shouldAutoRouteHeartbeatAlerts,
  shouldPersistInboundUserMessage,
  shouldReplaceRecentAssistantMessage,
  stripMarkupForHeartbeat,
} from '@/lib/server/chat-execution/chat-execution-utils'

// ---------------------------------------------------------------------------
// applyContextClearBoundary
// ---------------------------------------------------------------------------
describe('applyContextClearBoundary', () => {
  it('returns all messages when no context-clear marker exists', () => {
    const msgs: Message[] = [
      { role: 'user', text: 'hi', time: 1 },
      { role: 'assistant', text: 'hello', time: 2 },
    ]
    assert.deepEqual(applyContextClearBoundary(msgs), msgs)
  })

  it('returns messages after the last context-clear marker', () => {
    const msgs: Message[] = [
      { role: 'user', text: 'old', time: 1 },
      { role: 'assistant', text: 'stale', time: 2, kind: 'context-clear' },
      { role: 'user', text: 'fresh', time: 3 },
      { role: 'assistant', text: 'answer', time: 4 },
    ]
    const result = applyContextClearBoundary(msgs)
    assert.equal(result.length, 2)
    assert.equal(result[0].text, 'fresh')
  })

  it('uses the last context-clear when multiple exist', () => {
    const msgs: Message[] = [
      { role: 'user', text: 'a', time: 1 },
      { role: 'assistant', text: 'x', time: 2, kind: 'context-clear' },
      { role: 'user', text: 'b', time: 3 },
      { role: 'assistant', text: 'y', time: 4, kind: 'context-clear' },
      { role: 'user', text: 'c', time: 5 },
    ]
    const result = applyContextClearBoundary(msgs)
    assert.equal(result.length, 1)
    assert.equal(result[0].text, 'c')
  })

  it('filters out historyExcluded messages', () => {
    const msgs: Message[] = [
      { role: 'user', text: 'visible', time: 1 },
      { role: 'assistant', text: 'hidden', time: 2, historyExcluded: true },
      { role: 'user', text: 'also visible', time: 3 },
    ]
    const result = applyContextClearBoundary(msgs)
    assert.equal(result.length, 2)
    assert.ok(result.every((m) => m.text !== 'hidden'))
  })

  it('returns empty array when context-clear is the last message', () => {
    const msgs: Message[] = [
      { role: 'user', text: 'old', time: 1 },
      { role: 'assistant', text: 'clear', time: 2, kind: 'context-clear' },
    ]
    assert.deepEqual(applyContextClearBoundary(msgs), [])
  })
})

// ---------------------------------------------------------------------------
// shouldPersistInboundUserMessage
// ---------------------------------------------------------------------------
describe('shouldPersistInboundUserMessage', () => {
  it('returns true for non-internal messages', () => {
    assert.equal(shouldPersistInboundUserMessage(false, 'chat'), true)
    assert.equal(shouldPersistInboundUserMessage(false, 'connector'), true)
  })

  it('returns true for internal eval and subagent messages', () => {
    assert.equal(shouldPersistInboundUserMessage(true, 'eval'), true)
    assert.equal(shouldPersistInboundUserMessage(true, 'subagent'), true)
  })

  it('returns false for other internal messages', () => {
    assert.equal(shouldPersistInboundUserMessage(true, 'heartbeat'), false)
    assert.equal(shouldPersistInboundUserMessage(true, 'chat'), false)
    assert.equal(shouldPersistInboundUserMessage(true, 'daemon'), false)
  })
})

// ---------------------------------------------------------------------------
// shouldAutoRouteHeartbeatAlerts
// ---------------------------------------------------------------------------
describe('shouldAutoRouteHeartbeatAlerts', () => {
  it('returns true with no config', () => {
    assert.equal(shouldAutoRouteHeartbeatAlerts(), true)
    assert.equal(shouldAutoRouteHeartbeatAlerts(null), true)
  })

  it('returns false when showAlerts is false', () => {
    assert.equal(shouldAutoRouteHeartbeatAlerts({ showAlerts: false }), false)
  })

  it('returns false when deliveryMode is tool_only', () => {
    assert.equal(shouldAutoRouteHeartbeatAlerts({ deliveryMode: 'tool_only' }), false)
  })

  it('returns false when deliveryMode is silent', () => {
    assert.equal(shouldAutoRouteHeartbeatAlerts({ deliveryMode: 'silent' }), false)
  })

  it('returns true for default deliveryMode with showAlerts true', () => {
    assert.equal(shouldAutoRouteHeartbeatAlerts({ showAlerts: true, deliveryMode: 'default' }), true)
  })
})

// ---------------------------------------------------------------------------
// extractHeartbeatStatus
// ---------------------------------------------------------------------------
describe('extractHeartbeatStatus', () => {
  it('extracts meta from AGENT_HEARTBEAT_META tag', () => {
    const text = 'Some text [AGENT_HEARTBEAT_META] {"goal":"monitor","status":"ok","summary":"all good","next_action":"wait"}'
    const result = extractHeartbeatStatus(text)
    assert.deepEqual(result, {
      goal: 'monitor',
      status: 'ok',
      summary: 'all good',
      nextAction: 'wait',
    })
  })

  it('returns null when no meta tag exists', () => {
    assert.equal(extractHeartbeatStatus('Just a normal response'), null)
  })

  it('returns null for invalid JSON after the tag', () => {
    assert.equal(extractHeartbeatStatus('[AGENT_HEARTBEAT_META] {invalid json}'), null)
  })

  it('returns null when JSON has no recognized fields', () => {
    assert.equal(extractHeartbeatStatus('[AGENT_HEARTBEAT_META] {"foo":"bar"}'), null)
  })

  it('returns partial results when only some fields present', () => {
    const result = extractHeartbeatStatus('[AGENT_HEARTBEAT_META] {"goal":"deploy"}')
    assert.deepEqual(result, { goal: 'deploy' })
  })

  it('trims whitespace from extracted values', () => {
    const result = extractHeartbeatStatus('[AGENT_HEARTBEAT_META] {"goal":"  deploy  ","status":" running "}')
    assert.equal(result?.goal, 'deploy')
    assert.equal(result?.status, 'running')
  })
})

// ---------------------------------------------------------------------------
// shouldReplaceRecentAssistantMessage
// ---------------------------------------------------------------------------
describe('shouldReplaceRecentAssistantMessage', () => {
  it('returns false when previous is null', () => {
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: null,
      nextToolEvents: [{ name: 'shell', input: 'ls' }],
      nextKind: 'chat',
      now: Date.now(),
    }), false)
  })

  it('returns false when previous is a user message', () => {
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: { role: 'user', text: 'hi', time: Date.now() },
      nextToolEvents: [{ name: 'shell', input: 'ls' }],
      nextKind: 'chat',
      now: Date.now(),
    }), false)
  })

  it('returns false when no tool events in new message', () => {
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: { role: 'assistant', text: 'hi', time: Date.now() },
      nextToolEvents: [],
      nextKind: 'chat',
      now: Date.now(),
    }), false)
  })

  it('returns false when previous has different kind', () => {
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: { role: 'assistant', text: 'hi', time: Date.now(), kind: 'heartbeat' },
      nextToolEvents: [{ name: 'shell', input: 'ls' }],
      nextKind: 'chat',
      now: Date.now(),
    }), false)
  })

  it('returns false when previous message is older than 45 seconds', () => {
    const now = Date.now()
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: { role: 'assistant', text: 'hi', time: now - 50_000 },
      nextToolEvents: [{ name: 'shell', input: 'ls' }],
      nextKind: 'chat',
      now,
    }), false)
  })

  it('returns false when previous already has tool events', () => {
    const now = Date.now()
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: { role: 'assistant', text: 'hi', time: now - 5000, toolEvents: [{ name: 'web', input: '{}' }] },
      nextToolEvents: [{ name: 'shell', input: 'ls' }],
      nextKind: 'chat',
      now,
    }), false)
  })

  it('returns true when all conditions met: recent assistant, no prev tools, new has tools, same kind', () => {
    const now = Date.now()
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: { role: 'assistant', text: 'thinking...', time: now - 2000, kind: 'chat' },
      nextToolEvents: [{ name: 'shell', input: 'ls' }],
      nextKind: 'chat',
      now,
    }), true)
  })

  it('returns true when kinds are both undefined', () => {
    const now = Date.now()
    assert.equal(shouldReplaceRecentAssistantMessage({
      previous: { role: 'assistant', text: 'x', time: now - 1000 },
      nextToolEvents: [{ name: 'shell', input: 'ls' }],
      nextKind: undefined,
      now,
    }), true)
  })
})

// ---------------------------------------------------------------------------
// hasPersistableAssistantPayload
// ---------------------------------------------------------------------------
describe('hasPersistableAssistantPayload', () => {
  it('returns true for non-empty text', () => {
    assert.equal(hasPersistableAssistantPayload('hello', '', []), true)
  })

  it('returns true for non-empty thinking', () => {
    assert.equal(hasPersistableAssistantPayload('', 'internal thought', []), true)
  })

  it('returns true when tool events exist', () => {
    assert.equal(hasPersistableAssistantPayload('', '', [{ name: 'shell', input: 'ls' }]), true)
  })

  it('returns false for successful memory-write tool events without visible text', () => {
    assert.equal(
      hasPersistableAssistantPayload('', '', [{
        name: 'memory_store',
        input: '{"title":"Siobhan contact"}',
        output: 'Stored memory "Siobhan contact" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
      }]),
      false,
    )
  })

  it('returns false for all-whitespace text, thinking, and empty events', () => {
    assert.equal(hasPersistableAssistantPayload('  ', '   ', []), false)
  })

  it('returns false for completely empty inputs', () => {
    assert.equal(hasPersistableAssistantPayload('', '', []), false)
  })
})

// ---------------------------------------------------------------------------
// getPersistedAssistantText
// ---------------------------------------------------------------------------
describe('getPersistedAssistantText', () => {
  it('returns trimmed text when non-empty', () => {
    assert.equal(getPersistedAssistantText('  hello world  ', []), 'hello world')
  })

  it('generates summary from tool events when text is empty', () => {
    const events: MessageToolEvent[] = [
      { name: 'shell', input: 'ls', output: 'files listed' },
    ]
    const result = getPersistedAssistantText('', events)
    assert.ok(result.length > 0)
    assert.ok(result.includes('shell'))
  })

  it('returns empty string when text is empty and no tool events', () => {
    const result = getPersistedAssistantText('', [])
    // buildToolEventAssistantSummary with empty array returns empty
    assert.equal(result, '')
  })

  it('suppresses successful memory-write tool-only fallbacks', () => {
    const result = getPersistedAssistantText('', [{
      name: 'memory_store',
      input: '{"title":"Siobhan contact"}',
      output: 'Stored memory "Siobhan contact" (id: abc123). No further memory lookup is needed unless the user asked you to verify.',
    }])
    assert.equal(result, '')
  })
})

// ---------------------------------------------------------------------------
// getToolEventsSnapshotKey
// ---------------------------------------------------------------------------
describe('getToolEventsSnapshotKey', () => {
  it('returns deterministic key for same events', () => {
    const events: MessageToolEvent[] = [
      { name: 'shell', input: 'ls', output: 'ok', toolCallId: 'c1' },
    ]
    const key1 = getToolEventsSnapshotKey(events)
    const key2 = getToolEventsSnapshotKey([...events])
    assert.equal(key1, key2)
  })

  it('returns different keys for different events', () => {
    const a = getToolEventsSnapshotKey([{ name: 'shell', input: 'ls' }])
    const b = getToolEventsSnapshotKey([{ name: 'shell', input: 'pwd' }])
    assert.notEqual(a, b)
  })

  it('returns valid JSON string', () => {
    const key = getToolEventsSnapshotKey([{ name: 'web', input: '{}' }])
    assert.doesNotThrow(() => JSON.parse(key))
  })

  it('handles error flag correctly', () => {
    const withError = getToolEventsSnapshotKey([{ name: 'shell', input: 'x', error: true }])
    const withoutError = getToolEventsSnapshotKey([{ name: 'shell', input: 'x' }])
    assert.notEqual(withError, withoutError)
  })

  it('returns stable key for empty array', () => {
    assert.equal(getToolEventsSnapshotKey([]), '[]')
  })
})

// ---------------------------------------------------------------------------
// parseUsdLimit
// ---------------------------------------------------------------------------
describe('parseUsdLimit', () => {
  it('parses a number directly', () => {
    assert.equal(parseUsdLimit(5.0), 5.0)
  })

  it('parses a numeric string', () => {
    assert.equal(parseUsdLimit('10.50'), 10.50)
  })

  it('returns null for zero', () => {
    assert.equal(parseUsdLimit(0), null)
  })

  it('returns null for negative', () => {
    assert.equal(parseUsdLimit(-1), null)
  })

  it('returns null for NaN', () => {
    assert.equal(parseUsdLimit(Number.NaN), null)
  })

  it('returns null for non-numeric string', () => {
    assert.equal(parseUsdLimit('not-a-number'), null)
  })

  it('returns null for null/undefined', () => {
    assert.equal(parseUsdLimit(null), null)
    assert.equal(parseUsdLimit(undefined), null)
  })

  it('clamps to minimum of 0.01', () => {
    assert.equal(parseUsdLimit(0.001), 0.01)
  })

  it('clamps to maximum of 1,000,000', () => {
    assert.equal(parseUsdLimit(2_000_000), 1_000_000)
  })

  it('returns null for Infinity', () => {
    assert.equal(parseUsdLimit(Infinity), null)
  })
})

// ---------------------------------------------------------------------------
// stripMarkupForHeartbeat
// ---------------------------------------------------------------------------
describe('stripMarkupForHeartbeat', () => {
  it('strips HTML tags', () => {
    assert.equal(stripMarkupForHeartbeat('<b>bold</b>'), 'bold')
  })

  it('strips &nbsp;', () => {
    assert.equal(stripMarkupForHeartbeat('hello&nbsp;world'), 'hello world')
  })

  it('strips leading/trailing markdown formatting chars', () => {
    assert.equal(stripMarkupForHeartbeat('**bold text**'), 'bold text')
    assert.equal(stripMarkupForHeartbeat('`code`'), 'code')
    assert.equal(stripMarkupForHeartbeat('~~strikethrough~~'), 'strikethrough')
  })

  it('trims whitespace', () => {
    assert.equal(stripMarkupForHeartbeat('  hello  '), 'hello')
  })

  it('returns empty for all-markup input', () => {
    assert.equal(stripMarkupForHeartbeat('<br>'), '')
  })
})

// ---------------------------------------------------------------------------
// classifyHeartbeatResponse
// ---------------------------------------------------------------------------
describe('classifyHeartbeatResponse', () => {
  it('suppresses exact HEARTBEAT_OK', () => {
    assert.equal(classifyHeartbeatResponse('HEARTBEAT_OK', 300, false), 'suppress')
  })

  it('suppresses exact NO_MESSAGE', () => {
    assert.equal(classifyHeartbeatResponse('NO_MESSAGE', 300, false), 'suppress')
  })

  it('suppresses HEARTBEAT_OK with trailing punctuation', () => {
    assert.equal(classifyHeartbeatResponse('HEARTBEAT_OK.', 300, false), 'suppress')
  })

  it('suppresses when only HEARTBEAT_OK remains after stripping', () => {
    assert.equal(classifyHeartbeatResponse('**HEARTBEAT_OK**', 300, false), 'suppress')
  })

  it('suppresses short text without tool calls under ackMaxChars', () => {
    assert.equal(classifyHeartbeatResponse('All systems nominal.', 300, false), 'suppress')
  })

  it('keeps text with tool calls even when short', () => {
    assert.equal(classifyHeartbeatResponse('Ran monitoring checks.', 300, true), 'keep')
  })

  it('suppresses when text ends with HEARTBEAT_OK even with prefix', () => {
    // The regex detects trailing HEARTBEAT_OK and suppresses the whole response
    assert.equal(classifyHeartbeatResponse('Everything looks fine. HEARTBEAT_OK', 10, true), 'suppress')
  })

  it('strips when HEARTBEAT_OK is mid-text with real content after it', () => {
    // HEARTBEAT_OK in middle, real content follows -> strip (removes control token)
    const text = 'HEARTBEAT_OK — Alert: disk at 95% on node-5. Immediate attention required for production stability.'
    assert.equal(classifyHeartbeatResponse(text, 50, false), 'strip')
  })

  it('keeps text when long and no control tokens', () => {
    const longText = 'Alert: CPU usage at 95% on node-3. Memory usage approaching threshold. Immediate attention needed for the production cluster.'
    assert.equal(classifyHeartbeatResponse(longText, 50, false), 'keep')
  })
})

// ---------------------------------------------------------------------------
// estimateConversationTone
// ---------------------------------------------------------------------------
describe('estimateConversationTone', () => {
  it('detects technical tone from code', () => {
    assert.equal(estimateConversationTone('Here is the function:\n```\nconst x = 1;\n```'), 'technical')
  })

  it('detects technical tone from programming keywords', () => {
    assert.equal(estimateConversationTone('The async function returns a Promise'), 'technical')
  })

  it('detects technical tone from error keywords', () => {
    assert.equal(estimateConversationTone('There was a TypeError in the stack trace'), 'technical')
  })

  it('detects empathetic tone', () => {
    assert.equal(estimateConversationTone('I understand how difficult this must be for you'), 'empathetic')
  })

  it('detects formal tone', () => {
    assert.equal(estimateConversationTone('Furthermore, the committee has decided accordingly'), 'formal')
  })

  it('detects casual tone', () => {
    assert.equal(estimateConversationTone('Hey, gonna grab some lunch, lol'), 'casual')
  })

  it('detects casual tone from multiple exclamation marks', () => {
    assert.equal(estimateConversationTone('That is so great!!'), 'casual')
  })

  it('returns neutral for generic text', () => {
    assert.equal(estimateConversationTone('The weather today is sunny with a high of 72.'), 'neutral')
  })

  it('returns neutral for empty string', () => {
    assert.equal(estimateConversationTone(''), 'neutral')
  })
})

// ---------------------------------------------------------------------------
// pruneOldHeartbeatMessages
// ---------------------------------------------------------------------------
describe('pruneOldHeartbeatMessages', () => {
  it('removes old heartbeat messages keeping only the most recent 2', () => {
    const messages: Message[] = [
      { role: 'user', text: 'hi', time: 1 },
      { role: 'assistant', text: 'alert 1', time: 2, kind: 'heartbeat' },
      { role: 'assistant', text: 'alert 2', time: 3, kind: 'heartbeat' },
      { role: 'assistant', text: 'real reply', time: 4, kind: 'chat' },
      { role: 'assistant', text: 'alert 3', time: 5, kind: 'heartbeat' },
      { role: 'assistant', text: 'alert 4', time: 6, kind: 'heartbeat' },
    ]
    const removed = pruneOldHeartbeatMessages(messages)
    assert.equal(removed, 2)
    assert.equal(messages.length, 4)
    // Only the last 2 heartbeat messages remain
    const heartbeats = messages.filter((m) => m.kind === 'heartbeat')
    assert.equal(heartbeats.length, 2)
    assert.equal(heartbeats[0].text, 'alert 3')
    assert.equal(heartbeats[1].text, 'alert 4')
  })

  it('does not remove anything when count is at or below maxKeep', () => {
    const messages: Message[] = [
      { role: 'assistant', text: 'alert 1', time: 1, kind: 'heartbeat' },
      { role: 'user', text: 'hi', time: 2 },
      { role: 'assistant', text: 'alert 2', time: 3, kind: 'heartbeat' },
    ]
    assert.equal(pruneOldHeartbeatMessages(messages), 0)
    assert.equal(messages.length, 3)
  })

  it('respects custom maxKeep value', () => {
    const messages: Message[] = [
      { role: 'assistant', text: 'hb1', time: 1, kind: 'heartbeat' },
      { role: 'assistant', text: 'hb2', time: 2, kind: 'heartbeat' },
      { role: 'assistant', text: 'hb3', time: 3, kind: 'heartbeat' },
    ]
    assert.equal(pruneOldHeartbeatMessages(messages, 1), 2)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].text, 'hb3')
  })

  it('does not touch non-heartbeat messages', () => {
    const messages: Message[] = [
      { role: 'user', text: 'a', time: 1 },
      { role: 'assistant', text: 'b', time: 2, kind: 'chat' },
      { role: 'assistant', text: 'c', time: 3 },
    ]
    assert.equal(pruneOldHeartbeatMessages(messages), 0)
    assert.equal(messages.length, 3)
  })
})
