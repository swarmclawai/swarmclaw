import { createHash } from 'crypto'
import path from 'path'

import { genId } from '@/lib/id'
import type {
  KnowledgeCitation,
  KnowledgeHygieneAction,
  KnowledgeHygieneFinding,
  KnowledgeHygieneSummary,
  KnowledgeSource,
  KnowledgeSourceDetail,
  KnowledgeSourceKind,
  KnowledgeSourceSummary,
  KnowledgeRetrievalTrace,
  KnowledgeSearchHit,
  MemoryEntry,
} from '@/types'
import {
  deleteKnowledgeSource as deleteKnowledgeSourceRecord,
  loadKnowledgeSource,
  loadKnowledgeSources,
  patchKnowledgeSource,
  upsertKnowledgeSource,
} from '@/lib/server/storage'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import {
  deriveKnowledgeTitle,
  extractKnowledgeTextFromFile,
  extractKnowledgeTextFromUrl,
} from '@/lib/server/knowledge-import'
import { onNextIdleWindow } from '@/lib/server/runtime/idle-window'

const KNOWLEDGE_STALE_AFTER_MS = 1000 * 60 * 60 * 24 * 14
const CHUNK_TARGET_CHARS = 2200
const CHUNK_OVERLAP_CHARS = 320
const MAX_KNOWLEDGE_SCAN = 10_000
const MAX_HYGIENE_FINDINGS = 120
const MAX_GROUNDING_HITS = 4

interface KnowledgeSourceInput {
  kind?: KnowledgeSourceKind
  title?: string
  content?: string | null
  tags?: string[]
  scope?: 'global' | 'agent'
  agentIds?: string[]
  sourceLabel?: string | null
  sourceUrl?: string | null
  sourcePath?: string | null
  metadata?: Record<string, unknown>
}

interface IndexedChunk {
  title: string
  content: string
  chunkIndex: number
  chunkCount: number
  charStart: number
  charEnd: number
  sectionLabel?: string | null
}

let backfillPromise: Promise<void> | null = null
let backfillComplete = false
let maintenanceRegistered = false
let maintenanceHistory: KnowledgeHygieneAction[] = []

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeOptionalText(value: unknown): string | null {
  const trimmed = normalizeText(value)
  return trimmed || null
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function matchesTagFilter(sourceTags: string[], filterTags: string[]): boolean {
  if (filterTags.length === 0) return true
  const tagSet = new Set(sourceTags.map((tag) => tag.toLowerCase()))
  return filterTags.some((tag) => tagSet.has(tag.toLowerCase()))
}

function normalizeAgentIds(agentIds: unknown): string[] {
  if (!Array.isArray(agentIds)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of agentIds) {
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function normalizeScope(scope: unknown): 'global' | 'agent' {
  return scope === 'agent' ? 'agent' : 'global'
}

function normalizeKind(kind: unknown): KnowledgeSourceKind {
  return kind === 'file' || kind === 'url' ? kind : 'manual'
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function isStaleSource(source: KnowledgeSource): boolean {
  if (source.archivedAt || source.supersededBySourceId) return false
  if (source.syncStatus === 'error') return true
  if (source.kind === 'manual') return false
  const indexedAt = typeof source.lastIndexedAt === 'number' ? source.lastIndexedAt : 0
  if (!indexedAt) return true
  return (Date.now() - indexedAt) > KNOWLEDGE_STALE_AFTER_MS
}

function coerceSource(source: KnowledgeSource): KnowledgeSource {
  const now = Date.now()
  return {
    id: source.id,
    kind: normalizeKind(source.kind),
    title: normalizeText(source.title) || 'Knowledge Source',
    content: typeof source.content === 'string' ? source.content : null,
    sourceLabel: normalizeOptionalText(source.sourceLabel),
    sourceUrl: normalizeOptionalText(source.sourceUrl),
    sourcePath: normalizeOptionalText(source.sourcePath),
    sourceHash: normalizeOptionalText(source.sourceHash),
    scope: normalizeScope(source.scope),
    agentIds: normalizeAgentIds(source.agentIds),
    tags: normalizeTags(source.tags),
    syncStatus: source.syncStatus === 'syncing' || source.syncStatus === 'error' ? source.syncStatus : 'ready',
    lastIndexedAt: typeof source.lastIndexedAt === 'number' ? source.lastIndexedAt : null,
    lastSyncedAt: typeof source.lastSyncedAt === 'number' ? source.lastSyncedAt : null,
    lastError: normalizeOptionalText(source.lastError),
    archivedAt: typeof source.archivedAt === 'number' ? source.archivedAt : null,
    archivedReason: normalizeOptionalText(source.archivedReason),
    duplicateOfSourceId: normalizeOptionalText(source.duplicateOfSourceId),
    supersededBySourceId: normalizeOptionalText(source.supersededBySourceId),
    maintenanceUpdatedAt: typeof source.maintenanceUpdatedAt === 'number' ? source.maintenanceUpdatedAt : null,
    maintenanceNotes: normalizeOptionalText(source.maintenanceNotes),
    nextSyncAt: typeof source.nextSyncAt === 'number' ? source.nextSyncAt : null,
    lastAutoSyncAt: typeof source.lastAutoSyncAt === 'number' ? source.lastAutoSyncAt : null,
    chunkCount: typeof source.chunkCount === 'number' ? source.chunkCount : 0,
    contentLength: typeof source.contentLength === 'number' ? source.contentLength : 0,
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : now,
    metadata: source.metadata && typeof source.metadata === 'object' ? source.metadata : undefined,
  }
}

function sourceIsArchived(source: KnowledgeSource): boolean {
  return typeof source.archivedAt === 'number' && source.archivedAt > 0
}

function sourceIsSuperseded(source: KnowledgeSource): boolean {
  return typeof source.supersededBySourceId === 'string' && source.supersededBySourceId.trim().length > 0
}

function sourceIsExcludedByDefault(source: KnowledgeSource): boolean {
  return sourceIsArchived(source) || sourceIsSuperseded(source)
}

function sourceVisibleToAgent(source: KnowledgeSource, viewerAgentId?: string | null): boolean {
  if (source.scope === 'global') return true
  if (!viewerAgentId) return false
  return source.agentIds.includes(viewerAgentId)
}

function cleanKnowledgeTokens(value: string): string[] {
  return Array.from(new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  ))
}

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = cleanKnowledgeTokens(left)
  const rightSet = new Set(cleanKnowledgeTokens(right))
  if (leftTokens.length === 0 || rightSet.size === 0) return 0
  let matches = 0
  for (const token of leftTokens) {
    if (rightSet.has(token)) matches += 1
  }
  return matches / Math.max(leftTokens.length, 1)
}

function jaccardSimilarity(left: string, right: string): number {
  const leftSet = new Set(cleanKnowledgeTokens(left))
  const rightSet = new Set(cleanKnowledgeTokens(right))
  if (leftSet.size === 0 || rightSet.size === 0) return 0
  let intersection = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1
  }
  const union = leftSet.size + rightSet.size - intersection
  return union > 0 ? intersection / union : 0
}

function whyMatched(query: string, title: string, content: string, sectionLabel?: string | null): string {
  const queryTokens = cleanKnowledgeTokens(query)
  const contentText = `${title}\n${sectionLabel || ''}\n${content}`
  const contentTokens = new Set(cleanKnowledgeTokens(contentText))
  const matched = queryTokens.filter((token) => contentTokens.has(token))
  if (matched.length > 0) {
    const head = matched.slice(0, 4).join(', ')
    return `Matched query terms: ${head}${matched.length > 4 ? ', ...' : ''}`
  }
  if (sectionLabel?.trim()) return `Matched the ${sectionLabel.trim()} section`
  return 'Retrieved as a high-relevance knowledge chunk'
}

function toCitation(hit: KnowledgeSearchHit): KnowledgeCitation {
  return {
    sourceId: hit.sourceId,
    sourceTitle: hit.sourceTitle,
    sourceKind: hit.sourceKind,
    sourceUrl: hit.sourceUrl || null,
    sourceLabel: hit.sourceLabel || null,
    chunkId: hit.id,
    chunkIndex: hit.chunkIndex,
    chunkCount: hit.chunkCount,
    charStart: hit.charStart,
    charEnd: hit.charEnd,
    sectionLabel: hit.sectionLabel || null,
    snippet: hit.snippet,
    whyMatched: hit.whyMatched || null,
    score: hit.score,
  }
}

function listStoredSources(): KnowledgeSource[] {
  return Object.values(loadKnowledgeSources())
    .map((source) => coerceSource(source))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

function sourceTitleFromUrl(sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl)
    const leaf = path.basename(parsed.pathname || '')
    return leaf ? deriveKnowledgeTitle(leaf) : parsed.hostname
  } catch {
    return sourceUrl
  }
}

