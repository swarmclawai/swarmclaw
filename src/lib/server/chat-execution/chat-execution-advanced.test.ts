import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageToolEvent } from '@/types'
import {
  collectToolEvent,
  deriveTerminalRunError,
  dedupeConsecutiveToolEvents,
  hasDirectLocalCodingTools,
  isLikelyToolErrorOutput,
  normalizeAssistantArtifactLinks,
  reconcileConnectorDeliveryText,
  requestedToolNamesFromMessage,
  translateRequestedToolInvocation,
} from '@/lib/server/chat-execution/chat-execution'
import {
  buildToolDisciplineLines,
  getExplicitRequiredToolNames,
  looksLikeOpenEndedDeliverableTask,
  resolveFinalStreamResponseText,
} from '@/lib/server/chat-execution/stream-agent-chat'
import {
  stripHiddenControlTokens,
  shouldSuppressHiddenControlText,
} from '@/lib/server/agents/assistant-control'

// ---------------------------------------------------------------------------
// collectToolEvent advanced
// ---------------------------------------------------------------------------
describe('collectToolEvent advanced', () => {
  it('tracks three parallel tool calls with different toolCallIds', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_call', toolName: 'web', toolInput: '{"q":"a"}', toolCallId: 'c1' }, bag)
    collectToolEvent({ t: 'tool_call', toolName: 'shell', toolInput: 'ls', toolCallId: 'c2' }, bag)
    collectToolEvent({ t: 'tool_call', toolName: 'files', toolInput: '{}', toolCallId: 'c3' }, bag)

    assert.equal(bag.length, 3)
    assert.equal(bag[0].toolCallId, 'c1')
    assert.equal(bag[1].toolCallId, 'c2')
    assert.equal(bag[2].toolCallId, 'c3')
  })

  it('matches results arriving out of order by toolCallId', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_call', toolName: 'web', toolInput: '{}', toolCallId: 'c1' }, bag)
    collectToolEvent({ t: 'tool_call', toolName: 'shell', toolInput: 'ls', toolCallId: 'c2' }, bag)

    // Result for c2 arrives first
    collectToolEvent({ t: 'tool_result', toolName: 'shell', toolOutput: 'dir listing', toolCallId: 'c2' }, bag)
    collectToolEvent({ t: 'tool_result', toolName: 'web', toolOutput: 'search results', toolCallId: 'c1' }, bag)

    assert.equal(bag[0].output, 'search results')
    assert.equal(bag[1].output, 'dir listing')
  })

  it('discards orphaned tool_result with no matching call', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_result', toolName: 'shell', toolOutput: 'orphan', toolCallId: 'no-match' }, bag)
    assert.equal(bag.length, 0)
  })

  it('marks error=true for error results', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_call', toolName: 'shell', toolInput: 'bad', toolCallId: 'e1' }, bag)
    collectToolEvent({ t: 'tool_result', toolName: 'shell', toolOutput: 'Error (exit 1): command failed', toolCallId: 'e1' }, bag)

    assert.equal(bag[0].error, true)
  })

  it('tracks multiple calls to the same tool with different inputs separately', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_call', toolName: 'files', toolInput: '{"path":"a.txt"}', toolCallId: 'f1' }, bag)
    collectToolEvent({ t: 'tool_call', toolName: 'files', toolInput: '{"path":"b.txt"}', toolCallId: 'f2' }, bag)

    assert.equal(bag.length, 2)
    assert.equal(bag[0].input, '{"path":"a.txt"}')
    assert.equal(bag[1].input, '{"path":"b.txt"}')
  })

  it('marks error=true for JSON error in tool output', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_call', toolName: 'web', toolInput: '{}', toolCallId: 'j1' }, bag)
    collectToolEvent({ t: 'tool_result', toolName: 'web', toolOutput: '{"error":"timeout","status":"failed"}', toolCallId: 'j1' }, bag)

    assert.equal(bag[0].error, true)
  })

  it('marks error=true for MCP validation failure', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_call', toolName: 'mcp', toolInput: '{}', toolCallId: 'm1' }, bag)
    collectToolEvent({ t: 'tool_result', toolName: 'mcp', toolOutput: 'invalid_type: expected string, received number (zod issue)', toolCallId: 'm1' }, bag)

    assert.equal(bag[0].error, true)
  })

  it('leaves error undefined for normal successful output', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({ t: 'tool_call', toolName: 'files', toolInput: '{}', toolCallId: 's1' }, bag)
    collectToolEvent({ t: 'tool_result', toolName: 'files', toolOutput: 'File written successfully', toolCallId: 's1' }, bag)

    assert.ok(!bag[0].error)
  })

  it('handles long sequence call-result-call-result-call-result producing 3 complete entries', () => {
    const bag: MessageToolEvent[] = []
    for (let i = 1; i <= 3; i++) {
      collectToolEvent({ t: 'tool_call', toolName: 'shell', toolInput: `cmd${i}`, toolCallId: `seq${i}` }, bag)
      collectToolEvent({ t: 'tool_result', toolName: 'shell', toolOutput: `out${i}`, toolCallId: `seq${i}` }, bag)
    }

    assert.equal(bag.length, 3)
    assert.equal(bag[0].output, 'out1')
    assert.equal(bag[1].output, 'out2')
    assert.equal(bag[2].output, 'out3')
  })
})

