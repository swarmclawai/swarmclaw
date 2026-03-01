import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { genId } from '@/lib/id'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogCategory =
  | 'trigger'       // what kicked off the action
  | 'decision'      // reasoning / model choice
  | 'tool_call'     // tool invocation with input
  | 'tool_result'   // tool output
  | 'outbound'      // messages sent to users/platforms
  | 'file_op'       // file read/write/delete with checksums
  | 'commit'        // git commit activity
  | 'error'         // errors during execution

export interface ExecutionLogEntry {
  id: string
  sessionId: string
  runId: string | null
  agentId: string | null
  category: LogCategory
  summary: string
  detail: Record<string, unknown> | null
  ts: number
}

export interface LogQueryOpts {
  sessionId?: string
  agentId?: string
  runId?: string
  category?: LogCategory
  since?: number
  until?: number
  limit?: number
  offset?: number
  search?: string
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

import { DATA_DIR } from './data-dir'
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = path.join(DATA_DIR, 'logs.db')

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (_db) return _db
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.exec(`
    CREATE TABLE IF NOT EXISTS execution_logs (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id     TEXT,
      agent_id   TEXT,
      category   TEXT NOT NULL,
      summary    TEXT NOT NULL,
      detail     TEXT,
      ts         INTEGER NOT NULL
    )
  `)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_session ON execution_logs(session_id, ts)`)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_agent   ON execution_logs(agent_id, ts)`)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_run     ON execution_logs(run_id)`)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_cat     ON execution_logs(category)`)
  return _db
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const insertStmt = () =>
  getDb().prepare(
    `INSERT INTO execution_logs (id, session_id, run_id, agent_id, category, summary, detail, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

export function logExecution(
  sessionId: string,
  category: LogCategory,
  summary: string,
  opts?: {
    runId?: string | null
    agentId?: string | null
    detail?: Record<string, unknown>
  },
): string {
  const id = genId(8)
  const ts = Date.now()
  try {
    insertStmt().run(
      id,
      sessionId,
      opts?.runId ?? null,
      opts?.agentId ?? null,
      category,
      summary,
      opts?.detail ? JSON.stringify(opts.detail) : null,
      ts,
    )
  } catch {
    // Non-critical — never block agent execution for logging failures
  }
  return id
}

// Batch insert for bulk writes (e.g. file ops)
export function logExecutionBatch(
  entries: Array<{
    sessionId: string
    category: LogCategory
    summary: string
    runId?: string | null
    agentId?: string | null
    detail?: Record<string, unknown>
  }>,
): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO execution_logs (id, session_id, run_id, agent_id, category, summary, detail, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const ts = Date.now()
  const tx = db.transaction(() => {
    for (const e of entries) {
      stmt.run(
        genId(8),
        e.sessionId,
        e.runId ?? null,
        e.agentId ?? null,
        e.category,
        e.summary,
        e.detail ? JSON.stringify(e.detail) : null,
        ts,
      )
    }
  })
  try { tx() } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Read / Query
// ---------------------------------------------------------------------------

export function queryLogs(opts: LogQueryOpts): ExecutionLogEntry[] {
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.sessionId) {
    conditions.push('session_id = ?')
    params.push(opts.sessionId)
  }
  if (opts.agentId) {
    conditions.push('agent_id = ?')
    params.push(opts.agentId)
  }
  if (opts.runId) {
    conditions.push('run_id = ?')
    params.push(opts.runId)
  }
  if (opts.category) {
    conditions.push('category = ?')
    params.push(opts.category)
  }
  if (opts.since) {
    conditions.push('ts >= ?')
    params.push(opts.since)
  }
  if (opts.until) {
    conditions.push('ts <= ?')
    params.push(opts.until)
  }
  if (opts.search) {
    conditions.push('(summary LIKE ? OR detail LIKE ?)')
    const pattern = `%${opts.search}%`
    params.push(pattern, pattern)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ?? 200
  const offset = opts.offset ?? 0

  const rows = getDb()
    .prepare(`SELECT * FROM execution_logs ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<{
      id: string
      session_id: string
      run_id: string | null
      agent_id: string | null
      category: string
      summary: string
      detail: string | null
      ts: number
    }>

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    runId: r.run_id,
    agentId: r.agent_id,
    category: r.category as LogCategory,
    summary: r.summary,
    detail: r.detail ? JSON.parse(r.detail) : null,
    ts: r.ts,
  }))
}

export function countLogs(opts: Omit<LogQueryOpts, 'limit' | 'offset'>): number {
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.sessionId) { conditions.push('session_id = ?'); params.push(opts.sessionId) }
  if (opts.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId) }
  if (opts.runId) { conditions.push('run_id = ?'); params.push(opts.runId) }
  if (opts.category) { conditions.push('category = ?'); params.push(opts.category) }
  if (opts.since) { conditions.push('ts >= ?'); params.push(opts.since) }
  if (opts.until) { conditions.push('ts <= ?'); params.push(opts.until) }
  if (opts.search) {
    conditions.push('(summary LIKE ? OR detail LIKE ?)')
    const pattern = `%${opts.search}%`
    params.push(pattern, pattern)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const row = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM execution_logs ${where}`)
    .get(...params) as { cnt: number }
  return row.cnt
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

export function clearLogs(sessionId?: string): number {
  if (sessionId) {
    const result = getDb().prepare('DELETE FROM execution_logs WHERE session_id = ?').run(sessionId)
    return result.changes
  }
  const result = getDb().prepare('DELETE FROM execution_logs').run()
  return result.changes
}

export function clearLogsByAge(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs
  const result = getDb().prepare('DELETE FROM execution_logs WHERE ts < ?').run(cutoff)
  return result.changes
}
