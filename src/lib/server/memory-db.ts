import Database from 'better-sqlite3'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import type { MemoryEntry, FileReference, MemoryImage, MemoryReference } from '@/types'
import { getEmbedding, cosineSimilarity, serializeEmbedding, deserializeEmbedding } from './embeddings'
import { loadSettings } from './storage'
import {
  normalizeLinkedMemoryIds,
  normalizeMemoryLookupLimits,
  resolveLookupRequest,
  traverseLinkedMemoryGraph,
  type MemoryLookupLimits,
} from './memory-graph'

const DB_PATH = path.join(process.cwd(), 'data', 'memory.db')
const IMAGES_DIR = path.join(process.cwd(), 'data', 'memory-images')

const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024 // 10MB
const IMAGE_EXT_WHITELIST = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'])
const MAX_FTS_QUERY_TERMS = 6
const MAX_FTS_TERM_LENGTH = 48
const MAX_FTS_RESULT_ROWS = 30
const MAX_MERGED_RESULTS = 50

const MEMORY_FTS_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
  'i', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'with',
  'you', 'your',
])

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

function buildFtsQuery(input: string): string {
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
  const absolute = path.isAbsolute(pathValue) ? pathValue : path.resolve(process.cwd(), pathValue)
  try {
    return fs.existsSync(absolute)
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
  ]) {
    try { db.exec(`ALTER TABLE memories ADD COLUMN ${col}`) } catch { /* already exists */ }
  }

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

  // Fresh installs now start with an empty memory graph.
  // Durable memories are created only from actual user/agent interactions.

  const stmts = {
    insert: db.prepare(`
      INSERT INTO memories (
        id, agentId, sessionId, category, title, content, metadata, embedding,
        "references", filePaths, image, imagePath, linkedMemoryIds, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE memories
      SET agentId=?, sessionId=?, category=?, title=?, content=?, metadata=?, embedding=?,
          "references"=?, filePaths=?, image=?, imagePath=?, linkedMemoryIds=?, updatedAt=?
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
    exactDuplicateBySessionCategory: db.prepare(`
      SELECT * FROM memories
      WHERE sessionId = ? AND category = ? AND title = ? AND content = ?
      ORDER BY updatedAt DESC
      LIMIT 1
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
  const getAllWithEmbeddingsByAgent = db.prepare(
    `SELECT * FROM memories WHERE embedding IS NOT NULL AND agentId = ?`
  )

  return {
    add(data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
      const id = crypto.randomBytes(6).toString('hex')
      const now = Date.now()
      const references = normalizeReferences(data.references, data.filePaths)
      const legacyFilePaths = referencesToLegacyFilePaths(references)
      const image = normalizeImage(data.image, data.imagePath)
      const linkedMemoryIds = normalizeLinkedMemoryIds(data.linkedMemoryIds, id)
      const sessionId = data.sessionId || null
      const category = data.category || 'note'
      const title = data.title || 'Untitled'
      const content = data.content || ''

      // Guard against exact duplicate memory spam for the same session/category.
      if (sessionId) {
        const duplicate = stmts.exactDuplicateBySessionCategory.get(sessionId, category, title, content) as Record<string, unknown> | undefined
        if (duplicate) return rowToEntry(duplicate)
      }
      stmts.insert.run(
        id, data.agentId || null, sessionId,
        category, title, content,
        data.metadata ? JSON.stringify(data.metadata) : null,
        null, // embedding computed async
        references?.length ? JSON.stringify(references) : null,
        legacyFilePaths?.length ? JSON.stringify(legacyFilePaths) : null,
        image ? JSON.stringify(image) : null,
        image?.path || null,
        linkedMemoryIds.length ? JSON.stringify(linkedMemoryIds) : null,
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
        const imgPath = path.join(process.cwd(), entry.image?.path || entry.imagePath || '')
        try { fs.unlinkSync(imgPath) } catch { /* file may not exist */ }
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

    search(query: string, agentId?: string): MemoryEntry[] {
      if (shouldSkipSearchQuery(query)) return []
      const startedAt = Date.now()
      // FTS keyword search
      const ftsQuery = buildFtsQuery(query)
      const ftsResults: MemoryEntry[] = ftsQuery
        ? (agentId
            ? stmts.searchByAgent.all(ftsQuery, agentId) as any[]
            : stmts.search.all(ftsQuery) as any[]
          ).map(rowToEntry)
        : []

      // Attempt vector search (synchronous — uses cached embedding if available)
      let vectorResults: MemoryEntry[] = []
      try {
        const queryEmbedding = getEmbeddingSync(query)
        if (queryEmbedding) {
          const rows = agentId
            ? getAllWithEmbeddingsByAgent.all(agentId) as any[]
            : getAllWithEmbeddings.all() as any[]

          const scored = rows
            .map((row) => {
              const emb = deserializeEmbedding(row.embedding)
              const score = cosineSimilarity(queryEmbedding, emb)
              return { row, score }
            })
            .filter((s) => s.score > 0.3) // relevance threshold
            .sort((a, b) => b.score - a.score)
            .slice(0, 20)

          vectorResults = scored.map((s) => rowToEntry(s.row))
        }
      } catch {
        // Vector search unavailable, use FTS only
      }

      // Merge: deduplicate by id, FTS results first then vector-only
      const seen = new Set<string>()
      const merged: MemoryEntry[] = []
      for (const entry of [...ftsResults, ...vectorResults]) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id)
          merged.push(entry)
        }
      }
      const out = merged.slice(0, MAX_MERGED_RESULTS)
      const elapsed = Date.now() - startedAt
      if (elapsed > 1200) {
        console.warn(
          `[memory-db] Slow search ${elapsed}ms (agent=${agentId || 'all'}, rawLen=${String(query || '').length}, fts="${ftsQuery.slice(0, 180)}")`,
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
    ): { entries: MemoryEntry[]; truncated: boolean; expandedLinkedCount: number; limits: MemoryLookupLimits } {
      const baseResults = this.search(query, agentId)
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
        ? stmts.listByAgent.all(agentId, safeLimit) as any[]
        : stmts.listAll.all(safeLimit) as any[]
      return rows.map(rowToEntry)
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

        const category = String(row.category || '').toLowerCase()
        const isWorkingLike = category === 'execution' || category === 'working' || category === 'scratch'
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

      if (dedupe) {
        const seen = new Set<string>()
        for (const row of rows) {
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
          const category = String(row.category || '').toLowerCase()
          const isWorkingLike = category === 'execution' || category === 'working' || category === 'scratch'
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
          const category = String(row.category || '').toLowerCase()
          const isWorkingLike = category === 'execution' || category === 'working' || category === 'scratch'
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
