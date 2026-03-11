import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, Chatroom } from '@/types'
import {
  parseMentions,
  compactChatroomMessages,
  buildHistoryForAgent,
  buildSyntheticSession,
  resolveChatroomWorkspaceDir,
  resolveAgentApiEndpoint,
  resolveReplyTargetAgentId,
  buildAgentSystemPromptForChatroom,
} from '@/lib/server/chatrooms/chatroom-helpers'

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

  it('routes reply-only messages back to the replied-to agent', () => {
    const agents = makeAgents()
    const memberIds = ['default', 'agent_analyst']
    const replyTargetAgentId = resolveReplyTargetAgentId('agent-msg', [
      {
        id: 'agent-msg',
        senderId: 'default',
        senderName: 'Assistant',
        role: 'assistant',
        text: 'Here is the previous answer.',
        mentions: [],
        reactions: [],
        time: Date.now(),
      },
    ], memberIds)
    const mentions = parseMentions('Can you expand on that?', agents, memberIds, { replyTargetAgentId })
    assert.deepEqual(mentions, ['default'])
  })

  it('keeps explicit mentions ahead of reply-based implicit targeting', () => {
    const agents = makeAgents()
    const memberIds = ['default', 'agent_analyst']
    const mentions = parseMentions('Actually @Analyst should take this one.', agents, memberIds, { replyTargetAgentId: 'default' })
    assert.deepEqual(mentions, ['agent_analyst'])
  })

  it('ignores replies to non-agent messages', () => {
    const replyTargetAgentId = resolveReplyTargetAgentId('user-msg', [
      {
        id: 'user-msg',
        senderId: 'user',
        senderName: 'You',
        role: 'user',
        text: 'Question',
        mentions: [],
        reactions: [],
        time: Date.now(),
      },
    ], ['default', 'agent_analyst'])
    assert.equal(replyTargetAgentId, null)
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

  it('resolves default provider endpoints for chatroom sessions', () => {
    const now = Date.now()
    const agent: Agent = {
      id: 'agent_writer',
      name: 'Writer',
      description: '',
      systemPrompt: '',
      provider: 'ollama',
      model: 'glm-5:cloud',
      createdAt: now,
      updatedAt: now,
    }

    assert.equal(resolveAgentApiEndpoint(agent), 'http://localhost:11434')
    assert.equal(buildSyntheticSession(agent, 'room-1').apiEndpoint, 'http://localhost:11434')
  })

  it('keeps chatroom execution inside the workspace instead of the repo root', () => {
    const cwd = buildSyntheticSession(makeAgents().default, 'room-safe').cwd
    assert.equal(cwd, resolveChatroomWorkspaceDir('room-safe'))
    assert.match(cwd, /chatrooms[\/\\]room-safe$/)
  })

  it('includes discoverable local skills in chatroom prompts even when none are pinned', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-chatroom-skill-'))
    try {
      const skillDir = path.join(cwd, 'skills', 'chatroom-default-skill')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: chatroom-default-skill
description: Local chatroom skill.
---
# Chatroom Default Skill

Prefer this chatroom workflow when it fits.
`)

      const prompt = buildAgentSystemPromptForChatroom(makeAgents().default, cwd)
      assert.match(prompt, /discoverable by default/i)
      assert.match(prompt, /chatroom-default-skill/i)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
