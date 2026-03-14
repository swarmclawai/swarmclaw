import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SSEEvent } from '@/types'
import {
  resolveRequestedToolPreflightResponse,
  runPostLlmToolRouting,
} from '@/lib/server/chat-execution/chat-turn-tool-routing'
import { resolveSessionToolPolicy } from '@/lib/server/tool-capability-policy'

describe('chat-turn-tool-routing', () => {
  it('fails fast before model execution when an explicitly requested tool is unavailable', () => {
    const response = resolveRequestedToolPreflightResponse({
      message: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      enabledPlugins: ['shell', 'files'],
      toolPolicy: resolveSessionToolPolicy(['shell', 'files'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
    })

    assert.match(String(response || ''), /couldn't use delegation/i)
    assert.match(String(response || ''), /not enabled/i)
  })

  it('returns a user-safe response when an explicitly requested delegation tool is policy-blocked', async () => {
    const events: SSEEvent[] = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: [],
      },
      sessionId: 'session-1',
      message: 'Use delegate_to_codex_cli. task: "Summarize the repo state."',
      effectiveMessage: 'Use delegate_to_codex_cli. task: "Summarize the repo state."',
      enabledPlugins: [],
      toolPolicy: resolveSessionToolPolicy([], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: (event) => { events.push(event) },
    }, '', undefined)

    assert.match(result.fullResponse, /couldn't use delegation/i)
    assert.equal(result.missedRequestedTools.length, 0)
    assert.equal(events.some((event) => event.t === 'err' && String((event as { text?: string }).text || '').includes('Capability policy blocked')), false)
  })

  it('returns a user-safe response when delegation is unavailable in the current session', async () => {
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['delegate'],
      },
      sessionId: 'session-2',
      message: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      effectiveMessage: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      enabledPlugins: ['delegate'],
      toolPolicy: resolveSessionToolPolicy(['delegate'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', 'Connection error.')

    assert.match(result.fullResponse, /couldn't use delegation/i)
    assert.match(result.fullResponse, /not enabled for this agent/i)
    assert.equal(result.missedRequestedTools.length, 0)
    assert.equal(result.errorMessage, undefined)
  })

  it('overrides improvised alternate-tool output when an explicitly requested tool is unavailable', async () => {
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['shell'],
      },
      sessionId: 'session-3',
      message: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      effectiveMessage: 'Use delegate_to_codex_cli. task: "Say hi in one sentence."',
      enabledPlugins: ['shell'],
      toolPolicy: resolveSessionToolPolicy(['shell'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [
        {
          name: 'shell',
          input: '{"action":"execute","command":"codex exec ..."}',
          output: 'Hi.',
        },
      ],
      emit: () => {},
    }, 'Task completed via shell fallback.', undefined)

    assert.match(result.fullResponse, /couldn't use delegation/i)
    assert.doesNotMatch(result.fullResponse, /Task completed via shell fallback/)
    assert.equal(result.missedRequestedTools.length, 0)
  })

  it('uses classifier-backed memory store fallback without heuristic parsing', async () => {
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-store',
      message: 'Please remember that my launch marker is ALPHA-7 for future conversations.',
      effectiveMessage: 'Please remember that my launch marker is ALPHA-7 for future conversations.',
      enabledPlugins: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, 'Got it.', undefined, {
      classifyDirectMemoryIntent: async () => ({
        action: 'store',
        confidence: 0.98,
        title: 'Launch marker',
        value: 'My launch marker is ALPHA-7',
        acknowledgement: 'I\'ll remember that your launch marker is ALPHA-7.',
      }),
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        invocations.push({ toolName, args })
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: 'Stored memory "Launch marker" (id: mem-1).',
        }
      },
    })

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].toolName, 'memory_store')
    assert.deepEqual(invocations[0].args, {
      title: 'Launch marker',
      value: 'My launch marker is ALPHA-7',
    })
    assert.equal(result.fullResponse, 'I\'ll remember that your launch marker is ALPHA-7.')
    assert.equal(result.errorMessage, undefined)
    assert.equal(result.calledNames.has('memory_store'), true)
  })

  it('uses classifier-backed memory update fallback and surfaces tool errors directly', async () => {
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-update',
      message: 'Correction: my launch marker is ALPHA-8 now.',
      effectiveMessage: 'Correction: my launch marker is ALPHA-8 now.',
      enabledPlugins: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', undefined, {
      classifyDirectMemoryIntent: async () => ({
        action: 'update',
        confidence: 0.97,
        title: 'Launch marker',
        value: 'My launch marker is ALPHA-8',
        acknowledgement: 'I\'ll use your updated launch marker going forward.',
      }),
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        invocations.push({ toolName, args })
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: 'Error: canonical memory entry not found.',
        }
      },
    })

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].toolName, 'memory_update')
    assert.deepEqual(invocations[0].args, {
      title: 'Launch marker',
      value: 'My launch marker is ALPHA-8',
    })
    assert.equal(result.fullResponse, 'Error: canonical memory entry not found.')
    assert.equal(result.calledNames.has('memory_update'), true)
  })

  it('uses classifier-backed recall fallback and returns a natural answer', async () => {
    const invocations: Array<{ toolName: string; args: Record<string, unknown> }> = []
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-recall',
      message: 'What is my launch marker right now?',
      effectiveMessage: 'What is my launch marker right now?',
      enabledPlugins: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', 'Connection error.', {
      classifyDirectMemoryIntent: async () => ({
        action: 'recall',
        confidence: 0.94,
        query: 'launch marker',
        missResponse: 'I do not have your launch marker in memory yet.',
      }),
      invokeTool: async (_ctx, toolName, args, _failurePrefix, calledNames) => {
        invocations.push({ toolName, args })
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: '[mem_123] (agent:agent-1) knowledge/facts/Launch marker: My launch marker is ALPHA-7',
        }
      },
    })

    assert.equal(invocations.length, 1)
    assert.equal(invocations[0].toolName, 'memory_search')
    assert.deepEqual(invocations[0].args, {
      query: 'launch marker',
      scope: 'auto',
    })
    assert.equal(result.fullResponse, 'Your launch marker is ALPHA-7.')
    assert.equal(result.errorMessage, undefined)
    assert.equal(result.calledNames.has('memory_search'), true)
  })

  it('returns the classifier miss response when recall finds no durable memory', async () => {
    const result = await runPostLlmToolRouting({
      session: {
        cwd: process.cwd(),
        tools: ['memory'],
      },
      sessionId: 'session-memory-miss',
      message: 'What is my launch marker right now?',
      effectiveMessage: 'What is my launch marker right now?',
      enabledPlugins: ['memory'],
      toolPolicy: resolveSessionToolPolicy(['memory'], {}),
      appSettings: {},
      internal: false,
      source: 'chat',
      toolEvents: [],
      emit: () => {},
    }, '', undefined, {
      classifyDirectMemoryIntent: async () => ({
        action: 'recall',
        confidence: 0.94,
        query: 'launch marker',
        missResponse: 'I do not have your launch marker in memory yet.',
      }),
      invokeTool: async (_ctx, toolName, _args, _failurePrefix, calledNames) => {
        calledNames.add(toolName)
        return {
          invoked: true,
          responseOverride: null,
          toolOutputText: 'No memories found.',
        }
      },
    })

    assert.equal(result.fullResponse, 'I do not have your launch marker in memory yet.')
    assert.equal(result.errorMessage, undefined)
    assert.equal(result.calledNames.has('memory_search'), true)
  })
})
