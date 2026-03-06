import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { PROVIDERS } from '../providers'
import { runStructuredExtraction } from './structured-extract'

const originalOllamaHandler = PROVIDERS.ollama.handler.streamChat

afterEach(() => {
  PROVIDERS.ollama.handler.streamChat = originalOllamaHandler
})

describe('runStructuredExtraction', () => {
  it('parses fenced JSON output from the current provider', async () => {
    PROVIDERS.ollama.handler.streamChat = async () => '```json\n{"name":"Ada","score":10}\n```'

    const result = await runStructuredExtraction({
      session: {
        id: 'session-1',
        provider: 'ollama',
        model: 'qwen3.5',
        credentialId: null,
        fallbackCredentialIds: [],
        apiEndpoint: 'http://localhost:11434',
      },
      text: 'Ada scored 10.',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
        },
        required: ['name', 'score'],
      },
      instruction: 'Extract the person and score.',
    })

    assert.deepEqual(result.object, { name: 'Ada', score: 10 })
    assert.deepEqual(result.validationErrors, [])
  })

  it('repairs invalid JSON with a second pass', async () => {
    let callCount = 0
    PROVIDERS.ollama.handler.streamChat = async () => {
      callCount += 1
      return callCount === 1 ? 'name: Ada' : '{"name":"Ada"}'
    }

    const result = await runStructuredExtraction({
      session: {
        id: 'session-2',
        provider: 'ollama',
        model: 'qwen3.5',
        credentialId: null,
        fallbackCredentialIds: [],
        apiEndpoint: 'http://localhost:11434',
      },
      text: 'Ada',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      },
      instruction: 'Extract the name.',
    })

    assert.equal(callCount, 2)
    assert.deepEqual(result.object, { name: 'Ada' })
    assert.deepEqual(result.validationErrors, [])
  })
})
