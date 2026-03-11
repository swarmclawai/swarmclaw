import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import fs from 'fs'
import { genId } from '@/lib/id'
import {
  filterMemoriesByScope,
  getMemoryDb,
  getMemoryLookupLimits,
  normalizeMemoryScopeMode,
  storeMemoryImageAsset,
  type MemoryScopeFilter,
} from '@/lib/server/memory/memory-db'
import { loadSettings } from '../storage'
import { expandQuery } from '../query-expansion'
import type { FileReference, MemoryEntry, MemoryImage, MemoryReference, Plugin, PluginHooks, Session } from '@/types'
import type { ToolBuildContext } from './context'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { getMemoryTier, partitionMemoriesByTier, shouldHideFromDurableRecall } from '@/lib/server/memory/memory-tiers'
import { syncSessionArchiveMemory } from '@/lib/server/memory/session-archive-memory'
import {
  buildMemoryDoctorReport,
  normalizeMemoryCategory,
  shouldAutoCaptureMemoryTurn,
  shouldInjectMemoryContext,
} from '@/lib/server/memory/memory-policy'

/**
 * Advanced Database-Backed Memory logic.
 */

/**
 * Lightweight in-memory cache for per-agent memory lookups (pinned + recent).
 * TTL-based with invalidation on any write operation.
 */
const MEMORY_CACHE_TTL_MS = 30_000
interface AgentMemoryCache {
  pinned: MemoryEntry[]
  allRecent: MemoryEntry[]
  cachedAt: number
}
const agentMemoryCache = new Map<string, AgentMemoryCache>()

function getCachedAgentMemories(agentId: string): AgentMemoryCache | null {
  const cached = agentMemoryCache.get(agentId)
  if (!cached) return null
  if (Date.now() - cached.cachedAt > MEMORY_CACHE_TTL_MS) {
    agentMemoryCache.delete(agentId)
    return null
  }
  return cached
}

function setCachedAgentMemories(agentId: string, pinned: MemoryEntry[], allRecent: MemoryEntry[]): void {
  agentMemoryCache.set(agentId, { pinned, allRecent, cachedAt: Date.now() })
}

function invalidateAgentMemoryCache(agentId?: string | null): void {
  if (agentId) {
    agentMemoryCache.delete(agentId)
  } else {
    agentMemoryCache.clear()
  }
}
type MemoryActionContext = Partial<Session> & {
  sessionId?: string | null
  memoryScopeMode?: string | null
  projectRoot?: string | null
}

type MemorySearchSource = 'durable' | 'working' | 'archive' | 'all'
type NarrowMemoryAction = 'search' | 'get' | 'store' | 'update'
type CanonicalMemoryCandidate = {
  entry: MemoryEntry
  score: number
  sharedTokens: number
  overlap: number
}

const MEMORY_SUBJECT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'assistant', 'current', 'details', 'fact', 'facts', 'for',
  'from', 'got', 'have', 'i', 'in', 'is', 'it', 'its', 'ive', 'memory', 'my',
  'note', 'notes', 'of', 'our', 'project', 'remember', 'stored', 'storing',
  'that', 'the', 'this', 'to', 'updated', 'updating', 'with', 'you', 'your',
])

const MEMORY_VOLATILE_STOP_WORDS = new Set([
  'april', 'august', 'corrected', 'correction', 'date', 'dates', 'december',
  'earlier', 'error', 'february', 'freeze', 'january', 'july', 'june', 'march',
  'may', 'new', 'november', 'october', 'old', 'september',
])

function isSessionContext(ctx: MemoryActionContext | null | undefined): ctx is Session {
  return !!ctx
    && typeof ctx.id === 'string'
    && typeof ctx.name === 'string'
    && Array.isArray(ctx.messages)
}

function latestUserFactFromSession(session: Session | null): string {
  if (!session || !Array.isArray(session.messages)) return ''
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]
    if (message?.role !== 'user') continue
    const text = typeof message.text === 'string' ? message.text.replace(/\s+/g, ' ').trim() : ''
    if (text) return text
  }
  return ''
}

function normalizeMemorySearchSources(raw: unknown): Set<MemorySearchSource> {
  const sources = Array.isArray(raw) ? raw : []
  const normalized = new Set<MemorySearchSource>()
  for (const entry of sources) {
    const value = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
    if (value === 'all') normalized.add('all')
    else if (value === 'durable' || value === 'working' || value === 'archive') normalized.add(value)
  }
  if (normalized.size === 0) normalized.add('durable')
  if (normalized.has('all')) return new Set<MemorySearchSource>(['all'])
  return normalized
}

function parseStructuredMemoryRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function normalizeStructuredMemoryArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...raw }
  for (const key of ['value', 'query', 'key', 'input', 'data', 'payload', 'parameters'] as const) {
    const parsed = parseStructuredMemoryRecord(normalized[key])
    if (!parsed) continue
    for (const [nestedKey, nestedValue] of Object.entries(parsed)) {
      if (normalized[nestedKey] === undefined || normalized[nestedKey] === null || normalized[nestedKey] === '') {
        normalized[nestedKey] = nestedValue
      }
    }
    if ((normalized.value === undefined || normalized.value === null || normalized.value === '')
      && typeof parsed.content === 'string') {
      normalized.value = parsed.content
    }
    if ((normalized.title === undefined || normalized.title === null || normalized.title === '')
      && typeof parsed.name === 'string') {
      normalized.title = parsed.name
    }
  }
  if (normalized.value === undefined || normalized.value === null || normalized.value === '') {
    for (const alias of ['content', 'note', 'body', 'text', 'memory'] as const) {
      if (typeof normalized[alias] === 'string' && normalized[alias].trim()) {
        normalized.value = normalized[alias]
        break
      }
    }
  }
  return normalized
}

function filterResultsBySources(entries: MemoryEntry[], sources: Set<MemorySearchSource>): MemoryEntry[] {
  if (sources.has('all')) return entries
  return entries.filter((entry) => {
    const tier = getMemoryTier(entry)
    if (!sources.has(tier)) return false
    if (tier === 'durable' && shouldHideFromDurableRecall(entry)) return false
    return true
  })
}

function normalizeMemoryText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s:/.-]/g, '')
    .trim()
}