// ---------------------------------------------------------------------------
// dedupeConsecutiveToolEvents advanced
// ---------------------------------------------------------------------------
describe('dedupeConsecutiveToolEvents advanced', () => {
  const ev = (name: string, input: string, output?: string, error?: boolean): MessageToolEvent => ({
    name, input, output, error,
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(dedupeConsecutiveToolEvents([]), [])
  })

  it('keeps a single event', () => {
    const events = [ev('shell', 'ls', 'ok')]
    assert.deepEqual(dedupeConsecutiveToolEvents(events), events)
  })

  it('collapses 4 identical consecutive events using block dedupe', () => {
    const single = ev('shell', 'ls', 'ok')
    const events = Array.from({ length: 4 }, () => ({ ...single }))
    const result = dedupeConsecutiveToolEvents(events)
    // Block dedupe (single pass): blockSize=2 matches [A,A]==[A,A], keeps first block [A,A] = 2
    assert.equal(result.length, 2)
    assert.equal(result[0].name, 'shell')
  })

  it('collapses 6 identical consecutive events to 3', () => {
    const single = ev('shell', 'ls', 'ok')
    const events = Array.from({ length: 6 }, () => ({ ...single }))
    const result = dedupeConsecutiveToolEvents(events)
    // blockSize=3: [A,A,A]==[A,A,A], keeps first block [A,A,A] = 3
    assert.equal(result.length, 3)
  })

  it('collapses A-B-A-B repeated block to A-B', () => {
    const a = ev('shell', 'ls', 'ok')
    const b = ev('files', 'read', 'data')
    const events = [a, b, { ...a }, { ...b }]
    const result = dedupeConsecutiveToolEvents(events)
    assert.equal(result.length, 2)
    assert.equal(result[0].name, 'shell')
    assert.equal(result[1].name, 'files')
  })

  it('preserves non-consecutive duplicates: A-B-A', () => {
    const a = ev('shell', 'ls', 'ok')
    const b = ev('files', 'read', 'data')
    const events = [a, b, { ...a }]
    const result = dedupeConsecutiveToolEvents(events)
    assert.equal(result.length, 3)
  })

  it('does not dedupe events with different outputs even if same tool', () => {
    const e1 = ev('shell', 'ls', 'output1')
    const e2 = ev('shell', 'ls', 'output2')
    const result = dedupeConsecutiveToolEvents([e1, e2])
    assert.equal(result.length, 2)
  })
})

// ---------------------------------------------------------------------------
// deriveTerminalRunError advanced
// ---------------------------------------------------------------------------
describe('deriveTerminalRunError advanced', () => {
  it('uses last stream error when multiple errors and no fullResponse', () => {
    const err = deriveTerminalRunError({
      fullResponse: '',
      streamErrors: ['rate limit exceeded', 'server timeout'],
      toolEvents: [],
      internal: false,
    })
    assert.equal(err, 'server timeout')
  })

  it('returns undefined when fullResponse has text, even with stream errors', () => {
    const err = deriveTerminalRunError({
      fullResponse: 'Here is your answer',
      streamErrors: ['some error'],
      toolEvents: [],
      internal: false,
    })
    assert.equal(err, undefined)
  })

  it('returns undefined when tool events exist but no text', () => {
    const err = deriveTerminalRunError({
      fullResponse: '',
      streamErrors: [],
      toolEvents: [{ name: 'shell', input: 'ls', output: 'ok' }],
      internal: false,
    })
    assert.equal(err, undefined)
  })

  it('returns undefined for internal run with empty response', () => {
    const err = deriveTerminalRunError({
      fullResponse: '',
      streamErrors: [],
      toolEvents: [],
      internal: true,
    })
    assert.equal(err, undefined)
  })

  it('generates user-friendly error for empty everything (non-internal)', () => {
    const err = deriveTerminalRunError({
      fullResponse: '',
      streamErrors: [],
      toolEvents: [],
      internal: false,
    })
    assert.ok(err)
    assert.ok(err.includes('Check the provider configuration'))
  })

  it('uses errorMessage directly when provided', () => {
    const err = deriveTerminalRunError({
      errorMessage: 'Custom error',
      fullResponse: 'some text',
      streamErrors: ['other error'],
      toolEvents: [],
      internal: false,
    })
    assert.equal(err, 'Custom error')
  })
})

