import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { Message } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let cm: typeof import('./context-manager')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-context-manager-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  cm = await import('./context-manager')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function makeMsg(role: 'user' | 'assistant', text: string, toolEvents?: Message['toolEvents']): Message {
  return { role, text, time: Date.now(), toolEvents }
}

describe('context-manager', () => {
  // --- estimateTokens ---

  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      assert.equal(cm.estimateTokens(''), 0)
    })

    it('returns 0 for falsy input', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.equal(cm.estimateTokens(null as any), 0)
    })

    it('estimates ~1 token per 4 chars', () => {
      const tokens = cm.estimateTokens('abcdefghijklmnop') // 16 chars
      assert.equal(tokens, 4)
    })

    it('rounds up fractional token counts', () => {
      const tokens = cm.estimateTokens('abcde') // 5 chars -> ceil(5/4) = 2
      assert.equal(tokens, 2)
    })
  })

  // --- estimateMessagesTokens ---

  describe('estimateMessagesTokens', () => {
    it('returns 0 for empty array', () => {
      assert.equal(cm.estimateMessagesTokens([]), 0)
    })

    it('includes per-message overhead', () => {
      const msgs = [makeMsg('user', 'hi')]
      const tokens = cm.estimateMessagesTokens(msgs)
      // 4 overhead + ceil(2/4) = 4 + 1 = 5
      assert.equal(tokens, 5)
    })

    it('includes tool event tokens', () => {
      const msgs = [makeMsg('assistant', 'ok', [
        { name: 'web_search', input: '{"q":"test query string here"}', output: 'result data here' },
      ])]
      const tokens = cm.estimateMessagesTokens(msgs)
      // Should be > just the text tokens
      assert.ok(tokens > 5, `Expected more than 5 tokens with tool events, got ${tokens}`)
    })
  })

  // --- getContextWindowSize ---

  describe('getContextWindowSize', () => {
    it('returns known model window size', () => {
      assert.equal(cm.getContextWindowSize('anthropic', 'claude-opus-4-6'), 200_000)
    })

    it('falls back to provider default for unknown model', () => {
      assert.equal(cm.getContextWindowSize('anthropic', 'claude-unknown-model'), 200_000)
    })

    it('falls back to 8192 for unknown provider and model', () => {
      assert.equal(cm.getContextWindowSize('unknown-provider', 'unknown-model'), 8_192)
    })

    it('returns openai model sizes', () => {
      assert.equal(cm.getContextWindowSize('openai', 'gpt-4o'), 128_000)
    })
  })

  // --- getContextStatus ---

  describe('getContextStatus', () => {
    it('returns ok for small context usage', () => {
      const msgs = [makeMsg('user', 'hello')]
      const status = cm.getContextStatus(msgs, 100, 'anthropic', 'claude-opus-4-6')
      assert.equal(status.strategy, 'ok')
      assert.ok(status.percentUsed < 70)
      assert.equal(status.contextWindow, 200_000)
      assert.equal(status.messageCount, 1)
      assert.equal(status.effectiveTokens, status.estimatedTokens)
    })

    it('returns warning at 70%+ usage', () => {
      // 200k window, need ~140k tokens. 140000 tokens * 4 chars = 560000 chars
      const bigText = 'x'.repeat(560_000)
      const msgs = [makeMsg('user', bigText)]
      const status = cm.getContextStatus(msgs, 0, 'anthropic', 'claude-opus-4-6')
      assert.equal(status.strategy, 'warning')
    })

    it('returns critical at 90%+ usage', () => {
      const bigText = 'x'.repeat(720_000) // 180k tokens
      const msgs = [makeMsg('user', bigText)]
      const status = cm.getContextStatus(msgs, 0, 'anthropic', 'claude-opus-4-6')
      assert.equal(status.strategy, 'critical')
    })

    it('includes extra and reserve tokens in effective usage', () => {
      const msgs = [makeMsg('user', 'hello')]
      const status = cm.getContextStatus(msgs, 100, 'anthropic', 'claude-opus-4-6', {
        extraTokens: 500,
        reserveTokens: 20_000,
      })
      assert.equal(status.extraTokens, 500)
      assert.equal(status.reserveTokens, 20_000)
      assert.equal(status.effectiveTokens, status.estimatedTokens + 20_000)
      assert.equal(status.remainingTokens, status.contextWindow - status.effectiveTokens)
    })
  })

  // --- getContextDegradationWarning ---

  describe('getContextDegradationWarning', () => {
    it('returns null below 60%', () => {
      const msgs = [makeMsg('user', 'short message')]
      const warning = cm.getContextDegradationWarning(msgs, 100, 'anthropic', 'claude-opus-4-6')
      assert.equal(warning, null)
    })

    it('returns warning at 85%+', () => {
      const bigText = 'x'.repeat(680_000) // ~170k tokens
      const msgs = [makeMsg('user', bigText)]
      const warning = cm.getContextDegradationWarning(msgs, 0, 'anthropic', 'claude-opus-4-6')
      assert.ok(warning !== null)
      assert.ok(warning!.includes('CRITICAL'))
    })

    it('returns softer warning between 60-70%', () => {
      // Need 60-70% of 200k = 120k-140k tokens = 480k-560k chars
      const text = 'x'.repeat(500_000)
      const msgs = [makeMsg('user', text)]
      const warning = cm.getContextDegradationWarning(msgs, 0, 'anthropic', 'claude-opus-4-6')
      assert.ok(warning !== null)
      assert.ok(warning!.includes('Consider saving'))
    })
  })

  // --- shouldAutoCompact ---

  describe('shouldAutoCompact', () => {
    it('returns false for small context', () => {
      const msgs = [makeMsg('user', 'hello')]
      assert.equal(cm.shouldAutoCompact(msgs, 100, 'anthropic', 'claude-opus-4-6'), false)
    })

    it('returns true when context exceeds threshold', () => {
      const bigText = 'x'.repeat(660_000) // ~165k tokens -> 82.5% of 200k
      const msgs = [makeMsg('user', bigText)]
      assert.equal(cm.shouldAutoCompact(msgs, 0, 'anthropic', 'claude-opus-4-6'), true)
    })

    it('respects custom trigger percent', () => {
      const bigText = 'x'.repeat(400_000) // ~100k tokens -> 50% of 200k
      const msgs = [makeMsg('user', bigText)]
      assert.equal(cm.shouldAutoCompact(msgs, 0, 'anthropic', 'claude-opus-4-6', 40, { reserveTokens: 0 }), true)
      assert.equal(cm.shouldAutoCompact(msgs, 0, 'anthropic', 'claude-opus-4-6', 60, { reserveTokens: 0 }), false)
    })

    it('accounts for the pending message and reserve headroom', () => {
      const msgs = [makeMsg('user', 'x'.repeat(480_000))] // ~120k tokens -> 60% of 200k
      assert.equal(cm.shouldAutoCompact(msgs, 0, 'anthropic', 'claude-opus-4-6', 80), false)
      assert.equal(cm.shouldAutoCompact(msgs, 0, 'anthropic', 'claude-opus-4-6', 80, {
        extraTokens: 30_000,
        reserveTokens: 20_000,
      }), true)
    })
  })

  describe('resolveCompactionReserveTokens', () => {
    it('matches the OpenClaw-style floor on large windows', () => {
      assert.equal(cm.resolveCompactionReserveTokens('anthropic', 'claude-opus-4-6'), 20_000)
    })

    it('scales reserve down for smaller windows', () => {
      assert.equal(cm.resolveCompactionReserveTokens('ollama', 'glm-5:cloud'), Math.floor(32_768 * 0.2))
    })
  })

  // --- slidingWindowCompact ---

  describe('slidingWindowCompact', () => {
    it('returns all messages when under limit', () => {
      const msgs = [makeMsg('user', 'a'), makeMsg('assistant', 'b')]
      const result = cm.slidingWindowCompact(msgs, 5)
      assert.equal(result.length, 2)
    })

    it('keeps only last N messages', () => {
      const msgs = Array.from({ length: 20 }, (_, i) => makeMsg('user', `msg-${i}`))
      const result = cm.slidingWindowCompact(msgs, 5)
      assert.equal(result.length, 5)
      assert.equal(result[0].text, 'msg-15')
      assert.equal(result[4].text, 'msg-19')
    })
  })

  // --- splitMessagesByTokenBudget ---

  describe('splitMessagesByTokenBudget', () => {
    it('returns empty array for empty messages', () => {
      assert.deepEqual(cm.splitMessagesByTokenBudget([], 1000), [])
    })

    it('keeps all in one chunk when within budget', () => {
      const msgs = [makeMsg('user', 'hi'), makeMsg('assistant', 'hello')]
      const chunks = cm.splitMessagesByTokenBudget(msgs, 10000)
      assert.equal(chunks.length, 1)
      assert.equal(chunks[0].length, 2)
    })

    it('splits messages across multiple chunks', () => {
      const msgs = Array.from({ length: 10 }, () =>
        makeMsg('user', 'x'.repeat(400)), // ~100 tokens + 4 overhead each
      )
      // Budget of 210 tokens should fit ~2 messages per chunk
      const chunks = cm.splitMessagesByTokenBudget(msgs, 210)
      assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`)
      // All messages should be accounted for
      const totalMsgs = chunks.reduce((sum, c) => sum + c.length, 0)
      assert.equal(totalMsgs, 10)
    })
  })

  // --- computeAdaptiveChunkRatio ---

  describe('computeAdaptiveChunkRatio', () => {
    it('returns base ratio for empty messages', () => {
      assert.equal(cm.computeAdaptiveChunkRatio([], 200_000), 0.4)
    })

    it('returns base ratio for small messages', () => {
      const msgs = [makeMsg('user', 'short')]
      const ratio = cm.computeAdaptiveChunkRatio(msgs, 200_000)
      assert.equal(ratio, 0.4)
    })

    it('reduces ratio for large average messages', () => {
      // Need avgRatio > 0.1: safeAvgTokens / contextWindow > 0.1
      // For 200k window: safeAvgTokens > 20k -> avgTokens > 20k/1.2 ~ 16667 -> chars > 66668
      const msgs = Array.from({ length: 4 }, () => makeMsg('user', 'x'.repeat(80_000)))
      const ratio = cm.computeAdaptiveChunkRatio(msgs, 200_000)
      assert.ok(ratio < 0.4, `Expected ratio < 0.4, got ${ratio}`)
      assert.ok(ratio >= 0.15, `Expected ratio >= 0.15, got ${ratio}`)
    })
  })

  // --- extractToolFailures ---

  describe('extractToolFailures', () => {
    it('returns empty array when no failures', () => {
      const msgs = [makeMsg('assistant', 'ok', [
        { name: 'web', input: '{}', output: 'data' },
      ])]
      assert.deepEqual(cm.extractToolFailures(msgs), [])
    })

    it('extracts tool failures', () => {
      const msgs = [makeMsg('assistant', 'fail', [
        { name: 'shell', input: 'ls', output: 'command not found', error: true },
      ])]
      const failures = cm.extractToolFailures(msgs)
      assert.equal(failures.length, 1)
      assert.ok(failures[0].includes('[shell]'))
      assert.ok(failures[0].includes('error'))
    })

    it('limits to MAX_TOOL_FAILURES (8)', () => {
      const events = Array.from({ length: 20 }, (_, i) => ({
        name: `tool-${i}`, input: '{}', output: `err-${i}`, error: true as const,
      }))
      const msgs = [makeMsg('assistant', 'many errors', events)]
      const failures = cm.extractToolFailures(msgs)
      assert.equal(failures.length, 8)
    })
  })

  // --- extractFileOperations ---

  describe('extractFileOperations', () => {
    it('returns empty sets when no file ops', () => {
      const msgs = [makeMsg('user', 'hello')]
      const ops = cm.extractFileOperations(msgs)
      assert.deepEqual(ops, { read: [], modified: [] })
    })

    it('extracts read operations', () => {
      const msgs = [makeMsg('assistant', 'reading', [
        { name: 'read_file', input: JSON.stringify({ filePath: '/tmp/test.ts' }) },
      ])]
      const ops = cm.extractFileOperations(msgs)
      assert.deepEqual(ops.read, ['/tmp/test.ts'])
      assert.deepEqual(ops.modified, [])
    })

    it('extracts write operations', () => {
      const msgs = [makeMsg('assistant', 'writing', [
        { name: 'write_file', input: JSON.stringify({ filePath: '/tmp/out.ts' }) },
        { name: 'edit_file', input: JSON.stringify({ filePath: '/tmp/edit.ts' }) },
      ])]
      const ops = cm.extractFileOperations(msgs)
      assert.deepEqual(ops.read, [])
      assert.equal(ops.modified.length, 2)
      assert.ok(ops.modified.includes('/tmp/out.ts'))
      assert.ok(ops.modified.includes('/tmp/edit.ts'))
    })

    it('deduplicates paths', () => {
      const msgs = [
        makeMsg('assistant', 'op1', [
          { name: 'read_file', input: JSON.stringify({ filePath: '/tmp/same.ts' }) },
        ]),
        makeMsg('assistant', 'op2', [
          { name: 'read_file', input: JSON.stringify({ filePath: '/tmp/same.ts' }) },
        ]),
      ]
      const ops = cm.extractFileOperations(msgs)
      assert.equal(ops.read.length, 1)
    })
  })

  // --- llmCompact ---

  describe('llmCompact', () => {
    it('returns original messages when under keepLastN', async () => {
      const msgs = [makeMsg('user', 'hi'), makeMsg('assistant', 'hey')]
      const result = await cm.llmCompact({
        messages: msgs,
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        agentId: null,
        sessionId: 'test-session',
        summarize: async () => 'summary',
      })
      assert.equal(result.prunedCount, 0)
      assert.equal(result.summaryAdded, false)
      assert.equal(result.messages.length, 2)
    })

    it('summarizes old messages and keeps recent ones', async () => {
      const msgs = Array.from({ length: 15 }, (_, i) =>
        makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message-${i}`),
      )
      const result = await cm.llmCompact({
        messages: msgs,
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        agentId: null,
        sessionId: 'test-session',
        summarize: async () => 'This is a test summary of the conversation.',
        keepLastN: 5,
      })
      assert.equal(result.prunedCount, 10)
      assert.equal(result.summaryAdded, true)
      // summary message + 5 recent
      assert.equal(result.messages.length, 6)
      assert.ok(result.messages[0].text.includes('[Context Summary]'))
    })

    it('falls back to sliding window when summarizer fails', async () => {
      const msgs = Array.from({ length: 15 }, (_, i) =>
        makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message-${i}`),
      )
      const result = await cm.llmCompact({
        messages: msgs,
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        agentId: null,
        sessionId: 'test-session',
        summarize: async () => { throw new Error('LLM unavailable') },
        keepLastN: 5,
      })
      assert.equal(result.summaryAdded, false)
      assert.equal(result.messages.length, 5)
    })
  })

  // --- consolidateToMemory ---

  describe('consolidateToMemory', () => {
    it('returns 0 when agentId is null', () => {
      const msgs = [makeMsg('assistant', 'We decided to use Rust.')]
      assert.equal(cm.consolidateToMemory(msgs, null, 'session-1'), 0)
    })

    it('stores memories for decision-containing messages', () => {
      const msgs = [makeMsg('assistant', 'We decided to refactor the module using a new approach.')]
      const stored = cm.consolidateToMemory(msgs, 'agent-test', 'session-test')
      assert.ok(stored >= 1, `Expected at least 1 memory stored, got ${stored}`)
    })

    it('skips user messages', () => {
      const msgs = [makeMsg('user', 'We decided to use TypeScript.')]
      const stored = cm.consolidateToMemory(msgs, 'agent-test', 'session-test')
      assert.equal(stored, 0)
    })

    it('skips messages without decision/fact/result keywords', () => {
      const msgs = [makeMsg('assistant', 'Hello there, how are you?')]
      const stored = cm.consolidateToMemory(msgs, 'agent-test', 'session-test')
      assert.equal(stored, 0)
    })
  })
})
