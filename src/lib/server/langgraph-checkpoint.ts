import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
  TASKS,
} from '@langchain/langgraph-checkpoint'
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  PendingWrite,
} from '@langchain/langgraph-checkpoint'
import Database from 'better-sqlite3'
import path from 'path'
import { DATA_DIR } from './data-dir'

const DB_PATH = path.join(DATA_DIR, 'swarmclaw.db')

function getDb(dbPath = DB_PATH): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  return db
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
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
  db.exec(`
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
  if (!hasColumn(db, 'langgraph_checkpoints', 'metadata_type')) {
    db.exec(`ALTER TABLE langgraph_checkpoints ADD COLUMN metadata_type TEXT NOT NULL DEFAULT 'json'`)
  }
}

const initDb = getDb()
ensureSchema(initDb)
initDb.close()

function getThreadId(config: RunnableConfig): string {
  return (config.configurable?.thread_id as string) || ''
}

function getOptionalCheckpointNs(config: RunnableConfig): string | undefined {
  const raw = config.configurable?.checkpoint_ns
  return typeof raw === 'string' ? raw : undefined
}

function getCheckpointNs(config: RunnableConfig, fallback = ''): string {
  return getOptionalCheckpointNs(config) ?? fallback
}

function getConfiguredCheckpointId(config: RunnableConfig): string | undefined {
  const raw = config.configurable?.checkpoint_id
  return typeof raw === 'string' && raw.trim() ? raw : undefined
}

function normalizeSerializedValue(value: unknown): Uint8Array | string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  return Buffer.from(String(value))
}

function readLegacyJson<T>(value: Uint8Array | string | undefined): T {
  if (value == null) return undefined as T
  const text = typeof value === 'string' ? value : Buffer.from(value).toString()
  return JSON.parse(text) as T
}

type CheckpointRow = {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  type: string
  checkpoint: Buffer | string
  metadata_type?: string | null
  metadata: Buffer | string
  created_at: number
}

type PendingWriteRow = {
  task_id: string
  idx: number
  channel: string
  type: string
  value: Buffer | string | null
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private db: Database.Database

  constructor(dbPath = DB_PATH) {
    super()
    this.db = getDb(dbPath)
    ensureSchema(this.db)
  }

  private async deserializeValue<T>(type: string | undefined, value: unknown): Promise<T> {
    const normalized = normalizeSerializedValue(value)
    if (normalized == null) return undefined as T
    const serializationType = typeof type === 'string' && type.trim() ? type : 'json'
    try {
      return await this.serde.loadsTyped(serializationType, normalized) as T
    } catch (err) {
      if (serializationType !== 'json') throw err
      return readLegacyJson<T>(normalized)
    }
  }

  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    const rows = this.db.prepare(
      `SELECT task_id, idx, channel, type, value
       FROM langgraph_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
       ORDER BY task_id ASC, idx ASC`
    ).all(threadId, checkpointNs, checkpointId) as PendingWriteRow[]

    return Promise.all(rows.map(async (row) => [
      row.task_id,
      row.channel,
      await this.deserializeValue(row.type, row.value),
    ]))
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string,
  ): Promise<void> {
    if (checkpoint.v >= 4) return

    const rows = this.db.prepare(
      `SELECT type, value
       FROM langgraph_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = ?
       ORDER BY idx ASC`
    ).all(threadId, checkpointNs, parentCheckpointId, TASKS) as Array<{ type: string; value: Buffer | string | null }>

    if (!rows.length) return

    const pendingSends = await Promise.all(rows.map((row) => this.deserializeValue(row.type, row.value)))
    checkpoint.channel_values ??= {}
    checkpoint.channel_values[TASKS] = pendingSends
    checkpoint.channel_versions ??= {}
    checkpoint.channel_versions[TASKS] = Object.keys(checkpoint.channel_versions).length > 0
      ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
      : this.getNextVersion(undefined)
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = getThreadId(config)
    if (!threadId) return undefined

    const checkpointNs = getCheckpointNs(config)
    const checkpointId = getConfiguredCheckpointId(config)

    let row: CheckpointRow | undefined
    if (checkpointId) {
      row = this.db.prepare(
        `SELECT *
         FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      ).get(threadId, checkpointNs, checkpointId) as CheckpointRow | undefined
    } else {
      row = this.db.prepare(
        `SELECT *
         FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC
         LIMIT 1`
      ).get(threadId, checkpointNs) as CheckpointRow | undefined
    }

    if (!row) return undefined

    const checkpoint = await this.deserializeValue<Checkpoint>(row.type, row.checkpoint)
    if (row.parent_checkpoint_id) {
      await this.migratePendingSends(checkpoint, threadId, checkpointNs, row.parent_checkpoint_id)
    }

    const resultConfig: RunnableConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: row.checkpoint_id,
      },
    }

    const parentConfig = row.parent_checkpoint_id
      ? {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: row.parent_checkpoint_id,
          },
        }
      : undefined

    return {
      config: resultConfig,
      checkpoint,
      metadata: await this.deserializeValue<CheckpointMetadata>(row.metadata_type ?? 'json', row.metadata),
      parentConfig,
      pendingWrites: await this.loadPendingWrites(threadId, checkpointNs, row.checkpoint_id),
    }
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = getThreadId(config)
    if (!threadId) return

    const checkpointNs = getOptionalCheckpointNs(config)
    const checkpointId = getConfiguredCheckpointId(config)
    const limit = options?.limit

    let query = `
      SELECT *
      FROM langgraph_checkpoints
      WHERE thread_id = ?
    `
    const params: Array<string | number> = [threadId]

    if (checkpointNs !== undefined) {
      query += ` AND checkpoint_ns = ?`
      params.push(checkpointNs)
    }

    if (checkpointId) {
      query += ` AND checkpoint_id = ?`
      params.push(checkpointId)
    }

    if (options?.before?.configurable?.checkpoint_id) {
      query += ` AND checkpoint_id < ?`
      params.push(options.before.configurable.checkpoint_id)
    }

    query += ` ORDER BY checkpoint_id DESC`

    const rows = this.db.prepare(query).all(...params) as CheckpointRow[]
    let yielded = 0

    for (const row of rows) {
      const metadata = await this.deserializeValue<CheckpointMetadata>(row.metadata_type ?? 'json', row.metadata)
      if (options?.filter && !Object.entries(options.filter).every(([key, value]) => (metadata as Record<string, unknown>)[key] === value)) {
        continue
      }

      const checkpoint = await this.deserializeValue<Checkpoint>(row.type, row.checkpoint)
      if (row.parent_checkpoint_id) {
        await this.migratePendingSends(checkpoint, threadId, row.checkpoint_ns, row.parent_checkpoint_id)
      }

      yield {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata,
        parentConfig: row.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites: await this.loadPendingWrites(threadId, row.checkpoint_ns, row.checkpoint_id),
      }

      yielded += 1
      if (limit !== undefined && yielded >= limit) break
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: Record<string, number | string>,
  ): Promise<RunnableConfig> {
    const threadId = getThreadId(config)
    const checkpointNs = getCheckpointNs(config)
    const parentCheckpointId = getConfiguredCheckpointId(config)

    if (!threadId) {
      throw new Error('Failed to put checkpoint. Missing required configurable.thread_id.')
    }
    void newVersions

    const preparedCheckpoint = copyCheckpoint(checkpoint)
    const [
      [checkpointType, serializedCheckpoint],
      [metadataType, serializedMetadata],
    ] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ])

    const createdAt = Number.isFinite(Date.parse(preparedCheckpoint.ts))
      ? Date.parse(preparedCheckpoint.ts)
      : Date.now()

    this.db.prepare(`
      INSERT OR REPLACE INTO langgraph_checkpoints
        (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata_type, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      checkpointNs,
      preparedCheckpoint.id,
      parentCheckpointId || null,
      checkpointType,
      Buffer.from(serializedCheckpoint),
      metadataType,
      Buffer.from(serializedMetadata),
      createdAt,
    )

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: preparedCheckpoint.id,
      },
    }
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = getThreadId(config)
    const checkpointNs = getCheckpointNs(config)
    const checkpointId = getConfiguredCheckpointId(config)

    if (!threadId) {
      throw new Error('Failed to put writes. Missing required configurable.thread_id.')
    }
    if (!checkpointId) {
      throw new Error('Failed to put writes. Missing required configurable.checkpoint_id.')
    }

    const serializedWrites = await Promise.all(writes.map(async ([channel, value], idx) => {
      const [type, serializedValue] = await this.serde.dumpsTyped(value)
      const writeIdx = WRITES_IDX_MAP[channel as string] ?? idx
      return {
        channel: channel as string,
        idx: writeIdx,
        type,
        value: Buffer.from(serializedValue),
      }
    }))

    const getExisting = this.db.prepare(
      `SELECT 1
       FROM langgraph_writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND task_id = ? AND idx = ?`
    )
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO langgraph_writes
        (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const tx = this.db.transaction((items: typeof serializedWrites) => {
      for (const item of items) {
        if (item.idx >= 0) {
          const existing = getExisting.get(threadId, checkpointNs, checkpointId, taskId, item.idx)
          if (existing) continue
        }
        upsert.run(
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          item.idx,
          item.channel,
          item.type,
          item.value,
        )
      }
    })

    tx(serializedWrites)
  }
  async deleteThread(threadId: string): Promise<void> {
    this.db.prepare(`DELETE FROM langgraph_checkpoints WHERE thread_id = ?`).run(threadId)
    this.db.prepare(`DELETE FROM langgraph_writes WHERE thread_id = ?`).run(threadId)
  }

  async deleteCheckpoint(threadId: string, checkpointId: string): Promise<void> {
    this.db.prepare(`DELETE FROM langgraph_checkpoints WHERE thread_id = ? AND checkpoint_id = ?`).run(threadId, checkpointId)
    this.db.prepare(`DELETE FROM langgraph_writes WHERE thread_id = ? AND checkpoint_id = ?`).run(threadId, checkpointId)
  }

  async deleteCheckpointsAfter(threadId: string, timestamp: number): Promise<void> {
    this.db.prepare(`DELETE FROM langgraph_checkpoints WHERE thread_id = ? AND created_at > ?`).run(threadId, timestamp)
    this.db.prepare(`
      DELETE FROM langgraph_writes
      WHERE thread_id = ?
        AND checkpoint_id NOT IN (
          SELECT checkpoint_id FROM langgraph_checkpoints WHERE thread_id = ?
        )
    `).run(threadId, threadId)
  }
}

let _saver: SqliteCheckpointSaver | undefined

export function getCheckpointSaver(): SqliteCheckpointSaver {
  if (!_saver) _saver = new SqliteCheckpointSaver()
  return _saver
}