// ---------------------------------------------------------------------------
// requestedToolNamesFromMessage advanced
// ---------------------------------------------------------------------------
describe('requestedToolNamesFromMessage advanced', () => {
  it('extracts files from "Use the files tool"', () => {
    const result = requestedToolNamesFromMessage('Use the files tool')
    assert.ok(result.includes('files'))
  })

  it('extracts web and browser from search + screenshot request', () => {
    const result = requestedToolNamesFromMessage('Use `web` to search and `browser` to take a screenshot')
    assert.ok(result.includes('web'))
    assert.ok(result.includes('browser'))
  })

  it('extracts connector_message_tool for "use connector_message_tool to send WhatsApp"', () => {
    const result = requestedToolNamesFromMessage('Use `connector_message_tool` to send to my WhatsApp')
    assert.ok(result.includes('connector_message_tool'))
  })

  it('returns empty for negated tool mention', () => {
    const result = requestedToolNamesFromMessage("Don't use the browser")
    assert.ok(!result.includes('browser'))
  })

  it('extracts memory_tool from "use `memory_tool` to store"', () => {
    const result = requestedToolNamesFromMessage('Use `memory_tool` to store this for later')
    assert.ok(result.includes('memory_tool'))
  })

  it('extracts narrow memory tool names when explicitly requested', () => {
    const result = requestedToolNamesFromMessage('Use `memory_search` first, then `memory_get`, and finish with `memory_store` if needed')
    assert.ok(result.includes('memory_search'))
    assert.ok(result.includes('memory_get'))
    assert.ok(result.includes('memory_store'))
  })

  it('extracts multiple tools from complex request', () => {
    const result = requestedToolNamesFromMessage('Use `web` to research, `browser` to screenshot, and `connector_message_tool` to send via Slack')
    assert.ok(result.includes('web'))
    assert.ok(result.includes('browser'))
    assert.ok(result.includes('connector_message_tool'))
  })

  it('returns empty array when no tool mentions', () => {
    const result = requestedToolNamesFromMessage('What is the weather like today?')
    assert.deepEqual(result, [])
  })
})

// ---------------------------------------------------------------------------
// translateRequestedToolInvocation advanced
// ---------------------------------------------------------------------------
describe('translateRequestedToolInvocation advanced', () => {
  it('maps manage_platform with resource=tasks to manage_tasks when available', () => {
    const { toolName, args } = translateRequestedToolInvocation(
      'manage_platform',
      { resource: 'tasks', action: 'list' },
      '',
      ['manage_tasks', 'files'],
    )
    assert.equal(toolName, 'manage_tasks')
    assert.equal(args.resource, 'tasks')
  })

  it('keeps manage_platform when specific tool not available', () => {
    const { toolName } = translateRequestedToolInvocation(
      'manage_platform',
      { resource: 'agents' },
      '',
      ['manage_platform'],
    )
    assert.equal(toolName, 'manage_platform')
  })

  it('uses specific tool directly when available', () => {
    const { toolName } = translateRequestedToolInvocation(
      'manage_tasks',
      { action: 'list' },
      '',
      ['manage_tasks'],
    )
    assert.equal(toolName, 'manage_tasks')
  })

  it('falls back to manage_platform when specific tool not available but umbrella is', () => {
    const { toolName, args } = translateRequestedToolInvocation(
      'manage_tasks',
      { action: 'list', id: '123' },
      '',
      ['manage_platform'],
    )
    assert.equal(toolName, 'manage_platform')
    assert.equal(args.resource, 'tasks')
    assert.equal(args.action, 'list')
  })

  it('maps web_search to web with action=search', () => {
    const { toolName, args } = translateRequestedToolInvocation(
      'web_search',
      { query: 'test query' },
      '',
      ['web'],
    )
    assert.equal(toolName, 'web')
    assert.equal(args.action, 'search')
    assert.equal(args.query, 'test query')
  })
})

