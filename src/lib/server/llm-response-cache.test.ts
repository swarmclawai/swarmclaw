import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '@/types'
import {
  buildLlmResponseCacheKey,
  clearLlmResponseCache,
  getCachedLlmResponse,
  resolveLlmResponseCacheConfig,
  setCachedLlmResponse,
} from './llm-response-cache'

const HISTORY: Message[] = [
  { role: 'user', text: 'Plan a release.', time: 1 },
  { role: 'assistant', text: 'Drafted plan.', time: 2 },
]

test('buildLlmResponseCacheKey is deterministic for equivalent payloads', () => {
  const keyA = buildLlmResponseCacheKey({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiEndpoint: 'https://api.openai.com/v1',
    systemPrompt: 'System prompt',
    message: 'hello',
    history: HISTORY,
    attachedFiles: ['a.txt', 'b.txt'],
  })
  const keyB = buildLlmResponseCacheKey({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiEndpoint: 'https://api.openai.com/v1',
    systemPrompt: '  System   prompt ',
    message: 'hello',
    history: [...HISTORY],
    attachedFiles: ['a.txt', 'b.txt'],
  })
  assert.equal(keyA, keyB)
})

test('set/get cached responses returns hit and increments hit count', () => {
  clearLlmResponseCache()
  const config = { enabled: true, ttlMs: 60_000, maxEntries: 10 }
  const keyInput = {
    provider: 'openai',
    model: 'gpt-4o',
    message: 'status',
    history: HISTORY,
  }
  setCachedLlmResponse(keyInput, 'cached answer', config, 1000)
  const hit1 = getCachedLlmResponse(keyInput, config, 1500)
  assert.ok(hit1)
  assert.equal(hit1?.text, 'cached answer')
  assert.equal(hit1?.hits, 1)
  const hit2 = getCachedLlmResponse(keyInput, config, 1600)
  assert.equal(hit2?.hits, 2)
})

test('expired cache entry is not returned', () => {
  clearLlmResponseCache()
  const config = { enabled: true, ttlMs: 1000, maxEntries: 10 }
  const keyInput = {
    provider: 'openai',
    model: 'gpt-4o',
    message: 'status',
    history: HISTORY,
  }
  setCachedLlmResponse(keyInput, 'stale', config, 1000)
  const miss = getCachedLlmResponse(keyInput, config, 3001)
  assert.equal(miss, null)
})

test('cache evicts least recently used entries over maxEntries', () => {
  clearLlmResponseCache()
  const config = { enabled: true, ttlMs: 60_000, maxEntries: 2 }
  const inputA = { provider: 'openai', model: 'gpt-4o', message: 'a', history: HISTORY }
  const inputB = { provider: 'openai', model: 'gpt-4o', message: 'b', history: HISTORY }
  const inputC = { provider: 'openai', model: 'gpt-4o', message: 'c', history: HISTORY }
  setCachedLlmResponse(inputA, 'A', config, 1000)
  setCachedLlmResponse(inputB, 'B', config, 1001)
  // Touch A so B becomes LRU.
  getCachedLlmResponse(inputA, config, 1002)
  setCachedLlmResponse(inputC, 'C', config, 1003)

  assert.equal(getCachedLlmResponse(inputB, config, 1004), null)
  assert.equal(getCachedLlmResponse(inputA, config, 1004)?.text, 'A')
  assert.equal(getCachedLlmResponse(inputC, config, 1004)?.text, 'C')
})

test('resolveLlmResponseCacheConfig applies defaults and bounds', () => {
  const fallback = resolveLlmResponseCacheConfig({})
  assert.equal(fallback.enabled, true)
  assert.equal(fallback.ttlMs, 900_000)
  assert.equal(fallback.maxEntries, 500)

  const custom = resolveLlmResponseCacheConfig({
    responseCacheEnabled: false,
    responseCacheTtlSec: 1,
    responseCacheMaxEntries: 999999,
  })
  assert.equal(custom.enabled, false)
  assert.equal(custom.ttlMs, 5000)
  assert.equal(custom.maxEntries, 20_000)
})
