import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ChatOpenAI } from '@langchain/openai'
import {
  buildChatModel,
  OPENAI_COMPAT_MODEL_MAX_RETRIES,
  OPENAI_COMPAT_MODEL_TIMEOUT_MS,
} from './build-llm'

type ChatOpenAiInternals = ChatOpenAI & {
  timeout?: number
  caller?: { maxRetries?: number }
  clientConfig?: { defaultHeaders?: Record<string, string> }
}

describe('buildChatModel', () => {
  it('applies bounded timeout and disables internal retries for openai-compatible models', () => {
    const llm = buildChatModel({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
    })
    const model = llm as ChatOpenAiInternals

    assert.equal(llm instanceof ChatOpenAI, true)
    assert.equal(model.timeout, OPENAI_COMPAT_MODEL_TIMEOUT_MS)
    assert.equal(model.caller?.maxRetries, OPENAI_COMPAT_MODEL_MAX_RETRIES)
  })

  it('preserves openclaw headers while applying the same timeout policy', () => {
    const llm = buildChatModel({
      provider: 'openclaw',
      model: 'gpt-4o',
      apiKey: 'test-key',
      apiEndpoint: 'https://example.com/v1',
    })
    const model = llm as ChatOpenAiInternals

    assert.equal(llm instanceof ChatOpenAI, true)
    assert.equal(model.timeout, OPENAI_COMPAT_MODEL_TIMEOUT_MS)
    assert.equal(model.caller?.maxRetries, OPENAI_COMPAT_MODEL_MAX_RETRIES)
    assert.deepEqual(model.clientConfig?.defaultHeaders, { 'Content-Type': 'text/plain' })
  })
})
