import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/types'
import { filterHealthyChatroomAgents } from '@/lib/server/chatrooms/chatroom-health'

describe('filterHealthyChatroomAgents', () => {
  it('treats providers with default endpoints as healthy without explicit agent endpoints', () => {
    const now = Date.now()
    const agents: Record<string, Agent> = {
      agent_writer: {
        id: 'agent_writer',
        name: 'Writer',
        description: '',
        systemPrompt: '',
        provider: 'ollama',
        model: 'glm-5:cloud',
        createdAt: now,
        updatedAt: now,
      },
    }

    const result = filterHealthyChatroomAgents(['agent_writer'], agents)
    assert.deepEqual(result.healthyAgentIds, ['agent_writer'])
    assert.deepEqual(result.skipped, [])
  })
})
