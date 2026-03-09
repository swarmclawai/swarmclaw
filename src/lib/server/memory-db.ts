import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { createHash } from 'crypto'
import { genId } from '@/lib/id'
import type { MemoryEntry, FileReference, MemoryImage, MemoryReference } from '@/types'
import { getEmbedding, cosineSimilarity, serializeEmbedding, deserializeEmbedding } from './embeddings'
import { applyMMR } from './mmr'
import { loadSettings } from './storage'
import {
  normalizeLinkedMemoryIds,
  normalizeMemoryLookupLimits,
  resolveLookupRequest,
  traverseLinkedMemoryGraph,
  type MemoryLookupLimits,
} from './memory-graph'
import { isWorkingMemoryCategory } from './memory-tiers'

import { DATA_DIR, WORKSPACE_DIR } from './data-dir'
import { tryResolvePathWithinBaseDir } from './path-utils'

const DB_PATH = path.join(DATA_DIR, 'memory.db')
const IMAGES_DIR = path.join(DATA_DIR, 'memory-images')
const APP_STATE_ROOT_DIR = path.dirname(DATA_DIR)

const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024 // 10MB
const IMAGE_EXT_WHITELIST = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'])
export const MAX_FTS_QUERY_TERMS = 6
export const MAX_FTS_TERM_LENGTH = 48
const MAX_FTS_RESULT_ROWS = 50
const MAX_MERGED_RESULTS = 80

export const MEMORY_FTS_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
  'i', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'with',
  'you', 'your',
])

export type MemoryScopeMode = 'auto' | 'all' | 'global' | 'agent' | 'session' | 'project'
export type MemoryRerankMode = 'balanced' | 'semantic' | 'lexical'

export interface MemoryScopeFilter {
  mode: MemoryScopeMode
  agentId?: string | null
  sessionId?: string | null
  projectRoot?: string | null
}

export interface MemorySearchOptions {
  scope?: MemoryScopeFilter
  rerankMode?: MemoryRerankMode
}

function normalizeScopeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizePathForScope(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return path.normalize(trimmed).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function memorySearchText(entry: MemoryEntry): string {
  const refs = Array.isArray(entry.references)
    ? entry.references.map((ref) => `${ref.type} ${ref.path || ''} ${ref.title || ''} ${ref.note || ''}`).join(' ')
    : ''
  return `${entry.title || ''} ${entry.content || ''} ${refs}`.toLowerCase()
}

function tokenizeForRerank(input: string): string[] {
  const raw = String(input || '').toLowerCase().match(/[a-z0-9][a-z0-9._:/-]*/g) || []
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of raw) {
    if (token.length < 2) continue
    if (MEMORY_FTS_STOP_WORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

function keywordOverlapScore(queryTokens: string[], entryText: string): number {
  if (!queryTokens.length) return 0
  const corpus = entryText.toLowerCase()
  let matched = 0
  for (const token of queryTokens) {
    if (token.length < 3) continue
    if (corpus.includes(token)) matched++
  }
  return matched / queryTokens.length
}

function entryRootsForScope(entry: MemoryEntry): string[] {
  const roots = new Set<string>()
  const add = (raw: unknown) => {
    const normalized = normalizePathForScope(raw)
    if (normalized) roots.add(normalized)
  }

  add((entry.metadata as Record<string, unknown> | undefined)?.projectRoot)

  if (Array.isArray(entry.references)) {
    for (const ref of entry.references) {
      add(ref.projectRoot)
      if (ref.type === 'project') add(ref.path)
      if (ref.type === 'folder' || ref.type === 'file') add(ref.path)
    }
  }

  if (Array.isArray(entry.filePaths)) {
    for (const ref of entry.filePaths) {
      add(ref.projectRoot)
      add(ref.path)
    }
  }

  return [...roots]
}

function scopeAllowsAgentAccess(entry: MemoryEntry, agentId: string): boolean {
  if (entry.agentId === agentId) return true
  if (Array.isArray(entry.sharedWith) && entry.sharedWith.includes(agentId)) return true
  return false
}

export function normalizeMemoryScopeMode(raw: unknown): MemoryScopeMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'shared') return 'global'
  if (value === 'all' || value === 'global' || value === 'agent' || value === 'session' || value === 'project') return value
  return 'auto'
}

export function filterMemoriesByScope(entries: MemoryEntry[], scope?: MemoryScopeFilter): MemoryEntry[] {
  if (!scope || scope.mode === 'all') return entries
  const mode = normalizeMemoryScopeMode(scope.mode)
  const agentId = normalizeScopeIdentifier(scope.agentId)
  const sessionId = normalizeScopeIdentifier(scope.sessionId)
  const projectRoot = normalizePathForScope(scope.projectRoot)

  if (mode === 'global') {
    return entries.filter((entry) => !entry.agentId)
  }

  if (mode === 'agent') {
    if (!agentId) return []
    return entries.filter((entry) => scopeAllowsAgentAccess(entry, agentId))
  }

  if (mode === 'session') {
    if (!sessionId) return []
    return entries.filter((entry) => entry.sessionId === sessionId)
  }

  if (mode === 'project') {
    if (!projectRoot) return []
    return entries.filter((entry) => {
      const roots = entryRootsForScope(entry)
      return roots.some((root) => root === projectRoot || root.startsWith(`${projectRoot}/`))
    })
  }

  // auto
  if (!agentId) return entries
  return entries.filter((entry) => !entry.agentId || scopeAllowsAgentAccess(entry, agentId))
}

function computeContentHash(category: string, content: string): string {
  const normalized = `${category}|${content.toLowerCase().trim()}`
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

function shouldSkipSearchQuery(input: string): boolean {
  const text = String(input || '').toLowerCase().trim()
  if (!text) return true
  if (text.length > 1200) return true
  if (text.includes('swarm_heartbeat_check')) return true
  if (text.includes('opencode_test_ok')) return true
  if (text.includes('reply exactly') && text.includes('heartbeat')) return true
  return false
}

// Simple cache for query embeddings to avoid blocking
const embeddingCache = new Map<string, number[]>()

function getEmbeddingSync(query: string): number[] | null {
  const cached = embeddingCache.get(query)
  if (cached) return cached
  // Kick off async computation for next time
  getEmbedding(query).then((emb) => {
    if (emb) embeddingCache.set(query, emb)
    // Evict old entries
    if (embeddingCache.size > 100) {
      const firstKey = embeddingCache.keys().next().value
      if (firstKey) embeddingCache.delete(firstKey)
    }
  }).catch(() => { /* ok */ })
  return null
}

function parseImageDimensionsFromSharp(metadata: { width?: number; height?: number }): { width?: number; height?: number } {
  const width = typeof metadata.width === 'number' ? metadata.width : undefined
  const height = typeof metadata.height === 'number' ? metadata.height : undefined
  return { width, height }
}

function normalizeImageExt(sourcePath: string): string {
  const ext = path.extname(sourcePath).toLowerCase()
  return IMAGE_EXT_WHITELIST.has(ext) ? ext : '.jpg'
}

/** Compress an image file and store it in the memory-images directory. Returns structured image metadata. */
export async function storeMemoryImageAsset(sourcePath: string, memoryId: string): Promise<MemoryImage> {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Image file not found: ${sourcePath}`)
  }
  const sourceStat = fs.statSync(sourcePath)
  if (sourceStat.size > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`Image exceeds max size (${MAX_IMAGE_INPUT_BYTES} bytes): ${sourcePath}`)
  }

  // Ensure images directory exists
  fs.mkdirSync(IMAGES_DIR, { recursive: true })

  const ext = normalizeImageExt(sourcePath)
  const destFilename = `${memoryId}${ext}`
  const destPath = path.join(IMAGES_DIR, destFilename)
  const jpgPath = destPath.replace(/\.[^.]+$/, '.jpg')

  try {
    // Try to use sharp for compression
    const sharp = (await import('sharp')).default
    const transformed = sharp(sourcePath)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 })
    const info = await transformed.toFile(jpgPath)
    const relPath = `data/memory-images/${path.basename(jpgPath)}`
    return {
      path: relPath,
      mimeType: 'image/jpeg',
      ...parseImageDimensionsFromSharp(info),
      sizeBytes: info.size,
    }
  } catch {
    // Fallback: copy file as-is if sharp is not available
    fs.copyFileSync(sourcePath, destPath)
    const stat = fs.statSync(destPath)
    const mimeType = ext === '.png'
      ? 'image/png'
      : ext === '.gif'
        ? 'image/gif'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/jpeg'
    return {
      path: `data/memory-images/${destFilename}`,
      mimeType,
      sizeBytes: stat.size,
    }
  }
}

export async function storeMemoryImageFromDataUrl(dataUrl: string, memoryId: string): Promise<MemoryImage> {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid image data URL format')
  const [, mimeType, base64] = match
  const buf = Buffer.from(base64, 'base64')
  if (buf.length > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`Image exceeds max size (${MAX_IMAGE_INPUT_BYTES} bytes)`)
  }

  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  const ext = mimeType.includes('png')
    ? '.png'
    : mimeType.includes('gif')
      ? '.gif'
      : mimeType.includes('webp')
        ? '.webp'
        : '.jpg'
  const tmpPath = path.join(IMAGES_DIR, `${memoryId}-upload${ext}`)
  fs.writeFileSync(tmpPath, buf)
  try {
    return await storeMemoryImageAsset(tmpPath, memoryId)
  } finally {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

/** Backward-compatible helper returning only the stored relative path. */
export async function storeMemoryImage(sourcePath: string, memoryId: string): Promise<string> {
  const image = await storeMemoryImageAsset(sourcePath, memoryId)
  return image.path
}

let _db: ReturnType<typeof initDb> | null = null

export function getMemoryLookupLimits(settingsOverride?: Record<string, unknown>): MemoryLookupLimits {
  const settings = settingsOverride || loadSettings()
  return normalizeMemoryLookupLimits(settings)
}

function parseJsonSafe<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeReferencePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value ? value : undefined
}

function canonicalText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s:/.-]/g, '')
    .trim()
}

export function buildFtsQuery(input: string): string {
  const tokens = String(input || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._:/-]*/g) || []
  if (!tokens.length) return ''

  const unique: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const term = token.slice(0, MAX_FTS_TERM_LENGTH)
    if (term.length < 3) continue
    if (MEMORY_FTS_STOP_WORDS.has(term)) continue
    if (seen.has(term)) continue
    seen.add(term)
    unique.push(term)
    if (unique.length >= MAX_FTS_QUERY_TERMS) break
  }

  if (unique.length === 1) {
    return unique[0].length >= 5 ? `"${unique[0].replace(/"/g, '')}"` : ''
  }

  const selected = unique.slice(0, Math.min(4, MAX_FTS_QUERY_TERMS))
  return selected.map((term) => `"${term.replace(/"/g, '')}"`).join(' AND ')
}