function sourceLabelFromUrl(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl)
    return parsed.hostname || null
  } catch {
    return null
  }
}

function headingLabel(text: string): string | null {
  const match = text.match(/^#{1,6}\s+(.+)$/m)
  return match?.[1]?.trim() || null
}

function previewSnippet(content: string, query?: string): string {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (!query) return normalized.slice(0, 180)

  const queryTokens = Array.from(new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  ))

  const lower = normalized.toLowerCase()
  let matchIndex = -1
  for (const token of queryTokens) {
    const idx = lower.indexOf(token)
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx
    }
  }

  if (matchIndex === -1) return normalized.slice(0, 180)
  const start = Math.max(0, matchIndex - 80)
  const end = Math.min(normalized.length, matchIndex + 220)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < normalized.length ? '…' : ''
  return `${prefix}${normalized.slice(start, end)}${suffix}`
}

function splitParagraphs(content: string): Array<{
  text: string
  start: number
  end: number
  sectionLabel: string | null
}> {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const paragraphs: Array<{ text: string; start: number; end: number; sectionLabel: string | null }> = []
  let cursor = 0
  let lastSection: string | null = null
  const breakRegex = /\n{2,}/g

  const pushParagraph = (rawStart: number, rawEnd: number) => {
    const raw = normalized.slice(rawStart, rawEnd)
    const leadingWhitespace = raw.match(/^\s*/)?.[0].length || 0
    const trailingWhitespace = raw.match(/\s*$/)?.[0].length || 0
    const text = raw.trim()
    if (!text) return
    const sectionLabel = headingLabel(text)
    if (sectionLabel) lastSection = sectionLabel
    paragraphs.push({
      text,
      start: rawStart + leadingWhitespace,
      end: rawEnd - trailingWhitespace,
      sectionLabel: lastSection,
    })
  }

  for (const match of normalized.matchAll(breakRegex)) {
    const boundary = match.index ?? 0
    pushParagraph(cursor, boundary)
    cursor = boundary + match[0].length
  }
  pushParagraph(cursor, normalized.length)
  return paragraphs
}

