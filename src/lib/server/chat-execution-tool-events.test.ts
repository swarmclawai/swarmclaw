import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { MessageToolEvent, SSEEvent } from '@/types'
import {
  collectToolEvent,
  dedupeConsecutiveToolEvents,
  isLikelyToolErrorOutput,
  normalizeAssistantArtifactLinks,
  requestedToolNamesFromMessage,
  translateRequestedToolInvocation,
} from './chat-execution'

describe('collectToolEvent', () => {
  it('dedupes consecutive identical pending tool_call events', () => {
    const bag: MessageToolEvent[] = []
    const toolCall: SSEEvent = {
      t: 'tool_call',
      toolName: 'files',
      toolInput: '{"path":"spec.md"}',
    }

    collectToolEvent(toolCall, bag)
    collectToolEvent(toolCall, bag)

    assert.deepEqual(bag, [
      {
        name: 'files',
        input: '{"path":"spec.md"}',
      },
    ])
  })

  it('still records a second tool call after the first one completed', () => {
    const bag: MessageToolEvent[] = []
    const toolCall: SSEEvent = {
      t: 'tool_call',
      toolName: 'files',
      toolInput: '{"path":"spec.md"}',
    }
    const toolResult: SSEEvent = {
      t: 'tool_result',
      toolName: 'files',
      toolOutput: 'Written spec.md (12 bytes)',
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
      },
      {
        name: 'files',
        input: '{"path":"spec.md"}',
      },
    ])
  })

  it('marks command-exit and MCP validation failures as tool errors', () => {
    const bag: MessageToolEvent[] = []
    collectToolEvent({
      t: 'tool_call',
      toolName: 'shell',
      toolInput: '{"command":"python broken.py"}',
    }, bag)
    collectToolEvent({
      t: 'tool_result',
      toolName: 'shell',
      toolOutput: 'Error (exit 1): Traceback...',
    }, bag)
    collectToolEvent({
      t: 'tool_call',
      toolName: 'browser',
      toolInput: '{"command":"click"}',
    }, bag)
    collectToolEvent({
      t: 'tool_result',
      toolName: 'browser',
      toolOutput: '{"error":"MCP error -32000: invalid_type","issues":[{"code":"invalid_type"}]}',
    }, bag)

    assert.equal(bag[0].error, true)
    assert.equal(bag[1].error, true)
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
