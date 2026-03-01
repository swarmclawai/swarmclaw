import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskResult } from './task-result'

describe('extractTaskResult', () => {
  it('limits artifact extraction to messages from the current run window', () => {
    const session = {
      messages: [
        {
          role: 'assistant',
          time: 1_000,
          text: 'old run artifact: /api/uploads/wiki-old.png',
        },
        {
          role: 'assistant',
          time: 2_000,
          text: 'new run artifact: /api/uploads/wiki-new.png',
        },
      ],
    }

    const result = extractTaskResult(session, 'done', { sinceTime: 1_500 })
    assert.deepEqual(result.artifacts.map((a) => a.url), ['/api/uploads/wiki-new.png'])
  })

  it('excludes messages without timestamps when sinceTime is provided', () => {
    const session = {
      messages: [
        {
          role: 'assistant',
          text: 'undated artifact: /api/uploads/undated.png',
        },
        {
          role: 'assistant',
          time: 5_000,
          text: 'dated artifact: /api/uploads/dated.png',
        },
      ],
    }

    const result = extractTaskResult(session, 'done', { sinceTime: 4_000 })
    assert.deepEqual(result.artifacts.map((a) => a.url), ['/api/uploads/dated.png'])
  })
})
