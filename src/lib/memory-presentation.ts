import type { MemoryEntry } from '@/types'

export type MemoryTier = 'working' | 'durable' | 'archive'
export type MemoryScopeBadge = 'global' | 'agent' | 'shared' | 'session' | 'project'

const WORKING_CATEGORIES = new Set(['execution', 'working', 'scratch', 'breadcrumb'])
const ARCHIVE_CATEGORIES = new Set(['session_archive'])

function hasProjectRoot(entry: Pick<MemoryEntry, 'metadata' | 'references' | 'filePaths'>): boolean {
  const metadataRoot = typeof entry.metadata?.projectRoot === 'string' ? entry.metadata.projectRoot.trim() : ''
  if (metadataRoot) return true

  if (Array.isArray(entry.references)) {
    for (const ref of entry.references) {
      if (typeof ref.projectRoot === 'string' && ref.projectRoot.trim()) return true
      if ((ref.type === 'project' || ref.type === 'folder' || ref.type === 'file') && typeof ref.path === 'string' && ref.path.trim()) {
        return true
      }
    }
  }

  if (Array.isArray(entry.filePaths)) {
    for (const ref of entry.filePaths) {
      if (typeof ref.projectRoot === 'string' && ref.projectRoot.trim()) return true
      if (typeof ref.path === 'string' && ref.path.trim()) return true
    }
  }

  return false
}

export function getMemoryTierForCategory(category: unknown): MemoryTier {
  const normalized = typeof category === 'string' ? category.trim().toLowerCase() : ''
  if (ARCHIVE_CATEGORIES.has(normalized)) return 'archive'
  if (WORKING_CATEGORIES.has(normalized)) return 'working'
  return 'durable'
}

export function getMemoryTier(entry: Pick<MemoryEntry, 'category' | 'metadata'>): MemoryTier {
  const metadataTier = typeof entry.metadata?.tier === 'string' ? entry.metadata.tier.trim().toLowerCase() : ''
  if (metadataTier === 'working' || metadataTier === 'durable' || metadataTier === 'archive') {
    return metadataTier
  }
  if (metadataTier === 'session_archive') return 'archive'
  return getMemoryTierForCategory(entry.category)
}

export function deriveMemoryScope(entry: Pick<MemoryEntry, 'agentId' | 'sessionId' | 'sharedWith' | 'metadata' | 'references' | 'filePaths'>): MemoryScopeBadge {
  if (entry.sessionId) return 'session'
  if (hasProjectRoot(entry)) return 'project'
  if (entry.agentId && Array.isArray(entry.sharedWith) && entry.sharedWith.length > 0) return 'shared'
  if (entry.agentId) return 'agent'
  return 'global'
}

export function getMemoryScopeLabel(scope: MemoryScopeBadge): string {
  if (scope === 'agent') return 'private'
  return scope
}