function buildNamedMemoryActionArgs(
  action: NarrowMemoryAction,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { ...args, action }
}

function executeNamedMemoryAction(
  action: NarrowMemoryAction,
  args: Record<string, unknown>,
  context: { session?: MemoryActionContext | null } | null | undefined,
) {
  return executeMemoryAction(
    buildNamedMemoryActionArgs(action, normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)),
    context?.session,
  )
}

function stripGeneratedMemoryPrefix(value: string): string {
  return value.replace(/^\[(?:auto|auto-consolidated)[^\]]*\]\s*/i, '').trim()
}

function tokenizeMemorySubject(value: string): string[] {
  const tokens = normalizeMemoryText(value).match(/[a-z0-9][a-z0-9._:/-]*/g) || []
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.length < 3) continue
    if (/^\d+$/.test(token)) continue
    if (MEMORY_SUBJECT_STOP_WORDS.has(token)) continue
    if (MEMORY_VOLATILE_STOP_WORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

function isMeaningfulMemoryTitle(title: string): boolean {
  const normalized = stripGeneratedMemoryPrefix(title).trim()
  if (!normalized) return false
  if (normalizeMemoryText(normalized) === 'untitled') return false
  return tokenizeMemorySubject(normalized).length > 0
}

function buildMemorySubjectKey(title: string, content: string): string | null {
  const titleTokens = tokenizeMemorySubject(stripGeneratedMemoryPrefix(title))
  const contentTokens = tokenizeMemorySubject(content)
  const preferred = [...titleTokens, ...contentTokens]
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of preferred) {
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= 4) break
  }
  return out.length >= 2 ? out.join('|') : null
}

function mergeMemoryMetadata(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...(base || {}), ...patch }
  if (!next.tier || next.tier === 'durable') delete next.tier
  if (!next.origin) delete next.origin
  if (!next.subjectKey) delete next.subjectKey
  if (!next.supersededBy) delete next.supersededBy
  if (!next.supersededReason) delete next.supersededReason
  if (!next.supersededAt) delete next.supersededAt
  return next
}

function selectCanonicalMemoryCandidates(args: {
  memDb: ReturnType<typeof getMemoryDb>
  agentId: string | null
  title: string
  content: string
  canReadMemory: (entry: MemoryEntry) => boolean
  canMutateMemory: (entry: MemoryEntry) => boolean
  scopeFilter: MemoryScopeFilter
}): CanonicalMemoryCandidate[] {
  if (!args.agentId) return []
  const desiredTitle = stripGeneratedMemoryPrefix(args.title)
  const desiredText = [isMeaningfulMemoryTitle(desiredTitle) ? desiredTitle : '', args.content]
    .filter(Boolean)
    .join('\n')
    .trim()
  const desiredTokens = tokenizeMemorySubject(desiredText)
  if (desiredTokens.length < 2) return []
  const desiredTitleNorm = normalizeMemoryText(desiredTitle)
  const desiredSubjectKey = buildMemorySubjectKey(desiredTitle, args.content)
  const candidateQuery = [desiredTitle, args.content].filter(Boolean).join(' ').slice(0, 400)
  const merged = new Map<string, MemoryEntry>()
  const sources = [
    ...(candidateQuery
      ? args.memDb.search(candidateQuery, args.agentId, { scope: args.scopeFilter, rerankMode: 'balanced' })
      : []),
    ...args.memDb.list(args.agentId, 80),
  ]
  for (const entry of sources) {
    if (merged.has(entry.id)) continue
    if (!args.canReadMemory(entry) || !args.canMutateMemory(entry)) continue
    if (getMemoryTier(entry) !== 'durable') continue
    if (shouldHideFromDurableRecall(entry)) continue
    merged.set(entry.id, entry)
  }

  const matches: CanonicalMemoryCandidate[] = []
  for (const entry of merged.values()) {
    const entryTitle = stripGeneratedMemoryPrefix(entry.title || '')
    const entryTitleNorm = normalizeMemoryText(entryTitle)
    const entryTokens = tokenizeMemorySubject([entryTitle, entry.content || ''].join('\n'))
    if (!entryTokens.length) continue
    const shared = desiredTokens.filter((token) => entryTokens.includes(token)).length
    const overlap = shared / Math.max(1, Math.min(desiredTokens.length, entryTokens.length))
    const entrySubjectKey = typeof entry.metadata?.subjectKey === 'string' && entry.metadata.subjectKey.trim()
      ? entry.metadata.subjectKey.trim()
      : buildMemorySubjectKey(entryTitle, entry.content || '')
    const titleExact = isMeaningfulMemoryTitle(desiredTitle) && desiredTitleNorm === entryTitleNorm
    const subjectKeyMatch = Boolean(desiredSubjectKey && entrySubjectKey && desiredSubjectKey === entrySubjectKey)
    const score = overlap
      + (shared * 0.12)
      + (titleExact ? 1.5 : 0)
      + (subjectKeyMatch ? 0.9 : 0)
      + (entry.category.startsWith('projects/') || entry.category.startsWith('knowledge/') ? 0.08 : 0)
    const confident = titleExact
      || subjectKeyMatch
      || (shared >= 3 && overlap >= 0.5)
      || (shared >= 2 && overlap >= 0.72)
    if (!confident) continue
    matches.push({ entry, score, sharedTokens: shared, overlap })
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return (right.entry.updatedAt || 0) - (left.entry.updatedAt || 0)
  })
  return matches
}

export function shouldAutoCaptureAutonomousTurn(ctx: {
  source: string
  response: string
  toolEvents?: Array<{ name?: string }>
}): boolean {
  if (!ctx.source || ctx.source === 'chat' || ctx.source === 'connector') return false
  const response = (ctx.response || '').trim()
  if (response.length < 60) return false
  if (/^(?:HEARTBEAT_OK|NO_MESSAGE)\b/i.test(response)) return false
  const toolEvents = Array.isArray(ctx.toolEvents) ? ctx.toolEvents : []
  return toolEvents.some((event) => typeof event?.name === 'string' && event.name.trim().length > 0)
}

