import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { Session } from '@/types'

import {
  findLatestObservablePlatformSession,
  isLocalhostBrowser,
  isVisibleSessionForViewer,
} from './local-observability'

const originalWindow = globalThis.window

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: overrides.id || 'session-test',
    name: overrides.name || 'Test Session',
    user: overrides.user || 'default',
    messages: overrides.messages || [],
    createdAt: overrides.createdAt || 1,
    updatedAt: overrides.updatedAt || overrides.createdAt || 1,
    lastActiveAt: overrides.lastActiveAt || overrides.updatedAt || overrides.createdAt || 1,
    provider: overrides.provider || 'openai',
    model: overrides.model || 'gpt-test',
    ...overrides,
  } as Session
}

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window
    return
  }
  globalThis.window = originalWindow
})

describe('local observability', () => {
  it('shows observable platform sessions only on localhost', () => {
    const workbench = makeSession({ id: 'wb-1', user: 'workbench' })
    const swarm = makeSession({ id: 'sw-1', user: 'swarm' })
    const mine = makeSession({ id: 'me-1', user: 'wayde' })

    assert.equal(isVisibleSessionForViewer(workbench, 'wayde', { localhost: false }), false)
    assert.equal(isVisibleSessionForViewer(workbench, 'wayde', { localhost: true }), true)
    assert.equal(isVisibleSessionForViewer(swarm, 'wayde', { localhost: false }), true)
    assert.equal(isVisibleSessionForViewer(mine, 'wayde', { localhost: false }), true)
  })

  it('prefers the latest live observable platform session for an agent', () => {
    const sessions: Record<string, Session> = {
      old: makeSession({ id: 'old', agentId: 'agent-1', user: 'workbench', lastActiveAt: 100 }),
      shortcut: makeSession({
        id: 'shortcut',
        agentId: 'agent-1',
        user: 'workbench',
        lastActiveAt: 500,
        shortcutForAgentId: 'agent-1',
      }),
      latest: makeSession({ id: 'latest', agentId: 'agent-1', user: 'comparison-bench', lastActiveAt: 300 }),
      otherAgent: makeSession({ id: 'other', agentId: 'agent-2', user: 'workbench', lastActiveAt: 999 }),
    }

    assert.equal(findLatestObservablePlatformSession(sessions, 'agent-1')?.id, 'latest')
  })

  it('detects localhost browser hosts', () => {
    globalThis.window = { location: { hostname: "localhost" } } as any
    assert.equal(isLocalhostBrowser(), true)

    globalThis.window = { location: { hostname: "swarmclaw.ai" } } as any
    assert.equal(isLocalhostBrowser(), false)
  })
})
