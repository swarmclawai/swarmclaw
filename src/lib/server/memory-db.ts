import Database from 'better-sqlite3'
import path from 'path'
import crypto from 'crypto'
import type { MemoryEntry } from '@/types'

const DB_PATH = path.join(process.cwd(), 'data', 'memory.db')

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
      INSERT INTO memories (id, agentId, sessionId, category, title, content, metadata, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: db.prepare(`
      UPDATE memories SET agentId=?, sessionId=?, category=?, title=?, content=?, metadata=?, updatedAt=?
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

  return {
    add(data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
      const id = crypto.randomBytes(6).toString('hex')
      const now = Date.now()
      stmts.insert.run(
        id, data.agentId || null, data.sessionId || null,
        data.category, data.title, data.content,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now, now,
      )
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
        now, id,
      )
      return { ...merged, updatedAt: now }
    },

    delete(id: string) {
      stmts.delete.run(id)
    },

    search(query: string, agentId?: string): MemoryEntry[] {
      // Sanitize FTS query — wrap each word in quotes
      const ftsQuery = query.split(/\s+/).filter(Boolean).map((w) => `"${w}"`).join(' OR ')
      if (!ftsQuery) return []
      const rows = agentId
        ? stmts.searchByAgent.all(ftsQuery, agentId) as any[]
        : stmts.search.all(ftsQuery) as any[]
      return rows.map(rowToEntry)
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