export async function executeMemoryAction(input: unknown, ctx: MemoryActionContext | null | undefined) {
  const normalized = normalizeStructuredMemoryArgs(
    normalizeToolInputArgs((input ?? {}) as Record<string, unknown>),
  )
  const n = normalized as Record<string, unknown>
  const {
    action, key, value, query, scope, rerank,
    scopeSessionId, projectRoot, filePaths, references, project,
    linkedMemoryIds, targetIds,
    pinned, sharedWith,
  } = n
  const actionText = typeof action === 'string' ? action.trim() : ''
  const keyText = typeof key === 'string' ? key.trim() : ''
  const hasValueText = typeof value === 'string'
  const valueText = hasValueText ? value : ''
  const queryText = typeof query === 'string' ? query : ''
  const requestedCategory = typeof n.category === 'string' && n.category.trim()
    ? n.category.trim()
    : undefined
  const normalizedLinkedMemoryIds = Array.isArray(linkedMemoryIds)
    ? linkedMemoryIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined
  const resolvedAction = actionText || 'list'
  const explicitMemoryId = typeof n.id === 'string' && n.id.trim()
    ? n.id.trim()
    : ''
  const memoryId = explicitMemoryId
    ? explicitMemoryId
    : keyText
      ? keyText
      : ''
  const memoryTitle = typeof n.title === 'string' && n.title.trim()
    ? n.title.trim()
    : keyText
      ? keyText
      : 'Untitled'
  const imagePath = typeof n.imagePath === 'string' ? n.imagePath : undefined
  
  const memDb = getMemoryDb()
  const currentAgentId = ctx?.agentId || null
  const currentSessionId = typeof ctx?.sessionId === 'string'
    ? ctx.sessionId
    : typeof ctx?.id === 'string'
      ? ctx.id
      : null
  const currentSession = isSessionContext(ctx) ? ctx : null
  const configuredScope = typeof ctx?.memoryScopeMode === 'string' ? ctx.memoryScopeMode : 'auto'
  const rawScope = typeof scope === 'string' ? scope : configuredScope
  const scopeMode = normalizeMemoryScopeMode(rawScope === 'shared' ? 'global' : rawScope)
  const rerankMode = rerank === 'semantic' || rerank === 'lexical' ? rerank : 'balanced'
  
  const scopeFilter: MemoryScopeFilter = {
    mode: scopeMode,
    agentId: currentAgentId,
    sessionId: (typeof scopeSessionId === 'string' && scopeSessionId.trim()) ? scopeSessionId.trim() : currentSessionId,
    projectRoot: (typeof projectRoot === 'string' && projectRoot.trim())
      ? projectRoot.trim()
      : ((project && typeof project === 'object' && 'rootPath' in project && typeof (project as Record<string, unknown>).rootPath === 'string')
          ? (project as Record<string, unknown>).rootPath as string
          : (typeof ctx?.projectRoot === 'string' && ctx.projectRoot.trim() ? ctx.projectRoot.trim() : null)),
  }
  
  const filterScope = (rows: MemoryEntry[]) => filterMemoriesByScope(rows, scopeFilter)
  const canReadMemory = (m: MemoryEntry) => filterScope([m]).length > 0
  const canMutateMemory = (m: MemoryEntry) => !m?.agentId || m.agentId === currentAgentId

  const limits = getMemoryLookupLimits(loadSettings())
  const maxPerLookup = limits.maxPerLookup
  const searchSources = normalizeMemorySearchSources(n.sources)
  const inputMetadata = n.metadata && typeof n.metadata === 'object' && !Array.isArray(n.metadata)
    ? { ...(n.metadata as Record<string, unknown>) }
    : {}
  if (scopeMode === 'project' && scopeFilter.projectRoot && !inputMetadata.projectRoot) {
    inputMetadata.projectRoot = scopeFilter.projectRoot
  }

  const buildCanonicalMetadata = (title: string, content: string, extra?: Record<string, unknown>) => {
    const subjectKey = buildMemorySubjectKey(title, content)
    return mergeMemoryMetadata(inputMetadata, {
      ...extra,
      subjectKey: subjectKey || undefined,
      tier: extra?.tier,
      supersededBy: extra?.supersededBy,
      supersededReason: extra?.supersededReason,
      supersededAt: extra?.supersededAt,
    })
  }

  const findRelatedCanonicalCandidates = (title: string, content: string) => selectCanonicalMemoryCandidates({
    memDb,
    agentId: currentAgentId,
    title,
    content,
    canReadMemory,
    canMutateMemory,
    scopeFilter,
  })

  const supersedeCompetingMemories = (targetId: string, title: string, content: string, related: CanonicalMemoryCandidate[]) => {
    const subjectKey = buildMemorySubjectKey(title, content)
    const seen = new Set<string>()
    for (const candidate of related) {
      const entry = candidate.entry
      if (entry.id === targetId || seen.has(entry.id)) continue
      seen.add(entry.id)
      const nextMetadata = mergeMemoryMetadata(entry.metadata, {
        subjectKey: subjectKey || undefined,
        supersededBy: targetId,
        supersededReason: 'canonical-upsert',
        supersededAt: Date.now(),
        tier: 'working',
      })
      memDb.update(entry.id, {
        metadata: nextMetadata,
      })
    }
  }

  if ((resolvedAction === 'search' || resolvedAction === 'list') && currentSession && (searchSources.has('archive') || searchSources.has('all'))) {
    try { syncSessionArchiveMemory(currentSession) } catch { /* archive sync is best-effort */ }
  }

  const formatEntry = (m: MemoryEntry) => {
    let line = `[${m.id}] (${m.agentId ? `agent:${m.agentId}` : 'shared'}) ${m.category}/${m.title}: ${m.content}`
    if (m.reinforcementCount) line += ` (reinforced ×${m.reinforcementCount})`
    if (m.references?.length) {
      line += `\n  refs: ${m.references.map((r: MemoryReference) => `${r.type}:${r.path || r.title || r.type}`).join(', ')}`
    }
    if (m.imagePath) line += `\n  image: ${m.imagePath}`
    if (m.linkedMemoryIds?.length) line += `\n  linked: ${m.linkedMemoryIds.join(', ')}`
    return line
  }

  if (resolvedAction === 'store') {
    const fallbackValueText = latestUserFactFromSession(currentSession)
    const storedValueText = hasValueText && valueText.trim()
      ? valueText
      : fallbackValueText
    if (!storedValueText.trim()) {
      return 'Error: memory_store requires a non-empty value and is only for remembering user facts/preferences. If you need to create a file, write code, or export data, use the `files` tool instead: files({action:"write", files:[{path:"path/to/file", content:"..."}]})'
    }
    let storedImage: MemoryImage | null = null
    if (imagePath && fs.existsSync(imagePath)) {
      storedImage = await storeMemoryImageAsset(imagePath, genId(6))
    }
    const normalizedCategory = normalizeMemoryCategory(requestedCategory || 'note', memoryTitle, storedValueText)
    const related = findRelatedCanonicalCandidates(memoryTitle, storedValueText)
    const canonicalTarget = related[0]?.entry || null
    const canonicalMetadata = buildCanonicalMetadata(memoryTitle, storedValueText)
    if (canonicalTarget) {
      const updated = memDb.update(canonicalTarget.id, {
        title: memoryTitle,
        content: storedValueText,
        category: normalizedCategory,
        metadata: mergeMemoryMetadata(canonicalTarget.metadata, canonicalMetadata),
        references: Array.isArray(references) ? references as MemoryReference[] : canonicalTarget.references,
        filePaths: Array.isArray(filePaths) ? filePaths as FileReference[] : canonicalTarget.filePaths,
        imagePath: storedImage?.path || canonicalTarget.imagePath,
        linkedMemoryIds: normalizedLinkedMemoryIds || canonicalTarget.linkedMemoryIds,
        pinned: typeof pinned === 'boolean' ? pinned : canonicalTarget.pinned,
        sharedWith: Array.isArray(sharedWith) ? sharedWith : canonicalTarget.sharedWith,
      })
      if (updated) {
        supersedeCompetingMemories(updated.id, memoryTitle, storedValueText, related)
        invalidateAgentMemoryCache(currentAgentId)
        return `Stored memory "${updated.title}" (id: ${updated.id}) in ${normalizedCategory} by updating the canonical entry. No further memory lookup is needed unless the user asked you to verify.`
      }
    }
    const entry = memDb.add({
      agentId: scopeMode === 'global' ? null : currentAgentId,
      sessionId: ctx?.sessionId || null,
      category: normalizedCategory,
      title: memoryTitle,
      content: storedValueText,
      metadata: canonicalMetadata,
      references: Array.isArray(references) ? references as MemoryReference[] : [],
      filePaths: Array.isArray(filePaths) ? filePaths as FileReference[] : undefined,
      imagePath: storedImage?.path || undefined,
      linkedMemoryIds: normalizedLinkedMemoryIds,
      pinned: pinned === true,
      sharedWith: Array.isArray(sharedWith) ? sharedWith : undefined,
    })
    invalidateAgentMemoryCache(currentAgentId)
    return `Stored memory "${entry.title}" (id: ${entry.id}) in ${normalizedCategory}. No further memory lookup is needed unless the user asked you to verify.`
  }

  if (resolvedAction === 'get') {
    const found = memDb.get(memoryId)
    if (!found || !canReadMemory(found)) return `Memory not found or access denied: ${memoryId}`
    return formatEntry(found)
  }

  if (resolvedAction === 'search') {
    const queries = queryText ? await expandQuery(queryText) : [keyText]
    const allResults: MemoryEntry[] = []
    const seenIds = new Set<string>()
    for (const q of queries) {
      const results = memDb.search(q, currentAgentId || undefined, { scope: scopeFilter, rerankMode })
      for (const r of results) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id); allResults.push(r)
        }
      }
    }
    const scopedResults = filterResultsBySources(allResults, searchSources)
    const visibleResults = scopedResults.length ? scopedResults : allResults
    if (!visibleResults.length) return 'No memories found.'
    return visibleResults.slice(0, maxPerLookup).map(formatEntry).join('\n')
  }

  if (resolvedAction === 'list') {
    const results = filterScope(memDb.list(undefined, maxPerLookup))
    const scopedResults = filterResultsBySources(results, searchSources)
    const visibleResults = scopedResults.length ? scopedResults : results
    return visibleResults.length ? visibleResults.map(formatEntry).join('\n') : 'No memories stored yet.'
  }

  if (resolvedAction === 'delete') {
    const found = memDb.get(memoryId)
    if (!found || !canMutateMemory(found)) return 'Memory not found or access denied.'
    memDb.delete(memoryId)
    invalidateAgentMemoryCache(currentAgentId)
    return `Deleted memory "${memoryId}"`
  }

  if (resolvedAction === 'update') {
    const exact = memoryId ? memDb.get(memoryId) : null
    const nextTitleSeed = typeof n.title === 'string' && n.title.trim()
      ? n.title.trim()
      : keyText
        ? keyText
        : exact?.title || memoryTitle
    const nextContentSeed = hasValueText && valueText.trim()
      ? valueText
      : queryText.trim()
        ? queryText.trim()
        : exact?.content || ''
    const related = findRelatedCanonicalCandidates(nextTitleSeed, nextContentSeed)
    const found = exact && canMutateMemory(exact)
      ? exact
      : related[0]?.entry || null
    if (!found) {
      if (explicitMemoryId) return 'Memory not found or access denied.'
      if (!nextContentSeed.trim()) return 'Memory update requires id, key, title, or query.'
      const normalizedCategory = normalizeMemoryCategory(requestedCategory || 'note', nextTitleSeed, nextContentSeed)
      const created = memDb.add({
        agentId: scopeMode === 'global' ? null : currentAgentId,
        sessionId: ctx?.sessionId || null,
        category: normalizedCategory,
        title: nextTitleSeed,
        content: nextContentSeed,
        metadata: buildCanonicalMetadata(nextTitleSeed, nextContentSeed),
        references: Array.isArray(references) ? references as MemoryReference[] : [],
        filePaths: Array.isArray(filePaths) ? filePaths as FileReference[] : undefined,
        linkedMemoryIds: normalizedLinkedMemoryIds,
        pinned: pinned === true,
        sharedWith: Array.isArray(sharedWith) ? sharedWith : undefined,
      })
      invalidateAgentMemoryCache(currentAgentId)
      return `Updated memory "${created.title}" (id: ${created.id}) by creating a new canonical entry. No further memory lookup is needed unless the user asked you to verify.`
    }
    const nextTitle = typeof n.title === 'string' && n.title.trim() ? n.title.trim() : found.title
    const nextContent = hasValueText && valueText.trim() ? valueText : found.content
    const updates: Partial<MemoryEntry> = {
      title: nextTitle,
      content: nextContent,
      category: requestedCategory
        ? normalizeMemoryCategory(requestedCategory, nextTitle, nextContent)
        : found.category,
      metadata: mergeMemoryMetadata(found.metadata, buildCanonicalMetadata(nextTitle, nextContent)),
    }
    if (normalizedLinkedMemoryIds) updates.linkedMemoryIds = normalizedLinkedMemoryIds
    if (Array.isArray(sharedWith)) updates.sharedWith = sharedWith
    if (typeof pinned === 'boolean') updates.pinned = pinned
    if (Array.isArray(references)) updates.references = references as MemoryReference[]
    if (Array.isArray(filePaths)) updates.filePaths = filePaths as FileReference[]
    const updated = memDb.update(found.id, updates)
    if (!updated) return `Memory not found: ${memoryId}`
    supersedeCompetingMemories(updated.id, nextTitle, nextContent, related)
    invalidateAgentMemoryCache(currentAgentId)
    return `Updated memory "${updated.title}" (id: ${updated.id}). No further memory lookup is needed unless the user asked you to verify.`
  }

  if (resolvedAction === 'link' || resolvedAction === 'unlink') {
    if (!memoryId) return `Memory ${resolvedAction} requires id or key.`
    const found = memDb.get(memoryId)
    if (!found || !canMutateMemory(found)) return 'Memory not found or access denied.'
    const ids = Array.isArray(targetIds)
      ? targetIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : []
    if (ids.length === 0) return `${resolvedAction} requires targetIds.`
    const updated = resolvedAction === 'link'
      ? memDb.link(memoryId, ids, true)
      : memDb.unlink(memoryId, ids, true)
    if (!updated) return `Memory not found: ${memoryId}`
    invalidateAgentMemoryCache(currentAgentId)
    return `${resolvedAction === 'link' ? 'Linked' : 'Unlinked'} ${ids.length} memories for "${updated.title}" (id: ${updated.id})`
  }

  if (resolvedAction === 'doctor') {
    const visible = filterScope(memDb.list(undefined, maxPerLookup))
    return buildMemoryDoctorReport(visible, currentAgentId)
  }

  return `Unknown action "${resolvedAction}".`
}

