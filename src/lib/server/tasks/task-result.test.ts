import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEmptyRunOutcome, extractTaskResult } from '@/lib/server/tasks/task-result'

describe('extractTaskResult', () => {
  it('limits artifact extraction to messages from the current run window', () => {
    const messages = [
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
    ]

    const result = extractTaskResult(messages, 'done', { sinceTime: 1_500 })
    assert.deepEqual(result.artifacts.map((a) => a.url), ['/api/uploads/wiki-new.png'])
  })

  it('excludes messages without timestamps when sinceTime is provided', () => {
    const messages = [
      {
        role: 'assistant',
        text: 'undated artifact: /api/uploads/undated.png',
      },
      {
        role: 'assistant',
        time: 5_000,
        text: 'dated artifact: /api/uploads/dated.png',
      },
    ]

    const result = extractTaskResult(messages, 'done', { sinceTime: 4_000 })
    assert.deepEqual(result.artifacts.map((a) => a.url), ['/api/uploads/dated.png'])
  })
})

describe('classifyEmptyRunOutcome', () => {
  it('flags a run with no text, no tool calls, and no error', () => {
    const reason = classifyEmptyRunOutcome({ text: '', error: null, toolEvents: [] })
    assert.match(reason || '', /Run produced no output/)
    assert.match(reason || '', /provider credential, model name, and endpoint/)
  })

  it('returns null when the run produced text', () => {
    assert.equal(classifyEmptyRunOutcome({ text: 'done', error: null, toolEvents: [] }), null)
  })

  it('returns null when the run made tool calls', () => {
    assert.equal(classifyEmptyRunOutcome({ text: '', error: null, toolEvents: [{ name: 'bash' }] }), null)
  })

  it('returns null when the run reported an error', () => {
    assert.equal(classifyEmptyRunOutcome({ text: '', error: 'boom', toolEvents: [] }), null)
  })

  it('treats whitespace-only text as empty', () => {
    assert.match(classifyEmptyRunOutcome({ text: '  \n ', error: '  ', toolEvents: null }) || '', /Run produced no output/)
  })
})
