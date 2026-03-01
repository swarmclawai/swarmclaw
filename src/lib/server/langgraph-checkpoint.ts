import { BaseCheckpointSaver } from '@langchain/langgraph'
import type { RunnableConfig } from '@langchain/core/runnables'
import type {
  Checkpoint,
  CheckpointTuple,
  CheckpointListOptions,
} from '@langchain/langgraph-checkpoint'
import type {
  CheckpointMetadata,
  PendingWrite,
  CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint'
import Database from 'better-sqlite3'
import path from 'path'
import { DATA_DIR } from './data-dir'

const DB_PATH = path.join(DATA_DIR, 'swarmclaw.db')

function getDb(): Database.Database {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  return db
}

// Ensure tables exist
const initDb = getDb()
initDb.exec(`
  CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT NOT NULL DEFAULT 'json',
    checkpoint BLOB NOT NULL,
    metadata BLOB NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  )
`)
initDb.exec(`
  CREATE TABLE IF NOT EXISTS langgraph_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'json',
    value BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  )
`)
initDb.close()

function getThreadId(config: RunnableConfig): string {
  return (config.configurable?.thread_id as string) || ''
}

function getCheckpointNs(config: RunnableConfig): string {
  return (config.configurable?.checkpoint_ns as string) || ''
}

function getCheckpointId(config: RunnableConfig): string | undefined {
  return config.configurable?.checkpoint_id as string | undefined
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private db: Database.Database

  constructor() {
    super()
    this.db = getDb()
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = getThreadId(config)
    if (!threadId) return undefined

    const ns = getCheckpointNs(config)
    const checkpointId = getCheckpointId(config)

    let row: any
    if (checkpointId) {
      row = this.db.prepare(
        `SELECT * FROM langgraph_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      ).get(threadId, ns, checkpointId)
    } else {
      row = this.db.prepare(
        `SELECT * FROM langgraph_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY created_at DESC LIMIT 1`
      ).get(threadId, ns)
    }

    if (!row) return undefined

    const checkpoint = JSON.parse(
      typeof row.checkpoint === 'string' ? row.checkpoint : Buffer.from(row.checkpoint).toString()
    ) as Checkpoint
    const metadata = JSON.parse(
      typeof row.metadata === 'string' ? row.metadata : Buffer.from(row.metadata).toString()
    ) as CheckpointMetadata

    const resultConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: row.checkpoint_id,
      },
    }

    const parentConfig = row.parent_checkpoint_id
      ? {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: ns,
            checkpoint_id: row.parent_checkpoint_id,
          },
        }
      : undefined

    // Load pending writes
    const writeRows = this.db.prepare(
      `SELECT task_id, channel, value FROM langgraph_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY idx`
    ).all(threadId, ns, row.checkpoint_id) as any[]

    const pendingWrites: CheckpointPendingWrite[] = writeRows.map((w) => [
      w.task_id,
      w.channel,
      w.value ? JSON.parse(typeof w.value === 'string' ? w.value : Buffer.from(w.value).toString()) : undefined,
    ])

    return {
      config: resultConfig,
      checkpoint,
      metadata,
      parentConfig,
      pendingWrites,
    }
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = getThreadId(config)
    if (!threadId) return

    const ns = getCheckpointNs(config)
    const limit = options?.limit ?? 100

    let query = `SELECT * FROM langgraph_checkpoints WHERE thread_id = ? AND checkpoint_ns = ?`
    const params: any[] = [threadId, ns]

    if (options?.before?.configurable?.checkpoint_id) {
      query += ` AND checkpoint_id < ?`
      params.push(options.before.configurable.checkpoint_id)
    }

    query += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(query).all(...params) as any[]

    for (const row of rows) {
      const checkpoint = JSON.parse(
        typeof row.checkpoint === 'string' ? row.checkpoint : Buffer.from(row.checkpoint).toString()
      ) as Checkpoint
      const metadata = JSON.parse(
        typeof row.metadata === 'string' ? row.metadata : Buffer.from(row.metadata).toString()
      ) as CheckpointMetadata

      const resultConfig: RunnableConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.checkpoint_id,
        },
      }

      const parentConfig = row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined

      yield {
        config: resultConfig,
        checkpoint,
        metadata,
        parentConfig,
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, number | string>,
  ): Promise<RunnableConfig> {
    const threadId = getThreadId(config)
    const ns = getCheckpointNs(config)
    const parentId = getCheckpointId(config)

    this.db.prepare(`
      INSERT OR REPLACE INTO langgraph_checkpoints
        (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      ns,
      checkpoint.id,
      parentId || null,
      JSON.stringify(checkpoint),
      JSON.stringify(metadata),
      Date.now(),
    )

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = getThreadId(config)
    const ns = getCheckpointNs(config)
    const checkpointId = getCheckpointId(config)
    if (!checkpointId) return

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO langgraph_writes
        (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const insertMany = this.db.transaction((items: PendingWrite[]) => {
      items.forEach(([channel, value], idx) => {
        stmt.run(
          threadId,
          ns,
          checkpointId,
          taskId,
          idx,
          channel as string,
          value !== undefined ? JSON.stringify(value) : null,
        )
      })
    })

    insertMany(writes)
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.prepare(`DELETE FROM langgraph_checkpoints WHERE thread_id = ?`).run(threadId)
    this.db.prepare(`DELETE FROM langgraph_writes WHERE thread_id = ?`).run(threadId)
  }
}

let _saver: SqliteCheckpointSaver | undefined
export function getCheckpointSaver(): SqliteCheckpointSaver {
  if (!_saver) _saver = new SqliteCheckpointSaver()
  return _saver
}