function resolveExists(pathValue: string | undefined): boolean | undefined {
  if (!pathValue) return undefined
  const candidates = path.isAbsolute(pathValue)
    ? [pathValue]
    : [
      tryResolvePathWithinBaseDir(APP_STATE_ROOT_DIR, pathValue),
      tryResolvePathWithinBaseDir(WORKSPACE_DIR, pathValue),
    ].filter((candidate): candidate is string => !!candidate)
  if (candidates.length === 0) return undefined
  try {
    return candidates.some((candidate) => fs.existsSync(candidate))
  } catch {
    return undefined
  }
}

function normalizeReferences(
  rawRefs: unknown,
  legacyFilePaths: unknown,
): MemoryReference[] | undefined {
  const output: MemoryReference[] = []
  const seen = new Set<string>()

  const pushRef = (ref: MemoryReference) => {
    const key = `${ref.type}|${ref.path || ''}|${ref.projectRoot || ''}|${ref.title || ''}`
    if (seen.has(key)) return
    seen.add(key)
    output.push(ref)
  }

  if (Array.isArray(rawRefs)) {
    for (const raw of rawRefs) {
      if (!raw || typeof raw !== 'object') continue
      const obj = raw as Record<string, unknown>
      const type = typeof obj.type === 'string' ? obj.type : 'file'
      if (!['project', 'folder', 'file', 'task', 'session', 'url'].includes(type)) continue
      const pathValue = normalizeReferencePath(obj.path)
      const projectRoot = normalizeReferencePath(obj.projectRoot)
      const title = typeof obj.title === 'string' ? obj.title.trim() : undefined
      const note = typeof obj.note === 'string' ? obj.note.trim() : undefined
      const projectName = typeof obj.projectName === 'string' ? obj.projectName.trim() : undefined
      const ts = typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp)
        ? Math.trunc(obj.timestamp)
        : Date.now()
      const exists = resolveExists(pathValue) ?? (typeof obj.exists === 'boolean' ? obj.exists : undefined)
      pushRef({
        type: type as MemoryReference['type'],
        path: pathValue,
        projectRoot,
        projectName,
        title,
        note,
        exists,
        timestamp: ts,
      })
    }
  }

  const legacy = Array.isArray(legacyFilePaths) ? legacyFilePaths as FileReference[] : []
  for (const raw of legacy) {
    if (!raw || typeof raw !== 'object') continue
    const pathValue = normalizeReferencePath((raw as FileReference).path)
    if (!pathValue) continue
    const kind = (raw as FileReference).kind || 'file'
    const type: MemoryReference['type'] = kind === 'project' ? 'project' : (kind === 'folder' ? 'folder' : 'file')
    const timestamp = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
      ? Math.trunc(raw.timestamp)
      : Date.now()
    pushRef({
      type,
      path: pathValue,
      projectRoot: raw.projectRoot,
      projectName: raw.projectName,
      note: raw.contextSnippet,
      exists: typeof raw.exists === 'boolean' ? raw.exists : resolveExists(pathValue),
      timestamp,
    })
  }

  return output.length ? output : undefined
}

