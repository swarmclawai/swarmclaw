import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { MessageToolEvent, SSEEvent } from '@/types'
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

describe('collectToolEvent', () => {
  it('dedupes consecutive identical pending tool_call events', () => {
    const bag: MessageToolEvent[] = []
    const toolCall: SSEEvent = {
      t: 'tool_call',
      toolName: 'files',
      toolInput: '{"path":"spec.md"}',
      toolCallId: 'call-1',
    }

    collectToolEvent(toolCall, bag)
    collectToolEvent(toolCall, bag)

    assert.deepEqual(bag, [
      {
        name: 'files',
        input: '{"path":"spec.md"}',
        toolCallId: 'call-1',
      },
    ])
  })

  it('still records a second tool call after the first one completed', () => {
    const bag: MessageToolEvent[] = []
    const toolCall: SSEEvent = {
      t: 'tool_call',
      toolName: 'files',
      toolInput: '{"path":"spec.md"}',
      toolCallId: 'call-1',
    }
    const toolResult: SSEEvent = {
      t: 'tool_result',
      toolName: 'files',
      toolOutput: 'Written spec.md (12 bytes)',
      toolCallId: 'call-1',
    }

    collectToolEvent(toolCall, bag)
    collectToolEvent(toolResult, bag)
    collectToolEvent(toolCall, bag)

    assert.deepEqual(bag, [
      {
        name: 'files',
        input: '{"path":"spec.md"}',
        output: 'Written spec.md (12 bytes)',
        error: undefined,
        toolCallId: 'call-1',
      },
      {
        name: 'files',
        input: '{"path":"spec.md"}',
        toolCallId: 'call-1',
      },
    ])
  })

  it('marks command-exit and MCP validation failures as tool errors', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({
      t: 'tool_call',
      toolName: 'shell',
      toolInput: '{"command":"python broken.py"}',
      toolCallId: 'call-shell',
    }, bag)
    collectToolEvent({
      t: 'tool_result',
      toolName: 'shell',
      toolOutput: 'Error (exit 1): Traceback...',
      toolCallId: 'call-shell',
    }, bag)
    collectToolEvent({
      t: 'tool_call',
      toolName: 'browser',
      toolInput: '{"command":"click"}',
      toolCallId: 'call-browser',
    }, bag)
    collectToolEvent({
      t: 'tool_result',
      toolName: 'browser',
      toolOutput: '{"error":"MCP error -32000: invalid_type","issues":[{"code":"invalid_type"}]}',
      toolCallId: 'call-browser',
    }, bag)

    assert.equal(bag[0].error, true)
    assert.equal(bag[1].error, true)
  })

  it('matches parallel same-tool results by toolCallId instead of swapping outputs', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({
      t: 'tool_call',
      toolName: 'wallet_tool',
      toolInput: '{"action":"balance","chain":"solana"}',
      toolCallId: 'call-sol',
    }, bag)
    collectToolEvent({
      t: 'tool_call',
      toolName: 'wallet_tool',
      toolInput: '{"action":"balance","chain":"ethereum"}',
      toolCallId: 'call-eth',
    }, bag)
    collectToolEvent({
      t: 'tool_result',
      toolName: 'wallet_tool',
      toolOutput: '{"chain":"solana"}',
      toolCallId: 'call-sol',
    }, bag)
    collectToolEvent({
      t: 'tool_result',
      toolName: 'wallet_tool',
      toolOutput: '{"chain":"ethereum"}',
      toolCallId: 'call-eth',
    }, bag)

    assert.equal(bag[0].output, '{"chain":"solana"}')
    assert.equal(bag[1].output, '{"chain":"ethereum"}')
  })
})

