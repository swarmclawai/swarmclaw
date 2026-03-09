import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MemoryEntry } from '@/types'
import { filterMemoriesByScope, normalizeMemoryScopeMode } from './memory-db'

function makeEntry(id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    agentId: null,
    sessionId: null,
    category: 'note',
    title: `Entry ${id}`,
    content: `content ${id}`,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

test('normalizeMemoryScopeMode maps shared alias to global', () => {
  assert.equal(normalizeMemoryScopeMode('shared'), 'global')
  assert.equal(normalizeMemoryScopeMode('project'), 'project')
  assert.equal(normalizeMemoryScopeMode('unknown'), 'auto')
})

test('filterMemoriesByScope auto includes global + own + shared-with-agent', () => {
  const rows: MemoryEntry[] = [
    makeEntry('global', { agentId: null }),
    makeEntry('mine', { agentId: 'agent-a' }),
    makeEntry('shared', { agentId: 'agent-b', sharedWith: ['agent-a'] }),
    makeEntry('other', { agentId: 'agent-b' }),
  ]
  const filtered = filterMemoriesByScope(rows, { mode: 'auto', agentId: 'agent-a' })
  assert.deepEqual(filtered.map((r) => r.id), ['global', 'mine', 'shared'])
})

test('filterMemoriesByScope supports project and session scopes', () => {
  const rows: MemoryEntry[] = [
    makeEntry('proj-hit', {
      sessionId: 's-1',
      references: [{ type: 'project', path: '/repo/swarm', projectRoot: '/repo/swarm', timestamp: 1 }],
    }),
    makeEntry('proj-miss', {
      sessionId: 's-1',
      references: [{ type: 'project', path: '/repo/other', projectRoot: '/repo/other', timestamp: 1 }],
    }),
    makeEntry('session-hit', { sessionId: 's-2' }),
  ]

  const projectFiltered = filterMemoriesByScope(rows, { mode: 'project', projectRoot: '/repo/swarm' })
  assert.deepEqual(projectFiltered.map((r) => r.id), ['proj-hit'])

  const sessionFiltered = filterMemoriesByScope(rows, { mode: 'session', sessionId: 's-2' })
  assert.deepEqual(sessionFiltered.map((r) => r.id), ['session-hit'])
})

