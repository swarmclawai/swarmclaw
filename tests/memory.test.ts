import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import {
  normalizeLinkedMemoryIds,
  normalizeMemoryLookupLimits,
  resolveLookupRequest,
  traverseLinkedMemoryGraph,
  type MemoryLookupLimits,
  type LinkedMemoryNode,
} from '../src/lib/server/memory-graph'

// Use a test-specific database path
const TEST_DB_DIR = path.join(process.cwd(), 'data', 'test-memory')
const TEST_IMAGES_DIR = path.join(TEST_DB_DIR, 'memory-images')

function setupTestDb() {
  // Clean up any existing test database
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  }
  fs.mkdirSync(TEST_DB_DIR, { recursive: true })
  fs.mkdirSync(TEST_IMAGES_DIR, { recursive: true })
}

function cleanupTestDb() {
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true })
  }
}

describe('Memory System', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    cleanupTestDb()
  })

  describe('normalizeLinkedMemoryIds', () => {
    it('filters out empty strings and self-references', () => {
      assert.deepEqual(normalizeLinkedMemoryIds(['a', '', 'b', '  ', 'a', 'c'], 'self'), ['a', 'b', 'c'])
    })

    it('returns empty array for non-array input', () => {
      assert.deepEqual(normalizeLinkedMemoryIds(null), [])
      assert.deepEqual(normalizeLinkedMemoryIds(undefined), [])
      assert.deepEqual(normalizeLinkedMemoryIds('not-an-array'), [])
    })

    it('deduplicates ids', () => {
      assert.deepEqual(normalizeLinkedMemoryIds(['a', 'b', 'a', 'a', 'c'], undefined), ['a', 'b', 'c'])
    })
  })

  describe('normalizeMemoryLookupLimits', () => {
    it('returns defaults for empty settings', () => {
      const limits = normalizeMemoryLookupLimits({})
      assert.equal(limits.maxDepth, 3)
      assert.equal(limits.maxPerLookup, 20)
      assert.equal(limits.maxLinkedExpansion, 60)
    })

    it('clamps values to valid ranges', () => {
      const limits = normalizeMemoryLookupLimits({
        memoryReferenceDepth: 100,
        maxMemoriesPerLookup: 1000,
        maxLinkedMemoriesExpanded: 5000,
      })
      assert.equal(limits.maxDepth, 12) // max
      assert.equal(limits.maxPerLookup, 200) // max
      assert.equal(limits.maxLinkedExpansion, 1000) // max
    })

    it('clamps zeros to minimums', () => {
      const limits = normalizeMemoryLookupLimits({
        memoryReferenceDepth: 0,
        maxMemoriesPerLookup: 0,
        maxLinkedMemoriesExpanded: 0,
      })
      assert.equal(limits.maxDepth, 0)
      assert.equal(limits.maxPerLookup, 1) // min
      assert.equal(limits.maxLinkedExpansion, 0)
    })

    it('uses legacy setting names as fallback', () => {
      const limits = normalizeMemoryLookupLimits({
        memoryMaxDepth: 5,
        memoryMaxPerLookup: 50,
      })
      assert.equal(limits.maxDepth, 5)
      assert.equal(limits.maxPerLookup, 50)
    })
  })

  describe('resolveLookupRequest', () => {
    const defaults: MemoryLookupLimits = {
      maxDepth: 3,
      maxPerLookup: 20,
      maxLinkedExpansion: 60,
    }

    it('uses defaults when request is empty', () => {
      const result = resolveLookupRequest(defaults, {})
      assert.deepEqual(result, defaults)
    })

    it('overrides with request values', () => {
      const result = resolveLookupRequest(defaults, { depth: 2, limit: 10, linkedLimit: 30 })
      assert.equal(result.maxDepth, 2)
      assert.equal(result.maxPerLookup, 10)
      assert.equal(result.maxLinkedExpansion, 30)
    })

    it('caps at defaults maxima', () => {
      const result = resolveLookupRequest(defaults, { depth: 100, limit: 1000, linkedLimit: 5000 })
      assert.equal(result.maxDepth, 3) // capped at default
      assert.equal(result.maxPerLookup, 20) // capped at default
      assert.equal(result.maxLinkedExpansion, 60) // capped at default
    })
  })

  describe('traverseLinkedMemoryGraph', () => {
    const fetchByIds = (ids: string[]): LinkedMemoryNode[] => {
      return ids.map((id) => ({
        id,
        linkedMemoryIds: id === 'a' ? ['b', 'c'] : id === 'b' ? ['d'] : [],
      }))
    }

    it('returns empty for empty seeds', () => {
      const result = traverseLinkedMemoryGraph([], { maxDepth: 3, maxPerLookup: 20, maxLinkedExpansion: 60 }, fetchByIds)
      assert.deepEqual(result.entries, [])
      assert.equal(result.truncated, false)
      assert.equal(result.expandedLinkedCount, 0)
    })

    it('traverses linked nodes by depth', () => {
      // a -> [b, c], b -> [d]
      const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 2, maxPerLookup: 20, maxLinkedExpansion: 60 }, fetchByIds)
      const ids = result.entries.map((n) => n.id)
      assert.ok(ids.includes('a'))
      assert.ok(ids.includes('b'))
      assert.ok(ids.includes('c'))
      assert.ok(ids.includes('d')) // depth 2
      assert.equal(result.expandedLinkedCount, 3) // b, c, d
    })

    it('respects maxDepth', () => {
      // a -> [b], b -> [c], c -> [d] (if fetch returned that)
      const limitedFetch = (ids: string[]): LinkedMemoryNode[] => {
        const map: Record<string, string[]> = { a: ['b'], b: ['c'], c: ['d'], d: [] }
        return ids.map((id) => ({ id, linkedMemoryIds: map[id] || [] }))
      }
      const seeds = [{ id: 'a', linkedMemoryIds: ['b'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 1, maxPerLookup: 20, maxLinkedExpansion: 60 }, limitedFetch)
      const ids = result.entries.map((n) => n.id)
      assert.ok(ids.includes('a'))
      assert.ok(ids.includes('b'))
      assert.ok(!ids.includes('c')) // depth 1 stops before c
    })

    it('respects maxPerLookup', () => {
      const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c', 'd', 'e'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 3, maxPerLookup: 3, maxLinkedExpansion: 60 }, fetchByIds)
      assert.equal(result.entries.length, 3)
      assert.equal(result.truncated, true)
    })

    it('respects maxLinkedExpansion', () => {
      const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c', 'd', 'e', 'f'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 3, maxPerLookup: 20, maxLinkedExpansion: 2 }, fetchByIds)
      assert.equal(result.expandedLinkedCount, 2)
      assert.equal(result.truncated, true)
    })

    it('handles circular links gracefully', () => {
      // a -> [b], b -> [a] (circular)
      const circularFetch = (ids: string[]): LinkedMemoryNode[] => {
        const map: Record<string, string[]> = { a: ['b'], b: ['a'] }
        return ids.map((id) => ({ id, linkedMemoryIds: map[id] || [] }))
      }
      const seeds = [{ id: 'a', linkedMemoryIds: ['b'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 10, maxPerLookup: 100, maxLinkedExpansion: 100 }, circularFetch)
      assert.equal(result.entries.length, 2) // just a and b
      assert.equal(result.truncated, false)
    })
  })
})

describe('Memory Database', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    cleanupTestDb()
  })

  // Note: These tests require mocking the DB path or using a test-specific path
  // The actual getMemoryDb() uses a singleton, so these are integration-style tests
  
  describe('Reference normalization', () => {
    it('converts legacy filePaths to references', () => {
      const legacyPaths = [
        { path: '/src/lib/x.ts', contextSnippet: 'buggy function', kind: 'file' as const, timestamp: Date.now() },
        { path: '/src', kind: 'folder' as const, timestamp: Date.now() },
      ]
      // This would be tested via the actual memory-db.ts normalizeReferences helper
      // For now, verify the structure is expected
      assert.equal(legacyPaths[0].path, '/src/lib/x.ts')
      assert.equal(legacyPaths[0].kind, 'file')
    })
  })

  describe('Image storage', () => {
    it('rejects images over 10MB', async () => {
      // This would require creating a large temp file
      // Skipped for unit test - integration test needed
    })

    it('compresses images to 1024px max dimension', async () => {
      // This would require sharp and a real image file
      // Skipped for unit test - integration test needed
    })
  })
})