describe('dedupeConsecutiveToolEvents', () => {
  it('removes consecutive duplicate persisted events', () => {
    const events: MessageToolEvent[] = [
      { name: 'web', input: '{"action":"search"}', output: 'ok' },
      { name: 'web', input: '{"action":"search"}', output: 'ok' },
      { name: 'files', input: '{"action":"list"}', output: 'spec.md' },
      { name: 'files', input: '{"action":"list"}', output: 'spec.md' },
      { name: 'web', input: '{"action":"search"}', output: 'ok' },
    ]

    assert.deepEqual(dedupeConsecutiveToolEvents(events), [
      { name: 'web', input: '{"action":"search"}', output: 'ok' },
      { name: 'files', input: '{"action":"list"}', output: 'spec.md' },
      { name: 'web', input: '{"action":"search"}', output: 'ok' },
    ])
  })

  it('collapses adjacent repeated event blocks', () => {
    const events: MessageToolEvent[] = [
      { name: 'delegate', input: '{"task":"draft"}', output: '{"status":"completed"}' },
      { name: 'files', input: '{"action":"write"}', output: 'Written spec.md' },
      { name: 'delegate', input: '{"task":"draft"}', output: '{"status":"completed"}' },
      { name: 'files', input: '{"action":"write"}', output: 'Written spec.md' },
      { name: 'delegate_to_codex_cli', input: '{"task":"full"}', output: '{"status":"completed"}' },
    ]

    assert.deepEqual(dedupeConsecutiveToolEvents(events), [
      { name: 'delegate', input: '{"task":"draft"}', output: '{"status":"completed"}' },
      { name: 'files', input: '{"action":"write"}', output: 'Written spec.md' },
      { name: 'delegate_to_codex_cli', input: '{"task":"full"}', output: '{"status":"completed"}' },
    ])
  })
})

describe('deriveTerminalRunError', () => {
  it('uses the streamed provider error when no text was produced', () => {
    assert.equal(
      deriveTerminalRunError({
        errorMessage: undefined,
        fullResponse: '',
        streamErrors: ['Ollama error (401): invalid api key'],
        toolEvents: [],
        internal: false,
      }),
      'Ollama error (401): invalid api key',
    )
  })

  it('converts empty successful runs into a visible assistant error', () => {
    assert.equal(
      deriveTerminalRunError({
        errorMessage: undefined,
        fullResponse: '',
        streamErrors: [],
        toolEvents: [],
        internal: false,
      }),
      'Run completed without any response text, tool calls, or explicit error details. Check the provider configuration and try again.',
    )
  })

  it('does not invent an error when tools ran or when the run was internal', () => {
    assert.equal(
      deriveTerminalRunError({
        errorMessage: undefined,
        fullResponse: '',
        streamErrors: [],
        toolEvents: [{ name: 'files', input: '{"action":"list"}', output: 'spec.md' }],
        internal: false,
      }),
      undefined,
    )
    assert.equal(
      deriveTerminalRunError({
        errorMessage: undefined,
        fullResponse: '',
        streamErrors: [],
        toolEvents: [],
        internal: true,
      }),
      undefined,
    )
  })
})

describe('requestedToolNamesFromMessage', () => {
  it('does not infer delegate from ordinary delegation prose', () => {
    assert.deepEqual(
      requestedToolNamesFromMessage('If Molly delegates later, that is fine, but do not mention tools.'),
      [],
    )
  })

  it('still detects explicit delegate tool requests', () => {
    assert.deepEqual(
      requestedToolNamesFromMessage('Use the delegate tool if Codex is better suited.'),
      ['delegate'],
    )
  })

  it('ignores negated web mentions and ordinary browsing prose', () => {
    assert.deepEqual(
      requestedToolNamesFromMessage('Do not browse the web for this task.'),
      [],
    )
    assert.deepEqual(
      requestedToolNamesFromMessage('Avoid using browser for this step.'),
      [],
    )
  })

  it('detects explicit email tool requests', () => {
    assert.deepEqual(
      requestedToolNamesFromMessage('Use the email tool to send a welcome email after signup finishes.'),
      ['email'],
    )
  })
})

describe('hasDirectLocalCodingTools', () => {
  it('treats shell and file tooling as local coding capability', () => {
    assert.equal(hasDirectLocalCodingTools({ plugins: ['files'] }), true)
    assert.equal(hasDirectLocalCodingTools({ plugins: ['shell'] }), true)
    assert.equal(hasDirectLocalCodingTools({ plugins: ['edit_file'] }), true)
    assert.equal(hasDirectLocalCodingTools({ plugins: ['delegate'] }), false)
  })
})

