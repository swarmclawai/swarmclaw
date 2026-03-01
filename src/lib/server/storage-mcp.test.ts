import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Tests for the MCP server storage operations (loadMcpServers, saveMcpServers, deleteMcpServer).
 *
 * Since storage.ts uses a hardcoded DB path with module-level initialization,
 * we replicate the same SQL pattern against a temporary SQLite database.
 */

const TABLE = 'mcp_servers'

let dbPath: string
let db: InstanceType<typeof Database>

// --- Replicated storage helpers (mirror storage.ts logic) ---

function loadMcpServers(): Record<string, any> {
  const rows = db.prepare(`SELECT id, data FROM ${TABLE}`).all() as { id: string; data: string }[]
  const result: Record<string, any> = {}
  for (const row of rows) {
    try {
      result[row.id] = JSON.parse(row.data)
    } catch {
      // skip malformed
    }
  }
  return result
}

function saveMcpServers(m: Record<string, any>) {
  const existingRows = db.prepare(`SELECT id FROM ${TABLE}`).all() as { id: string }[]
  const nextIds = new Set(Object.keys(m))
  const toDelete = existingRows.map((r) => r.id).filter((id) => !nextIds.has(id))
  const upsert = db.prepare(`INSERT OR REPLACE INTO ${TABLE} (id, data) VALUES (?, ?)`)
  const del = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`)
  const transaction = db.transaction(() => {
    for (const id of toDelete) {
      del.run(id)
    }
    for (const [id, val] of Object.entries(m)) {
      upsert.run(id, JSON.stringify(val))
    }
  })
  transaction()
}

function deleteMcpServer(id: string) {
  db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id)
}

// --- Test setup / teardown ---

before(() => {
  dbPath = path.join(os.tmpdir(), `test-storage-mcp-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
})

after(() => {
  db.close()
  try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-wal') } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + '-shm') } catch { /* ignore */ }
})

// --- Tests ---

describe('MCP server storage', () => {
  it('saveMcpServers saves a config and it is retrievable', () => {
    const config = { id: 'srv-1', name: 'Test MCP', url: 'http://localhost:9000' }
    saveMcpServers({ 'srv-1': config })

    const row = db.prepare(`SELECT data FROM ${TABLE} WHERE id = ?`).get('srv-1') as { data: string } | undefined
    assert.ok(row, 'row should exist after save')
    assert.deepStrictEqual(JSON.parse(row.data), config)
  })

  it('loadMcpServers returns all saved configs', () => {
    saveMcpServers({
      'srv-1': { id: 'srv-1', name: 'First' },
      'srv-2': { id: 'srv-2', name: 'Second' },
    })

    const all = loadMcpServers()
    assert.ok('srv-1' in all)
    assert.ok('srv-2' in all)
    assert.equal(all['srv-2'].name, 'Second')
  })

  it('loadMcpServers returns empty object when table is empty', () => {
    db.exec(`DELETE FROM ${TABLE}`)
    const all = loadMcpServers()
    assert.deepStrictEqual(all, {})
  })

  it('saveMcpServers with same id updates the record', () => {
    saveMcpServers({ 'srv-u': { id: 'srv-u', name: 'Original' } })
    saveMcpServers({ 'srv-u': { id: 'srv-u', name: 'Updated' } })

    const all = loadMcpServers()
    assert.equal(all['srv-u'].name, 'Updated')

    // only one row for that id
    const count = (db.prepare(`SELECT COUNT(*) as c FROM ${TABLE} WHERE id = ?`).get('srv-u') as { c: number }).c
    assert.equal(count, 1)
  })

  it('saveMcpServers removes records omitted from the next save payload', () => {
    saveMcpServers({
      'srv-a': { id: 'srv-a', name: 'A' },
      'srv-b': { id: 'srv-b', name: 'B' },
    })
    saveMcpServers({
      'srv-b': { id: 'srv-b', name: 'B2' },
    })

    const all = loadMcpServers()
    assert.equal('srv-a' in all, false)
    assert.equal(all['srv-b'].name, 'B2')
  })

  it('deleteMcpServer removes the record', () => {
    saveMcpServers({ 'srv-d': { id: 'srv-d', name: 'ToDelete' } })
    deleteMcpServer('srv-d')

    const row = db.prepare(`SELECT data FROM ${TABLE} WHERE id = ?`).get('srv-d')
    assert.equal(row, undefined)
  })

  it('deleteMcpServer does not throw for nonexistent id', () => {
    assert.doesNotThrow(() => {
      deleteMcpServer('nonexistent-id-xyz')
    })
  })

  it('round-trip: save multiple, load all, verify count and data', () => {
    db.exec(`DELETE FROM ${TABLE}`)

    const configs: Record<string, any> = {}
    for (let i = 0; i < 5; i++) {
      configs[`rt-${i}`] = { id: `rt-${i}`, name: `Server ${i}`, port: 3000 + i }
    }
    saveMcpServers(configs)

    const all = loadMcpServers()
    assert.equal(Object.keys(all).length, 5)
    for (let i = 0; i < 5; i++) {
      assert.equal(all[`rt-${i}`].port, 3000 + i)
    }
  })

  it('data integrity: saved JSON is correctly parsed back with all fields', () => {
    db.exec(`DELETE FROM ${TABLE}`)

    const config = {
      id: 'integrity-1',
      name: 'Full Config',
      url: 'https://mcp.example.com',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { HOME: '/tmp' },
      enabled: true,
      createdAt: 1700000000000,
      tags: ['production', 'filesystem'],
      nested: { deep: { value: 42 } },
    }

    saveMcpServers({ 'integrity-1': config })
    const loaded = loadMcpServers()

    assert.deepStrictEqual(loaded['integrity-1'], config)
    assert.ok(Array.isArray(loaded['integrity-1'].args))
    assert.equal(loaded['integrity-1'].args.length, 2)
    assert.equal(loaded['integrity-1'].nested.deep.value, 42)
    assert.equal(typeof loaded['integrity-1'].enabled, 'boolean')
  })
})
