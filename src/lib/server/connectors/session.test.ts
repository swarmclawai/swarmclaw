import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Agent, Connector, Session } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let mod: typeof import('./session')
let storage: typeof import('../storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-connector-session-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  storage = await import('../storage')
  mod = await import('./session')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('connectors/session', () => {
  // ---- modelHistoryTail ----

  describe('modelHistoryTail', () => {
    it('returns last N messages', () => {
      const messages = Array.from({ length: 30 }, (_, i) => ({
        role: 'user' as const,
        text: `msg-${i}`,
        time: i,
      }))
      const tail = mod.modelHistoryTail(messages, 5)
      assert.equal(tail.length, 5)
      assert.equal(tail[0].text, 'msg-25')
      assert.equal(tail[4].text, 'msg-29')
    })

    it('filters out historyExcluded messages', () => {
      const messages = [
        { role: 'user' as const, text: 'a', time: 1 },
        { role: 'assistant' as const, text: 'b', time: 2, historyExcluded: true },
        { role: 'user' as const, text: 'c', time: 3 },
      ]
      const tail = mod.modelHistoryTail(messages, 20)
      assert.equal(tail.length, 2)
      assert.equal(tail[0].text, 'a')
      assert.equal(tail[1].text, 'c')
    })

    it('returns empty array for null/undefined input', () => {
      assert.deepEqual(mod.modelHistoryTail(null), [])
      assert.deepEqual(mod.modelHistoryTail(undefined), [])
    })

    it('defaults to 20 message limit', () => {
      const messages = Array.from({ length: 40 }, (_, i) => ({
        role: 'user' as const,
        text: `m-${i}`,
        time: i,
      }))
      const tail = mod.modelHistoryTail(messages)
      assert.equal(tail.length, 20)
    })
  })

  // ---- applyConnectorRuntimeDefaults ----

  describe('applyConnectorRuntimeDefaults', () => {
    it('overwrites session provider/model/endpoint/thinkingLevel', () => {
      const session = {
        id: 'sess-1',
        name: 'test',
        provider: 'ollama' as const,
        model: 'old-model',
        apiEndpoint: 'http://old',
        connectorThinkLevel: null as string | null,
        messages: [],
        createdAt: Date.now(),
      } as unknown as Session

      mod.applyConnectorRuntimeDefaults(session, {
        provider: 'anthropic',
        model: 'claude-3',
        apiEndpoint: 'https://api.anthropic.com',
        thinkingLevel: 'high',
      })

      assert.equal(session.provider, 'anthropic')
      assert.equal(session.model, 'claude-3')
      assert.equal(session.apiEndpoint, 'https://api.anthropic.com')
      assert.equal(session.connectorThinkLevel, 'high')
    })
  })

  // ---- findDirectSessionForInbound ----

  describe('findDirectSessionForInbound', () => {
    it('returns null for chatroom connectors', () => {
      const connector = {
        id: 'conn-1',
        name: 'Test',
        platform: 'discord' as const,
        agentId: 'agent-1',
        chatroomId: 'room-1',
        config: {},
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as Connector
      const msg = {
        platform: 'discord',
        channelId: 'ch-1',
        senderId: 'user-1',
        senderName: 'User',
        text: 'hello',
      }
      const result = mod.findDirectSessionForInbound(connector, msg)
      assert.equal(result, null)
    })

    it('returns null when no matching sessions exist', () => {
      const connector = {
        id: 'conn-1',
        name: 'Test',
        platform: 'discord' as const,
        agentId: 'agent-1',
        config: {},
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as Connector
      const msg = {
        platform: 'discord',
        channelId: 'ch-no-match',
        senderId: 'user-no-match',
        senderName: 'Ghost',
        text: 'hello',
      }
      const result = mod.findDirectSessionForInbound(connector, msg)
      assert.equal(result, null)
    })

    it('finds session created by resolveDirectSession', () => {
      // Use resolveDirectSession to create a session, then findDirectSessionForInbound should find it
      const connector = {
        id: 'conn-findable',
        name: 'Findable',
        platform: 'discord' as const,
        agentId: 'agent-findable',
        config: {},
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as Connector
      const msg = {
        platform: 'discord',
        channelId: 'ch-findable',
        senderId: 'sender-findable',
        senderName: 'Finder',
        text: 'hello',
      }
      const agent = {
        id: 'agent-findable',
        name: 'Findable Agent',
        provider: 'anthropic' as const,
        model: 'claude-3',
        plugins: [],
        systemPrompt: '',
        createdAt: Date.now(),
      } as unknown as Agent

      storage.upsertStoredItem('agents', 'agent-findable', agent)
      const created = mod.resolveDirectSession({ connector, msg, agent })
      assert.equal(created.wasCreated, true)

      // Now findDirectSessionForInbound should locate it
      const found = mod.findDirectSessionForInbound(connector, msg)
      assert.ok(found)
      assert.equal(found!.id, created.session.id)
    })

    it('returns null when multiple direct sessions match without a unique thread or sender match', () => {
      const now = Date.now()
      storage.saveSessions({
        'sess-a': {
          id: 'sess-a',
          name: 'connector:discord:alice',
          user: 'connector',
          provider: 'anthropic',
          model: 'claude-3',
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          agentId: 'agent-1',
          connectorContext: {
            connectorId: 'conn-1',
            channelId: 'shared-channel',
            senderId: 'alice-1',
          },
        },
        'sess-b': {
          id: 'sess-b',
          name: 'connector:discord:bob',
          user: 'connector',
          provider: 'anthropic',
          model: 'claude-3',
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          agentId: 'agent-1',
          connectorContext: {
            connectorId: 'conn-1',
            channelId: 'shared-channel',
            senderId: 'bob-1',
          },
        },
      })

      const connector = {
        id: 'conn-1',
        name: 'Test',
        platform: 'discord' as const,
        agentId: 'agent-1',
        config: {},
        enabled: true,
        createdAt: now,
        updatedAt: now,
      } as unknown as Connector

      const result = mod.findDirectSessionForInbound(connector, {
        platform: 'discord',
        channelId: 'shared-channel',
        senderId: 'unknown-user',
        senderName: 'Unknown',
        text: 'hello',
      })

      assert.equal(result, null)
    })

    it('returns null when the inbound thread id does not match an existing direct thread session', () => {
      const now = Date.now()
      storage.saveSessions({
        'sess-thread': {
          id: 'sess-thread',
          name: 'connector:discord:thread',
          user: 'connector',
          provider: 'anthropic',
          model: 'claude-3',
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          agentId: 'agent-1',
          connectorContext: {
            connectorId: 'conn-1',
            channelId: 'channel-1',
            senderId: 'user-1',
            threadId: 'thread-1',
          },
        },
      })

      const connector = {
        id: 'conn-1',
        name: 'Test',
        platform: 'discord' as const,
        agentId: 'agent-1',
        config: {},
        enabled: true,
        createdAt: now,
        updatedAt: now,
      } as unknown as Connector

      const result = mod.findDirectSessionForInbound(connector, {
        platform: 'discord',
        channelId: 'channel-1',
        senderId: 'user-1',
        senderName: 'User',
        text: 'hello',
        threadId: 'thread-2',
      })

      assert.equal(result, null)
    })
  })

  // ---- updateSessionConnectorContext ----

  describe('updateSessionConnectorContext', () => {
    it('populates connector context fields from message', () => {
      const session = {
        id: 'sess-ctx',
        name: 'test',
        provider: 'anthropic' as const,
        model: 'test',
        messages: [],
        createdAt: Date.now(),
        connectorContext: {},
      } as unknown as Session
      const connector = {
        id: 'conn-ctx',
        name: 'CTX',
        platform: 'telegram' as const,
        agentId: 'agent-ctx',
        config: {},
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as Connector
      const msg = {
        platform: 'telegram',
        channelId: 'tg-ch-1',
        senderId: 'tg-user-1',
        senderName: 'TG User',
        senderAvatarUrl: 'https://example.com/tg-user.png',
        text: 'hi',
        isGroup: true,
        threadId: 'thread-42',
      }

      mod.updateSessionConnectorContext(session, connector, msg, 'connector:telegram:agent-ctx:tg-ch-1')

      assert.equal(session.connectorContext?.connectorId, 'conn-ctx')
      assert.equal(session.connectorContext?.platform, 'telegram')
      assert.equal(session.connectorContext?.channelId, 'tg-ch-1')
      assert.equal(session.connectorContext?.senderId, 'tg-user-1')
      assert.equal(session.connectorContext?.senderName, 'TG User')
      assert.equal(session.connectorContext?.senderAvatarUrl, 'https://example.com/tg-user.png')
      assert.equal(session.connectorContext?.isGroup, true)
      assert.equal(session.connectorContext?.isOwnerConversation, false)
      assert.equal(session.connectorContext?.threadId, 'thread-42')
      assert.ok(typeof session.connectorContext?.lastInboundAt === 'number')
    })
  })

  // ---- resolveDirectSession ----

  describe('resolveDirectSession', () => {
    it('creates a new session for unknown connector/channel', () => {
      // Ensure agent exists in storage
      storage.upsertStoredItem('agents', 'agent-new', {
        id: 'agent-new',
        name: 'New Agent',
        provider: 'anthropic',
        model: 'claude-3',
        plugins: ['web'],
        systemPrompt: 'You are helpful.',
        createdAt: Date.now(),
      })

      const connector = {
        id: 'conn-new',
        name: 'New Conn',
        platform: 'slack' as const,
        agentId: 'agent-new',
        config: {},
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as Connector
      const msg = {
        platform: 'slack',
        channelId: 'slack-ch-unique',
        senderId: 'slack-user-1',
        senderName: 'Slack User',
        text: 'first message',
      }
      const agent = {
        id: 'agent-new',
        name: 'New Agent',
        provider: 'anthropic' as const,
        model: 'claude-3',
        plugins: ['web'],
        systemPrompt: 'You are helpful.',
        createdAt: Date.now(),
      } as unknown as Agent

      const result = mod.resolveDirectSession({ connector, msg, agent })

      assert.equal(result.wasCreated, true)
      assert.ok(result.session.id)
      assert.equal(result.session.agentId, 'agent-new')
      assert.equal(result.session.provider, 'anthropic')
      assert.equal(result.session.model, 'claude-3')
      assert.equal(result.session.memoryScopeMode, 'session')
      assert.ok(result.sessionKey.includes('connector:'))
    })

    it('reuses existing session for same connector/channel/agent', () => {
      const connector = {
        id: 'conn-reuse',
        name: 'Reuse Conn',
        platform: 'discord' as const,
        agentId: 'agent-reuse',
        config: {},
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as Connector
      const msg = {
        platform: 'discord',
        channelId: 'disc-ch-reuse',
        senderId: 'disc-user-1',
        senderName: 'Discord User',
        text: 'first',
      }
      const agent = {
        id: 'agent-reuse',
        name: 'Reuse Agent',
        provider: 'anthropic' as const,
        model: 'claude-3',
        plugins: [],
        systemPrompt: '',
        createdAt: Date.now(),
      } as unknown as Agent

      storage.upsertStoredItem('agents', 'agent-reuse', agent)

      const first = mod.resolveDirectSession({ connector, msg, agent })
      assert.equal(first.wasCreated, true)

      const second = mod.resolveDirectSession({ connector, msg, agent })
      assert.equal(second.wasCreated, false)
      assert.equal(second.session.id, first.session.id)
    })

    it('routes owner conversations to the agent thread session instead of a direct connector session', () => {
      const now = Date.now()
      storage.upsertStoredItem('agents', 'agent-owner', {
        id: 'agent-owner',
        name: 'Owner Agent',
        provider: 'anthropic',
        model: 'claude-3',
        plugins: [],
        threadSessionId: 'agent-thread-owner',
        createdAt: now,
      })
      storage.saveSessions({
        'agent-thread-owner': {
          id: 'agent-thread-owner',
          name: 'Owner Agent',
          cwd: process.env.WORKSPACE_DIR || '',
          user: 'default',
          provider: 'anthropic',
          model: 'claude-3',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent-owner',
          plugins: [],
        },
      })

      const connector = {
        id: 'conn-owner',
        name: 'Owner WhatsApp',
        platform: 'whatsapp' as const,
        agentId: 'agent-owner',
        config: {},
        enabled: true,
        createdAt: now,
        updatedAt: now,
      } as unknown as Connector
      const msg = {
        platform: 'whatsapp',
        channelId: '15550001111@s.whatsapp.net',
        senderId: '15550001111@s.whatsapp.net',
        senderName: 'Wayde',
        text: 'hello from self chat',
        isOwnerConversation: true,
      }
      const agent = {
        id: 'agent-owner',
        name: 'Owner Agent',
        provider: 'anthropic' as const,
        model: 'claude-3',
        plugins: [],
        threadSessionId: 'agent-thread-owner',
        createdAt: now,
      } as unknown as Agent

      const result = mod.resolveDirectSession({ connector, msg, agent })

      assert.equal(result.session.id, 'agent-thread-owner')
      assert.equal(result.session.user, 'default')
      assert.equal(result.session.connectorContext?.isOwnerConversation, true)
      assert.equal(result.session.connectorContext?.scope, 'main')
    })
  })

  describe('pushSessionMessage', () => {
    it('does not mirror external connector transcript entries into the main agent thread', () => {
      const now = Date.now()
      storage.upsertStoredItem('agents', 'agent-mirror', {
        id: 'agent-mirror',
        name: 'Mirror Agent',
        provider: 'anthropic',
        model: 'claude-3',
        plugins: [],
        threadSessionId: 'agent-thread-mirror',
        createdAt: now,
      })
      storage.saveSessions({
        'agent-thread-mirror': {
          id: 'agent-thread-mirror',
          name: 'Mirror Agent',
          cwd: process.env.WORKSPACE_DIR || '',
          user: 'default',
          provider: 'anthropic',
          model: 'claude-3',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent-mirror',
          plugins: [],
        },
      })

      const session = {
        id: 'connector-session',
        name: 'connector:conn-owner:agent:agent-mirror:channel:15550001111@s.whatsapp.net:peer:15550001111@s.whatsapp.net',
        user: 'connector',
        provider: 'anthropic' as const,
        model: 'claude-3',
        messages: [],
        createdAt: now,
        lastActiveAt: now,
        agentId: 'agent-mirror',
        connectorContext: {
          connectorId: 'conn-owner',
          senderId: '15550001111@s.whatsapp.net',
          senderName: 'Alice',
          isOwnerConversation: false,
        },
      } as unknown as Session

      mod.pushSessionMessage(session, 'user', 'hello there', {
        source: {
          platform: 'whatsapp',
          connectorId: 'conn-owner',
          channelId: '15550001111@s.whatsapp.net',
          senderId: '15550001111@s.whatsapp.net',
          senderName: 'Alice',
          messageId: 'msg-1',
        },
      })

      const thread = storage.loadStoredItem('sessions', 'agent-thread-mirror') as Session
      assert.equal(session.messages.length, 1)
      assert.equal(thread.messages.length, 0)
    })
  })

  // ---- persistSessionRecord ----

  describe('persistSessionRecord', () => {
    it('sets updatedAt and persists to storage', () => {
      const session = {
        id: 'sess-persist',
        name: 'persist-test',
        provider: 'anthropic' as const,
        model: 'test',
        messages: [],
        createdAt: Date.now(),
        updatedAt: 0,
      } as unknown as Session

      mod.persistSessionRecord(session)

      assert.ok(session.updatedAt > 0)
      const loaded = storage.loadStoredItem('sessions', 'sess-persist') as Record<string, unknown>
      assert.ok(loaded)
      assert.equal(loaded.name, 'persist-test')
    })
  })
})
