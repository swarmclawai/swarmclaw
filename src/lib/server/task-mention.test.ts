import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/types'
import { parseAssignedAgentId, parseMentionedAgentId, resolveAgentReference, resolveTaskAgentFromDescription } from './task-mention'

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

  it('resolves agent ids directly', () => {
    const resolved = resolveAgentReference('coder', agents)
    assert.equal(resolved, 'coder')
  })

  it('parses plain-language assignment phrases', () => {
    const assigned = parseAssignedAgentId('Create this task and assign it to agent "default".', agents)
    assert.equal(assigned, 'default')
  })

  it('resolves task assignment without @mentions', () => {
    const resolved = resolveTaskAgentFromDescription('Please delegate this to CodeBot.', 'default', agents)
    assert.equal(resolved, 'coder')
  })
})