function splitOversizedParagraph(
  paragraph: { text: string; start: number; end: number; sectionLabel: string | null },
  sourceTitle: string,
): IndexedChunk[] {
  const chunks: IndexedChunk[] = []
  let cursor = 0

  while (cursor < paragraph.text.length) {
    let end = Math.min(paragraph.text.length, cursor + CHUNK_TARGET_CHARS)
    if (end < paragraph.text.length) {
      const boundary = paragraph.text.lastIndexOf(' ', end)
      if (boundary > cursor + 400) end = boundary
    }

    const raw = paragraph.text.slice(cursor, end)
    const leadingWhitespace = raw.match(/^\s*/)?.[0].length || 0
    const trailingWhitespace = raw.match(/\s*$/)?.[0].length || 0
    const content = raw.trim()
    if (content) {
      const relativeStart = cursor + leadingWhitespace
      const relativeEnd = end - trailingWhitespace
      chunks.push({
        title: paragraph.sectionLabel ? `${sourceTitle} · ${paragraph.sectionLabel}` : sourceTitle,
        content,
        chunkIndex: 0,
        chunkCount: 0,
        charStart: paragraph.start + relativeStart,
        charEnd: paragraph.start + relativeEnd,
        sectionLabel: paragraph.sectionLabel,
      })
    }

    if (end >= paragraph.text.length) break
    cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP_CHARS)
  }

  return chunks
}

function chunkKnowledgeContent(sourceTitle: string, content: string): IndexedChunk[] {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const paragraphs = splitParagraphs(normalized)
  if (paragraphs.length === 0) return []

  const chunks: IndexedChunk[] = []
  let index = 0

  while (index < paragraphs.length) {
    const firstIndex = index
    const first = paragraphs[index]

    if (first.text.length > CHUNK_TARGET_CHARS) {
      chunks.push(...splitOversizedParagraph(first, sourceTitle))
      index += 1
      continue
    }

    let combined = first.text
    const charStart = first.start
    let charEnd = first.end
    let sectionLabel = first.sectionLabel
    let nextIndex = index + 1

    while (nextIndex < paragraphs.length) {
      const nextParagraph = paragraphs[nextIndex]
      if (nextParagraph.text.length > CHUNK_TARGET_CHARS) break
      const candidate = `${combined}\n\n${nextParagraph.text}`
      if (candidate.length > CHUNK_TARGET_CHARS) break
      combined = candidate
      charEnd = nextParagraph.end
      sectionLabel = sectionLabel || nextParagraph.sectionLabel
      nextIndex += 1
    }

    chunks.push({
      title: sectionLabel ? `${sourceTitle} · ${sectionLabel}` : sourceTitle,
      content: combined,
      chunkIndex: 0,
      chunkCount: 0,
      charStart,
      charEnd,
      sectionLabel,
    })

    if (nextIndex >= paragraphs.length) break

    let overlapChars = 0
    let overlapStart = nextIndex
    for (let back = nextIndex - 1; back > firstIndex; back--) {
      overlapChars += paragraphs[back].text.length
      overlapStart = back
      if (overlapChars >= CHUNK_OVERLAP_CHARS) break
    }
    index = Math.max(firstIndex + 1, overlapStart)
  }

  const chunkCount = chunks.length
  return chunks.map((chunk, chunkIndex) => ({
    ...chunk,
    chunkIndex,
    chunkCount,
  }))
}

function memorySourceMeta(entry: MemoryEntry): Record<string, unknown> {
  return entry.metadata && typeof entry.metadata === 'object'
    ? entry.metadata as Record<string, unknown>
    : {}
}

function buildSourceSummary(source: KnowledgeSource, chunks?: MemoryEntry[]): KnowledgeSourceSummary {
  const firstChunk = chunks?.[0] || null
  const preview = typeof source.content === 'string' && source.content.trim()
    ? source.content
    : firstChunk?.content || ''

  return {
    ...source,
    stale: isStaleSource(source),
    topSnippet: preview ? previewSnippet(preview) : null,
  }
}