// ---------------------------------------------------------------------------
// isLikelyToolErrorOutput advanced
// ---------------------------------------------------------------------------
describe('isLikelyToolErrorOutput advanced', () => {
  it('detects "Error (exit 127): command not found"', () => {
    assert.equal(isLikelyToolErrorOutput('Error (exit 127): command not found'), true)
  })

  it('detects JSON with error and failed status', () => {
    assert.equal(isLikelyToolErrorOutput('{"error":"timeout","status":"failed"}'), true)
  })

  it('does not flag normal JSON response', () => {
    assert.equal(isLikelyToolErrorOutput('{"status":"ok","data":[]}'), false)
  })

  it('does not flag success message', () => {
    assert.equal(isLikelyToolErrorOutput('File written successfully'), false)
  })

  it('detects JSON with status=failed without error key', () => {
    assert.equal(isLikelyToolErrorOutput('{"status":"failed"}'), true)
  })

  it('returns false for empty string', () => {
    assert.equal(isLikelyToolErrorOutput(''), false)
  })

  it('detects MCP error keyword', () => {
    assert.equal(isLikelyToolErrorOutput('MCP error: server connection refused'), true)
  })

  it('detects ECONNREFUSED', () => {
    assert.equal(isLikelyToolErrorOutput('connect ECONNREFUSED 127.0.0.1:3000'), true)
  })
})

// ---------------------------------------------------------------------------
// hasDirectLocalCodingTools
// ---------------------------------------------------------------------------
describe('hasDirectLocalCodingTools', () => {
  it('returns true when shell is in plugins', () => {
    assert.equal(hasDirectLocalCodingTools({ plugins: ['shell', 'memory'] }), true)
  })

  it('returns false when only delegate and web', () => {
    assert.equal(hasDirectLocalCodingTools({ plugins: ['delegate', 'web'] }), false)
  })

  it('returns true when edit_file is in plugins', () => {
    assert.equal(hasDirectLocalCodingTools({ plugins: ['edit_file'] }), true)
  })

  it('returns false for empty plugins', () => {
    assert.equal(hasDirectLocalCodingTools({ plugins: [] }), false)
  })

  it('returns true for files plugin', () => {
    assert.equal(hasDirectLocalCodingTools({ plugins: ['files'] }), true)
  })

  it('returns true for sandbox plugin', () => {
    assert.equal(hasDirectLocalCodingTools({ plugins: ['sandbox'] }), true)
  })
})

// ---------------------------------------------------------------------------
// reconcileConnectorDeliveryText advanced
// ---------------------------------------------------------------------------
describe('reconcileConnectorDeliveryText advanced', () => {
  it('keeps original text when one connector event succeeds and another fails', () => {
    const events: MessageToolEvent[] = [
      { name: 'connector_message_tool', input: '{}', output: '{"error":"fail"}', error: true },
      { name: 'connector_message_tool', input: '{}', output: '{"status":"sent"}' },
    ]
    const text = "I've sent the message to your WhatsApp."
    assert.equal(reconcileConnectorDeliveryText(text, events), text)
  })

  it('overrides text when all connector events fail', () => {
    const events: MessageToolEvent[] = [
      { name: 'connector_message_tool', input: '{}', output: '{"error":"timeout"}', error: true },
    ]
    const text = 'I sent your message!'
    const result = reconcileConnectorDeliveryText(text, events)
    assert.ok(result.includes("couldn't send"))
  })

  it('keeps original text when no connector events exist', () => {
    const events: MessageToolEvent[] = [
      { name: 'shell', input: 'ls', output: 'ok' },
    ]
    const text = "I've sent the message to your account."
    assert.equal(reconcileConnectorDeliveryText(text, events), text)
  })

  it('extracts error detail from nested JSON', () => {
    const events: MessageToolEvent[] = [
      {
        name: 'connector_message_tool',
        input: '{}',
        output: '{"error":"failed","detail":{"message":"WhatsApp session expired"}}',
        error: true,
      },
    ]
    const text = 'I sent the message.'
    const result = reconcileConnectorDeliveryText(text, events)
    assert.ok(result.includes('WhatsApp session expired'))
  })

  it('keeps text that does not match positive delivery pattern', () => {
    const events: MessageToolEvent[] = [
      { name: 'connector_message_tool', input: '{}', output: '{"error":"fail"}', error: true },
    ]
    const text = 'The connector returned an error.'
    assert.equal(reconcileConnectorDeliveryText(text, events), text)
  })
})

