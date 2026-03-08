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

  it('routes glm-5:cloud to Ollama Cloud and strips the transport suffix', () => {
    const originalKey = process.env.OLLAMA_API_KEY
    process.env.OLLAMA_API_KEY = 'ollama-cloud-test-key'

    try {
      const llm = buildChatModel({
        provider: 'ollama',
        model: 'glm-5:cloud',
        apiKey: null,
      })
      const model = llm as ChatOpenAiInternals & {
        model?: string
        clientConfig?: { baseURL?: string }
      }

      assert.equal(llm instanceof ChatOpenAI, true)
      assert.equal(model.model, 'glm-5')
      assert.equal(model.clientConfig?.baseURL, 'https://ollama.com/v1')
      assert.equal(model.timeout, OPENAI_COMPAT_MODEL_TIMEOUT_MS)
      assert.equal(model.caller?.maxRetries, OPENAI_COMPAT_MODEL_MAX_RETRIES)
    } finally {
      if (originalKey === undefined) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = originalKey
    }
  })

  it('keeps glm-5:cloud on the local Ollama endpoint when no cloud key is available', () => {
    const originalKey = process.env.OLLAMA_API_KEY
    delete process.env.OLLAMA_API_KEY

    try {
      const llm = buildChatModel({
        provider: 'ollama',
        model: 'glm-5:cloud',
        apiKey: null,
      })
      const model = llm as ChatOpenAiInternals & {
        model?: string
        clientConfig?: { baseURL?: string }
      }

      assert.equal(llm instanceof ChatOpenAI, true)
      assert.equal(model.model, 'glm-5:cloud')
      assert.equal(model.clientConfig?.baseURL, 'http://localhost:11434/v1')
      assert.equal(model.timeout, OPENAI_COMPAT_MODEL_TIMEOUT_MS)
      assert.equal(model.caller?.maxRetries, OPENAI_COMPAT_MODEL_MAX_RETRIES)
    } finally {
      if (originalKey === undefined) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = originalKey
    }
  })

  it('keeps an explicit local Ollama endpoint even when a cloud key exists', () => {
    const originalKey = process.env.OLLAMA_API_KEY
    process.env.OLLAMA_API_KEY = 'ollama-cloud-test-key'

    try {
      const llm = buildChatModel({
        provider: 'ollama',
        model: 'glm-5:cloud',
        apiKey: null,
        apiEndpoint: 'http://localhost:11434',
      })
      const model = llm as ChatOpenAiInternals & {
        model?: string
        clientConfig?: { baseURL?: string }
      }

      assert.equal(llm instanceof ChatOpenAI, true)
      assert.equal(model.model, 'glm-5:cloud')
      assert.equal(model.clientConfig?.baseURL, 'http://localhost:11434/v1')
      assert.equal(model.timeout, OPENAI_COMPAT_MODEL_TIMEOUT_MS)
      assert.equal(model.caller?.maxRetries, OPENAI_COMPAT_MODEL_MAX_RETRIES)
    } finally {
      if (originalKey === undefined) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = originalKey
    }
  })
})
