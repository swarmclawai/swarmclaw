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
  resolveSyntheticSessionId,
  resolveAgentApiEndpoint,
  resolveReplyTargetAgentId,
  buildAgentSystemPromptForChatroom,
} from '@/lib/server/chatrooms/chatroom-helpers'
import { resolveChatroomSyntheticSessionId } from '@/lib/chatroom-sessions'

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

function makeMultiWordAgents(): Record<string, Agent> {
  const now = Date.now()
  return {
    hal2k: {
      id: 'hal2k',
      name: 'Hal2k',
      description: '',
      systemPrompt: '',
      provider: 'openai',
      model: 'gpt-4o',
      createdAt: now,
      updatedAt: now,
    },
    'hal2k-openai': {
      id: 'hal2k-openai',
      name: 'Hal2k (OpenAI)',
      description: '',
      systemPrompt: '',
      provider: 'openai',
      model: 'gpt-4o',
      createdAt: now,
      updatedAt: now,
    },
    'code-monkey': {
      id: 'code-monkey',
      name: 'Code Monkey',
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

  it('resolves Ollama Cloud endpoints for chatroom sessions with a credential-backed cloud model', async () => {
    const now = Date.now()
    const storage = await import('@/lib/server/storage')
    const agent: Agent = {
      id: 'agent_cloud',
      name: 'Cloud Writer',
      description: '',
      systemPrompt: '',
      provider: 'ollama',
      model: 'glm-5:cloud',
      ollamaMode: 'cloud',
      credentialId: 'cred-ollama-cloud',
      createdAt: now,
      updatedAt: now,
    }

    storage.saveCredentials({
      'cred-ollama-cloud': {
        id: 'cred-ollama-cloud',
        provider: 'ollama',
        name: 'Ollama Cloud',
        encryptedKey: storage.encryptKey('ollama-cloud-key'),
        createdAt: now,
      },
    })

    assert.equal(resolveAgentApiEndpoint(agent), 'https://ollama.com')
    assert.equal(buildSyntheticSession(agent, 'room-ollama-cloud').apiEndpoint, 'https://ollama.com')
  })

  it('keeps chatroom execution inside the workspace instead of the repo root', () => {
    const cwd = buildSyntheticSession(makeAgents().default, 'room-safe').cwd
    assert.equal(cwd, resolveChatroomWorkspaceDir('room-safe'))
    assert.match(cwd, /chatrooms[\/\\]room-safe$/)
  })

  it('uses a stable synthetic session id convention shared with the UI', () => {
    assert.equal(resolveChatroomSyntheticSessionId('room-1', 'agent-1'), 'chatroom-room-1-agent-1')
    assert.equal(resolveSyntheticSessionId('room-1', 'agent-1'), 'chatroom-room-1-agent-1')
  })

  it('matches multi-word agent name over shorter prefix', () => {
    const agents = makeMultiWordAgents()
    const memberIds = ['hal2k', 'hal2k-openai', 'code-monkey']
    const mentions = parseMentions('Hey @Hal2k (OpenAI), can you help?', agents, memberIds)
    assert.deepEqual(mentions, ['hal2k-openai'])
  })

  it('matches short name when only short prefix is used', () => {
    const agents = makeMultiWordAgents()
    const memberIds = ['hal2k', 'hal2k-openai', 'code-monkey']
    const mentions = parseMentions('Hey @Hal2k, can you help?', agents, memberIds)
    assert.deepEqual(mentions, ['hal2k'])
  })

  it('matches multi-word agent with spaces', () => {
    const agents = makeMultiWordAgents()
    const memberIds = ['hal2k', 'hal2k-openai', 'code-monkey']
    const mentions = parseMentions('Ask @Code Monkey to review this', agents, memberIds)
    assert.deepEqual(mentions, ['code-monkey'])
  })

  it('self-mention falls through to implicit when senderId matches', () => {
    const agents = makeMultiWordAgents()
    const memberIds = ['hal2k', 'hal2k-openai', 'code-monkey']
    // Agent "Hal2k" mentions itself — should fall through to implicit matching
    const mentions = parseMentions('@Hal2k check this code', agents, memberIds, { senderId: 'hal2k' })
    // hal2k is still included (self-mention not removed), but implicit also runs
    assert.ok(mentions.includes('hal2k'), 'self-mention should still be in results')
  })

  it('@all still works with multi-word agents', () => {
    const agents = makeMultiWordAgents()
    const memberIds = ['hal2k', 'hal2k-openai', 'code-monkey']
    const mentions = parseMentions('@all please review', agents, memberIds)
    assert.deepEqual(mentions, ['hal2k', 'hal2k-openai', 'code-monkey'])
  })

  it('matches both short and long name in the same message', () => {
    const agents = makeMultiWordAgents()
    const memberIds = ['hal2k', 'hal2k-openai', 'code-monkey']
    const mentions = parseMentions('@Hal2k and @Hal2k (OpenAI) both look at this', agents, memberIds)
    assert.deepEqual(mentions, ['hal2k', 'hal2k-openai'])
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
