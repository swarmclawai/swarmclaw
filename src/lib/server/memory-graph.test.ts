import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  normalizeLinkedMemoryIds,
  normalizeMemoryLookupLimits,
  resolveLookupRequest,
  traverseLinkedMemoryGraph,
} from './memory-graph'
import type { MemoryLookupLimits, LinkedMemoryNode } from './memory-graph'

describe('normalizeLinkedMemoryIds', () => {
  it('filters empty strings and self-references', () => {
    assert.deepStrictEqual(
      normalizeLinkedMemoryIds(['a', '', 'b', '  ', 'a', 'c'], 'self'),
      ['a', 'b', 'c']
    )
  })

  it('returns empty array for non-array input', () => {
    assert.deepStrictEqual(normalizeLinkedMemoryIds(null), [])
    assert.deepStrictEqual(normalizeLinkedMemoryIds(undefined), [])
    assert.deepStrictEqual(normalizeLinkedMemoryIds('not-an-array'), [])
  })

  it('deduplicates ids', () => {
    assert.deepStrictEqual(
      normalizeLinkedMemoryIds(['a', 'b', 'a', 'a', 'c'], undefined),
      ['a', 'b', 'c']
    )
  })
})

describe('normalizeMemoryLookupLimits', () => {
  it('returns defaults for empty settings', () => {
    const limits = normalizeMemoryLookupLimits({})
    assert.strictEqual(limits.maxDepth, 3)
    assert.strictEqual(limits.maxPerLookup, 20)
    assert.strictEqual(limits.maxLinkedExpansion, 60)
  })

  it('clamps to valid ranges', () => {
    const limits = normalizeMemoryLookupLimits({
      memoryReferenceDepth: 100,
      maxMemoriesPerLookup: 1000,
      maxLinkedMemoriesExpanded: 5000,
    })
    assert.strictEqual(limits.maxDepth, 12) // max
    assert.strictEqual(limits.maxPerLookup, 200) // max
    assert.strictEqual(limits.maxLinkedExpansion, 1000) // max
  })

  it('allows zeros for depth and linked expansion', () => {
    const limits = normalizeMemoryLookupLimits({
      memoryReferenceDepth: 0,
      maxMemoriesPerLookup: 5,
      maxLinkedMemoriesExpanded: 0,
    })
    assert.strictEqual(limits.maxDepth, 0)
    assert.strictEqual(limits.maxPerLookup, 5)
    assert.strictEqual(limits.maxLinkedExpansion, 0)
  })
})

describe('resolveLookupRequest', () => {
  const defaults: MemoryLookupLimits = {
    maxDepth: 3,
    maxPerLookup: 20,
    maxLinkedExpansion: 60,
  }

  it('uses defaults for empty request', () => {
    assert.deepStrictEqual(resolveLookupRequest(defaults, {}), defaults)
  })

  it('overrides with request values', () => {
    const result = resolveLookupRequest(defaults, { depth: 2, limit: 10, linkedLimit: 30 })
    assert.strictEqual(result.maxDepth, 2)
    assert.strictEqual(result.maxPerLookup, 10)
    assert.strictEqual(result.maxLinkedExpansion, 30)
  })

  it('caps at defaults maxima', () => {
    const result = resolveLookupRequest(defaults, { depth: 100, limit: 1000, linkedLimit: 5000 })
    assert.strictEqual(result.maxDepth, 3)
    assert.strictEqual(result.maxPerLookup, 20)
    assert.strictEqual(result.maxLinkedExpansion, 60)
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
    assert.strictEqual(result.entries.length, 0)
    assert.strictEqual(result.truncated, false)
    assert.strictEqual(result.expandedLinkedCount, 0)
  })

  it('traverses linked nodes by depth', () => {
    const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c'] }]
    const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 2, maxPerLookup: 20, maxLinkedExpansion: 60 }, fetchByIds)
    const ids = result.entries.map((n) => n.id)
    assert.ok(ids.includes('a'))
    assert.ok(ids.includes('b'))
    assert.ok(ids.includes('c'))
    assert.ok(ids.includes('d')) // depth 2
    assert.strictEqual(result.expandedLinkedCount, 3) // b, c, d
  })

  it('respects maxDepth', () => {
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
    const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c', 'd', 'e', 'f'] }]
    const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 3, maxPerLookup: 3, maxLinkedExpansion: 60 }, fetchByIds)
    assert.strictEqual(result.entries.length, 3)
    assert.strictEqual(result.truncated, true)
  })

  it('respects maxLinkedExpansion', () => {
    const seeds = [{ id: 'a', linkedMemoryIds: ['b', 'c', 'd', 'e', 'f'] }]
    const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 3, maxPerLookup: 20, maxLinkedExpansion: 2 }, fetchByIds)
    assert.strictEqual(result.expandedLinkedCount, 2)
    assert.strictEqual(result.truncated, true)
  })

  it('handles circular links', () => {
    const circularFetch = (ids: string[]): LinkedMemoryNode[] => {
      const map: Record<string, string[]> = { a: ['b'], b: ['a'] }
      return ids.map((id) => ({ id, linkedMemoryIds: map[id] || [] }))
    }
    const seeds = [{ id: 'a', linkedMemoryIds: ['b'] }]
    const result = traverseLinkedMemoryGraph(seeds, { maxDepth: 10, maxPerLookup: 100, maxLinkedExpansion: 100 }, circularFetch)
    assert.strictEqual(result.entries.length, 2) // just a and b
    assert.strictEqual(result.truncated, false)
  })
})