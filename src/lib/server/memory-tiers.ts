import type { MemoryEntry } from '@/types'

export type MemoryTier = 'working' | 'durable' | 'archive'

const WORKING_CATEGORIES = new Set(['execution', 'working', 'scratch', 'breadcrumb'])
const ARCHIVE_CATEGORIES = new Set(['session_archive'])

export function getMemoryTierForCategory(category: unknown): MemoryTier {
  const normalized = typeof category === 'string' ? category.trim().toLowerCase() : ''
  if (ARCHIVE_CATEGORIES.has(normalized)) return 'archive'
  if (WORKING_CATEGORIES.has(normalized)) return 'working'
  return 'durable'
}

export function getMemoryTier(entry: Pick<MemoryEntry, 'category' | 'metadata'>): MemoryTier {
  const metadataTier = typeof entry.metadata?.tier === 'string' ? entry.metadata.tier.trim().toLowerCase() : ''
  if (metadataTier === 'archive' || metadataTier === 'session_archive') return 'archive'
  if (metadataTier === 'working') return 'working'
  if (metadataTier === 'durable') return 'durable'
  return getMemoryTierForCategory(entry.category)
}

export function partitionMemoriesByTier<T extends Pick<MemoryEntry, 'category' | 'metadata'>>(entries: T[]) {
  const working: T[] = []
  const durable: T[] = []
  const archive: T[] = []

  for (const entry of entries) {
    const tier = getMemoryTier(entry)
    if (tier === 'working') working.push(entry)
    else if (tier === 'archive') archive.push(entry)
    else durable.push(entry)
  }

  return { working, durable, archive }
}

export function isWorkingMemoryCategory(category: unknown): boolean {
  return getMemoryTierForCategory(category) === 'working'
}
