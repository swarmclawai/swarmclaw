import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { BoardTask, Session } from '@/types'
import {
  applyTaskResumeStateToSession,
  collectTaskConnectorFollowupTargets,
  dequeueNextRunnableTask,
  resolveTaskOriginConnectorFollowupTarget,
  resolveTaskResumeContext,
  resolveReusableTaskSessionId,
} from './queue'

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
  connectorContext?: {
    connectorId?: string
    channelId?: string
    threadId?: string
  }
  messages: Array<{
    role: string
    text?: string
    historyExcluded?: boolean
    source?: {
      connectorId?: string
      channelId?: string
      threadId?: string
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
      connectors: connectors as any,
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
      connectors: connectors as any,
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
      connectors: connectors as any,
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
      connectors: connectors as any,
      running,
    })

    assert.deepEqual(target, {
      connectorId: 'conn-wa',
      channelId: '447700900123@s.whatsapp.net',
    })
  })

  it('prefers explicit task followup metadata over later thread traffic', () => {
    const task = makeTask({
      createdInSessionId: 'session-1',
      followupConnectorId: 'conn-wa',
      followupChannelId: '447700900111@s.whatsapp.net',
      followupThreadId: 'thread-me',
    })
    const sessions = {
      'session-1': {
        messages: [
          {
            role: 'user',
            text: 'wife said hello',
            source: {
              connectorId: 'conn-wa',
              channelId: '447700900222@s.whatsapp.net',
              threadId: 'thread-wife',
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
        recentChannelId: '447700900222@s.whatsapp.net',
      },
    ]

    const target = resolveTaskOriginConnectorFollowupTarget({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors: connectors as any,
      running,
    })

    assert.deepEqual(target, {
      connectorId: 'conn-wa',
      channelId: '447700900111@s.whatsapp.net',
      threadId: 'thread-me',
    })
  })

  it('ignores mirrored connector transcript copies when resolving delayed followups', () => {
    const task = makeTask({ createdInSessionId: 'session-main' })
    const sessions = {
      'session-main': {
        messages: [
          {
            role: 'user',
            text: 'from me over whatsapp',
            historyExcluded: true,
            source: {
              connectorId: 'conn-wa',
              channelId: '447700900111@s.whatsapp.net',
            },
          },
          {
            role: 'user',
            text: 'from wife over whatsapp later',
            historyExcluded: true,
            source: {
              connectorId: 'conn-wa',
              channelId: '447700900222@s.whatsapp.net',
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
        config: {
          taskFollowups: 'true',
        },
      },
    }
    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: '447700900222@s.whatsapp.net',
      },
    ]

    const target = resolveTaskOriginConnectorFollowupTarget({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors: connectors as any,
      running,
    })

    assert.equal(target, null)
  })
})

describe('collectTaskConnectorFollowupTargets', () => {
  it('does not fall back to a connector recent channel when there is no explicit origin target', () => {
    const task = makeTask({ createdInSessionId: 'session-main' })
    const sessions = {
      'session-main': {
        messages: [
          {
            role: 'user',
            text: 'mirrored from me',
            historyExcluded: true,
            source: {
              connectorId: 'conn-wa',
              channelId: '447700900111@s.whatsapp.net',
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
        config: {
          taskFollowups: 'true',
        },
      },
    }
    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: '447700900222@s.whatsapp.net',
      },
    ]

    const targets = collectTaskConnectorFollowupTargets({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors: connectors as any,
      running,
    })

    assert.deepEqual(targets, [])
  })

  it('uses only the origin target when both origin and a different recent channel exist', () => {
    const task = makeTask({
      createdInSessionId: 'session-origin',
      followupConnectorId: 'conn-wa',
      followupChannelId: '447700900111@s.whatsapp.net',
    })
    const sessions = {
      'session-origin': {
        messages: [],
      },
    }
    const connectors = {
      'conn-wa': {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        config: {
          taskFollowups: 'true',
          outboundJid: '447700900333@s.whatsapp.net',
        },
      },
    }
    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: '447700900222@s.whatsapp.net',
      },
    ]

    const targets = collectTaskConnectorFollowupTargets({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors: connectors as any,
      running,
    })

    assert.deepEqual(targets, [
      {
        connectorId: 'conn-wa',
        channelId: '447700900111@s.whatsapp.net',
      },
    ])
  })

  it('uses configured outbound targets for generic task followups', () => {
    const task = makeTask({ createdInSessionId: 'session-main' })
    const sessions = {
      'session-main': {
        messages: [],
      },
    }
    const connectors = {
      'conn-wa': {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        config: {
          taskFollowups: 'true',
          outboundJid: '+44 7700 900333',
        },
      },
    }
    const running = [
      {
        id: 'conn-wa',
        platform: 'whatsapp',
        agentId: 'agent-a',
        supportsSend: true,
        configuredTargets: [],
        recentChannelId: '447700900222@s.whatsapp.net',
      },
    ]

    const targets = collectTaskConnectorFollowupTargets({
      task,
      sessions: sessions as SessionFixtureMap,
      connectors: connectors as any,
      running,
    })

    assert.deepEqual(targets, [
      {
        connectorId: 'conn-wa',
        channelId: '447700900333@s.whatsapp.net',
      },
    ])
  })
})

describe('task resume context', () => {
  it('falls back to delegated parent task resume handles for follow-up work', () => {
    const parent = makeTask({
      id: 'task-parent',
      title: 'Parent task',
      codexResumeId: 'codex-thread-123',
      geminiResumeId: 'gemini-session-123',
      sessionId: 'session-parent',
    })
    const child = makeTask({
      id: 'task-child',
      title: 'Child task',
      delegatedFromTaskId: 'task-parent',
    })

    const context = resolveTaskResumeContext(child, {
      [parent.id]: parent,
      [child.id]: child,
    })

    assert.ok(context)
    assert.equal(context?.source, 'delegated_from_task')
    assert.equal(context?.sourceTaskId, 'task-parent')
    assert.equal(context?.sourceSessionId, 'session-parent')
    assert.equal(context?.resume.codexThreadId, 'codex-thread-123')
    assert.equal(context?.resume.delegateResumeIds.gemini, 'gemini-session-123')
  })

  it('hydrates task execution sessions with stored resume state', () => {
    const session = {
      id: 'session-task',
      name: 'Task session',
      cwd: process.cwd(),
      user: 'system',
      provider: 'codex-cli',
      model: 'gpt-5-codex',
      claudeSessionId: null,
      codexThreadId: null,
      opencodeSessionId: null,
      delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human',
      agentId: 'agent-a',
      parentSessionId: null,
      plugins: ['delegate'],
    } satisfies Session

    const changed = applyTaskResumeStateToSession(session, {
      claudeSessionId: 'claude-resume-1',
      codexThreadId: 'codex-resume-1',
      opencodeSessionId: 'opencode-resume-1',
      delegateResumeIds: {
        claudeCode: 'claude-resume-1',
        codex: 'codex-resume-1',
        opencode: 'opencode-resume-1',
        gemini: 'gemini-resume-1',
      },
    })

    assert.equal(changed, true)
    assert.equal(session.claudeSessionId, 'claude-resume-1')
    assert.equal(session.codexThreadId, 'codex-resume-1')
    assert.equal(session.opencodeSessionId, 'opencode-resume-1')
    assert.equal(session.delegateResumeIds?.gemini, 'gemini-resume-1')
  })
})

describe('dequeueNextRunnableTask', () => {
  it('leaves blocked queued tasks in place until their dependencies are completed', () => {
    const source = makeTask({
      id: 'task-source',
      title: 'Source task',
      status: 'running',
    })
    const followup = makeTask({
      id: 'task-followup',
      title: 'Follow-up task',
      status: 'queued',
      blockedBy: ['task-source'],
    })
    const queue = ['task-followup']

    const selectedWhileBlocked = dequeueNextRunnableTask(queue, {
      [source.id]: source,
      [followup.id]: followup,
    })

    assert.equal(selectedWhileBlocked, null)
    assert.deepEqual(queue, ['task-followup'])

    source.status = 'completed'
    const selectedAfterUnblock = dequeueNextRunnableTask(queue, {
      [source.id]: source,
      [followup.id]: followup,
    })

    assert.equal(selectedAfterUnblock, 'task-followup')
    assert.deepEqual(queue, [])
  })
})

describe('resolveReusableTaskSessionId', () => {
  it('reuses the completed dependency session for continuation tasks once it exists', () => {
    const source = makeTask({
      id: 'task-source',
      title: 'Source task',
      status: 'completed',
      sessionId: 'session-source',
      checkpoint: {
        lastSessionId: 'session-source',
        updatedAt: Date.now(),
      },
    })
    const followup = makeTask({
      id: 'task-followup',
      title: 'Follow-up task',
      status: 'queued',
      blockedBy: ['task-source'],
    })

    const sessionId = resolveReusableTaskSessionId(
      followup,
      {
        [source.id]: source,
        [followup.id]: followup,
      },
      {
        'session-source': {
          messages: [],
        },
      } as SessionFixtureMap,
    )

    assert.equal(sessionId, 'session-source')
  })
})
