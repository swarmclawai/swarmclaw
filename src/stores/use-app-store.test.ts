import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Agent, Session } from '@/types'
import { useAppStore } from './use-app-store'

const originalState = {
  agents: useAppStore.getState().agents,
  sessions: useAppStore.getState().sessions,
  currentAgentId: useAppStore.getState().currentAgentId,
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent One',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-5',
    plugins: ['memory'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Agent
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Session One',
    cwd: '/tmp',
    user: 'default',
    provider: 'openai',
    model: 'gpt-5',
    claudeSessionId: null,
    messages: [],
    createdAt: 1,
    lastActiveAt: 1,
    plugins: ['memory'],
    ...overrides,
  } as Session
}

afterEach(() => {
  useAppStore.setState({
    agents: originalState.agents,
    sessions: originalState.sessions,
    currentAgentId: originalState.currentAgentId,
  })
})

describe('useAppStore immediate record updates', () => {
  it('updates agent records synchronously', () => {
    useAppStore.setState({
      agents: {
        'agent-1': makeAgent({ heartbeatEnabled: false, heartbeatIntervalSec: null }),
      },
    })

    useAppStore.getState().updateAgentInStore(
      makeAgent({ heartbeatEnabled: true, heartbeatIntervalSec: 300 }),
    )

    const updated = useAppStore.getState().agents['agent-1']
    assert.equal(updated?.heartbeatEnabled, true)
    assert.equal(updated?.heartbeatIntervalSec, 300)
  })

  it('updates session records synchronously', () => {
    useAppStore.setState({
      sessions: {
        'session-1': makeSession({ heartbeatEnabled: false, heartbeatIntervalSec: null }),
      },
    })

    useAppStore.getState().updateSessionInStore(
      makeSession({ heartbeatEnabled: true, heartbeatIntervalSec: 1800 }),
    )

    const updated = useAppStore.getState().sessions['session-1']
    assert.equal(updated?.heartbeatEnabled, true)
    assert.equal(updated?.heartbeatIntervalSec, 1800)
  })
})