function buildSearchHit(source: KnowledgeSource, entry: MemoryEntry, score: number, query: string): KnowledgeSearchHit {
  const metadata = memorySourceMeta(entry)
  return {
    id: entry.id,
    sourceId: source.id,
    sourceTitle: source.title,
    sourceKind: source.kind,
    sourceUrl: source.sourceUrl || null,
    sourceLabel: source.sourceLabel || null,
    scope: source.scope,
    agentIds: source.agentIds,
    tags: source.tags,
    syncStatus: source.syncStatus,
    stale: isStaleSource(source),
    title: entry.title || source.title,
    snippet: previewSnippet(entry.content, query),
    content: entry.content,
    chunkIndex: typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : 0,
    chunkCount: typeof metadata.chunkCount === 'number' ? metadata.chunkCount : source.chunkCount,
    charStart: typeof metadata.charStart === 'number' ? metadata.charStart : 0,
    charEnd: typeof metadata.charEnd === 'number' ? metadata.charEnd : entry.content.length,
    sectionLabel: typeof metadata.sectionLabel === 'string' ? metadata.sectionLabel : null,
    score,
    whyMatched: whyMatched(query, entry.title || source.title, entry.content, typeof metadata.sectionLabel === 'string' ? metadata.sectionLabel : null),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

async function resolveSourceContent(
  source: KnowledgeSource,
  overrideContent?: string | null,
): Promise<{ content: string; title: string; sourceLabel?: string | null }> {
  const inlineContent = typeof overrideContent === 'string' ? overrideContent.trim() : ''
  if (inlineContent) {
    return {
      content: overrideContent || '',
      title: source.title,
      sourceLabel: source.sourceLabel || null,
    }
  }

  if (source.kind === 'manual') {
    if (!source.content?.trim()) throw new Error('Content is required for manual knowledge.')
    return {
      content: source.content,
      title: source.title,
      sourceLabel: source.sourceLabel || null,
    }
  }

  if (source.kind === 'file') {
    if (source.sourcePath) {
      return {
        content: await extractKnowledgeTextFromFile(source.sourcePath, source.sourceLabel || source.title),
        title: source.title,
        sourceLabel: source.sourceLabel || path.basename(source.sourcePath),
      }
    }
    if (source.content?.trim()) {
      return {
        content: source.content,
        title: source.title,
        sourceLabel: source.sourceLabel || null,
      }
    }
    throw new Error('A file path or extracted content is required for file knowledge.')
  }

  if (!source.sourceUrl) {
    if (source.content?.trim()) {
      return {
        content: source.content,
        title: source.title,
        sourceLabel: source.sourceLabel || null,
      }
    }
    throw new Error('A URL is required for URL knowledge.')
  }

  const extracted = await extractKnowledgeTextFromUrl(source.sourceUrl)
  return {
    content: extracted.content,
    title: source.title || extracted.title || sourceTitleFromUrl(source.sourceUrl),
    sourceLabel: source.sourceLabel || extracted.title || sourceLabelFromUrl(source.sourceUrl),
  }
}

function sharedWithForSource(source: KnowledgeSource): string[] | undefined {
  return source.scope === 'agent' && source.agentIds.length > 0 ? source.agentIds : undefined
}

function toChunkMetadata(source: KnowledgeSource, chunk: IndexedChunk): Record<string, unknown> {
  return {
    sourceId: source.id,
    sourceTitle: source.title,
    sourceKind: source.kind,
    sourceUrl: source.sourceUrl || null,
    sourceLabel: source.sourceLabel || null,
    tags: source.tags,
    scope: source.scope,
    agentIds: source.agentIds,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    sectionLabel: chunk.sectionLabel || null,
    indexedAt: Date.now(),
  }
}

function replaceSourceChunks(source: KnowledgeSource, chunks: IndexedChunk[]): MemoryEntry[] {
  const db = getMemoryDb()
  for (const existingChunk of db.listKnowledgeSourceChunks(source.id)) {
    db.delete(existingChunk.id)
  }

  return chunks.map((chunk) => db.add({
    agentId: null,
    sessionId: null,
    category: 'knowledge',
    title: chunk.title,
    content: chunk.content,
    metadata: toChunkMetadata(source, chunk),
    sharedWith: sharedWithForSource(source),
  }))
}

async function ensureLegacyKnowledgeBackfill(): Promise<void> {
  if (backfillComplete) return
  if (backfillPromise) return backfillPromise
  backfillPromise = (async () => {
    const db = getMemoryDb()
    const entries = db.listByCategory('knowledge', undefined, MAX_KNOWLEDGE_SCAN)

    for (const entry of entries) {
      const metadata = memorySourceMeta(entry)
      const existingSourceId = typeof metadata.sourceId === 'string' ? metadata.sourceId.trim() : ''
      if (existingSourceId) continue

      const scope = normalizeScope(metadata.scope)
      const agentIds = normalizeAgentIds(metadata.agentIds)
      const sourceId = entry.id
      const source = coerceSource({
        id: sourceId,
        kind: 'manual',
        title: entry.title || 'Knowledge Source',
        content: entry.content,
        sourceLabel: typeof metadata.source === 'string' ? metadata.source : null,
        sourceUrl: typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : null,
        sourcePath: typeof metadata.sourcePath === 'string' ? metadata.sourcePath : null,
        sourceHash: contentHash(entry.content || ''),
        scope,
        agentIds,
        tags: normalizeTags(metadata.tags),
        syncStatus: 'ready',
        lastIndexedAt: entry.updatedAt,
        lastSyncedAt: entry.updatedAt,
        chunkCount: 1,
        contentLength: entry.content.length,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        metadata: {
          legacyMemoryId: entry.id,
          migratedAt: Date.now(),
        },
      })

      upsertKnowledgeSource(sourceId, source)
      db.update(entry.id, {
        sharedWith: sharedWithForSource(source),
        metadata: {
          ...metadata,
          sourceId,
          sourceTitle: source.title,
          sourceKind: source.kind,
          sourceLabel: source.sourceLabel,
          sourceUrl: source.sourceUrl,
          tags: source.tags,
          scope: source.scope,
          agentIds: source.agentIds,
          chunkIndex: typeof metadata.chunkIndex === 'number' ? metadata.chunkIndex : 0,
          chunkCount: typeof metadata.chunkCount === 'number' ? metadata.chunkCount : 1,
          charStart: typeof metadata.charStart === 'number' ? metadata.charStart : 0,
          charEnd: typeof metadata.charEnd === 'number' ? metadata.charEnd : entry.content.length,
          sectionLabel: typeof metadata.sectionLabel === 'string' ? metadata.sectionLabel : null,
          indexedAt: typeof metadata.indexedAt === 'number' ? metadata.indexedAt : entry.updatedAt,
        },
      })
    }
    backfillComplete = true
  })().finally(() => {
    backfillPromise = null
  })

  return backfillPromise
}

export async function listKnowledgeSourceSummaries(options?: {
  tags?: string[]
  limit?: number
  includeArchived?: boolean
}): Promise<KnowledgeSourceSummary[]> {
  await ensureLegacyKnowledgeBackfill()
  registerKnowledgeMaintenanceIdleCallback()
  const tagFilter = normalizeTags(options?.tags)
  const limit = Math.max(1, Math.min(500, Math.trunc(options?.limit || 200)))
  const includeArchived = options?.includeArchived === true

  const sources = listStoredSources()
    .filter((source) => includeArchived || !sourceIsExcludedByDefault(source))
    .filter((source) => matchesTagFilter(source.tags, tagFilter))
    .slice(0, limit)

  return sources.map((source) => buildSourceSummary(source))
}

export async function searchKnowledgeHits(options: {
  query: string
  tags?: string[]
  limit?: number
  includeArchived?: boolean
  viewerAgentId?: string | null
}): Promise<KnowledgeSearchHit[]> {
  await ensureLegacyKnowledgeBackfill()
  registerKnowledgeMaintenanceIdleCallback()
  const query = normalizeText(options.query)
  if (!query) return []

  const tagFilter = normalizeTags(options.tags)
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit || 50)))
  const includeArchived = options.includeArchived === true
  const viewerAgentId = typeof options.viewerAgentId === 'string' ? options.viewerAgentId.trim() : ''
  const sourceMap = new Map(listStoredSources().map((source) => [source.id, source] as const))
  const matches = getMemoryDb().search(query)
    .filter((entry) => entry.category === 'knowledge')

  const hits: KnowledgeSearchHit[] = []
  for (const entry of matches) {
    const metadata = memorySourceMeta(entry)
    const sourceId = typeof metadata.sourceId === 'string' ? metadata.sourceId : ''
    const source = sourceMap.get(sourceId)
    if (!source) continue
    if (!includeArchived && sourceIsExcludedByDefault(source)) continue
    if (viewerAgentId && !sourceVisibleToAgent(source, viewerAgentId)) continue
    if (!matchesTagFilter(source.tags, tagFilter)) continue
    hits.push(buildSearchHit(source, entry, Math.max(0, 1 - hits.length / Math.max(matches.length, 1)), query))
    if (hits.length >= limit) break
  }

  return hits
}