describe('normalizeAssistantArtifactLinks', () => {
  it('rewrites existing workspace sandbox links to served file URLs', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-execution-links-'))
    const nestedDir = path.join(cwd, 'notes')
    fs.mkdirSync(nestedDir, { recursive: true })
    const filePath = path.join(nestedDir, 'spec.md')
    fs.writeFileSync(filePath, '# spec\n')

    const normalized = normalizeAssistantArtifactLinks(
      `Saved \`sandbox:/workspace/notes/spec.md\`, [spec](${filePath}), [workspace spec](sandbox:/workspace/notes/spec.md), and sandbox:/api/uploads/demo.pdf`,
      cwd,
    )

    assert.equal(
      normalized,
      `Saved \`sandbox:/workspace/notes/spec.md\`, [spec](/api/files/serve?path=${encodeURIComponent(filePath)}), [workspace spec](/api/files/serve?path=${encodeURIComponent(filePath)}), and /api/uploads/demo.pdf`,
    )
  })
})

describe('isLikelyToolErrorOutput', () => {
  it('recognizes broader structured tool failures without flagging normal output', () => {
    assert.equal(isLikelyToolErrorOutput('Error (exit 1): build failed'), true)
    assert.equal(isLikelyToolErrorOutput('{"status":"failed","error":"timeout"}'), true)
    assert.equal(isLikelyToolErrorOutput('{"status":"completed"}'), false)
    assert.equal(isLikelyToolErrorOutput('Written spec.md (12 bytes)'), false)
  })
})

describe('translateRequestedToolInvocation', () => {
  it('keeps a specific manage tool when that tool is directly available', () => {
    assert.deepEqual(
      translateRequestedToolInvocation(
        'manage_schedules',
        { action: 'create', scheduleType: 'interval' },
        'schedule a job',
        ['manage_schedules'],
      ),
      {
        toolName: 'manage_schedules',
        args: { action: 'create', scheduleType: 'interval' },
      },
    )
  })

  it('maps manage_platform back to the specific manage tool when only the specific tool exists', () => {
    assert.deepEqual(
      translateRequestedToolInvocation(
        'manage_platform',
        { resource: 'schedules', action: 'create', scheduleType: 'interval' },
        'schedule a job',
        ['manage_schedules'],
      ),
      {
        toolName: 'manage_schedules',
        args: { resource: 'schedules', action: 'create', scheduleType: 'interval' },
      },
    )
  })

  it('still falls back to manage_platform when only the unified tool exists', () => {
    assert.deepEqual(
      translateRequestedToolInvocation(
        'manage_schedules',
        { action: 'list' },
        'list schedules',
        ['manage_platform'],
      ),
      {
        toolName: 'manage_platform',
        args: { resource: 'schedules', action: 'list' },
      },
    )
  })
})

describe('reconcileConnectorDeliveryText', () => {
  it('overrides false connector success claims when no send succeeded', () => {
    assert.equal(
      reconcileConnectorDeliveryText(
        `I've successfully sent the voice note to your WhatsApp.`,
        [
          {
            name: 'connector_message_tool',
            input: '{"action":"send_voice_note"}',
            output: 'Error: {"detail":{"message":"Free users cannot use library voices via the API."}}',
            error: true,
          },
        ],
      ),
      `I couldn't send that through the configured connector. Free users cannot use library voices via the API.`,
    )
  })

  it('preserves connector success confirmations when a send completed', () => {
    assert.equal(
      reconcileConnectorDeliveryText(
        `I've successfully sent the update to your WhatsApp.`,
        [
          {
            name: 'connector_message_tool',
            input: '{"action":"send"}',
            output: '{"status":"sent","to":"447700900444@s.whatsapp.net"}',
          },
        ],
      ),
      `I've successfully sent the update to your WhatsApp.`,
    )
  })

  it('downgrades connector delivery claims when no connector tool call was recorded', () => {
    assert.equal(
      reconcileConnectorDeliveryText(
        `Sent voice notes to both Mom and Gran.\n\n| Recipient | Number | Message ID |\n|-----------|--------|------------|`,
        [],
      ),
      `I couldn't confirm that the configured connector actually sent anything. No connector delivery tool call was recorded for this response.`,
    )
  })
})
