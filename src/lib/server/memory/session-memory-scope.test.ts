import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Session } from '@/types'
import {
  buildSessionMemoryScopeFilter,
  resolveEffectiveSessionMemoryScopeMode,
  shouldForceSessionScopedConnectorMemory,
} from '@/lib/server/memory/session-memory-scope'

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: overrides.id || 'session-1',
    name: overrides.name || 'Session',
    cwd: overrides.cwd || '/tmp',
    user: overrides.user || 'default',
    provider: overrides.provider || 'openai',
    model: overrides.model || 'gpt-test',
    claudeSessionId: overrides.claudeSessionId ?? null,
    messages: overrides.messages || [],
    createdAt: overrides.createdAt || 1,
    lastActiveAt: overrides.lastActiveAt || 1,
    ...overrides,
  } as Session
}

describe('session memory scope helpers', () => {
  it('forces strict session scope for external connector conversations', () => {
    const session = makeSession({
      user: 'connector',
      name: 'connector:whatsapp:conn-1:peer:user-1',
      agentId: 'agent-1',
      connectorContext: { isOwnerConversation: false },
      memoryScopeMode: 'agent',
    })

    assert.equal(shouldForceSessionScopedConnectorMemory(session), true)
    assert.equal(resolveEffectiveSessionMemoryScopeMode(session, 'agent'), 'session')
    assert.deepEqual(buildSessionMemoryScopeFilter(session, 'agent'), {
      mode: 'session',
      agentId: 'agent-1',
      sessionId: 'session-1',
      projectRoot: null,
    })
  })

  it('keeps agent fallback scope for owner or normal sessions', () => {
    const ownerSession = makeSession({
      user: 'connector',
      name: 'connector:whatsapp:owner',
      agentId: 'agent-1',
      connectorContext: { isOwnerConversation: true },
    })
    const mainSession = makeSession({
      user: 'default',
      name: 'Main Chat',
      agentId: 'agent-2',
      memoryScopeMode: 'project',
    })

    assert.equal(shouldForceSessionScopedConnectorMemory(ownerSession), false)
    assert.equal(resolveEffectiveSessionMemoryScopeMode(ownerSession, 'agent'), 'agent')
    assert.equal(resolveEffectiveSessionMemoryScopeMode(mainSession, 'agent'), 'project')
  })
})
