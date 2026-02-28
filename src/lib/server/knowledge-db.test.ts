import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import type { MemoryEntry } from '@/types'

// ---------------------------------------------------------------------------
// Portable test harness:
// We replicate the minimal schema from memory-db.ts and build thin wrappers
// equivalent to addKnowledge / searchKnowledge / listKnowledge so we can test
// the knowledge helpers' logic against an isolated temp SQLite file without
// pulling in the full module singleton (which depends on storage.ts, embeddings,
// and a hardcoded DB_PATH).
// ---------------------------------------------------------------------------

const tmpDbPath = path.join(
  os.tmpdir(),
  `knowledge-test-${crypto.randomBytes(4).toString('hex')}.db`,
)

let db: ReturnType<typeof Database>

// ---- Schema (mirrors initDb in memory-db.ts) ----
function createSchema(d: ReturnType<typeof Database>) {
  d.pragma('journal_mode = WAL')
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agentId TEXT,
      sessionId TEXT,
      category TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT,
      embedding BLOB,
      "references" TEXT,
      filePaths TEXT,
      image TEXT,
      imagePath TEXT,
      linkedMemoryIds TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title, content, category,
      content='memories',
      content_rowid='rowid'
    )
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, category)
      VALUES ('delete', old.rowid, old.title, old.content, old.category);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, category)
      VALUES ('delete', old.rowid, old.title, old.content, old.category);
      INSERT INTO memories_fts(rowid, title, content, category)
      VALUES (new.rowid, new.title, new.content, new.category);
    END
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updatedAt DESC)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent_updated_at ON memories(agentId, updatedAt DESC)`)
}

// ---- Prepared statements ----
let stmts: {
  insert: ReturnType<ReturnType<typeof Database>['prepare']>
  listAll: ReturnType<ReturnType<typeof Database>['prepare']>
  listByAgent: ReturnType<ReturnType<typeof Database>['prepare']>
  search: ReturnType<ReturnType<typeof Database>['prepare']>
  searchByAgent: ReturnType<ReturnType<typeof Database>['prepare']>
}

function parseJsonSafe<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row.id || ''),
    agentId: typeof row.agentId === 'string' ? row.agentId : null,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    category: typeof row.category === 'string' ? row.category : 'note',
    title: typeof row.title === 'string' ? row.title : 'Untitled',
    content: typeof row.content === 'string' ? row.content : '',
    metadata: parseJsonSafe<Record<string, unknown> | undefined>(row.metadata, undefined),
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
  }
}

// ---- Knowledge helpers (mirrors memory-db.ts exported functions) ----

const MEMORY_FTS_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
  'i', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'with',
  'you', 'your',
])
const MAX_FTS_QUERY_TERMS = 6
const MAX_FTS_TERM_LENGTH = 48

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

function addRawMemory(data: {
  agentId?: string | null
  sessionId?: string | null
  category: string
  title: string
  content: string
  metadata?: Record<string, unknown>
}): MemoryEntry {
  const id = crypto.randomBytes(6).toString('hex')
  const now = Date.now()
  stmts.insert.run(
    id,
    data.agentId || null,
    data.sessionId || null,
    data.category,
    data.title,
    data.content,
    data.metadata ? JSON.stringify(data.metadata) : null,
    now,
    now,
  )
  return {
    id,
    agentId: data.agentId || null,
    sessionId: data.sessionId || null,
    category: data.category,
    title: data.title,
    content: data.content,
    metadata: data.metadata,
    createdAt: now,
    updatedAt: now,
  }
}

function addKnowledge(params: {
  title: string
  content: string
  tags?: string[]
  createdByAgentId?: string | null
  createdBySessionId?: string | null
}): MemoryEntry {
  return addRawMemory({
    agentId: null,
    sessionId: null,
    category: 'knowledge',
    title: params.title,
    content: params.content,
    metadata: {
      tags: params.tags || [],
      createdByAgentId: params.createdByAgentId || null,
      createdBySessionId: params.createdBySessionId || null,
    },
  })
}

function searchKnowledge(query: string, tags?: string[], limit?: number): MemoryEntry[] {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery) return []
  const rows = (stmts.search.all(ftsQuery) as Record<string, unknown>[]).map(rowToEntry)
  let filtered = rows.filter((e) => e.category === 'knowledge')
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

function listKnowledge(tags?: string[], limit?: number): MemoryEntry[] {
  const rows = (stmts.listAll.all(500) as Record<string, unknown>[]).map(rowToEntry)
  let filtered = rows.filter((e) => e.category === 'knowledge')
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
before(() => {
  db = new Database(tmpDbPath)
  createSchema(db)
  stmts = {
    insert: db.prepare(`
      INSERT INTO memories (id, agentId, sessionId, category, title, content, metadata, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listAll: db.prepare(`SELECT * FROM memories ORDER BY updatedAt DESC LIMIT ?`),
    listByAgent: db.prepare(`SELECT * FROM memories WHERE agentId=? ORDER BY updatedAt DESC LIMIT ?`),
    search: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ?
      LIMIT 30
    `),
    searchByAgent: db.prepare(`
      SELECT m.* FROM memories m
      INNER JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND m.agentId = ?
      LIMIT 30
    `),
  }
})

after(() => {
  try { db?.close() } catch { /* ok */ }
  try { fs.unlinkSync(tmpDbPath) } catch { /* ok */ }
  // WAL / SHM files
  try { fs.unlinkSync(tmpDbPath + '-wal') } catch { /* ok */ }
  try { fs.unlinkSync(tmpDbPath + '-shm') } catch { /* ok */ }
})

// ---------------------------------------------------------------------------
// 1. addKnowledge
// ---------------------------------------------------------------------------
describe('addKnowledge', () => {
  it('creates entry with category=knowledge and agentId=null', () => {
    const entry = addKnowledge({ title: 'CatK', content: 'body' })
    assert.equal(entry.category, 'knowledge')
    assert.equal(entry.agentId, null)
  })

  it('stores title and content correctly', () => {
    const entry = addKnowledge({ title: 'My Title', content: 'My Content' })
    assert.equal(entry.title, 'My Title')
    assert.equal(entry.content, 'My Content')
  })

  it('stores tags in metadata', () => {
    const entry = addKnowledge({ title: 'Tagged', content: 'c', tags: ['alpha', 'beta'] })
    const meta = entry.metadata as Record<string, unknown>
    assert.deepEqual(meta.tags, ['alpha', 'beta'])
  })

  it('returns a valid hex ID', () => {
    const entry = addKnowledge({ title: 'IDcheck', content: 'x' })
    assert.ok(entry.id)
    assert.match(entry.id, /^[0-9a-f]+$/)
  })

  it('stores createdByAgentId and createdBySessionId in metadata', () => {
    const entry = addKnowledge({
      title: 'MetaEntry',
      content: 'body',
      createdByAgentId: 'agent-1',
      createdBySessionId: 'session-1',
    })
    const meta = entry.metadata as Record<string, unknown>
    assert.equal(meta.createdByAgentId, 'agent-1')
    assert.equal(meta.createdBySessionId, 'session-1')
  })

  it('defaults tags to empty array when omitted', () => {
    const entry = addKnowledge({ title: 'NoTags', content: 'c' })
    const meta = entry.metadata as Record<string, unknown>
    assert.deepEqual(meta.tags, [])
  })

  it('defaults createdByAgentId/createdBySessionId to null when omitted', () => {
    const entry = addKnowledge({ title: 'NullCreator', content: 'c' })
    const meta = entry.metadata as Record<string, unknown>
    assert.equal(meta.createdByAgentId, null)
    assert.equal(meta.createdBySessionId, null)
  })
})

// ---------------------------------------------------------------------------
// 2. searchKnowledge
// ---------------------------------------------------------------------------
describe('searchKnowledge', () => {
  before(() => {
    addKnowledge({ title: 'Quantum physics overview', content: 'Entanglement is a quantum phenomenon', tags: ['science'] })
    addKnowledge({ title: 'Cooking pasta recipe', content: 'Boil water and add pasta noodles', tags: ['cooking'] })
    addKnowledge({ title: 'Quantum computing primer', content: 'Qubits leverage superposition for computing', tags: ['science', 'tech'] })
  })

  it('FTS search finds entries by content', () => {
    const results = searchKnowledge('entanglement quantum phenomenon')
    assert.ok(results.length > 0)
    assert.ok(results.some(e => e.title === 'Quantum physics overview'))
  })

  it('FTS search finds entries by title', () => {
    const results = searchKnowledge('quantum physics overview')
    assert.ok(results.length > 0)
    assert.ok(results.some(e => e.title.includes('Quantum')))
  })

  it('tag filter only returns entries with matching tag', () => {
    const results = searchKnowledge('quantum', ['tech'])
    for (const r of results) {
      const tags: string[] = (r.metadata as Record<string, unknown>)?.tags as string[] || []
      assert.ok(tags.some(t => t.toLowerCase() === 'tech'))
    }
  })

  it('limit parameter works', () => {
    const results = searchKnowledge('quantum computing', undefined, 1)
    assert.ok(results.length <= 1)
  })

  it('no results for non-matching query', () => {
    const results = searchKnowledge('xylophone orchestration symphony')
    assert.equal(results.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 3. listKnowledge
// ---------------------------------------------------------------------------
describe('listKnowledge', () => {
  it('lists all knowledge entries', () => {
    const all = listKnowledge()
    assert.ok(all.length > 0)
    for (const e of all) {
      assert.equal(e.category, 'knowledge')
    }
  })

  it('tag filter works', () => {
    const filtered = listKnowledge(['cooking'])
    assert.ok(filtered.length > 0)
    for (const e of filtered) {
      const tags: string[] = (e.metadata as Record<string, unknown>)?.tags as string[] || []
      assert.ok(tags.some(t => t.toLowerCase() === 'cooking'))
    }
  })

  it('limit parameter works', () => {
    const limited = listKnowledge(undefined, 2)
    assert.ok(limited.length <= 2)
  })

  it('returns entries sorted by updatedAt desc', () => {
    const all = listKnowledge()
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].updatedAt >= all[i].updatedAt)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Isolation between knowledge and agent memory
// ---------------------------------------------------------------------------
describe('isolation between knowledge and agent memory', () => {
  before(() => {
    // Add a regular agent memory entry.
    addRawMemory({
      agentId: 'agent-xyz',
      sessionId: null,
      category: 'note',
      title: 'Agent private quantum data',
      content: 'Secret quantum agent information entanglement',
    })
  })

  it('regular memory entries (with agentId) do not appear in knowledge list', () => {
    const knowledgeList = listKnowledge()
    for (const e of knowledgeList) {
      assert.equal(e.agentId, null)
      assert.equal(e.category, 'knowledge')
    }
  })

  it('regular memory entries do not appear in knowledge search', () => {
    const results = searchKnowledge('quantum entanglement')
    for (const e of results) {
      assert.equal(e.category, 'knowledge')
    }
  })

  it('knowledge entries do not appear in agent-scoped memory list', () => {
    const agentMemories = (stmts.listByAgent.all('agent-xyz', 500) as Record<string, unknown>[]).map(rowToEntry)
    for (const e of agentMemories) {
      assert.notEqual(e.category, 'knowledge')
      assert.equal(e.agentId, 'agent-xyz')
    }
  })

  it('knowledge entries do not appear in agent-scoped search', () => {
    const ftsQuery = buildFtsQuery('quantum entanglement')
    if (!ftsQuery) return
    const agentResults = (stmts.searchByAgent.all(ftsQuery, 'agent-xyz') as Record<string, unknown>[]).map(rowToEntry)
    for (const e of agentResults) {
      assert.equal(e.agentId, 'agent-xyz')
    }
  })
})
