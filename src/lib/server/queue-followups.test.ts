import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { BoardTask } from '@/types'
import { resolveTaskOriginConnectorFollowupTarget } from './queue'

function makeTask(partial?: Partial<BoardTask> & { createdInSessionId?: string | null }): BoardTask {
  const now = Date.now()
  return {
    id: 'task-1',
    title: 'Test task',
    description: 'desc',
    status: 'queued',
    agentId: 'agent-a',
    createdAt: now,
    updatedAt: now,
    ...(partial || {}),
  } as BoardTask
}

type SessionFixtureMap = Record<string, {
  messages: Array<{
    role: string
    text?: string
    source?: {
      connectorId?: string
      channelId?: string
    }
  }>
}>

describe('resolveTaskOriginConnectorFollowupTarget', () => {
  it('uses connector source channel from origin session and normalizes WhatsApp numbers', () => {
    const task = makeTask({ createdInSessionId: 'session-1' })
    const sessions = {
      'session-1': {
        messages: [
          { role: 'assistant', text: 'ok' },
          {
            role: 'user',
            text: 'please update me',
            source: {
              connectorId: 'conn-wa',
              channelId: '+44 7700 900123',
            },
          },
        ],
      },
    }
    const connectors = {
      'conn-wa': {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        config: {},
      },
    }
    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: '185200000000000@lid',
      },
    ]

    const target = resolveTaskOriginConnectorFollowupTarget({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors,
      running,
    })

    assert.deepEqual(target, {
      connectorId: 'conn-wa',
      channelId: '447700900123@s.whatsapp.net',
    })
  })

  it('falls back to runtime recent channel when source channel is unavailable', () => {
    const task = makeTask({ createdInSessionId: 'session-1' })
    const sessions = {
      'session-1': {
        messages: [
          {
            role: 'user',
            text: 'run this later',
            source: {
              connectorId: 'conn-telegram',
            },
          },
        ],
      },
    }
    const connectors = {
      'conn-telegram': {
        id: 'conn-telegram',
        platform: 'telegram',
        agentId: 'agent-a',
        config: {},
      },
    }
    const running = [
      {
        id: 'conn-telegram',
        platform: 'telegram',
        agentId: 'agent-a',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: 'tg-chat-42',
      },
    ]

    const target = resolveTaskOriginConnectorFollowupTarget({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors,
      running,
    })

    assert.deepEqual(target, {
      connectorId: 'conn-telegram',
      channelId: 'tg-chat-42',
    })
  })

  it('returns null when the source connector belongs to a different agent', () => {
    const task = makeTask({ createdInSessionId: 'session-1' })
    const sessions = {
      'session-1': {
        messages: [
          {
            role: 'user',
            text: 'do it',
            source: {
              connectorId: 'conn-wa',
              channelId: '+15551230000',
            },
          },
        ],
      },
    }
    const connectors = {
      'conn-wa': {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'different-agent',
        config: {},
      },
    }
    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'different-agent',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: null,
      },
    ]

    const target = resolveTaskOriginConnectorFollowupTarget({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors,
      running,
    })

    assert.equal(target, null)
  })

  it('allows delegated tasks to follow up via the delegating agent connector', () => {
    const task = makeTask({
      agentId: 'worker-agent',
      delegatedByAgentId: 'delegator-agent',
      createdInSessionId: 'session-1',
    })
    const sessions = {
      'session-1': {
        messages: [
          {
            role: 'user',
            text: 'run and update me here',
            source: {
              connectorId: 'conn-wa',
              channelId: '+44 7700 900123',
            },
          },
        ],
      },
    }
    const connectors = {
      'conn-wa': {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'delegator-agent',
        config: {},
      },
    }
    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'delegator-agent',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: null,
      },
    ]

    const target = resolveTaskOriginConnectorFollowupTarget({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors,
      running,
    })

    assert.deepEqual(target, {
      connectorId: 'conn-wa',
      channelId: '447700900123@s.whatsapp.net',
    })
  })
})
