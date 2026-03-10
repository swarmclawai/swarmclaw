export const DEFAULT_MEMORY_REFERENCE_DEPTH = 3
export const DEFAULT_MAX_MEMORIES_PER_LOOKUP = 20
export const DEFAULT_MAX_LINKED_MEMORIES_EXPANDED = 60

const MAX_MEMORY_REFERENCE_DEPTH = 12
const MAX_MEMORIES_PER_LOOKUP = 200
const MAX_LINKED_MEMORIES_EXPANDED = 1000

export interface MemoryLookupLimits {
  maxDepth: number
  maxPerLookup: number
  maxLinkedExpansion: number
}

export interface MemoryLookupRequest {
  depth?: number | null
  limit?: number | null
  linkedLimit?: number | null
}

export interface LinkedMemoryNode {
  id: string
  linkedMemoryIds?: string[]
}

export interface TraversalResult<TNode extends LinkedMemoryNode> {
  entries: TNode[]
  truncated: boolean
  expandedLinkedCount: number
}

function parseIntSetting(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return Math.trunc(parsed)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function normalizeMemoryLookupLimits(settings: Record<string, unknown>): MemoryLookupLimits {
  const depthRaw = parseIntSetting(settings.memoryReferenceDepth ?? settings.memoryMaxDepth)
  const perLookupRaw = parseIntSetting(settings.maxMemoriesPerLookup ?? settings.memoryMaxPerLookup)
  const linkedRaw = parseIntSetting(settings.maxLinkedMemoriesExpanded)

  const maxDepth = clamp(depthRaw ?? DEFAULT_MEMORY_REFERENCE_DEPTH, 0, MAX_MEMORY_REFERENCE_DEPTH)
  const maxPerLookup = clamp(perLookupRaw ?? DEFAULT_MAX_MEMORIES_PER_LOOKUP, 1, MAX_MEMORIES_PER_LOOKUP)
  const maxLinkedExpansion = clamp(linkedRaw ?? DEFAULT_MAX_LINKED_MEMORIES_EXPANDED, 0, MAX_LINKED_MEMORIES_EXPANDED)

  return { maxDepth, maxPerLookup, maxLinkedExpansion }
}

export function resolveLookupRequest(
  defaults: MemoryLookupLimits,
  request: MemoryLookupRequest = {},
): MemoryLookupLimits {
  const depth = parseIntSetting(request.depth)
  const limit = parseIntSetting(request.limit)
  const linkedLimit = parseIntSetting(request.linkedLimit)

  return {
    maxDepth: clamp(depth ?? defaults.maxDepth, 0, defaults.maxDepth),
    maxPerLookup: clamp(limit ?? defaults.maxPerLookup, 1, defaults.maxPerLookup),
    maxLinkedExpansion: clamp(linkedLimit ?? defaults.maxLinkedExpansion, 0, defaults.maxLinkedExpansion),
  }
}

export function normalizeLinkedMemoryIds(input: unknown, selfId?: string): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || id === selfId || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function traverseLinkedMemoryGraph<TNode extends LinkedMemoryNode>(
  seedNodes: TNode[],
  opts: MemoryLookupLimits,
  fetchByIds: (ids: string[]) => TNode[],
): TraversalResult<TNode> {
  if (!seedNodes.length || opts.maxPerLookup <= 0) {
    return { entries: [], truncated: false, expandedLinkedCount: 0 }
  }

  const seen = new Set<string>()
  const seedIds = new Set(seedNodes.map((n) => n.id))
  const out: TNode[] = []
  let queue: TNode[] = [...seedNodes]
  let depth = 0
  let truncated = false
  let expandedLinkedCount = 0

  while (queue.length > 0 && depth <= opts.maxDepth) {
    const nextQueue: TNode[] = []
    for (const entry of queue) {
      if (seen.has(entry.id)) continue

      const isLinkedExpansion = !seedIds.has(entry.id)
      if (isLinkedExpansion) {
        if (expandedLinkedCount >= opts.maxLinkedExpansion) {
          truncated = true
          return { entries: out, truncated, expandedLinkedCount }
        }
        expandedLinkedCount++
      }

      seen.add(entry.id)
      out.push(entry)
      if (out.length >= opts.maxPerLookup) {
        truncated = true
        return { entries: out, truncated, expandedLinkedCount }
      }

      if (depth >= opts.maxDepth) continue
      const linkedIds = normalizeLinkedMemoryIds(entry.linkedMemoryIds, entry.id).filter((id) => !seen.has(id))
      if (!linkedIds.length) continue
      const linkedEntries = fetchByIds(linkedIds)
      for (const linked of linkedEntries) {
        if (!linked?.id || seen.has(linked.id)) continue
        nextQueue.push(linked)
      }
    }
    queue = nextQueue
    depth++
  }

  return { entries: out, truncated, expandedLinkedCount }
}