function referencesToLegacyFilePaths(references?: MemoryReference[]): FileReference[] | undefined {
  if (!references?.length) return undefined
  const fileRefs: FileReference[] = references
    .filter((ref) => ref.type === 'file' || ref.type === 'folder' || ref.type === 'project')
    .map((ref) => ({
      path: ref.path || '',
      contextSnippet: ref.note,
      kind: ref.type === 'project'
        ? 'project' as const
        : ref.type === 'folder'
          ? 'folder' as const
          : 'file' as const,
      projectRoot: ref.projectRoot,
      projectName: ref.projectName,
      exists: ref.exists,
      timestamp: ref.timestamp || Date.now(),
    }))
    .filter((ref) => !!ref.path)
  return fileRefs.length ? fileRefs : undefined
}

function normalizeImage(rawImage: unknown, legacyImagePath?: string | null): MemoryImage | null | undefined {
  if (rawImage && typeof rawImage === 'object') {
    const obj = rawImage as Record<string, unknown>
    const pathValue = normalizeReferencePath(obj.path)
    if (pathValue) {
      return {
        path: pathValue,
        mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : undefined,
        width: typeof obj.width === 'number' ? obj.width : undefined,
        height: typeof obj.height === 'number' ? obj.height : undefined,
        sizeBytes: typeof obj.sizeBytes === 'number' ? obj.sizeBytes : undefined,
      }
    }
  }
  const legacy = normalizeReferencePath(legacyImagePath || undefined)
  if (legacy) return { path: legacy }
  return undefined
}

function initDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agentId TEXT,
      sessionId TEXT,
      category TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `)

  // Safe column migrations for older databases
  for (const col of [
    'agentId TEXT',
    'sessionId TEXT',
    'embedding BLOB',
    'filePaths TEXT',
    'imagePath TEXT',
    'linkedMemoryIds TEXT',
    '"references" TEXT',
    'image TEXT',
    'pinned INTEGER DEFAULT 0',
    'sharedWith TEXT',
    'accessCount INTEGER DEFAULT 0',
    'lastAccessedAt INTEGER DEFAULT 0',
    'contentHash TEXT',
    'reinforcementCount INTEGER DEFAULT 0',
  ]) {
    try { db.exec(`ALTER TABLE memories ADD COLUMN ${col}`) } catch { /* already exists */ }
  }

  // Partial index for fast pinned-memory lookups
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(agentId, updatedAt DESC) WHERE pinned = 1`)

  // Index for content hash dedup lookups
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(contentHash) WHERE contentHash IS NOT NULL`)

  // FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title, content, category,
      content='memories',
      content_rowid='rowid'
    )
  `)

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `)

  // Critical list-path indexes for large memory datasets.
  // Without these, ORDER BY updatedAt DESC LIMIT N performs a full table scan + temp sort.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updatedAt DESC)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_agent_updated_at ON memories(agentId, updatedAt DESC)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_session_category_updated_at ON memories(sessionId, category, updatedAt DESC)
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, category)
      VALUES ('delete', old.rowid, old.title, old.content, old.category);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, category)
      VALUES ('delete', old.rowid, old.title, old.content, old.category);
      INSERT INTO memories_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `)

  const rowsForMigration = db.prepare(`
    SELECT id, filePaths, imagePath, linkedMemoryIds, "references" as refs, image
    FROM memories
  `).all() as Array<{
    id: string
    filePaths: string | null
    imagePath: string | null
    linkedMemoryIds: string | null
    refs: string | null
    image: string | null
  }>

  const migrationStmt = db.prepare(`
    UPDATE memories
    SET "references" = ?, image = ?, linkedMemoryIds = ?
    WHERE id = ?
  `)

  const migrateLegacyRows = db.transaction(() => {
    let migrated = 0
    for (const row of rowsForMigration) {
      const legacyFilePaths = parseJsonSafe<FileReference[]>(row.filePaths, [])
      const refs = normalizeReferences(parseJsonSafe<MemoryReference[]>(row.refs, []), legacyFilePaths)
      const image = normalizeImage(parseJsonSafe<MemoryImage | null>(row.image, null), row.imagePath)
      const linkedIds = normalizeLinkedMemoryIds(parseJsonSafe<string[]>(row.linkedMemoryIds, []), row.id)

      const nextRefs = refs?.length ? JSON.stringify(refs) : null
      const nextImage = image ? JSON.stringify(image) : null
      const nextLinks = linkedIds.length ? JSON.stringify(linkedIds) : null

      if (nextRefs === row.refs && nextImage === row.image && nextLinks === row.linkedMemoryIds) continue
      migrationStmt.run(nextRefs, nextImage, nextLinks, row.id)
      migrated++
    }
    if (migrated > 0) {
      console.log(`[memory-db] Migrated ${migrated} legacy memory row(s) to graph schema`)
    }
  })
  migrateLegacyRows()

  // Backfill contentHash for existing rows that don't have one yet
  const unhashed = (db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE contentHash IS NULL`).get() as { cnt: number }).cnt
  if (unhashed > 0) {
    const backfillRows = db.prepare(`SELECT id, category, content FROM memories WHERE contentHash IS NULL`).all() as Array<{ id: string; category: string; content: string }>
    const backfillStmt = db.prepare(`UPDATE memories SET contentHash = ? WHERE id = ?`)
    const BATCH = 500
    for (let i = 0; i < backfillRows.length; i += BATCH) {
      const batch = backfillRows.slice(i, i + BATCH)
      const tx = db.transaction(() => {
        for (const r of batch) {
          backfillStmt.run(computeContentHash(r.category, r.content), r.id)
        }
      })
      tx()
    }
    console.log(`[memory-db] Backfilled contentHash for ${backfillRows.length} memory row(s)`)
  }

  // Fresh installs now start with an empty memory graph.
  // Durable memories are created only from actual user/agent interactions.

  const stmts = {
    insert: db.prepare(`
      INSERT INTO memories (
        id, agentId, sessionId, category, title, content, metadata, embedding,
        "references", filePaths, image, imagePath, linkedMemoryIds, pinned, sharedWith, contentHash, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE memories
      SET agentId=?, sessionId=?, category=?, title=?, content=?, metadata=?, embedding=?,
          "references"=?, filePaths=?, image=?, imagePath=?, linkedMemoryIds=?, pinned=?, sharedWith=?, updatedAt=?
      WHERE id=?
    `),
    delete: db.prepare(`DELETE FROM memories WHERE id=?`),
    getById: db.prepare(`SELECT * FROM memories WHERE id=?`),
    getByIds: (ids: string[]) => {
      if (!ids.length) return []
      const placeholders = ids.map(() => '?').join(',')
      return db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as any[]
    },
    listAll: db.prepare(`SELECT * FROM memories ORDER BY updatedAt DESC LIMIT ?`),
    listByAgent: db.prepare(`SELECT * FROM memories WHERE agentId=? ORDER BY updatedAt DESC LIMIT ?`),
    listByAgentOrShared: db.prepare(`SELECT * FROM memories WHERE agentId=? OR sharedWith LIKE ? ORDER BY updatedAt DESC LIMIT ?`),
    listPinnedByAgent: db.prepare(`SELECT * FROM memories WHERE pinned = 1 AND agentId = ? ORDER BY updatedAt DESC LIMIT ?`),
    listPinnedAll: db.prepare(`SELECT * FROM memories WHERE pinned = 1 ORDER BY updatedAt DESC LIMIT ?`),
    search: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
      LIMIT ${MAX_FTS_RESULT_ROWS}
    `),
    searchByAgent: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND m.agentId = ?
      LIMIT ${MAX_FTS_RESULT_ROWS}
    `),
    searchByAgentOrShared: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND (m.agentId = ? OR m.sharedWith LIKE ?)
      LIMIT ${MAX_FTS_RESULT_ROWS}
    `),
    // Remove a linked ID from all memories that reference it (cleanup on delete)
    findMemoriesLinkingTo: db.prepare(`SELECT * FROM memories WHERE linkedMemoryIds LIKE ?`),
    updateLinks: db.prepare(`UPDATE memories SET linkedMemoryIds = ?, updatedAt = ? WHERE id = ?`),
    latestBySessionCategory: db.prepare(`
      SELECT * FROM memories
      WHERE sessionId = ? AND category = ?
      ORDER BY updatedAt DESC
      LIMIT 1
    `),
    allRowsByUpdated: db.prepare(`SELECT * FROM memories ORDER BY updatedAt DESC`),
    countsByAgent: db.prepare(`SELECT COALESCE(agentId, '_global') AS agentKey, COUNT(*) AS cnt FROM memories GROUP BY agentKey`),
    exactDuplicateBySessionCategory: db.prepare(`
      SELECT * FROM memories
      WHERE sessionId = ? AND category = ? AND title = ? AND content = ?
      ORDER BY updatedAt DESC
      LIMIT 1
    `),
    findByContentHash: db.prepare(`
      SELECT * FROM memories
      WHERE contentHash = ? AND agentId = ?
      ORDER BY updatedAt DESC
      LIMIT 1
    `),
    findByContentHashShared: db.prepare(`
      SELECT * FROM memories
      WHERE contentHash = ? AND agentId IS NULL
      ORDER BY updatedAt DESC
      LIMIT 1
    `),
    reinforceMemory: db.prepare(`
      UPDATE memories SET reinforcementCount = reinforcementCount + 1, updatedAt = ? WHERE id = ?
    `),
    bumpAccessCount: db.prepare(`
      UPDATE memories SET accessCount = accessCount + 1, lastAccessedAt = ? WHERE id = ?
    `),
  }

  function rowToEntry(row: Record<string, unknown>): MemoryEntry {
    const legacyFilePaths = parseJsonSafe<FileReference[]>(row.filePaths, [])
    const references = normalizeReferences(parseJsonSafe<MemoryReference[]>(row.references, []), legacyFilePaths)
    const image = normalizeImage(parseJsonSafe<MemoryImage | null>(row.image, null), typeof row.imagePath === 'string' ? row.imagePath : null)
    const filePaths = referencesToLegacyFilePaths(references)
    const linkedMemoryIds = normalizeLinkedMemoryIds(parseJsonSafe<string[]>(row.linkedMemoryIds, []), typeof row.id === 'string' ? row.id : undefined)

    return {
      id: String(row.id || ''),
      agentId: typeof row.agentId === 'string' ? row.agentId : null,
      sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
      category: typeof row.category === 'string' ? row.category : 'note',
      title: typeof row.title === 'string' ? row.title : 'Untitled',
      content: typeof row.content === 'string' ? row.content : '',
      metadata: parseJsonSafe<Record<string, unknown> | undefined>(row.metadata, undefined),
      references,
      filePaths,
      image,
      imagePath: image?.path || undefined,
      linkedMemoryIds: linkedMemoryIds.length ? linkedMemoryIds : undefined,
      pinned: row.pinned === 1,
      sharedWith: parseJsonSafe<string[]>(row.sharedWith, []).length ? parseJsonSafe<string[]>(row.sharedWith, []) : undefined,
      accessCount: typeof row.accessCount === 'number' ? row.accessCount : 0,
      lastAccessedAt: typeof row.lastAccessedAt === 'number' ? row.lastAccessedAt : 0,
      contentHash: typeof row.contentHash === 'string' ? row.contentHash : undefined,
      reinforcementCount: typeof row.reinforcementCount === 'number' ? row.reinforcementCount : 0,
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    }
  }

  function traverseLinked(
    seedEntries: MemoryEntry[],
    limits: MemoryLookupLimits,
  ): { entries: MemoryEntry[]; truncated: boolean; expandedLinkedCount: number } {
    const traversal = traverseLinkedMemoryGraph(
      seedEntries,
      limits,
      (ids) => {
        const linkedRows = stmts.getByIds(ids)
        return linkedRows.map((row) => rowToEntry(row as Record<string, unknown>))
      },
    )
    return traversal
  }

  const getAllWithEmbeddings = db.prepare(
    `SELECT * FROM memories WHERE embedding IS NOT NULL`
  )
  const getAllWithEmbeddingsByAgentOrShared = db.prepare(
    `SELECT * FROM memories WHERE embedding IS NOT NULL AND (agentId = ? OR sharedWith LIKE ?)`
  )

  return {
    add(data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
      const id = genId(6)
      const now = Date.now()
      const references = normalizeReferences(data.references, data.filePaths)
      const legacyFilePaths = referencesToLegacyFilePaths(references)
      const image = normalizeImage(data.image, data.imagePath)
      const linkedMemoryIds = normalizeLinkedMemoryIds(data.linkedMemoryIds, id)
      const sessionId = data.sessionId || null
      const category = data.category || 'note'
      const title = data.title || 'Untitled'
      const content = data.content || ''
      const contentHash = computeContentHash(category, content)

      // Content-hash dedup: if same content already exists for this agent, reinforce instead of duplicating
      const agentId = data.agentId || null
      const existingByHash = agentId
        ? stmts.findByContentHash.get(contentHash, agentId) as Record<string, unknown> | undefined
        : stmts.findByContentHashShared.get(contentHash) as Record<string, unknown> | undefined
      if (existingByHash) {
        stmts.reinforceMemory.run(now, existingByHash.id)
        return rowToEntry({ ...existingByHash, reinforcementCount: ((existingByHash.reinforcementCount as number) || 0) + 1, updatedAt: now })
      }

      // Guard against exact duplicate memory spam for the same session/category.
      if (sessionId) {
        const duplicate = stmts.exactDuplicateBySessionCategory.get(sessionId, category, title, content) as Record<string, unknown> | undefined
        if (duplicate) return rowToEntry(duplicate)
      }
      const pinned = data.pinned ? 1 : 0
      const sharedWith = Array.isArray(data.sharedWith) && data.sharedWith.length ? JSON.stringify(data.sharedWith) : null
      stmts.insert.run(
        id, agentId, sessionId,
        category, title, content,
        data.metadata ? JSON.stringify(data.metadata) : null,
        null, // embedding computed async
        references?.length ? JSON.stringify(references) : null,
        legacyFilePaths?.length ? JSON.stringify(legacyFilePaths) : null,
        image ? JSON.stringify(image) : null,
        image?.path || null,
        linkedMemoryIds.length ? JSON.stringify(linkedMemoryIds) : null,
        pinned,
        sharedWith,
        contentHash,
        now, now,
      )
      // Compute embedding in background (fire-and-forget)
      const text = `${title} ${content}`.slice(0, 4000)
      getEmbedding(text).then((emb) => {
        if (emb) {
          db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(
            serializeEmbedding(emb), id,
          )
        }
      }).catch(() => { /* embedding not available, ok */ })

      // Keep memory links bidirectional by default.
      if (linkedMemoryIds.length) this.link(id, linkedMemoryIds, true)

      const created = this.get(id)
      if (created) return created
      return {
        ...data,
        id,
        sessionId,
        category,
        title,
        content,
        references,
        filePaths: legacyFilePaths,
        image,
        imagePath: image?.path || null,
        linkedMemoryIds,
        accessCount: 0,
        lastAccessedAt: 0,
        contentHash,
        reinforcementCount: 0,
        createdAt: now,
        updatedAt: now,
      }
    },

    update(id: string, updates: Partial<MemoryEntry>): MemoryEntry | null {
      const existing = stmts.getById.get(id) as Record<string, unknown> | undefined
      if (!existing) return null
      const existingEntry = rowToEntry(existing)
      const merged = { ...existingEntry, ...updates }
      const references = normalizeReferences(merged.references, merged.filePaths)
      const legacyFilePaths = referencesToLegacyFilePaths(references)
      const image = normalizeImage(merged.image, merged.imagePath)
      const nextLinked = normalizeLinkedMemoryIds(merged.linkedMemoryIds, id)
      const prevLinked = normalizeLinkedMemoryIds(existingEntry.linkedMemoryIds, id)
      const now = Date.now()
      const pinnedVal = merged.pinned ? 1 : 0
      const sharedWithVal = Array.isArray(merged.sharedWith) && merged.sharedWith.length ? JSON.stringify(merged.sharedWith) : null
      stmts.update.run(
        merged.agentId || null, merged.sessionId || null,
        merged.category, merged.title, merged.content,
        merged.metadata ? JSON.stringify(merged.metadata) : null,
        existing.embedding || null, // preserve existing embedding
        references?.length ? JSON.stringify(references) : null,
        legacyFilePaths?.length ? JSON.stringify(legacyFilePaths) : null,
        image ? JSON.stringify(image) : null,
        image?.path || null,
        nextLinked.length ? JSON.stringify(nextLinked) : null,
        pinnedVal,
        sharedWithVal,
        now, id,
      )

      // Keep links reciprocal when link set changes.
      if (updates.linkedMemoryIds) {
        const added = nextLinked.filter((lid) => !prevLinked.includes(lid))
        const removed = prevLinked.filter((lid) => !nextLinked.includes(lid))
        if (added.length) this.link(id, added, true)
        if (removed.length) this.unlink(id, removed, true)
      }

      // Re-compute embedding if content changed
      if (updates.title || updates.content) {
        const text = `${merged.title} ${merged.content}`.slice(0, 4000)
        getEmbedding(text).then((emb) => {
          if (emb) {
            db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(
              serializeEmbedding(emb), id,
            )
          }
        }).catch(() => { /* ok */ })
      }
      return this.get(id)
    },

    delete(id: string) {
      // Clean up image file if present
      const row = stmts.getById.get(id) as Record<string, unknown> | undefined
      const entry = row ? rowToEntry(row) : null
      if (entry?.image?.path || entry?.imagePath) {
        const imagePath = entry.image?.path || entry.imagePath || ''
        const candidatePaths = path.isAbsolute(imagePath)
          ? [imagePath]
          : [
            tryResolvePathWithinBaseDir(APP_STATE_ROOT_DIR, imagePath),
            tryResolvePathWithinBaseDir(WORKSPACE_DIR, imagePath),
          ].filter((candidate): candidate is string => !!candidate)
        for (const imgPath of candidatePaths) {
          try {
            fs.unlinkSync(imgPath)
            break
          } catch {
            // file may not exist
          }
        }
      }
      stmts.delete.run(id)
      // Remove this ID from any other memory's linkedMemoryIds
      const linking = stmts.findMemoriesLinkingTo.all(`%"${id}"%`) as any[]
      for (const row of linking) {
        const ids = normalizeLinkedMemoryIds(parseJsonSafe<string[]>(row.linkedMemoryIds, []), row.id)
        const filtered = ids.filter((lid: string) => lid !== id)
        stmts.updateLinks.run(filtered.length ? JSON.stringify(filtered) : null, Date.now(), row.id)
      }
    },

    get(id: string): MemoryEntry | null {
      const row = stmts.getById.get(id) as Record<string, unknown> | undefined
      if (!row) return null
      // Bump access count (non-blocking)
      setTimeout(() => {
        try { stmts.bumpAccessCount.run(Date.now(), id) } catch { /* best-effort */ }
      }, 0)
      return rowToEntry(row)
    },

    /** Get a memory and its linked memories via BFS traversal */
    getWithLinked(
      id: string,
      maxDepth?: number,
      maxResults?: number,
      maxLinkedExpansion?: number,
    ): { entries: MemoryEntry[]; truncated: boolean; expandedLinkedCount: number; limits: MemoryLookupLimits } | null {
      const row = stmts.getById.get(id) as Record<string, unknown> | undefined
      if (!row) return null
      const entry = rowToEntry(row)
      const defaults = getMemoryLookupLimits()
      const limits = resolveLookupRequest(defaults, {
        depth: maxDepth ?? defaults.maxDepth,
        limit: maxResults ?? defaults.maxPerLookup,
        linkedLimit: maxLinkedExpansion ?? defaults.maxLinkedExpansion,
      })
      const traversal = traverseLinked([entry], limits)
      return { ...traversal, limits }
    },

    /** Add links from one memory to others */
    link(id: string, targetIds: string[], bidirectional = true): MemoryEntry | null {
      const existing = stmts.getById.get(id) as Record<string, unknown> | undefined
      if (!existing) return null
      const entry = rowToEntry(existing)
      const validTargetIds = normalizeLinkedMemoryIds(targetIds, id)
      const targetRows = stmts.getByIds(validTargetIds)
      const existingTargetIds = new Set((targetRows as Array<Record<string, unknown>>).map((row) => String(row.id)))
      const filteredTargets = validTargetIds.filter((tid) => existingTargetIds.has(tid))

      const sourceLinks = new Set(normalizeLinkedMemoryIds(entry.linkedMemoryIds, id))
      for (const tid of filteredTargets) sourceLinks.add(tid)

      const now = Date.now()
      const tx = db.transaction(() => {
        const sourceValues = [...sourceLinks]
        stmts.updateLinks.run(sourceValues.length ? JSON.stringify(sourceValues) : null, now, id)

        if (!bidirectional) return
        for (const targetRow of targetRows as Array<Record<string, unknown>>) {
          const targetEntry = rowToEntry(targetRow)
          const targetLinks = new Set(normalizeLinkedMemoryIds(targetEntry.linkedMemoryIds, targetEntry.id))
          targetLinks.add(id)
          const next = [...targetLinks]
          stmts.updateLinks.run(next.length ? JSON.stringify(next) : null, now, targetEntry.id)
        }
      })
      tx()

      return this.get(id)
    },

    /** Remove links from one memory to others */
    unlink(id: string, targetIds: string[], bidirectional = true): MemoryEntry | null {
      const existing = stmts.getById.get(id) as Record<string, unknown> | undefined
      if (!existing) return null
      const entry = rowToEntry(existing)
      const removeSet = new Set(normalizeLinkedMemoryIds(targetIds, id))
      const now = Date.now()
      const tx = db.transaction(() => {
        const sourceLinks = normalizeLinkedMemoryIds(entry.linkedMemoryIds, id).filter((lid) => !removeSet.has(lid))
        stmts.updateLinks.run(sourceLinks.length ? JSON.stringify(sourceLinks) : null, now, id)

        if (!bidirectional || !removeSet.size) return
        const targetRows = stmts.getByIds([...removeSet]) as Array<Record<string, unknown>>
        for (const targetRow of targetRows) {
          const targetEntry = rowToEntry(targetRow)
          const next = normalizeLinkedMemoryIds(targetEntry.linkedMemoryIds, targetEntry.id).filter((lid) => lid !== id)
          stmts.updateLinks.run(next.length ? JSON.stringify(next) : null, now, targetEntry.id)
        }
      })
      tx()

      return this.get(id)
    },

    search(query: string, agentId?: string, options: MemorySearchOptions = {}): MemoryEntry[] {
      if (shouldSkipSearchQuery(query)) return []
      const startedAt = Date.now()
      const normalizedAgentId = normalizeScopeIdentifier(agentId)
      const rerankMode: MemoryRerankMode = options.rerankMode === 'semantic' || options.rerankMode === 'lexical'
        ? options.rerankMode
        : 'balanced'
      const scopeMode = options.scope
        ? normalizeMemoryScopeMode(options.scope.mode)
        : (normalizedAgentId ? 'agent' : 'all')
      const scopeFilter: MemoryScopeFilter | undefined = scopeMode === 'all'
        ? undefined
        : {
            mode: scopeMode,
            agentId: options.scope?.agentId ?? normalizedAgentId,
            sessionId: options.scope?.sessionId,
            projectRoot: options.scope?.projectRoot,
          }

      // FTS keyword search (includes memories shared with this agent)
      const ftsQuery = buildFtsQuery(query)
      const fastAgentOnlyScope = scopeMode === 'agent' && !!normalizedAgentId
      const ftsResults: MemoryEntry[] = ftsQuery
        ? (fastAgentOnlyScope
            ? stmts.searchByAgentOrShared.all(ftsQuery, normalizedAgentId, `%"${normalizedAgentId}"%`) as any[]
            : stmts.search.all(ftsQuery) as any[]
          ).map(rowToEntry)
        : []
      const ftsHitIds = new Set<string>(ftsResults.map((entry) => entry.id))

      // Attempt vector search (synchronous — uses cached embedding if available)
      const vectorSimilarityScores = new Map<string, number>()
      const rawEmbeddings = new Map<string, number[]>()
      let vectorResults: MemoryEntry[] = []
      let queryEmbeddingResult: number[] | undefined
      try {
        const queryEmbedding = getEmbeddingSync(query)
        queryEmbeddingResult = queryEmbedding || undefined
        if (queryEmbedding) {
          const rows = fastAgentOnlyScope
            ? getAllWithEmbeddingsByAgentOrShared.all(normalizedAgentId, `%"${normalizedAgentId}"%`) as any[]
            : getAllWithEmbeddings.all() as any[]

          const scored = rows
            .map((row) => {
              const emb = deserializeEmbedding(row.embedding)
              const score = cosineSimilarity(queryEmbedding, emb)
              return { row, score, emb }
            })
            .filter((s) => s.score > 0.3) // relevance threshold
            .sort((a, b) => b.score - a.score)
            .slice(0, 20)

          vectorResults = scored.map((s) => {
            const entry = rowToEntry(s.row)
            vectorSimilarityScores.set(entry.id, s.score)
            rawEmbeddings.set(entry.id, s.emb)
            return entry
          })
        }
      } catch {
        // Vector search unavailable, use FTS only
      }

      // Merge: deduplicate by id
      const seen = new Set<string>()
      const merged: MemoryEntry[] = []
      for (const entry of [...ftsResults, ...vectorResults]) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id)
          merged.push(entry)
        }
      }
      const scopedMerged = scopeFilter ? filterMemoriesByScope(merged, scopeFilter) : merged

      // Retrieval v2 rerank: hybrid relevance (semantic + lexical + FTS signal), then salience decay/boosting.
      const queryTokens = tokenizeForRerank(query)
      const now = Date.now()
      const HALF_LIFE_DAYS = 30
      const salienceScored = scopedMerged.map((entry) => {
        const semantic = vectorSimilarityScores.get(entry.id) ?? (ftsHitIds.has(entry.id) ? 0.42 : 0.18)
        const lexical = keywordOverlapScore(queryTokens, memorySearchText(entry))
        const ftsSignal = ftsHitIds.has(entry.id) ? 1 : 0
        const relevance = rerankMode === 'semantic'
          ? (semantic * 0.78 + ftsSignal * 0.22)
          : rerankMode === 'lexical'
            ? (lexical * 0.78 + ftsSignal * 0.22)
            : (semantic * 0.50 + lexical * 0.35 + ftsSignal * 0.15)
        const daysSinceAccess = (now - (entry.lastAccessedAt || entry.updatedAt)) / 86_400_000
        const recencyDecay = Math.exp(-0.693 * daysSinceAccess / HALF_LIFE_DAYS)
        const reinforcement = Math.log((entry.reinforcementCount || 0) + 1) + 1
        const pinnedBoost = entry.pinned ? 1.5 : 1.0
        const salience = Math.max(0.0001, relevance) * recencyDecay * reinforcement * pinnedBoost
        return { entry, salience, embedding: rawEmbeddings.get(entry.id) }
      })

      // Apply MMR when semantic reranking is enabled and query embeddings are available.
      let out: MemoryEntry[] = []
      const useMmr = !!queryEmbeddingResult && rerankMode !== 'lexical'
      if (useMmr && queryEmbeddingResult) {
        out = applyMMR(queryEmbeddingResult, salienceScored, MAX_MERGED_RESULTS, 0.6)
      } else {
        salienceScored.sort((a, b) => b.salience - a.salience)
        out = salienceScored.slice(0, MAX_MERGED_RESULTS).map((s) => s.entry)
      }

      // Bump access counts for returned results (non-blocking)
      if (out.length) {
        const returnedIds = out.map((e) => e.id)
        setTimeout(() => {
          try {
            const ts = Date.now()
            for (const mid of returnedIds) stmts.bumpAccessCount.run(ts, mid)
          } catch { /* best-effort */ }
        }, 0)
      }

      const elapsed = Date.now() - startedAt
      if (elapsed > 1200) {
        console.warn(
          `[memory-db] Slow search ${elapsed}ms (scope=${scopeMode}, rerank=${rerankMode}, rawLen=${String(query || '').length}, fts="${ftsQuery.slice(0, 180)}")`,
        )
      }
      return out
    },

    /** Search with linked memory traversal */
    searchWithLinked(
      query: string,
      agentId?: string,
      maxDepth?: number,
      maxResults?: number,
      maxLinkedExpansion?: number,
      options: MemorySearchOptions = {},
    ): { entries: MemoryEntry[]; truncated: boolean; expandedLinkedCount: number; limits: MemoryLookupLimits } {
      const baseResults = this.search(query, agentId, options)
      const defaults = getMemoryLookupLimits()
      const limits = resolveLookupRequest(defaults, {
        depth: maxDepth ?? defaults.maxDepth,
        limit: maxResults ?? defaults.maxPerLookup,
        linkedLimit: maxLinkedExpansion ?? defaults.maxLinkedExpansion,
      })
      if (limits.maxDepth <= 0) {
        return {
          entries: baseResults.slice(0, limits.maxPerLookup),
          truncated: baseResults.length > limits.maxPerLookup,
          expandedLinkedCount: 0,
          limits,
        }
      }
      const traversal = traverseLinked(baseResults, limits)
      return { ...traversal, limits }
    },

    list(agentId?: string, limit = 200): MemoryEntry[] {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
      const rows = agentId
        ? stmts.listByAgentOrShared.all(agentId, `%"${agentId}"%`, safeLimit) as any[]
        : stmts.listAll.all(safeLimit) as any[]
      return rows.map(rowToEntry)
    },

    listPinned(agentId?: string, limit = 20): MemoryEntry[] {
      const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
      const rows = agentId
        ? stmts.listPinnedByAgent.all(agentId, safeLimit) as any[]
        : stmts.listPinnedAll.all(safeLimit) as any[]
      return rows.map(rowToEntry)
    },

    countsByAgent(): Record<string, number> {
      const rows = stmts.countsByAgent.all() as { agentKey: string; cnt: number }[]
      const result: Record<string, number> = {}
      for (const row of rows) result[row.agentKey] = row.cnt
      return result
    },

    getByAgent(agentId: string, limit = 200): MemoryEntry[] {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
      return (stmts.listByAgent.all(agentId, safeLimit) as any[]).map(rowToEntry)
    },

    analyzeMaintenance(ttlHours = 24): {
      total: number
      exactDuplicateCandidates: number
      canonicalDuplicateCandidates: number
      staleWorkingCandidates: number
    } {
      const rows = (stmts.allRowsByUpdated.all() as any[]).map(rowToEntry)
      const seenExact = new Set<string>()
      const seenCanonical = new Set<string>()
      let exactDuplicateCandidates = 0
      let canonicalDuplicateCandidates = 0
      let staleWorkingCandidates = 0
      const cutoff = Date.now() - Math.max(1, Math.min(24 * 365, Math.trunc(ttlHours))) * 3600_000

      for (const row of rows) {
        const keyExact = [
          row.agentId || '',
          row.sessionId || '',
          row.category || '',
          row.title || '',
          row.content || '',
        ].join('|')
        if (seenExact.has(keyExact)) exactDuplicateCandidates++
        else seenExact.add(keyExact)

        const keyCanonical = [
          row.agentId || '',
          row.sessionId || '',
          row.category || '',
          canonicalText(row.title),
          canonicalText(row.content),
        ].join('|')
        if (seenCanonical.has(keyCanonical)) canonicalDuplicateCandidates++
        else seenCanonical.add(keyCanonical)

        const isWorkingLike = isWorkingMemoryCategory(row.category)
        if (isWorkingLike && (row.updatedAt || row.createdAt || 0) < cutoff) staleWorkingCandidates++
      }

      return {
        total: rows.length,
        exactDuplicateCandidates,
        canonicalDuplicateCandidates,
        staleWorkingCandidates,
      }
    },

    maintain(opts?: {
      dedupe?: boolean
      canonicalDedupe?: boolean
      pruneWorking?: boolean
      ttlHours?: number
      maxDeletes?: number
    }): {
      deduped: number
      pruned: number
      deletedIds: string[]
      analyzed: {
        total: number
        exactDuplicateCandidates: number
        canonicalDuplicateCandidates: number
        staleWorkingCandidates: number
      }
    } {
      const options = opts || {}
      const rows = (stmts.allRowsByUpdated.all() as any[]).map(rowToEntry)
      const analyzed = this.analyzeMaintenance(options.ttlHours)
      const deleteBudget = Math.max(1, Math.min(20_000, Math.trunc(options.maxDeletes || 500)))
      const deleteIds: string[] = []
      const toDelete = new Set<string>()
      const dedupe = options.dedupe !== false
      const canonicalDedupe = options.canonicalDedupe === true
      const pruneWorking = options.pruneWorking !== false
      const cutoff = Date.now() - Math.max(1, Math.min(24 * 365, Math.trunc(options.ttlHours || 24))) * 3600_000

      // Hash-based dedup: group by contentHash + agentId, keep the one with highest reinforcementCount
      if (dedupe && toDelete.size < deleteBudget) {
        const hashGroups = new Map<string, MemoryEntry[]>()
        for (const row of rows) {
          if (!row.contentHash || toDelete.has(row.id)) continue
          const groupKey = `${row.agentId || ''}|${row.contentHash}`
          const group = hashGroups.get(groupKey)
          if (group) group.push(row)
          else hashGroups.set(groupKey, [row])
        }
        for (const group of hashGroups.values()) {
          if (group.length <= 1) continue
          group.sort((a, b) => (b.reinforcementCount || 0) - (a.reinforcementCount || 0))
          for (let i = 1; i < group.length; i++) {
            toDelete.add(group[i].id)
            if (toDelete.size >= deleteBudget) break
          }
          if (toDelete.size >= deleteBudget) break
        }
      }

      // Exact string-match dedup (legacy fallback for rows without contentHash)
      if (dedupe) {
        const seen = new Set<string>()
        for (const row of rows) {
          if (toDelete.has(row.id)) continue
          const key = [
            row.agentId || '',
            row.sessionId || '',
            row.category || '',
            row.title || '',
            row.content || '',
          ].join('|')
          if (seen.has(key)) toDelete.add(row.id)
          else seen.add(key)
          if (toDelete.size >= deleteBudget) break
        }
      }

      if (canonicalDedupe && toDelete.size < deleteBudget) {
        const seen = new Set<string>()
        for (const row of rows) {
          if (toDelete.has(row.id)) continue
          const key = [
            row.agentId || '',
            row.sessionId || '',
            row.category || '',
            canonicalText(row.title),
            canonicalText(row.content),
          ].join('|')
          if (seen.has(key)) toDelete.add(row.id)
          else seen.add(key)
          if (toDelete.size >= deleteBudget) break
        }
      }

      if (pruneWorking && toDelete.size < deleteBudget) {
        for (const row of rows) {
          if (toDelete.has(row.id)) continue
          const isWorkingLike = isWorkingMemoryCategory(row.category)
          const updatedAt = row.updatedAt || row.createdAt || 0
          if (isWorkingLike && updatedAt < cutoff) toDelete.add(row.id)
          if (toDelete.size >= deleteBudget) break
        }
      }

      for (const id of toDelete) {
        this.delete(id)
        deleteIds.push(id)
        if (deleteIds.length >= deleteBudget) break
      }

      let pruned = 0
      let deduped = 0
      if (deleteIds.length) {
        const deletedSet = new Set(deleteIds)
        for (const row of rows) {
          if (!deletedSet.has(row.id)) continue
          const isWorkingLike = isWorkingMemoryCategory(row.category)
          if (isWorkingLike) pruned++
          else deduped++
        }
      }

      return {
        deduped,
        pruned,
        deletedIds: deleteIds,
        analyzed,
      }
    },

    getLatestBySessionCategory(sessionId: string, category: string): MemoryEntry | null {
      const sid = (sessionId || '').trim()
      const cat = (category || '').trim()
      if (!sid || !cat) return null
      const row = stmts.latestBySessionCategory.get(sid, cat) as Record<string, unknown> | undefined
      if (!row) return null
      return rowToEntry(row)
    },
  }
}

