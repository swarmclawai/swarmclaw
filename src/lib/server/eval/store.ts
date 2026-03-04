import Database from 'better-sqlite3'
import path from 'path'
import type { EvalRun } from './types'

const DB_PATH = path.join(process.cwd(), 'data', 'eval-runs.db')

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )`)
  }
  return db
}

export function saveEvalRun(run: EvalRun): void {
  getDb().prepare('INSERT OR REPLACE INTO eval_runs (id, data) VALUES (?, ?)').run(run.id, JSON.stringify(run))
}

export function getEvalRun(id: string): EvalRun | null {
  const row = getDb().prepare('SELECT data FROM eval_runs WHERE id = ?').get(id) as { data: string } | undefined
  return row ? JSON.parse(row.data) as EvalRun : null
}

export function listEvalRuns(limit = 50): EvalRun[] {
  const rows = getDb().prepare('SELECT data FROM eval_runs ORDER BY rowid DESC LIMIT ?').all(limit) as { data: string }[]
  return rows.map(r => JSON.parse(r.data) as EvalRun)
}

export function listEvalRunsByAgent(agentId: string, limit = 50): EvalRun[] {
  return listEvalRuns(limit * 2).filter(r => r.agentId === agentId).slice(0, limit)
}