// ---------------------------------------------------------------------------
// buildToolDisciplineLines advanced
// ---------------------------------------------------------------------------
describe('buildToolDisciplineLines advanced', () => {
  it('returns basic line only for minimal tools', () => {
    const lines = buildToolDisciplineLines(['files'])
    assert.ok(lines.length >= 1)
    assert.ok(lines[0].includes('Enabled tools'))
  })

  it('includes memory guidance when memory_tool is not directly available but memory is', () => {
    const lines = buildToolDisciplineLines(['memory'])
    assert.ok(lines.some((line) => line.includes('Enabled tools')))
  })

  it('includes schedule guidance when manage_schedules is enabled', () => {
    const lines = buildToolDisciplineLines(['manage_schedules'])
    assert.ok(lines.some((line) => line.includes('reuse or update matching agent-created schedules')))
  })

  it('includes delegate local-first guidance when coding tools and delegate enabled', () => {
    const lines = buildToolDisciplineLines(['delegate', 'shell', 'files'])
    assert.ok(lines.some((line) => line.includes('prefer using them directly for straightforward coding')))
  })

  it('tells research-capable agents to try another enabled acquisition path before manual fallback', () => {
    const lines = buildToolDisciplineLines(['web_search', 'web_fetch', 'http_request', 'shell'])
    assert.ok(lines.some((line) => line.includes('try one other enabled acquisition path') && line.includes('`shell`') && line.includes('`http_request`')))
  })

  it('adds direct drafting/file-save/swarm-id guidance when those tools are enabled', () => {
    const lines = buildToolDisciplineLines(['files', 'email', 'spawn_subagent'])
    assert.ok(lines.some((line) => line.includes('draft, outline, critique, or revise email copy')))
    assert.ok(lines.some((line) => line.includes('actual file-writing tool call')))
    assert.ok(lines.some((line) => line.includes('returned `swarmId`')))
  })
})

// ---------------------------------------------------------------------------
// looksLikeOpenEndedDeliverableTask advanced
// ---------------------------------------------------------------------------
describe('looksLikeOpenEndedDeliverableTask advanced', () => {
  it('returns true for "Write a blog post about sustainable energy practices and create a draft document"', () => {
    assert.equal(looksLikeOpenEndedDeliverableTask('Write a blog post about sustainable energy practices and create a draft document'), true)
  })

  it('returns false for short specific fix request', () => {
    assert.equal(looksLikeOpenEndedDeliverableTask('Fix the bug in line 42'), false)
  })

  it('returns true for "Draft a proposal for the Q3 marketing campaign including budget and timeline"', () => {
    assert.equal(looksLikeOpenEndedDeliverableTask('Draft a proposal for the Q3 marketing campaign including budget and timeline'), true)
  })

  it('returns false for "npm install"', () => {
    assert.equal(looksLikeOpenEndedDeliverableTask('npm install'), false)
  })

  it('returns false for empty string', () => {
    assert.equal(looksLikeOpenEndedDeliverableTask(''), false)
  })

  it('returns true for text containing "deliverable"', () => {
    assert.equal(looksLikeOpenEndedDeliverableTask('Create a final deliverable summarizing the research findings from this quarter'), true)
  })
})

// ---------------------------------------------------------------------------
// Assistant control
// ---------------------------------------------------------------------------
describe('stripHiddenControlTokens', () => {
  it('removes HEARTBEAT_OK', () => {
    assert.equal(stripHiddenControlTokens('HEARTBEAT_OK'), '')
  })

  it('removes NO_MESSAGE', () => {
    assert.equal(stripHiddenControlTokens('NO_MESSAGE'), '')
  })

  it('passes through regular text', () => {
    assert.equal(stripHiddenControlTokens("Here's your answer"), "Here's your answer")
  })

  it('strips control tokens from mixed text, keeps the rest', () => {
    const result = stripHiddenControlTokens('HEARTBEAT_OK Here is the real message')
    assert.ok(!result.includes('HEARTBEAT_OK'))
    assert.ok(result.includes('real message'))
  })

  it('handles multiple control tokens', () => {
    assert.equal(stripHiddenControlTokens('NO_MESSAGE HEARTBEAT_OK'), '')
  })
})

