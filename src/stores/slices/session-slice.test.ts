import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, Session } from '../../types'
import type { AppState } from '../use-app-store'
import { selectActiveSessionId } from './session-slice'

function makeState(overrides: Partial<AppState>): AppState {
  return {
    currentAgentId: null,
    agents: {},
    sessions: {},
    activeSessionIdOverride: null,
    ...overrides,
  } as AppState
}

function makeAgent(id: string, threadSessionId: string): Agent {
  return { id, threadSessionId } as unknown as Agent
}

function makeSession(id: string): Session {
  return { id } as unknown as Session
}

test('selectActiveSessionId prefers override when present', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: { 'thread-1': makeSession('thread-1'), 'task-1': makeSession('task-1') },
    activeSessionIdOverride: 'task-1',
  })
  assert.equal(selectActiveSessionId(state), 'task-1')
})

test('selectActiveSessionId falls back to agent thread session', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: { 'thread-1': makeSession('thread-1') },
  })
  assert.equal(selectActiveSessionId(state), 'thread-1')
})

test('selectActiveSessionId ignores stale override ids', () => {
  const state = makeState({
    currentAgentId: 'agent-1',
    agents: { 'agent-1': makeAgent('agent-1', 'thread-1') },
    sessions: { 'thread-1': makeSession('thread-1') },
    activeSessionIdOverride: 'missing-session',
  })
  assert.equal(selectActiveSessionId(state), 'thread-1')
})
