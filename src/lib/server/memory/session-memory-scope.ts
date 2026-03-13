import type { Session } from '@/types'
import type { MemoryScopeFilter, MemoryScopeMode } from '@/lib/server/memory/memory-db'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'

type SessionMemoryShape = {
  id?: string | null
  agentId?: string | null
  memoryScopeMode?: MemoryScopeMode | string | null
  connectorContext?: Session['connectorContext'] | null
  name?: string | null
  user?: string | null
}

function normalizeMemoryScopeMode(value: unknown): MemoryScopeMode | null {
  if (value === null || value === undefined) return null
  if (value === 'auto' || value === 'all' || value === 'global' || value === 'agent' || value === 'session' || value === 'project') {
    return value
  }
  return null
}

export function shouldForceSessionScopedConnectorMemory(session?: SessionMemoryShape | null): boolean {
  if (!session) return false
  return isDirectConnectorSession(session) && session.connectorContext?.isOwnerConversation !== true
}

export function resolveEffectiveSessionMemoryScopeMode(
  session?: SessionMemoryShape | null,
  fallbackMode: MemoryScopeMode | null = null,
): MemoryScopeMode | null {
  if (shouldForceSessionScopedConnectorMemory(session)) return 'session'
  const sessionMode = normalizeMemoryScopeMode(session?.memoryScopeMode)
  return sessionMode || fallbackMode || null
}

export function buildSessionMemoryScopeFilter(
  session: SessionMemoryShape,
  fallbackMode: MemoryScopeMode | null = null,
  projectRoot: string | null = null,
): MemoryScopeFilter {
  return {
    mode: resolveEffectiveSessionMemoryScopeMode(session, fallbackMode) || 'auto',
    agentId: session.agentId ?? null,
    sessionId: session.id ?? null,
    projectRoot,
  }
}
