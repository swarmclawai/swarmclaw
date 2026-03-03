import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, Chatroom } from '@/types'
import { parseMentions, compactChatroomMessages, buildHistoryForAgent } from './chatroom-helpers'

function makeAgents(): Record<string, Agent> {
  const now = Date.now()
  return {
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
    agent_analyst: {
      id: 'agent_analyst',
      name: 'Analyst',
      description: '',
      systemPrompt: '',
      provider: 'openai',
      model: 'gpt-4o',
      createdAt: now,
      updatedAt: now,
    },
  }
}

describe('chatroom-helpers', () => {
  it('parses mentions with punctuation and agent ids', () => {
    const agents = makeAgents()
    const memberIds = ['default', 'agent_analyst']
    const mentions = parseMentions('Hey @Assistant, can @agent_analyst review this?', agents, memberIds)
    assert.deepEqual(mentions, ['default', 'agent_analyst'])
  })

  it('compacts long chatrooms with a persisted summary message', () => {
    const now = Date.now()
    const chatroom: Chatroom = {
      id: 'room-1',
      name: 'Room',
      description: '',
      agentIds: ['default'],
      messages: Array.from({ length: 120 }, (_, idx) => ({
        id: `m-${idx}`,
        senderId: idx % 2 === 0 ? 'user' : 'default',
        senderName: idx % 2 === 0 ? 'You' : 'Assistant',
        role: idx % 2 === 0 ? 'user' : 'assistant',
        text: `message ${idx}`,
        mentions: [],
        reactions: [],
        time: now + idx,
      })),
      createdAt: now,
      updatedAt: now,
    }

    const changed = compactChatroomMessages(chatroom, 90)
    assert.equal(changed, true)
    assert.equal(chatroom.messages.length, 91)
    assert.equal(chatroom.messages[0].senderId, 'system')
    assert.match(chatroom.messages[0].text, /^\[Conversation summary\]/)
  })

  it('only includes attachment-heavy context for recent history entries', () => {
    const now = Date.now()
    const chatroom: Chatroom = {
      id: 'room-2',
      name: 'Room',
      agentIds: ['default'],
      messages: Array.from({ length: 24 }, (_, idx) => ({
        id: `x-${idx}`,
        senderId: idx % 2 === 0 ? 'user' : 'default',
        senderName: idx % 2 === 0 ? 'You' : 'Assistant',
        role: idx % 2 === 0 ? 'user' : 'assistant',
        text: `line ${idx}`,
        mentions: [],
        reactions: [],
        time: now + idx,
        ...(idx < 10 ? { attachedFiles: [`/tmp/file-${idx}.txt`] } : {}),
      })),
      createdAt: now,
      updatedAt: now,
    }

    const history = buildHistoryForAgent(chatroom, 'default')
    const attachmentMarkers = history.filter((msg) => msg.text.includes('[Attached:')).length
    assert.ok(attachmentMarkers <= 6)
  })
})

