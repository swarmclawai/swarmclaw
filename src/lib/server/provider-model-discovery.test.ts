import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeModelId,
  looksLikeChatModel,
  dedupeModels,
  extractCandidateModelIds,
  extractDiscoveredModels,
  ttlForDescriptor,
  parseErrorMessage,
  type DiscoveryDescriptor,
} from './provider-model-discovery'

// ---------------------------------------------------------------------------
// normalizeModelId
// ---------------------------------------------------------------------------

test('normalizeModelId strips :latest for ollama', () => {
  assert.equal(normalizeModelId('llama3.2:latest', 'ollama'), 'llama3.2')
})

test('normalizeModelId preserves non-latest tags for ollama', () => {
  assert.equal(normalizeModelId('codellama:7b', 'ollama'), 'codellama:7b')
})

test('normalizeModelId strips models/ prefix for google', () => {
  assert.equal(normalizeModelId('models/gemini-2.0-flash', 'google'), 'gemini-2.0-flash')
})

test('normalizeModelId no-ops for openai-compatible', () => {
  assert.equal(normalizeModelId('gpt-4o', 'openai-compatible'), 'gpt-4o')
})

test('normalizeModelId returns empty for whitespace', () => {
  assert.equal(normalizeModelId('   ', 'openai-compatible'), '')
})

// ---------------------------------------------------------------------------
// looksLikeChatModel
// ---------------------------------------------------------------------------

test('looksLikeChatModel excludes embeddings', () => {
  assert.equal(looksLikeChatModel('openai', 'text-embedding-3-small'), false)
})

test('looksLikeChatModel excludes rerank', () => {
  assert.equal(looksLikeChatModel('together', 'rerank-v1'), false)
})

test('looksLikeChatModel excludes tts', () => {
  assert.equal(looksLikeChatModel('openai', 'tts-1'), false)
})

test('looksLikeChatModel excludes whisper', () => {
  assert.equal(looksLikeChatModel('openai', 'whisper-1'), false)
})

test('looksLikeChatModel excludes stable-diffusion', () => {
  assert.equal(looksLikeChatModel('together', 'stable-diffusion-xl'), false)
})

test('looksLikeChatModel: openai gpt-4o → true', () => {
  assert.equal(looksLikeChatModel('openai', 'gpt-4o'), true)
})

test('looksLikeChatModel: openai o1 → true', () => {
  assert.equal(looksLikeChatModel('openai', 'o1'), true)
})

test('looksLikeChatModel: openai o3-mini → true', () => {
  assert.equal(looksLikeChatModel('openai', 'o3-mini'), true)
})

test('looksLikeChatModel: openai o4-mini → true', () => {
  assert.equal(looksLikeChatModel('openai', 'o4-mini'), true)
})

test('looksLikeChatModel: openai chatgpt-4o → true', () => {
  assert.equal(looksLikeChatModel('openai', 'chatgpt-4o-latest'), true)
})

test('looksLikeChatModel: openai dall-e → false', () => {
  assert.equal(looksLikeChatModel('openai', 'dall-e-3'), false)
})

test('looksLikeChatModel: anthropic claude- → true', () => {
  assert.equal(looksLikeChatModel('anthropic', 'claude-sonnet-4-6'), true)
})

test('looksLikeChatModel: google gemini- → true', () => {
  assert.equal(looksLikeChatModel('google', 'gemini-2.0-flash'), true)
})

test('looksLikeChatModel: google non-gemini → false', () => {
  assert.equal(looksLikeChatModel('google', 'text-bison-001'), false)
})

test('looksLikeChatModel: deepseek deepseek-chat → true', () => {
  assert.equal(looksLikeChatModel('deepseek', 'deepseek-chat'), true)
})

test('looksLikeChatModel: xai grok-3 → true', () => {
  assert.equal(looksLikeChatModel('xai', 'grok-3'), true)
})

test('looksLikeChatModel: unknown provider passes anything not excluded', () => {
  assert.equal(looksLikeChatModel('custom', 'my-model'), true)
})

test('looksLikeChatModel: empty string → false', () => {
  assert.equal(looksLikeChatModel('openai', ''), false)
})

// ---------------------------------------------------------------------------
// dedupeModels
// ---------------------------------------------------------------------------

