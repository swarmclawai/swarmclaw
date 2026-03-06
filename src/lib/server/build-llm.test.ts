import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChatOpenAI } from '@langchain/openai'
import {
  buildChatModel,
  OPENAI_COMPAT_MODEL_MAX_RETRIES,
  OPENAI_COMPAT_MODEL_TIMEOUT_MS,
} from './build-llm'

describe('buildChatModel', () => {
  it('applies bounded timeout and disables internal retries for openai-compatible models', () => {
    const llm = buildChatModel({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
    })

    assert.equal(llm instanceof ChatOpenAI, true)
    assert.equal((llm as any).timeout, OPENAI_COMPAT_MODEL_TIMEOUT_MS)
    assert.equal((llm as any).caller?.maxRetries, OPENAI_COMPAT_MODEL_MAX_RETRIES)
  })

  it('preserves openclaw headers while applying the same timeout policy', () => {
    const llm = buildChatModel({
      provider: 'openclaw',
      model: 'gpt-4o',
      apiKey: 'test-key',
      apiEndpoint: 'https://example.com/v1',
    })

    assert.equal(llm instanceof ChatOpenAI, true)
    assert.equal((llm as any).timeout, OPENAI_COMPAT_MODEL_TIMEOUT_MS)
    assert.equal((llm as any).caller?.maxRetries, OPENAI_COMPAT_MODEL_MAX_RETRIES)
    assert.deepEqual((llm as any).clientConfig?.defaultHeaders, { 'Content-Type': 'text/plain' })
  })
})