/**
 * Register as a Built-in Plugin
 */
const MemoryPlugin: Plugin = {
  name: 'Core Memory',
  description: 'Advanced database-backed long-term memory with semantic search and graph linking.',
  hooks: {
    getAgentContext: async (ctx) => {
      const agentId = ctx.session.agentId
      if (!agentId) return null

      // QMD scope: identity/* memories and contact resolution are private (DM/peer only).
      // Group channels, threads, and shared "main" sessions don't see them.
      const connCtx = ctx.session.connectorContext
      const isPrivateContext = !connCtx || !connCtx.isGroup

      const memDb = getMemoryDb()
      const seen = new Set<string>()
      const formatMemoryLine = (m: { category?: string; title?: string; content?: string; pinned?: boolean }) => {
        const category = String(m.category || 'note')
        const title = String(m.title || 'Untitled').replace(/\s+/g, ' ').trim()
        const snippet = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 220)
        const pin = m.pinned ? ' [pinned]' : ''
        return `- [${category}]${pin} ${title}: ${snippet}`
      }
      const dedup = (m: MemoryEntry): boolean => {
        if (!m?.id || seen.has(m.id)) return false
        if (shouldHideFromDurableRecall(m)) return false
        seen.add(m.id)
        return true
      }

      // --- Always-on: pinned + identity memories (bypass shouldInjectMemoryContext gate) ---
      const cached = getCachedAgentMemories(agentId)
      const pinned = cached?.pinned ?? memDb.listPinned(agentId, 5)
      const allRecent = cached?.allRecent ?? memDb.list(agentId, 100)
      if (!cached) setCachedAgentMemories(agentId, pinned, allRecent)

      const pinnedLines = pinned.filter(dedup).map(formatMemoryLine)

      // Fetch identity/* category memories — only in private (DM/peer) contexts
      const identityMemories = isPrivateContext
        ? allRecent.filter((m) => m.category?.startsWith('identity/') && dedup(m))
        : []
      const identityLines = identityMemories.map(formatMemoryLine)

      // --- Contact resolution for connector messages (private contexts only) ---
      const lastUserMsg = [...ctx.history].reverse().find((m) => m.role === 'user')
      const senderName = lastUserMsg?.source?.senderName || connCtx?.senderName || null

      let contactBlock = ''
      let resolvedContactName: string | null = null
      if (isPrivateContext && connCtx) {
        // Collect all possible identifiers for the sender (senderId, senderIdAlt, channelId, etc.)
        const rawSenderIds = [
          lastUserMsg?.source?.senderId,
          connCtx.senderId,
          connCtx.senderIdAlt,
          connCtx.channelId,
          connCtx.channelIdAlt,
          ...(connCtx.allKnownPeerIds || []),
        ].filter((v): v is string => typeof v === 'string' && v.length > 0)

        // Normalize a phone string to bare trailing digits for suffix matching.
        // Handles: "+44 76 2422 8104", "076 2422 8104", "447624228104@s.whatsapp.net", LIDs, etc.
        // UK local numbers starting with 0 are converted to 44 prefix.
        const toDigits = (raw: string): string => {
          const stripped = raw.replace(/@.*$/, '').replace(/[^\d]/g, '')
          if (stripped.startsWith('0') && stripped.length >= 10) return '44' + stripped.slice(1)
          return stripped
        }

        // Build a set of digit-strings from the sender's identifiers
        const senderDigits = new Set(
          rawSenderIds
            .map(toDigits)
            .filter((d) => d.length >= 6),
        )

        if (senderDigits.size > 0 || senderName) {
          const extractPhoneDigits = (text: string): string[] => {
            const matches = text.match(/(?:\+?\d[\d\s\-().]{6,}\d)/g) || []
            return matches.map(toDigits).filter((d) => d.length >= 6)
          }

          const contactHits = allRecent.filter((m) => {
            if (m.category !== 'identity/contacts' && m.category !== 'identity/relationships') return false
            const content = (m.content || '').toLowerCase()
            const title = (m.title || '').toLowerCase()
            for (const rawId of rawSenderIds) {
              const rid = rawId.toLowerCase()
              if (content.includes(rid) || title.includes(rid)) return true
            }
            const memoryPhones = extractPhoneDigits(m.content || '')
            const metaIds = (() => {
              const meta = m.metadata as Record<string, unknown> | undefined
              return Array.isArray(meta?.identifiers) ? (meta.identifiers as string[]).map(toDigits) : []
            })()
            const allMemDigits = [...memoryPhones, ...metaIds]
            for (const memDigit of allMemDigits) {
              for (const senderDigit of senderDigits) {
                if (senderDigit.endsWith(memDigit) || memDigit.endsWith(senderDigit)) return true
              }
            }
            return false
          })
          if (contactHits.length) {
            const contact = contactHits[0]
            const displayId = rawSenderIds[0] || senderName || 'unknown'
            resolvedContactName = contact.title || null
            contactBlock = [
              '## Known Sender',
              `The current sender (${displayId}${senderName ? `, name: ${senderName}` : ''}) is: ${contact.title}`,
              contact.content || '',
            ].join('\n')
          }
        }
      }

      // --- Relevance-based search (gated on message quality) ---
      let relevantLines: string[] = []
      let recentLines: string[] = []
      if (shouldInjectMemoryContext(ctx.message || '')) {
        // Prepend resolved contact name so person-specific memories rank higher
        const contactQueryHint = resolvedContactName || senderName || ''
        const memoryQuerySeed = [
          contactQueryHint,
          ctx.message,
          ...ctx.history
            .slice(-4)
            .filter((h) => h.role === 'user')
            .map((h) => h.text),
        ].join('\n')

        const relevantSlice = Math.max(2, 6 - pinnedLines.length)
        const relevantLookup = memDb.searchWithLinked(memoryQuerySeed, agentId, 1, 10, 14)
        const recent = memDb.list(agentId, 12).slice(0, 6)
        const relevantByTier = partitionMemoriesByTier(relevantLookup.entries)
        const recentByTier = partitionMemoriesByTier(recent)

        relevantLines = relevantByTier.durable
          .filter(dedup)
          .slice(0, relevantSlice)
          .map(formatMemoryLine)

        recentLines = recentByTier.durable
          .filter(dedup)
          .map(formatMemoryLine)
      }

      const parts: string[] = []
      if (contactBlock) {
        parts.push(contactBlock)
      }
      if (pinnedLines.length) {
        parts.push(['## Pinned Memories', 'Always-loaded memories marked as important.', ...pinnedLines].join('\n'))
      }
      if (identityLines.length) {
        parts.push(['## Identity & Preferences', 'Always-loaded identity memories (preferences, relationships, contacts).', ...identityLines].join('\n'))
      }
      if (relevantLines.length) {
        parts.push(['## Relevant Memory Hits', 'These memories were retrieved by relevance for the current objective.', ...relevantLines].join('\n'))
      }
      if (recentLines.length) {
        parts.push(['## Recent Memory Notes', 'Recent durable notes that may still apply.', ...recentLines].join('\n'))
      }

      // Memory Policy
      parts.push([
        '## My Memory',
        'I have long-term memory that persists across conversations. I use it when the user asks me to remember something or when I need to recall past conversations.',
        'Memory tiers: working memory is short-lived, durable memory stores stable facts and decisions, and session archives are available separately when explicitly needed.',
        '',
        '**Things worth remembering:**',
        '- What the user likes, dislikes, or has corrected me on',
        '- Important decisions, outcomes, and lessons learned',
        '- What I\'ve discovered about projects, codebases, or environments',
        '- Problems I\'ve hit and how I solved them',
        '- Who people are and how they relate to each other',
        '- Contact details: phone numbers, emails, platform IDs — use category "contacts"',
        '- Configuration details and environment specifics that I\'ll need again',
        '',
        '**Not worth cluttering my memory with:**',
        '- Throwaway acknowledgments or small talk',
        '- Work-in-progress that\'ll change soon (use category "working" for scratch notes)',
        '- Things already in my system prompt',
        '- Something I\'ve already stored',
        '',
        '**Categories** — pick the one that fits best when storing:',
        '- `identity/preferences` — Likes, dislikes, style choices, timezone, pronouns',
        '- `identity/relationships` — Who people are and how they relate to each other',
        '- `identity/contacts` — Phone numbers, emails, platform IDs for matching senders',
        '- `identity/routines` — Recurring patterns: "picks up kids at 3pm", "checks in every morning"',
        '- `identity/goals` — What the user is working toward: "launch MVP by Q2", "learn Spanish"',
        '- `identity/events` — Significant life events: illness, birth, wedding, promotion, loss',
        '- `knowledge/instructions` — Standing directives: "always respond in English", "use metric units"',
        '- `knowledge/facts` — General knowledge, references, documentation',
        '- `projects/decisions` — Decisions made and why',
        '- `projects/learnings` — Lessons learned, solved problems, post-mortems',
        '- `projects/context` — Project details, milestones, roadmap',
        '- `operations/environment` — Config, credentials, endpoints, infrastructure',
        '- `working/scratch` — Temporary notes that\'ll change soon',
        '',
        '**Good habits:**',
        '- Give memories clear titles ("User prefers dark mode" not "Note 1")',
        '- For contacts, store identifiers (phone, email, platform IDs) in content so I can match senders automatically',
        '- When storing something about a specific person, include their name in the title (e.g. "Wife prefers short replies") so it surfaces when they message',
        '- Store behavioral rules about a person on their contact/relationship entry rather than as separate memories',
        '- Prefer durable memories first; only inspect session archives when transcript history is specifically needed',
        '- Check what I already know before storing something new',
        '- When I learn something that corrects old knowledge, update or remove the old memory',
      ].join('\n'))

      // Pre-compaction consolidation nudge
      const msgCount = ctx.history.filter(m => m.role === 'user' || m.role === 'assistant').length
      if (msgCount > 20) {
        parts.push([
          '## Reflection & Consolidation Reminder',
          'This conversation is getting long and I might lose older context soon.',
          'Save anything important I\'ve learned, decided, or discovered to memory now. Only what matters, not every detail.',
        ].join('\n'))
      }

      return parts.join('\n\n') || null
    },
    afterToolExec: (ctx) => {
      const agentId = ctx.session.agentId
      if (!agentId) return
      const inp = ctx.input
      if (!inp || typeof inp !== 'object') return
      const action = typeof inp.action === 'string' ? inp.action : ''
      let title: string | null = null
      if (ctx.toolName === 'manage_tasks') {
        if (action === 'create') title = `Created task: ${inp.title || 'Untitled'}`
        else if (ctx.output && /status.*completed|completed.*successfully/i.test(ctx.output)) title = `Completed task: ${inp.title || inp.taskId || 'unknown'}`
      }
      if (ctx.toolName === 'manage_schedules' && action === 'create') title = `Created schedule: ${inp.name || 'Untitled'}`
      if (ctx.toolName === 'manage_agents' && action === 'create') title = `Created agent: ${inp.name || 'Untitled'}`
      if (!title) return
      try {
        const memDb = getMemoryDb()
        memDb.add({ agentId, sessionId: ctx.session.id, category: 'breadcrumb', title, content: '' })
      } catch { /* breadcrumbs are best-effort */ }
    },
    afterChatTurn: (ctx) => {
      const agentId = ctx.session.agentId
      if (!agentId) return
      const msg = (ctx.message || '').trim()
      const resp = (ctx.response || '').trim()
      const shouldCapture = ctx.internal
        ? shouldAutoCaptureAutonomousTurn(ctx)
        : ((ctx.source === 'chat' || ctx.source === 'connector') && shouldAutoCaptureMemoryTurn(msg, resp))
      if (!shouldCapture) return
      const now = Date.now()
      const last = typeof ctx.session.lastAutoMemoryAt === 'number' ? ctx.session.lastAutoMemoryAt : 0
      if (last > 0 && now - last < 5 * 60 * 1000) return
      try {
        const memDb = getMemoryDb()
        const compactMessage = msg.replace(/\s+/g, ' ').slice(0, 220)
        const compactResponse = resp.replace(/\s+/g, ' ').slice(0, 700)
        const compactToolNames = Array.isArray(ctx.toolEvents)
          ? ctx.toolEvents
            .map((event) => String(event?.name || '').trim())
            .filter(Boolean)
            .slice(0, 8)
          : []
        const autoTitleSeed = compactMessage || compactResponse
        const autoTitle = `[auto] ${autoTitleSeed.slice(0, 90)}`
        const content = [
          `source: ${ctx.source}`,
          compactToolNames.length > 0 ? `tools: ${compactToolNames.join(', ')}` : '',
          compactMessage ? `user_request: ${compactMessage}` : '',
          `assistant_outcome: ${compactResponse}`,
        ].filter(Boolean).join('\n')
        memDb.add({
          agentId,
          sessionId: ctx.session.id,
          category: normalizeMemoryCategory('execution', autoTitle, content),
          title: autoTitle,
          content,
        })
        ctx.session.lastAutoMemoryAt = now
      } catch { /* auto-memory is best-effort */ }
    },
    getCapabilityDescription: () => 'I have long-term memory (`memory_search`, `memory_get`, `memory_store`, `memory_update`, `memory_tool`) — I can remember things across conversations and recall them when needed.',
    getOperatingGuidance: () => [
      'Memory: use narrow memory tools first. For past-conversation recall, prefer `memory_search` then `memory_get`. For direct writes or corrections, prefer `memory_store` or `memory_update`. Keep `memory_tool` for list/delete/link/doctor or when you truly need the generic surface. NEVER use memory tools to create files, CSV data, code, or documents — always use the `files` tool for those.',
      'For info already in the current conversation, respond directly without calling any memory tool.',
      'For questions about prior work, decisions, dates, people, preferences, or todos from earlier conversations: start with one durable `memory_search`, then use `memory_get` only if you need a more targeted read. Only use archive/session history when the user explicitly needs transcript-level detail or the durable search is insufficient.',
      'When the user directly says to remember, store, or correct a fact, do one `memory_store` or `memory_update` call immediately. Treat the newest direct user statement as authoritative.',
      'When one user message contains multiple related facts to remember, prefer one canonical `memory_store` write that captures the full set instead of many near-duplicate store calls.',
      'If someone says "remember this", write it down; do not rely on RAM alone.',
      'Memory writes merge canonical memories and retire superseded variants. After a successful store/update, do not keep re-searching unless the user explicitly asked you to verify.',
      'By default, memory searches focus on durable memories. Only include archives or working execution notes when you explicitly need transcript or run-history context.',
      'For open goals, form a hypothesis and execute — do not keep re-asking broad questions.',
    ],
  } as PluginHooks,
  tools: [
    {
      name: 'memory_tool',
      description: 'Advanced long-term memory system. Store and update canonical durable facts across conversations; store/update will merge matching memories and retire superseded variants. Search defaults to durable memories unless sources explicitly include archive or working.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['store', 'get', 'search', 'list', 'delete', 'update', 'link', 'unlink', 'doctor'] },
          id: { type: 'string' },
          key: { type: 'string' },
          title: { type: 'string' },
          value: { type: 'string' },
          category: { type: 'string' },
          query: { type: 'string' },
          sources: { type: 'array', items: { type: 'string', enum: ['durable', 'working', 'archive', 'all'] } },
          targetIds: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', enum: ['auto', 'all', 'global', 'shared', 'agent', 'session', 'project'] },
        },
        required: ['action']
      },
      execute: async (args, context) => {
        return executeMemoryAction(args, context.session)
      },
      planning: {
        capabilities: ['memory.search', 'memory.write'],
        disciplineGuidance: [
          'Use `memory_tool` for broad memory administration such as list, delete, link, unlink, or doctor. Prefer the narrow memory tools for routine search/get/store/update work.',
        ],
      },
    },
    {
      name: 'memory_search',
      description: 'Search durable long-term memory for prior work, decisions, dates, people, preferences, or todos from earlier conversations. Prefer this before broader history tools.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string', enum: ['auto', 'all', 'global', 'shared', 'agent', 'session', 'project'] },
          sources: { type: 'array', items: { type: 'string', enum: ['durable', 'working', 'archive', 'all'] } },
          rerank: { type: 'string', enum: ['balanced', 'semantic', 'lexical'] },
        },
        required: ['query'],
      },
      planning: {
        capabilities: ['memory.search'],
        disciplineGuidance: [
          'For earlier-conversation recall, start with `memory_search` instead of browsing archive/session history. Keep searches durable-first unless transcript or run-history detail is explicitly needed.',
        ],
      },
      execute: async (args, context) => executeNamedMemoryAction('search', args, context),
    },
    {
      name: 'memory_get',
      description: 'Read a specific memory entry by id or key after search, keeping context focused.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          key: { type: 'string' },
          scope: { type: 'string', enum: ['auto', 'all', 'global', 'shared', 'agent', 'session', 'project'] },
        },
        required: [],
      },
      planning: {
        capabilities: ['memory.search'],
        disciplineGuidance: [
          'Use `memory_get` after `memory_search` when you need one targeted memory entry. Do not dump the whole memory list when a single entry is enough.',
        ],
      },
      execute: async (args, context) => executeNamedMemoryAction('get', args, context),
    },
    {
      name: 'memory_store',
      description: 'Store a durable fact, preference, decision, or correction from the user. Use this immediately when the user says to remember something. If several related facts arrive in one request, prefer one canonical write over many near-duplicate calls. NOT for writing files, documents, code, or data exports — use the files tool for those.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          value: { type: 'string' },
          category: { type: 'string' },
          key: { type: 'string' },
          scope: { type: 'string', enum: ['auto', 'all', 'global', 'shared', 'agent', 'session', 'project'] },
          sharedWith: { type: 'array', items: { type: 'string' } },
        },
        required: [],
      },
      planning: {
        capabilities: ['memory.write'],
        disciplineGuidance: [
          'When the user says to remember or store a fact, call `memory_store` immediately. Do not delegate or use platform-management tools first.',
          'If the user bundled multiple related facts into one remember request, store them together in one canonical write unless they asked for separate memories.',
        ],
      },
      execute: async (args, context) => {
        // Guard: reject file-like content and redirect to the files tool.
        // Weaker models often confuse memory_store with file creation.
        const value = typeof args?.value === 'string' ? args.value : ''
        const title = typeof args?.title === 'string' ? args.title : ''
        const key = typeof args?.key === 'string' ? args.key : ''
        const category = typeof args?.category === 'string' ? args.category : ''
        const allText = `${title} ${key} ${category} ${value}`
        const hasFileExtension = /\.\w{1,5}$/.test(title || key)
        const hasFilePath = /(?:^|[\s"'/])(?:\/[\w.-]+){2,}\.[\w]{1,5}\b/.test(allText)
        const mentionsFileOp = /\b(?:csv|file|refactor|code|script|document|spreadsheet|inventory)\b/i.test(allText)
        const lineCount = (value.match(/\n/g) || []).length + 1
        const looksLikeCode = /^(import |export |function |const |let |var |class |interface |type |def |from |#include|package |using )/m.test(value)
        const looksLikeCsv = lineCount >= 3 && (value.match(/,/g) || []).length >= lineCount * 2
        const looksLikeStructuredData = lineCount >= 5 && (/^\s*[\[{]/m.test(value) || looksLikeCsv)
        const redirectMsg = 'Error: memory_store is only for remembering facts, preferences, and decisions — NOT for creating files, CSV data, code, or documents. To write a file, use the `files` tool: files({action:"write", files:[{path:"path/to/file", content:"..."}]})'
        if (hasFileExtension || hasFilePath || (mentionsFileOp && (!value || value.length > 200))) {
          return redirectMsg
        }
        if (value.length > 500 && (looksLikeCode || looksLikeStructuredData || looksLikeCsv)) {
          return redirectMsg
        }
        return executeNamedMemoryAction('store', args, context)
      },
    },
    {
      name: 'memory_update',
      description: 'Update or correct an existing durable memory when new information supersedes the old value.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          key: { type: 'string' },
          title: { type: 'string' },
          value: { type: 'string' },
          category: { type: 'string' },
          query: { type: 'string' },
          scope: { type: 'string', enum: ['auto', 'all', 'global', 'shared', 'agent', 'session', 'project'] },
        },
        required: [],
      },
      planning: {
        capabilities: ['memory.write'],
        disciplineGuidance: [
          'When the user corrects or revises remembered information, prefer `memory_update` so the canonical durable memory is updated instead of creating noisy duplicates.',
        ],
      },
      execute: async (args, context) => executeNamedMemoryAction('update', args, context),
    }
  ]
}

