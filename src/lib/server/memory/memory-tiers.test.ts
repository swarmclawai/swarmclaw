import test from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryEntry } from '@/types'

import { getMemoryTierForCategory, partitionMemoriesByTier, shouldHideFromDurableRecall } from '@/lib/server/memory/memory-tiers'

test('getMemoryTierForCategory treats hierarchical execution and archive categories correctly', () => {
  assert.equal(getMemoryTierForCategory('operations/execution'), 'working')
  assert.equal(getMemoryTierForCategory('operations/execution/tool-run'), 'working')
  assert.equal(getMemoryTierForCategory('working/scratch'), 'working')
  assert.equal(getMemoryTierForCategory('session_archive'), 'archive')
  assert.equal(getMemoryTierForCategory('projects/decisions'), 'durable')
})

test('partitionMemoriesByTier keeps auto execution notes out of durable memory', () => {
  const partitioned = partitionMemoriesByTier([
    { category: 'projects/decisions', metadata: undefined },
    { category: 'operations/execution', metadata: undefined },
    { category: 'session_archive', metadata: { tier: 'archive' } },
  ])

  assert.equal(partitioned.durable.length, 1)
  assert.equal(partitioned.working.length, 1)
  assert.equal(partitioned.archive.length, 1)
})

test('shouldHideFromDurableRecall hides superseded and auto-consolidated entries', () => {
  const autoConsolidatedTitle: Pick<MemoryEntry, 'title' | 'metadata'> = {
    title: '[auto-consolidated] Project Kodiak note',
    metadata: undefined,
  }
  const autoConsolidatedOrigin: Pick<MemoryEntry, 'title' | 'metadata'> = {
    title: 'Project Kodiak',
    metadata: { origin: 'auto-consolidated' },
  }
  const supersededEntry: Pick<MemoryEntry, 'title' | 'metadata'> = {
    title: 'Project Kodiak',
    metadata: { supersededBy: 'abc123' },
  }
  const canonicalEntry: Pick<MemoryEntry, 'title' | 'metadata'> = {
    title: 'Canonical project fact',
    metadata: {},
  }

  assert.equal(shouldHideFromDurableRecall({
    ...autoConsolidatedTitle,
  }), true)

  assert.equal(shouldHideFromDurableRecall({
    ...autoConsolidatedOrigin,
  }), true)

  assert.equal(shouldHideFromDurableRecall({
    ...supersededEntry,
  }), true)

  assert.equal(shouldHideFromDurableRecall({
    ...canonicalEntry,
  }), false)
})