export async function getKnowledgeSourceDetail(id: string): Promise<KnowledgeSourceDetail | null> {
  await ensureLegacyKnowledgeBackfill()
  const source = loadKnowledgeSource(id)
  if (!source) return null
  const normalized = coerceSource(source)
  const chunks = getMemoryDb().listKnowledgeSourceChunks(id)
  return {
    source: buildSourceSummary(normalized, chunks),
    chunks,
  }
}

export async function buildKnowledgeRetrievalTrace(options: {
  query: string
  viewerAgentId?: string | null
  limit?: number
}): Promise<KnowledgeRetrievalTrace | null> {
  const hits = await searchKnowledgeHits({
    query: options.query,
    limit: Math.max(1, Math.min(MAX_GROUNDING_HITS, Math.trunc(options.limit || MAX_GROUNDING_HITS))),
    viewerAgentId: options.viewerAgentId || null,
  })
  if (hits.length === 0) return null
  return {
    query: normalizeText(options.query),
    scope: 'source_knowledge',
    hits: hits.map(toCitation),
    retrievedAt: Date.now(),
    selectorStatus: 'not_run',
  }
}

export function selectKnowledgeCitations(params: {
  responseText: string
  retrievalTrace?: KnowledgeRetrievalTrace | null
  limit?: number
}): { citations: KnowledgeCitation[]; retrievalTrace: KnowledgeRetrievalTrace | null } {
  const trace = params.retrievalTrace
  if (!trace || !Array.isArray(trace.hits) || trace.hits.length === 0) {
    return { citations: [], retrievalTrace: trace || null }
  }

  const responseText = normalizeText(params.responseText)
  if (!responseText) {
    return {
      citations: [],
      retrievalTrace: { ...trace, selectorStatus: 'no_match' },
    }
  }

  const ranked = trace.hits
    .map((hit) => ({
      hit,
      overlap: tokenOverlapScore(responseText, `${hit.sourceTitle}\n${hit.sectionLabel || ''}\n${hit.snippet}`),
    }))
    .sort((left, right) => {
      const overlapDelta = right.overlap - left.overlap
      if (overlapDelta !== 0) return overlapDelta
      return right.hit.score - left.hit.score
    })

  const limit = Math.max(1, Math.min(4, Math.trunc(params.limit || 3)))
  const selected = ranked
    .filter((entry, index) => entry.overlap >= 0.08 || (entry.hit.score >= 0.7 && index === 0))
    .slice(0, limit)
    .map((entry) => entry.hit)

  return {
    citations: selected,
    retrievalTrace: {
      ...trace,
      selectorStatus: selected.length > 0 ? 'selected' : 'no_match',
    },
  }
}

