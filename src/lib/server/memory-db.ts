import Database from 'better-sqlite3'
import path from 'path'
import crypto from 'crypto'
import type { MemoryEntry } from '@/types'
import { getEmbedding, cosineSimilarity, serializeEmbedding, deserializeEmbedding } from './embeddings'

const DB_PATH = path.join(process.cwd(), 'data', 'memory.db')

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

let _db: ReturnType<typeof initDb> | null = null

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

  // Add embedding column if not present (safe migration)
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB`)
  } catch {
    // Column already exists — ignore
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

  const stmts = {
    insert: db.prepare(`
      INSERT INTO memories (id, agentId, sessionId, category, title, content, metadata, embedding, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE memories SET agentId=?, sessionId=?, category=?, title=?, content=?, metadata=?, embedding=?, updatedAt=?
      WHERE id=?
    `),
    delete: db.prepare(`DELETE FROM memories WHERE id=?`),
    getById: db.prepare(`SELECT * FROM memories WHERE id=?`),
    listAll: db.prepare(`SELECT * FROM memories ORDER BY updatedAt DESC LIMIT 200`),
    listByAgent: db.prepare(`SELECT * FROM memories WHERE agentId=? ORDER BY updatedAt DESC LIMIT 200`),
    search: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT 100
    `),
    searchByAgent: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND m.agentId = ?
      ORDER BY rank
      LIMIT 100
    `),
  }

  function rowToEntry(row: any): MemoryEntry {
    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }
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
      stmts.insert.run(
        id, data.agentId || null, data.sessionId || null,
        data.category, data.title, data.content,
        data.metadata ? JSON.stringify(data.metadata) : null,
        null, // embedding computed async
        now, now,
      )
      // Compute embedding in background (fire-and-forget)
      const text = `${data.title} ${data.content}`.slice(0, 4000)
      getEmbedding(text).then((emb) => {
        if (emb) {
          db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(
            serializeEmbedding(emb), id,
          )
        }
      }).catch(() => { /* embedding not available, ok */ })
      return { ...data, id, createdAt: now, updatedAt: now }
    },

    update(id: string, updates: Partial<MemoryEntry>): MemoryEntry | null {
      const existing = stmts.getById.get(id) as any
      if (!existing) return null
      const merged = { ...rowToEntry(existing), ...updates }
      const now = Date.now()
      stmts.update.run(
        merged.agentId || null, merged.sessionId || null,
        merged.category, merged.title, merged.content,
        merged.metadata ? JSON.stringify(merged.metadata) : null,
        existing.embedding, // preserve existing embedding
        now, id,
      )
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
      return { ...merged, updatedAt: now }
    },

    delete(id: string) {
      stmts.delete.run(id)
    },

    search(query: string, agentId?: string): MemoryEntry[] {
      // FTS keyword search
      const ftsQuery = query.split(/\s+/).filter(Boolean).map((w) => `"${w}"`).join(' OR ')
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
      return merged.slice(0, 100)
    },

    list(agentId?: string): MemoryEntry[] {
      const rows = agentId
        ? stmts.listByAgent.all(agentId) as any[]
        : stmts.listAll.all() as any[]
      return rows.map(rowToEntry)
    },

    getByAgent(agentId: string): MemoryEntry[] {
      return (stmts.listByAgent.all(agentId) as any[]).map(rowToEntry)
    },
  }
}

export function getMemoryDb() {
  if (!_db) _db = initDb()
  return _db
}
