import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let memDb: typeof import('@/lib/server/memory/memory-db')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-memory-db-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  memDb = await import('@/lib/server/memory/memory-db')
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

describe('memory-db', () => {
  // --- Basic CRUD ---

  describe('add and get', () => {
    it('stores a memory and retrieves it by ID', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: 'agent-1',
        sessionId: 'session-1',
        category: 'note',
        title: 'Test Memory',
        content: 'This is a test memory entry.',
      })
      assert.ok(entry.id)
      assert.equal(entry.title, 'Test Memory')
      assert.equal(entry.content, 'This is a test memory entry.')
      assert.equal(entry.category, 'note')
      assert.equal(entry.agentId, 'agent-1')

      const retrieved = db.get(entry.id)
      assert.ok(retrieved)
      assert.equal(retrieved!.id, entry.id)
      assert.equal(retrieved!.title, 'Test Memory')
    })

    it('generates unique IDs for each entry', () => {
      const db = memDb.getMemoryDb()
      const e1 = db.add({ agentId: null, category: 'note', title: 'A', content: 'a-content' })
      const e2 = db.add({ agentId: null, category: 'note', title: 'B', content: 'b-content' })
      assert.notEqual(e1.id, e2.id)
    })

    it('returns null for non-existent ID', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.get('nonexistent-id-xyz'), null)
    })
  })

  // --- Update ---

  describe('update', () => {
    it('updates a memory entry', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: 'agent-up',
        category: 'note',
        title: 'Original Title',
        content: 'Original content.',
      })
      const updated = db.update(entry.id, { title: 'Updated Title', content: 'Updated content.' })
      assert.ok(updated)
      assert.equal(updated!.title, 'Updated Title')
      assert.equal(updated!.content, 'Updated content.')
      assert.equal(updated!.agentId, 'agent-up')
    })

    it('returns null when updating non-existent entry', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.update('nonexistent-id', { title: 'Nope' }), null)
    })
  })

  // --- Delete ---

  describe('delete', () => {
    it('removes a memory entry', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: 'agent-del',
        category: 'note',
        title: 'To Delete',
        content: 'This will be deleted.',
      })
      assert.ok(db.get(entry.id))
      db.delete(entry.id)
      assert.equal(db.get(entry.id), null)
    })
  })

  // --- List ---

  describe('list', () => {
    it('lists memories for an agent', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-list-${Date.now()}`
      db.add({ agentId, category: 'note', title: 'List 1', content: 'Content 1' })
      db.add({ agentId, category: 'note', title: 'List 2', content: 'Content 2' })
      db.add({ agentId: 'other-agent', category: 'note', title: 'Other', content: 'Other content' })

      const agentMemories = db.list(agentId)
      assert.ok(agentMemories.length >= 2, `Expected at least 2 agent memories, got ${agentMemories.length}`)
      const titles = agentMemories.map((m) => m.title)
      assert.ok(titles.includes('List 1'))
      assert.ok(titles.includes('List 2'))
    })

    it('respects limit parameter', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-limit-${Date.now()}`
      for (let i = 0; i < 10; i++) {
        db.add({ agentId, category: 'note', title: `Mem ${i}`, content: `Content ${i}` })
      }
      const limited = db.list(agentId, 3)
      assert.equal(limited.length, 3)
    })
  })

  // --- FTS5 Search ---

  describe('search (FTS5)', () => {
    it('finds memories by content keyword', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-fts-${Date.now()}`
      db.add({
        agentId,
        category: 'note',
        title: 'Kubernetes Deployment',
        content: 'Deployed the application to a Kubernetes cluster using Helm charts.',
      })
      db.add({
        agentId,
        category: 'note',
        title: 'Database Migration',
        content: 'Ran the PostgreSQL migration scripts successfully.',
      })

      const results = db.search('kubernetes deployment helm', agentId)
      assert.ok(results.length >= 1, `Expected FTS results for kubernetes, got ${results.length}`)
      const titles = results.map((r) => r.title)
      assert.ok(titles.includes('Kubernetes Deployment'))
    })

    it('returns empty for skip-query patterns', () => {
      const db = memDb.getMemoryDb()
      assert.deepEqual(db.search(''), [])
      assert.deepEqual(db.search('swarm_heartbeat_check'), [])
    })

    it('returns empty for very long queries', () => {
      const db = memDb.getMemoryDb()
      const longQuery = 'x'.repeat(1300)
      assert.deepEqual(db.search(longQuery), [])
    })
  })

  // --- buildFtsQuery ---

  describe('buildFtsQuery', () => {
    it('removes stop words', () => {
      const query = memDb.buildFtsQuery('what is the purpose of this')
      // 'what', 'is', 'the', 'of', 'this' are stop words; 'purpose' should remain
      assert.ok(query.includes('purpose'))
      assert.ok(!query.includes('"the"'))
    })

    it('returns empty for all stop words', () => {
      const query = memDb.buildFtsQuery('the is a an')
      assert.equal(query, '')
    })

    it('limits to MAX_FTS_QUERY_TERMS', () => {
      const query = memDb.buildFtsQuery('alpha bravo charlie delta echo foxtrot golf hotel india juliet')
      // Should have at most 4 terms (slice 0..4)
      const termCount = (query.match(/AND/g) || []).length + 1
      assert.ok(termCount <= 4, `Expected at most 4 terms, got ${termCount}`)
    })

    it('handles empty input', () => {
      assert.equal(memDb.buildFtsQuery(''), '')
    })

    it('deduplicates terms', () => {
      const query = memDb.buildFtsQuery('kubernetes kubernetes kubernetes')
      // Should only have one kubernetes
      const occurrences = (query.match(/kubernetes/g) || []).length
      assert.equal(occurrences, 1)
    })

    it('skips very short terms', () => {
      const query = memDb.buildFtsQuery('go is ok no')
      // All terms are <3 chars or stop words
      assert.equal(query, '')
    })
  })

  // --- Content hash dedup ---

  describe('content hash dedup', () => {
    it('reinforces instead of duplicating same content for same agent', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-dedup-${Date.now()}`
      const first = db.add({
        agentId,
        category: 'fact',
        title: 'Dedup Test',
        content: 'Identical content for dedup testing.',
      })
      const second = db.add({
        agentId,
        category: 'fact',
        title: 'Dedup Test Different Title',
        content: 'Identical content for dedup testing.',
      })
      // Should return the same ID (reinforced, not duplicated)
      assert.equal(second.id, first.id)
      assert.ok((second.reinforcementCount || 0) >= 1, 'Expected reinforcement count to increase')
    })
  })

  // --- Memory linking ---

  describe('link and unlink', () => {
    it('links two memories bidirectionally', () => {
      const db = memDb.getMemoryDb()
      const a = db.add({ agentId: 'agent-link', category: 'note', title: 'Memory A', content: 'Content A' })
      const b = db.add({ agentId: 'agent-link', category: 'note', title: 'Memory B', content: 'Content B' })

      db.link(a.id, [b.id])

      const aAfter = db.get(a.id)
      const bAfter = db.get(b.id)
      assert.ok(aAfter!.linkedMemoryIds?.includes(b.id), 'A should link to B')
      assert.ok(bAfter!.linkedMemoryIds?.includes(a.id), 'B should link back to A')
    })

    it('unlinks memories bidirectionally', () => {
      const db = memDb.getMemoryDb()
      const a = db.add({ agentId: 'agent-unlink', category: 'note', title: 'Unlink A', content: 'Unlink Content A' })
      const b = db.add({ agentId: 'agent-unlink', category: 'note', title: 'Unlink B', content: 'Unlink Content B' })

      db.link(a.id, [b.id])
      db.unlink(a.id, [b.id])

      const aAfter = db.get(a.id)
      const bAfter = db.get(b.id)
      const aLinks = aAfter?.linkedMemoryIds || []
      const bLinks = bAfter?.linkedMemoryIds || []
      assert.ok(!aLinks.includes(b.id), 'A should no longer link to B')
      assert.ok(!bLinks.includes(a.id), 'B should no longer link to A')
    })

    it('link returns null for non-existent source', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.link('nonexistent', ['also-nonexistent']), null)
    })
  })

  // --- Pinned memories ---

  describe('pinned memories', () => {
    it('lists pinned memories for an agent', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-pinned-${Date.now()}`
      db.add({ agentId, category: 'note', title: 'Regular', content: 'Not pinned' })
      db.add({ agentId, category: 'note', title: 'Pinned One', content: 'This is pinned', pinned: true })

      const pinned = db.listPinned(agentId)
      assert.ok(pinned.length >= 1)
      assert.ok(pinned.some((m) => m.title === 'Pinned One'))
      assert.ok(pinned.every((m) => m.pinned === true))
    })
  })

  // --- Scope filtering ---

  describe('filterMemoriesByScope', () => {
    it('returns all entries with mode=all', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: null, category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'all' })
      assert.equal(result.length, 2)
    })

    it('filters to global-only with mode=global', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: null, category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'global' })
      assert.equal(result.length, 1)
      assert.equal(result[0].id, '2')
    })

    it('filters by agent with mode=agent', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: 'a2', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'agent', agentId: 'a1' })
      assert.equal(result.length, 1)
      assert.equal(result[0].agentId, 'a1')
    })

    it('includes shared-with entries in agent mode', () => {
      const entries = [
        { id: '1', agentId: 'a2', sharedWith: ['a1'], category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'agent', agentId: 'a1' })
      assert.equal(result.length, 1)
    })

    it('returns empty for agent mode without agentId', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'agent' })
      assert.equal(result.length, 0)
    })

    it('filters by session with mode=session', () => {
      const entries = [
        { id: '1', agentId: 'a1', sessionId: 's1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: 'a1', sessionId: 's2', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'session', sessionId: 's1' })
      assert.equal(result.length, 1)
      assert.equal(result[0].sessionId, 's1')
    })
  })

  // --- normalizeMemoryScopeMode ---

  describe('normalizeMemoryScopeMode', () => {
    it('normalizes known modes', () => {
      assert.equal(memDb.normalizeMemoryScopeMode('all'), 'all')
      assert.equal(memDb.normalizeMemoryScopeMode('global'), 'global')
      assert.equal(memDb.normalizeMemoryScopeMode('agent'), 'agent')
      assert.equal(memDb.normalizeMemoryScopeMode('session'), 'session')
      assert.equal(memDb.normalizeMemoryScopeMode('project'), 'project')
    })

    it('maps shared to global', () => {
      assert.equal(memDb.normalizeMemoryScopeMode('shared'), 'global')
    })

    it('defaults to auto for unknown', () => {
      assert.equal(memDb.normalizeMemoryScopeMode('invalid'), 'auto')
      assert.equal(memDb.normalizeMemoryScopeMode(''), 'auto')
      assert.equal(memDb.normalizeMemoryScopeMode(null), 'auto')
      assert.equal(memDb.normalizeMemoryScopeMode(undefined), 'auto')
    })
  })

  // --- getLatestBySessionCategory ---

  describe('getLatestBySessionCategory', () => {
    it('returns a memory for a valid session+category', () => {
      const db = memDb.getMemoryDb()
      const sessionId = `sess-latest-${Date.now()}`
      db.add({ agentId: 'a', sessionId, category: 'working/context', title: 'Entry A', content: 'content alpha unique' })
      db.add({ agentId: 'a', sessionId, category: 'working/context', title: 'Entry B', content: 'content beta unique' })

      const latest = db.getLatestBySessionCategory(sessionId, 'working/context')
      assert.ok(latest, 'Should return a memory entry')
      assert.equal(latest!.sessionId, sessionId)
      assert.equal(latest!.category, 'working/context')
    })

    it('returns null for non-matching category', () => {
      const db = memDb.getMemoryDb()
      const sessionId = `sess-nomatch-${Date.now()}`
      db.add({ agentId: 'a', sessionId, category: 'note', title: 'X', content: 'x content unique nomatch' })
      assert.equal(db.getLatestBySessionCategory(sessionId, 'working/context'), null)
    })

    it('returns null for empty session/category', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.getLatestBySessionCategory('', 'note'), null)
      assert.equal(db.getLatestBySessionCategory('valid', ''), null)
    })
  })

  // --- countsByAgent ---

  describe('countsByAgent', () => {
    it('returns counts grouped by agent', () => {
      const db = memDb.getMemoryDb()
      // Data already exists from previous tests — just verify the shape
      const counts = db.countsByAgent()
      assert.equal(typeof counts, 'object')
      // Should have at least one key
      assert.ok(Object.keys(counts).length >= 1)
      for (const [, val] of Object.entries(counts)) {
        assert.equal(typeof val, 'number')
        assert.ok(val > 0)
      }
    })
  })

  // --- Delete cleans up links ---

  describe('delete cleans up linked references', () => {
    it('removes deleted ID from other memories linkedMemoryIds', () => {
      const db = memDb.getMemoryDb()
      const a = db.add({ agentId: 'agent-cleanup', category: 'note', title: 'Cleanup A', content: 'Cleanup A content' })
      const b = db.add({ agentId: 'agent-cleanup', category: 'note', title: 'Cleanup B', content: 'Cleanup B content' })
      const c = db.add({ agentId: 'agent-cleanup', category: 'note', title: 'Cleanup C', content: 'Cleanup C content' })

      db.link(a.id, [b.id, c.id])

      // Verify links exist
      const bBefore = db.get(b.id)
      assert.ok(bBefore?.linkedMemoryIds?.includes(a.id))

      // Delete A
      db.delete(a.id)

      // B and C should no longer reference A
      const bAfter = db.get(b.id)
      const cAfter = db.get(c.id)
      const bLinks = bAfter?.linkedMemoryIds || []
      const cLinks = cAfter?.linkedMemoryIds || []
      assert.ok(!bLinks.includes(a.id), 'B should not reference deleted A')
      assert.ok(!cLinks.includes(a.id), 'C should not reference deleted A')
    })
  })

  // --- addKnowledge ---

  describe('addKnowledge', () => {
    it('creates a global knowledge entry', () => {
      const entry = memDb.addKnowledge({
        title: 'API Rate Limits',
        content: 'The API has a rate limit of 100 requests per minute.',
        tags: ['api', 'limits'],
      })
      assert.ok(entry.id)
      assert.equal(entry.category, 'knowledge')
      assert.equal(entry.agentId, null)
      assert.equal(entry.title, 'API Rate Limits')
    })
  })

  // --- searchKnowledge ---

  describe('searchKnowledge', () => {
    it('finds knowledge entries by query', () => {
      // Add a knowledge entry with a unique term
      memDb.addKnowledge({
        title: 'Photosynthesis Process',
        content: 'Chlorophyll absorbs sunlight to convert carbon dioxide into glucose.',
        tags: ['biology', 'science'],
      })

      const results = memDb.searchKnowledge('chlorophyll photosynthesis glucose')
      assert.ok(results.length >= 1, `Expected at least 1 result, got ${results.length}`)
      assert.ok(results.every((r) => r.category === 'knowledge'))
    })
  })
})