test('dedupeModels removes duplicates and preserves order', () => {
  assert.deepEqual(dedupeModels(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c'])
})

test('dedupeModels strips empty strings', () => {
  assert.deepEqual(dedupeModels(['a', '', '  ', 'b']), ['a', 'b'])
})

test('dedupeModels trims whitespace', () => {
  assert.deepEqual(dedupeModels([' a ', 'a']), ['a'])
})

// ---------------------------------------------------------------------------
// extractCandidateModelIds
// ---------------------------------------------------------------------------

test('extractCandidateModelIds reads .data[] with .id', () => {
  const payload = { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }
  assert.deepEqual(extractCandidateModelIds(payload, 'openai-compatible'), ['gpt-4o', 'gpt-4o-mini'])
})

test('extractCandidateModelIds reads .models[] with .name', () => {
  const payload = { models: [{ name: 'llama3.2:latest' }] }
  assert.deepEqual(extractCandidateModelIds(payload, 'ollama'), ['llama3.2'])
})

test('extractCandidateModelIds reads top-level array', () => {
  const payload = [{ id: 'model-a' }, { id: 'model-b' }]
  assert.deepEqual(extractCandidateModelIds(payload, 'openai-compatible'), ['model-a', 'model-b'])
})

test('extractCandidateModelIds reads .model field', () => {
  const payload = { data: [{ model: 'my-model' }] }
  assert.deepEqual(extractCandidateModelIds(payload, 'openai-compatible'), ['my-model'])
})

test('extractCandidateModelIds dedupes across .id and .name', () => {
  const payload = { data: [{ id: 'foo', name: 'foo' }] }
  assert.deepEqual(extractCandidateModelIds(payload, 'openai-compatible'), ['foo'])
})

test('extractCandidateModelIds handles empty payload', () => {
  assert.deepEqual(extractCandidateModelIds({}, 'openai-compatible'), [])
})

// ---------------------------------------------------------------------------
// extractDiscoveredModels
// ---------------------------------------------------------------------------

test('extractDiscoveredModels filters non-chat models for cloud providers', () => {
  const payload = {
    data: [
      { id: 'gpt-4o' },
      { id: 'text-embedding-3-small' },
      { id: 'gpt-4o-mini' },
      { id: 'dall-e-3' },
    ],
  }
  const result = extractDiscoveredModels('openai', 'openai-compatible', payload)
  assert.deepEqual(result.models, ['gpt-4o', 'gpt-4o-mini'])
  assert.equal(result.rawCount, 4)
})

test('extractDiscoveredModels skips filter for ollama', () => {
  const payload = { models: [{ name: 'llama3.2:latest' }, { name: 'nomic-embed-text:latest' }] }
  const result = extractDiscoveredModels('ollama', 'ollama', payload)
  assert.deepEqual(result.models, ['llama3.2', 'nomic-embed-text'])
  assert.equal(result.rawCount, 2)
})

// ---------------------------------------------------------------------------
// ttlForDescriptor
// ---------------------------------------------------------------------------

function makeDescriptor(overrides: Partial<DiscoveryDescriptor> = {}): DiscoveryDescriptor {
  return {
    providerId: 'openai',
    providerName: 'OpenAI',
    strategy: 'openai-compatible',
    requiresApiKey: true,
    optionalApiKey: false,
    supportsDiscovery: true,
    ...overrides,
  }
}

test('ttlForDescriptor returns 15min for cloud on success', () => {
  assert.equal(ttlForDescriptor(makeDescriptor(), true), 15 * 60_000)
})

test('ttlForDescriptor returns 1min for ollama on success', () => {
  assert.equal(ttlForDescriptor(makeDescriptor({ strategy: 'ollama' }), true), 60_000)
})

test('ttlForDescriptor returns 1min for openclaw on success', () => {
  assert.equal(ttlForDescriptor(makeDescriptor({ strategy: 'openclaw' }), true), 60_000)
})

test('ttlForDescriptor returns 30s on error', () => {
  assert.equal(ttlForDescriptor(makeDescriptor(), false), 30_000)
})

// ---------------------------------------------------------------------------
// parseErrorMessage (synchronous variant in provider-model-discovery)
// ---------------------------------------------------------------------------

test('parseErrorMessage extracts .error.message from JSON', () => {
  assert.equal(parseErrorMessage(JSON.stringify({ error: { message: 'bad key' } }), 'fallback'), 'bad key')
})

test('parseErrorMessage extracts .error string from JSON', () => {
  assert.equal(parseErrorMessage(JSON.stringify({ error: 'rate limited' }), 'fallback'), 'rate limited')
})

test('parseErrorMessage extracts .detail from JSON', () => {
  assert.equal(parseErrorMessage(JSON.stringify({ detail: 'not found' }), 'fallback'), 'not found')
})

test('parseErrorMessage falls back to raw text for non-JSON', () => {
  assert.equal(parseErrorMessage('Service Unavailable', 'fallback'), 'Service Unavailable')
})

test('parseErrorMessage returns fallback for empty body', () => {
  assert.equal(parseErrorMessage('', 'fallback'), 'fallback')
})
