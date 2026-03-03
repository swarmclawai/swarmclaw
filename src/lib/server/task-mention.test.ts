import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/types'
import { parseMentionedAgentId, resolveTaskAgentFromDescription } from './task-mention'

const now = Date.now()
const agents: Record<string, Agent> = {
  default: {
    id: 'default',
    name: 'Assistant',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-4o',
    createdAt: now,
    updatedAt: now,
  },
  coder: {
    id: 'coder',
    name: 'CodeBot',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-4o',
    createdAt: now,
    updatedAt: now,
  },
}

describe('task-mention', () => {
  it('matches mentions with trailing punctuation', () => {
    const found = parseMentionedAgentId('Please hand this to @CodeBot, thanks.', agents)
    assert.equal(found, 'coder')
  })

  it('falls back to current agent when no mention is present', () => {
    const resolved = resolveTaskAgentFromDescription('No mention here', 'default', agents)
    assert.equal(resolved, 'default')
  })
})

