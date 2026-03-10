import type { MemoryEntry } from '@/types'

export type MemoryTier = 'working' | 'durable' | 'archive'

const WORKING_CATEGORIES = new Set(['execution', 'working', 'scratch', 'breadcrumb'])
const ARCHIVE_CATEGORIES = new Set(['session_archive'])

export function getMemoryTierForCategory(category: unknown): MemoryTier {
  const normalized = typeof category === 'string' ? category.trim().toLowerCase() : ''
  if (ARCHIVE_CATEGORIES.has(normalized)) return 'archive'
  if (normalized.startsWith('session_archive/')) return 'archive'
  if (normalized === 'operations/execution' || normalized.startsWith('operations/execution/')) return 'working'
  if (normalized === 'working/scratch' || normalized.startsWith('working/')) return 'working'
  if (normalized === 'execution' || normalized.startsWith('execution/')) return 'working'
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

export function shouldHideFromDurableRecall(
  entry: Pick<MemoryEntry, 'title' | 'metadata'>,
): boolean {
  const metadata = entry.metadata || {}
  const origin = typeof metadata.origin === 'string' ? metadata.origin.trim().toLowerCase() : ''
  if (origin === 'auto-consolidated') return true
  if (typeof metadata.supersededBy === 'string' && metadata.supersededBy.trim()) return true
  if (typeof metadata.supersededAt === 'number' && Number.isFinite(metadata.supersededAt)) return true
  const title = typeof entry.title === 'string' ? entry.title.trim().toLowerCase() : ''
  return title.startsWith('[auto-consolidated]')
}