describe('shouldSuppressHiddenControlText', () => {
  it('returns true for "HEARTBEAT_OK"', () => {
    assert.equal(shouldSuppressHiddenControlText('HEARTBEAT_OK'), true)
  })

  it('returns false for normal text', () => {
    assert.equal(shouldSuppressHiddenControlText("Here's your answer"), false)
  })

  it('returns true for "NO_MESSAGE"', () => {
    assert.equal(shouldSuppressHiddenControlText('NO_MESSAGE'), true)
  })

  it('returns false for empty string', () => {
    assert.equal(shouldSuppressHiddenControlText(''), false)
  })

  it('returns false for text with control token embedded in real content', () => {
    assert.equal(shouldSuppressHiddenControlText('HEARTBEAT_OK and here is some real content'), false)
  })
})

// ---------------------------------------------------------------------------
// resolveFinalStreamResponseText advanced
// ---------------------------------------------------------------------------
describe('resolveFinalStreamResponseText advanced', () => {
  it('uses fullText when no tool calls', () => {
    const result = resolveFinalStreamResponseText({
      fullText: 'Full response text here',
      lastSegment: 'Last segment',
      lastSettledSegment: 'Settled segment',
      hasToolCalls: false,
    })
    assert.equal(result, 'Full response text here')
  })

  it('prefers lastSegment when tool calls are present', () => {
    const result = resolveFinalStreamResponseText({
      fullText: 'Full text with lots of content',
      lastSegment: 'Last segment content',
      lastSettledSegment: 'Settled segment content',
      hasToolCalls: true,
    })
    assert.equal(result, 'Last segment content')
  })

  it('falls back through candidates when earlier ones are empty', () => {
    const result = resolveFinalStreamResponseText({
      fullText: 'Full text fallback',
      lastSegment: '',
      lastSettledSegment: '',
      hasToolCalls: true,
    })
    assert.equal(result, 'Full text fallback')
  })

  it('returns empty string when all candidates empty with tool calls', () => {
    const result = resolveFinalStreamResponseText({
      fullText: '',
      lastSegment: '',
      lastSettledSegment: '',
      hasToolCalls: true,
    })
    assert.equal(result, '')
  })
})

// ---------------------------------------------------------------------------
// normalizeAssistantArtifactLinks
// ---------------------------------------------------------------------------
describe('normalizeAssistantArtifactLinks', () => {
  it('rewrites sandbox:/api/uploads/ to /api/uploads/', () => {
    const text = 'See [file](sandbox:/api/uploads/abc123.png)'
    const result = normalizeAssistantArtifactLinks(text, '/tmp')
    assert.ok(result.includes('/api/uploads/abc123.png'))
    assert.ok(!result.includes('sandbox:'))
  })

  it('passes through text without links unchanged', () => {
    const text = 'No links here at all'
    assert.equal(normalizeAssistantArtifactLinks(text, '/tmp'), text)
  })
})

// ---------------------------------------------------------------------------
// getExplicitRequiredToolNames
// ---------------------------------------------------------------------------
describe('getExplicitRequiredToolNames', () => {
  it('does not force web_search for generic research phrasing when the tool was not explicitly named', () => {
    const result = getExplicitRequiredToolNames(
      'Search the web for the latest news about AI regulation',
      ['web_search', 'web_fetch', 'browser'],
    )
    assert.deepEqual(result, [])
  })

  it('returns empty when no tool matches the message', () => {
    const result = getExplicitRequiredToolNames(
      'What is 2 + 2?',
      ['files', 'shell'],
    )
    assert.deepEqual(result, [])
  })

  it('forces shell when the user explicitly asks for curl execution', () => {
    const result = getExplicitRequiredToolNames(
      'Can you run the curl request in the terminal?',
      ['files', 'shell'],
    )
    assert.deepEqual(result, ['shell'])
  })

  it('requires a file-writing tool when the user explicitly asks for a saved artifact path', () => {
    const result = getExplicitRequiredToolNames(
      'Build a dashboard and save it as dashboard.html in the current directory.',
      ['files', 'shell'],
    )
    assert.deepEqual(result, ['files'])
  })

  it('does not require email delivery for a drafting-only email request', () => {
    const result = getExplicitRequiredToolNames(
      'Draft a 3-email onboarding sequence for new SaaS customers.',
      ['email', 'files'],
    )
    assert.deepEqual(result, [])
  })
})