export function getMemoryDb() {
  if (!_db) _db = initDb()
  return _db
}

// ---------------------------------------------------------------------------
// Cross-Agent Knowledge Base helpers
// ---------------------------------------------------------------------------

export function addKnowledge(params: {
  title: string
  content: string
  tags?: string[]
  scope?: 'global' | 'agent'
  agentIds?: string[]
  createdByAgentId?: string | null
  createdBySessionId?: string | null
  source?: string
  sourceUrl?: string
}): MemoryEntry {
  const db = getMemoryDb()
  const metadata: Record<string, unknown> = {
    tags: params.tags || [],
    scope: params.scope || 'global',
    agentIds: params.scope === 'agent' ? (params.agentIds || []) : [],
    createdByAgentId: params.createdByAgentId || null,
    createdBySessionId: params.createdBySessionId || null,
  }
  if (params.source) metadata.source = params.source
  if (params.sourceUrl) metadata.sourceUrl = params.sourceUrl
  return db.add({
    agentId: null,
    sessionId: null,
    category: 'knowledge',
    title: params.title,
    content: params.content,
    metadata,
  })
}

export function searchKnowledge(query: string, tags?: string[], limit?: number): MemoryEntry[] {
  const db = getMemoryDb()
  const results = db.search(query)
  let filtered = results.filter((e) => e.category === 'knowledge')

  if (tags && tags.length > 0) {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()))
    filtered = filtered.filter((e) => {
      const entryTags: string[] = (e.metadata as Record<string, unknown>)?.tags as string[] || []
      return entryTags.some((t) => tagSet.has(t.toLowerCase()))
    })
  }

  if (limit && limit > 0) {
    filtered = filtered.slice(0, limit)
  }

  return filtered
}

export function listKnowledge(tags?: string[], limit?: number): MemoryEntry[] {
  const db = getMemoryDb()
  const all = db.list(undefined, 500)
  let filtered = all.filter((e) => e.category === 'knowledge')

  if (tags && tags.length > 0) {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()))
    filtered = filtered.filter((e) => {
      const entryTags: string[] = (e.metadata as Record<string, unknown>)?.tags as string[] || []
      return entryTags.some((t) => tagSet.has(t.toLowerCase()))
    })
  }

  if (limit && limit > 0) {
    filtered = filtered.slice(0, limit)
  }

  return filtered
}