async function syncSourceRecord(
  source: KnowledgeSource,
  options?: { overrideContent?: string | null; forceRewrite?: boolean },
): Promise<KnowledgeSourceDetail> {
  const loading = coerceSource({
    ...source,
    syncStatus: 'syncing',
    lastError: null,
    updatedAt: Date.now(),
  })
  upsertKnowledgeSource(loading.id, loading)

  try {
    const resolved = await resolveSourceContent(loading, options?.overrideContent)
    const chunks = chunkKnowledgeContent(resolved.title, resolved.content)
    if (chunks.length === 0) {
      throw new Error('No readable content was extracted for this source.')
    }

    const nextHash = contentHash(resolved.content)
    const metadataChanged = options?.forceRewrite === true
      || loading.title !== resolved.title
      || (loading.sourceLabel || null) !== (resolved.sourceLabel || null)

    let indexedChunks = getMemoryDb().listKnowledgeSourceChunks(loading.id)
    if (indexedChunks.length === 0 || metadataChanged || loading.sourceHash !== nextHash) {
      const rewrittenSource = coerceSource({
        ...loading,
        title: resolved.title,
        content: resolved.content,
        sourceLabel: resolved.sourceLabel ?? loading.sourceLabel ?? null,
        sourceHash: nextHash,
        chunkCount: chunks.length,
        contentLength: resolved.content.length,
        syncStatus: 'ready',
        lastError: null,
        lastIndexedAt: Date.now(),
        lastSyncedAt: Date.now(),
        nextSyncAt: Date.now() + KNOWLEDGE_STALE_AFTER_MS,
        updatedAt: Date.now(),
      })
      upsertKnowledgeSource(rewrittenSource.id, rewrittenSource)
      indexedChunks = replaceSourceChunks(rewrittenSource, chunks)
      return {
        source: buildSourceSummary(rewrittenSource, indexedChunks),
        chunks: indexedChunks,
      }
    }

    const refreshedSource = coerceSource({
      ...loading,
      content: resolved.content,
      sourceHash: nextHash,
      syncStatus: 'ready',
      lastError: null,
      lastSyncedAt: Date.now(),
      nextSyncAt: Date.now() + KNOWLEDGE_STALE_AFTER_MS,
      updatedAt: Date.now(),
    })
    upsertKnowledgeSource(refreshedSource.id, refreshedSource)
    return {
      source: buildSourceSummary(refreshedSource, indexedChunks),
      chunks: indexedChunks,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Knowledge sync failed'
    const failed = coerceSource({
      ...loading,
      syncStatus: 'error',
      lastError: message,
      updatedAt: Date.now(),
    })
    upsertKnowledgeSource(failed.id, failed)
    throw error
  }
}

export async function createKnowledgeSource(input: KnowledgeSourceInput): Promise<KnowledgeSourceDetail> {
  await ensureLegacyKnowledgeBackfill()

  const now = Date.now()
  const kind = normalizeKind(input.kind)
  const title = normalizeText(input.title)
    || (kind === 'file' && input.sourcePath ? deriveKnowledgeTitle(path.basename(input.sourcePath)) : '')
    || (kind === 'url' && input.sourceUrl ? sourceTitleFromUrl(input.sourceUrl) : '')
    || 'Knowledge Source'

  const source: KnowledgeSource = coerceSource({
    id: genId(8),
    kind,
    title,
    content: typeof input.content === 'string' ? input.content : null,
    sourceLabel: normalizeOptionalText(input.sourceLabel),
    sourceUrl: normalizeOptionalText(input.sourceUrl),
    sourcePath: normalizeOptionalText(input.sourcePath),
    sourceHash: null,
    scope: normalizeScope(input.scope),
    agentIds: normalizeAgentIds(input.agentIds),
    tags: normalizeTags(input.tags),
    syncStatus: 'syncing',
    lastIndexedAt: null,
    lastSyncedAt: null,
    lastError: null,
    chunkCount: 0,
    contentLength: 0,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
  })

  upsertKnowledgeSource(source.id, source)
  return syncSourceRecord(source, { overrideContent: input.content, forceRewrite: true })
}

export async function updateKnowledgeSource(
  id: string,
  input: KnowledgeSourceInput,
): Promise<KnowledgeSourceDetail | null> {
  await ensureLegacyKnowledgeBackfill()
  const existing = loadKnowledgeSource(id)
  if (!existing) return null

  const normalizedExisting = coerceSource(existing)
  const next: KnowledgeSource = coerceSource({
    ...normalizedExisting,
    kind: normalizeKind(input.kind ?? normalizedExisting.kind),
    title: normalizeText(input.title) || normalizedExisting.title,
    content: typeof input.content === 'string' ? input.content : normalizedExisting.content,
    sourceLabel: input.sourceLabel !== undefined ? normalizeOptionalText(input.sourceLabel) : normalizedExisting.sourceLabel,
    sourceUrl: input.sourceUrl !== undefined ? normalizeOptionalText(input.sourceUrl) : normalizedExisting.sourceUrl,
    sourcePath: input.sourcePath !== undefined ? normalizeOptionalText(input.sourcePath) : normalizedExisting.sourcePath,
    scope: normalizeScope(input.scope ?? normalizedExisting.scope),
    agentIds: normalizeAgentIds(input.agentIds ?? normalizedExisting.agentIds),
    tags: normalizeTags(input.tags ?? normalizedExisting.tags),
    metadata: input.metadata ? { ...(normalizedExisting.metadata || {}), ...input.metadata } : normalizedExisting.metadata,
    updatedAt: Date.now(),
  })

  upsertKnowledgeSource(next.id, next)
  return syncSourceRecord(next, { overrideContent: input.content, forceRewrite: true })
}

export async function syncKnowledgeSource(id: string): Promise<KnowledgeSourceDetail | null> {
  await ensureLegacyKnowledgeBackfill()
  const existing = loadKnowledgeSource(id)
  if (!existing) return null
  return syncSourceRecord(coerceSource(existing))
}

export async function deleteKnowledgeSource(id: string): Promise<boolean> {
  await ensureLegacyKnowledgeBackfill()
  const existing = loadKnowledgeSource(id)
  if (!existing) return false

  for (const chunk of getMemoryDb().listKnowledgeSourceChunks(id)) {
    getMemoryDb().delete(chunk.id)
  }
  deleteKnowledgeSourceRecord(id)
  return true
}

function recordMaintenanceAction(action: KnowledgeHygieneAction): void {
  maintenanceHistory = [action, ...maintenanceHistory].slice(0, 48)
}

function upsertSourceLifecycle(id: string, updater: (source: KnowledgeSource) => KnowledgeSource): KnowledgeSource | null {
  const updated = patchKnowledgeSource(id, (current) => {
    if (!current) return null
    return coerceSource(updater(coerceSource(current)))
  })
  return updated ? coerceSource(updated) : null
}

export async function archiveKnowledgeSource(
  id: string,
  input?: { reason?: string | null; duplicateOfSourceId?: string | null; supersededBySourceId?: string | null },
): Promise<KnowledgeSourceDetail | null> {
  await ensureLegacyKnowledgeBackfill()
  const updated = upsertSourceLifecycle(id, (source) => ({
    ...source,
    archivedAt: source.archivedAt || Date.now(),
    archivedReason: normalizeOptionalText(input?.reason) || source.archivedReason || 'archived',
    duplicateOfSourceId: normalizeOptionalText(input?.duplicateOfSourceId) || source.duplicateOfSourceId || null,
    supersededBySourceId: normalizeOptionalText(input?.supersededBySourceId) || source.supersededBySourceId || null,
    maintenanceUpdatedAt: Date.now(),
    maintenanceNotes: normalizeOptionalText(input?.reason) || source.maintenanceNotes || null,
    updatedAt: Date.now(),
  }))
  if (!updated) return null
  recordMaintenanceAction({
    kind: 'archive',
    sourceId: updated.id,
    relatedSourceId: updated.duplicateOfSourceId || updated.supersededBySourceId || null,
    summary: `Archived ${updated.title}`,
    createdAt: Date.now(),
  })
  return getKnowledgeSourceDetail(updated.id)
}

export async function restoreKnowledgeSource(id: string): Promise<KnowledgeSourceDetail | null> {
  await ensureLegacyKnowledgeBackfill()
  const updated = upsertSourceLifecycle(id, (source) => ({
    ...source,
    archivedAt: null,
    archivedReason: null,
    duplicateOfSourceId: null,
    supersededBySourceId: null,
    maintenanceUpdatedAt: Date.now(),
    maintenanceNotes: 'restored',
    updatedAt: Date.now(),
  }))
  if (!updated) return null
  recordMaintenanceAction({
    kind: 'restore',
    sourceId: updated.id,
    summary: `Restored ${updated.title}`,
    createdAt: Date.now(),
  })
  return getKnowledgeSourceDetail(updated.id)
}

export async function supersedeKnowledgeSource(
  id: string,
  supersededBySourceId: string,
): Promise<KnowledgeSourceDetail | null> {
  await ensureLegacyKnowledgeBackfill()
  const target = loadKnowledgeSource(supersededBySourceId)
  if (!target) throw new Error('Superseding source not found.')
  const updated = upsertSourceLifecycle(id, (source) => ({
    ...source,
    supersededBySourceId,
    archivedAt: source.archivedAt || Date.now(),
    archivedReason: source.archivedReason || 'superseded',
    maintenanceUpdatedAt: Date.now(),
    maintenanceNotes: `Superseded by ${supersededBySourceId}`,
    updatedAt: Date.now(),
  }))
  if (!updated) return null
  recordMaintenanceAction({
    kind: 'supersede',
    sourceId: updated.id,
    relatedSourceId: supersededBySourceId,
    summary: `Marked ${updated.title} as superseded`,
    createdAt: Date.now(),
  })
  return getKnowledgeSourceDetail(updated.id)
}

function sameSourceOrigin(left: KnowledgeSource, right: KnowledgeSource): boolean {
  if (left.id === right.id) return false
  if (left.sourceUrl && right.sourceUrl) return left.sourceUrl === right.sourceUrl
  if (left.sourcePath && right.sourcePath) return left.sourcePath === right.sourcePath
  return false
}

function duplicateOriginFingerprint(source: KnowledgeSource): string {
  if (source.sourceUrl) return `url:${source.sourceUrl}`
  if (source.sourcePath) return `path:${source.sourcePath}`
  return `kind:${source.kind}`
}

function duplicateGroupKey(source: KnowledgeSource): string | null {
  if (!source.sourceHash) return null
  const sortedAgentIds = [...source.agentIds].sort()
  const sortedTags = [...source.tags].map((tag) => tag.toLowerCase()).sort()
  return [
    source.sourceHash,
    source.kind,
    source.scope,
    sortedAgentIds.join(','),
    sortedTags.join(','),
    duplicateOriginFingerprint(source),
  ].join('|')
}

function collectDuplicateGroups(sources: KnowledgeSource[]): Map<string, KnowledgeSource[]> {
  const duplicateGroups = new Map<string, KnowledgeSource[]>()
  for (const source of sources) {
    const groupKey = duplicateGroupKey(source)
    if (!groupKey) continue
    const group = duplicateGroups.get(groupKey) || []
    group.push(source)
    duplicateGroups.set(groupKey, group)
  }
  return duplicateGroups
}

function canonicalSourceForGroup(group: KnowledgeSource[]): KnowledgeSource {
  return [...group].sort((left, right) => {
    const archiveDelta = Number(sourceIsExcludedByDefault(left)) - Number(sourceIsExcludedByDefault(right))
    if (archiveDelta !== 0) return archiveDelta
    const indexedDelta = (right.lastIndexedAt || 0) - (left.lastIndexedAt || 0)
    if (indexedDelta !== 0) return indexedDelta
    return left.createdAt - right.createdAt
  })[0]
}

function buildHygieneSummary(sources: KnowledgeSource[]): KnowledgeHygieneSummary {
  const scannedAt = Date.now()
  const findings: KnowledgeHygieneFinding[] = []
  const pushFinding = (finding: KnowledgeHygieneFinding) => {
    if (findings.length < MAX_HYGIENE_FINDINGS) findings.push(finding)
  }
  const duplicateGroups = collectDuplicateGroups(sources)

  for (const source of sources) {
    if (sourceIsArchived(source)) {
      pushFinding({
        kind: 'archived',
        sourceId: source.id,
        sourceTitle: source.title,
        detail: source.archivedReason || 'Archived source',
        createdAt: source.archivedAt || source.updatedAt,
      })
    }
    if (sourceIsSuperseded(source)) {
      pushFinding({
        kind: 'superseded',
        sourceId: source.id,
        sourceTitle: source.title,
        relatedSourceId: source.supersededBySourceId || null,
        detail: `Superseded by ${source.supersededBySourceId}`,
        createdAt: source.updatedAt,
      })
    }
    if (source.syncStatus === 'error') {
      pushFinding({
        kind: 'broken',
        sourceId: source.id,
        sourceTitle: source.title,
        detail: source.lastError || 'Last sync failed',
        createdAt: source.updatedAt,
      })
    } else if (isStaleSource(source)) {
      pushFinding({
        kind: 'stale',
        sourceId: source.id,
        sourceTitle: source.title,
        detail: 'Source is due for re-sync',
        createdAt: source.updatedAt,
      })
    }
  }

  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue
    const canonical = canonicalSourceForGroup(group)
    for (const source of group) {
      if (source.id === canonical.id) continue
      pushFinding({
        kind: 'duplicate',
        sourceId: source.id,
        sourceTitle: source.title,
        relatedSourceId: canonical.id,
        relatedSourceTitle: canonical.title,
        detail: 'Exact duplicate content hash',
        createdAt: source.updatedAt,
      })
    }
  }

  const activeSources = sources.filter((source) => !sourceIsExcludedByDefault(source))
  for (let index = 0; index < activeSources.length; index += 1) {
    const left = activeSources[index]
    const leftBody = `${left.title}\n${left.content || ''}`
    if (!leftBody.trim()) continue
    for (let compareIndex = index + 1; compareIndex < activeSources.length; compareIndex += 1) {
      const right = activeSources[compareIndex]
      const rightBody = `${right.title}\n${right.content || ''}`
      if (!rightBody.trim()) continue
      if (sameSourceOrigin(left, right)) continue
      const overlap = jaccardSimilarity(leftBody, rightBody)
      if (overlap < 0.6) continue
      pushFinding({
        kind: 'overlap',
        sourceId: left.id,
        sourceTitle: left.title,
        relatedSourceId: right.id,
        relatedSourceTitle: right.title,
        detail: `High content overlap (${Math.round(overlap * 100)}%)`,
        createdAt: Math.max(left.updatedAt, right.updatedAt),
      })
    }
  }

  return {
    scannedAt,
    counts: {
      stale: findings.filter((finding) => finding.kind === 'stale').length,
      duplicate: findings.filter((finding) => finding.kind === 'duplicate').length,
      overlap: findings.filter((finding) => finding.kind === 'overlap').length,
      broken: findings.filter((finding) => finding.kind === 'broken').length,
      archived: findings.filter((finding) => finding.kind === 'archived').length,
      superseded: findings.filter((finding) => finding.kind === 'superseded').length,
    },
    findings,
    recentActions: [...maintenanceHistory],
  }
}

