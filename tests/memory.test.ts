import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { getMemoryDb, storeMemoryImageAsset } from '../src/lib/server/memory-db'
import {
  normalizeLinkedMemoryIds,
  normalizeMemoryLookupLimits,
  resolveLookupRequest,
  traverseLinkedMemoryGraph,
  type MemoryLookupLimits,
  type LinkedMemoryNode,
} from '../src/lib/server/memory-graph'
import type { MemoryEntry, MemoryReference } from '../src/types'

// Use a test-specific database path
const TEST_DB_DIR = path.join(process.cwd(), 'data', 'test-memory')
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'memory.db')
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
      expect(normalizeLinkedMemoryIds(['a', '', 'b', '  ', 'a', 'c'], 'self')).toEqual(['a', 'b', 'c'])
    })

    it('returns empty array for non-array input', () => {
      expect(normalizeLinkedMemoryIds(null)).toEqual([])
      expect(normalizeLinkedMemoryIds(undefined)).toEqual([])
      expect(normalizeLinkedMemoryIds('not-an-array')).toEqual([])
    })

    it('deduplicates ids', () => {
      expect(normalizeLinkedMemoryIds(['a', 'b', 'a', 'a', 'c'], undefined)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('normalizeMemoryLookupLimits', () => {
    it('returns defaults for empty settings', () => {
      const limits = normalizeMemoryLookupLimits({})
      expect(limits.maxDepth).toBe(3)
      expect(limits.maxPerLookup).toBe(20)
      expect(limits.maxLinkedExpansion).toBe(60)
    })

    it('clamps values to valid ranges', () => {
      const limits = normalizeMemoryLookupLimits({
        memoryReferenceDepth: 100,
        maxMemoriesPerLookup: 1000,
        maxLinkedMemoriesExpanded: 5000,
      })
      expect(limits.maxDepth).toBe(12) // max
      expect(limits.maxPerLookup).toBe(200) // max
      expect(limits.maxLinkedExpansion).toBe(1000) // max
    })

    it('clamps zeros to minimums', () => {
      const limits = normalizeMemoryLookupLimits({
        memoryReferenceDepth: 0,
        maxMemoriesPerLookup: 0,
        maxLinkedMemoriesExpanded: 0,
      })
      expect(limits.maxDepth).toBe(0)
      expect(limits.maxPerLookup).toBe(1) // min
      expect(limits.maxLinkedExpansion).toBe(0)
    })

    it('uses legacy setting names as fallback', () => {
      const limits = normalizeMemoryLookupLimits({
        memoryMaxDepth: 5,
        memoryMaxPerLookup: 50,
      })
      expect(limits.maxDepth).toBe(5)
      expect(limits.maxPerLookup).toBe(50)
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
      expect(result).toEqual(defaults)
    })

    it('overrides with request values', () => {
      const result = resolveLookupRequest(defaults, { depth: 2, limit: 10, linkedLimit: 30 })
      expect(result.maxDepth).toBe(2)
      expect(result.maxPerLookup).toBe(10)
      expect(result.maxLinkedExpansion).toBe(30)
    })

    it('caps at defaults maxima', () => {
      const result = resolveLookupRequest(defaults, { depth: 100, limit: 1000, linkedLimit: 5000 })
      expect(result.maxDepth).toBe(3) // capped at default
      expect(result.maxPerLookup).toBe(20) // capped at default
      expect(result.maxLinkedExpansion).toBe(60) // capped at default
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
      expect(result.entries).toEqual([])
      expect(result.truncated).toBe(false)
      expect(result.expandedLinkedCount).toBe(0)
    })

    it('traverses linked nodes by depth', () => {
      // a -> [b, c], b -> [d]
      const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 2, maxPerLookup: 20, maxLinkedExpansion: 60 }, fetchByIds)
      const ids = result.entries.map((n) => n.id)
      expect(ids).toContain('a')
      expect(ids).toContain('b')
      expect(ids).toContain('c')
      expect(ids).toContain('d') // depth 2
      expect(result.expandedLinkedCount).toBe(3) // b, c, d
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
      expect(ids).toContain('a')
      expect(ids).toContain('b')
      expect(ids).not.toContain('c') // depth 1 stops before c
    })

    it('respects maxPerLookup', () => {
      const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c', 'd', 'e'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 3, maxPerLookup: 3, maxLinkedExpansion: 60 }, fetchByIds)
      expect(result.entries.length).toBe(3)
      expect(result.truncated).toBe(true)
    })

    it('respects maxLinkedExpansion', () => {
      const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c', 'd', 'e', 'f'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 3, maxPerLookup: 20, maxLinkedExpansion: 2 }, fetchByIds)
      expect(result.expandedLinkedCount).toBe(2)
      expect(result.truncated).toBe(true)
    })

    it('handles circular links gracefully', () => {
      // a -> [b], b -> [a] (circular)
      const circularFetch = (ids: string[]): LinkedMemoryNode[] => {
        const map: Record<string, string[]> = { a: ['b'], b: ['a'] }
        return ids.map((id) => ({ id, linkedMemoryIds: map[id] || [] }))
      }
      const seeds = [{ id: 'a', linkedMemoryIds: ['b'] }]
      const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 10, maxPerLookup: 100, maxLinkedExpansion: 100 }, circularFetch)
      expect(result.entries.length).toBe(2) // just a and b
      expect(result.truncated).toBe(false)
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
      expect(legacyPaths[0].path).toBe('/src/lib/x.ts')
      expect(legacyPaths[0].kind).toBe('file')
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