// Auto-register when imported
getPluginManager().registerBuiltin('memory', MemoryPlugin)

export function buildMemoryTools(bctx: ToolBuildContext) {
  if (!bctx.hasPlugin('memory')) return []
  
  return [
    tool(
      async (args) => executeMemoryAction(args, bctx.ctx),
      {
        name: 'memory_tool',
        description: MemoryPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    ),
    tool(
      async (args) => executeNamedMemoryAction('search', (args ?? {}) as Record<string, unknown>, { session: bctx.ctx }),
      {
        name: 'memory_search',
        description: MemoryPlugin.tools![1].description,
        schema: z.object({}).passthrough(),
      },
    ),
    tool(
      async (args) => executeNamedMemoryAction('get', (args ?? {}) as Record<string, unknown>, { session: bctx.ctx }),
      {
        name: 'memory_get',
        description: MemoryPlugin.tools![2].description,
        schema: z.object({}).passthrough(),
      },
    ),
    tool(
      async (args) => executeNamedMemoryAction('store', (args ?? {}) as Record<string, unknown>, { session: bctx.ctx }),
      {
        name: 'memory_store',
        description: MemoryPlugin.tools![3].description,
        schema: z.object({}).passthrough(),
      },
    ),
    tool(
      async (args) => executeNamedMemoryAction('update', (args ?? {}) as Record<string, unknown>, { session: bctx.ctx }),
      {
        name: 'memory_update',
        description: MemoryPlugin.tools![4].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