export async function getKnowledgeHygieneSummary(): Promise<KnowledgeHygieneSummary> {
  await ensureLegacyKnowledgeBackfill()
  registerKnowledgeMaintenanceIdleCallback()
  return buildHygieneSummary(listStoredSources())
}

export async function runKnowledgeHygieneMaintenance(): Promise<KnowledgeHygieneSummary> {
  await ensureLegacyKnowledgeBackfill()
  const sources = listStoredSources()
  const duplicateGroups = collectDuplicateGroups(sources)

  for (const source of sources) {
    if (sourceIsExcludedByDefault(source)) continue
    if (source.kind !== 'manual' && (isStaleSource(source) || source.syncStatus === 'error')) {
      try {
        const synced = await syncKnowledgeSource(source.id)
        if (synced?.source) {
          upsertSourceLifecycle(source.id, (current) => ({
            ...current,
            lastAutoSyncAt: Date.now(),
            maintenanceUpdatedAt: Date.now(),
            maintenanceNotes: 'auto-sync completed',
            updatedAt: Date.now(),
          }))
          recordMaintenanceAction({
            kind: source.sourceHash === synced.source.sourceHash ? 'sync' : 'reindex',
            sourceId: source.id,
            summary: `Auto-synced ${synced.source.title}`,
            createdAt: Date.now(),
          })
        }
      } catch {
        // Keep the existing error state for manual review.
      }
    }
  }

  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue
    const canonical = canonicalSourceForGroup(group)
    for (const source of group) {
      if (source.id === canonical.id || sourceIsExcludedByDefault(source)) continue
      await archiveKnowledgeSource(source.id, {
        reason: 'duplicate',
        duplicateOfSourceId: canonical.id,
      })
    }
  }

  const refreshed = listStoredSources()
  const originGroups = new Map<string, KnowledgeSource[]>()
  for (const source of refreshed) {
    if (sourceIsExcludedByDefault(source)) continue
    const origin = source.sourceUrl || source.sourcePath || ''
    if (!origin) continue
    const group = originGroups.get(origin) || []
    group.push(source)
    originGroups.set(origin, group)
  }
  for (const group of originGroups.values()) {
    if (group.length < 2) continue
    const canonical = canonicalSourceForGroup(group)
    for (const source of group) {
      if (source.id === canonical.id || sourceIsSuperseded(source)) continue
      if ((source.lastIndexedAt || 0) >= (canonical.lastIndexedAt || 0)) continue
      await supersedeKnowledgeSource(source.id, canonical.id)
    }
  }

  return buildHygieneSummary(listStoredSources())
}

export function registerKnowledgeMaintenanceIdleCallback(): void {
  if (maintenanceRegistered) return
  maintenanceRegistered = true
  onNextIdleWindow(async () => {
    maintenanceRegistered = false
    await runKnowledgeHygieneMaintenance()
    registerKnowledgeMaintenanceIdleCallback()
  })
}
