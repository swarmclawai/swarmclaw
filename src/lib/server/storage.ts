import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Database from 'better-sqlite3'

import { perf } from '@/lib/server/runtime/perf'
import { log } from '@/lib/server/logger'
import { notify } from '@/lib/server/ws-hub'

const TAG = 'storage'
import { DATA_DIR, IS_BUILD_BOOTSTRAP, WORKSPACE_DIR } from './data-dir'
import { normalizeHeartbeatSettingFields } from '@/lib/runtime/heartbeat-defaults'
import { normalizeRuntimeSettingFields } from '@/lib/runtime/runtime-loop'
import { normalizeCapabilitySelection } from '@/lib/capability-selection'
import type {
  Agent,
  AppNotification,
  AppSettings,
  BoardTask,
  Chatroom,
  EstopState,
  ExternalAgentRuntime,
  GatewayProfile,
  GuardianCheckpoint,
  LearnedSkill,
  Message,
  Mission,
  MissionEvent,
  ProtocolTemplate,
  ProtocolRun,
  ProtocolRunEvent,
  RunEventRecord,
  RunReflection,
  Schedule,
  Session,
  SessionRunRecord,
  SkillSuggestion,
  SupervisorIncident,
  UsageRecord,
} from '@/types'
import { dedup } from '@/lib/shared-utils'

// --- Extracted modules ---
import {
  TTLCache,
  LRUMap,
  collectionCache,
  factoryTtlCaches,
  capacityFor,
  getSettingsCache,
  getAgentsCache,
  getSessionsCache,
} from './storage-cache'
import { normalizeStoredRecord, type NormalizationResult } from './storage-normalization'
import {
  tryAcquireRuntimeLock as _tryAcquireRuntimeLock,
  renewRuntimeLock as _renewRuntimeLock,
  readRuntimeLock as _readRuntimeLock,
  isRuntimeLockActive as _isRuntimeLockActive,
  releaseRuntimeLock as _releaseRuntimeLock,
} from './storage-locks'

// Re-export cache classes/utilities for any external consumers
export { TTLCache, LRUMap } from './storage-cache'

// Re-export auth (side-effects run on import)
export {
  getAccessKey,
  validateAccessKey,
  isFirstTimeSetup,
  markSetupComplete,
  replaceAccessKey,
} from './storage-auth'

// Force auth side-effects to run (env loading, key generation)
import './storage-auth'

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')

// Ensure directories exist
for (const dir of [DATA_DIR, UPLOAD_DIR, WORKSPACE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// --- SQLite Database ---
const DB_PATH = IS_BUILD_BOOTSTRAP ? ':memory:' : path.join(DATA_DIR, 'swarmclaw.db')
const db = new Database(DB_PATH)
if (!IS_BUILD_BOOTSTRAP) {
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -64000')
  db.pragma('mmap_size = 268435456')
}
db.pragma('foreign_keys = ON')

/** Run a function inside an immediate SQLite transaction for atomicity. */
export function withTransaction<T>(fn: () => T): T {
  const wrapped = db.transaction(fn)
  return wrapped()
}

/** Internal: raw database handle for specialized repositories (e.g. message-repository). */
export function getDb(): InstanceType<typeof Database> { return db }

type StoredObject = Record<string, unknown>
type StoredSessionRecord = Session
type StoredAgentRecord = Agent

// Collection tables (id → JSON blob)
const COLLECTIONS = [
  'sessions',
  'credentials',
  'agents',
  'schedules',
  'tasks',
  'secrets',
  'provider_configs',
  'gateway_profiles',
  'skills',
  'learned_skills',
  'skill_suggestions',
  'supervisor_incidents',
  'run_reflections',
  'runtime_runs',
  'runtime_run_events',
  'runtime_estop',
  'connectors',
  'documents',
  'document_revisions',
  'webhooks',
  'model_overrides',
  'mcp_servers',
  'integrity_baselines',
  'webhook_logs',
  'projects',
  'activity',
  'webhook_retry_queue',
  'notifications',
  'chatrooms',
  'wallets',
  'wallet_transactions',
  'wallet_balance_history',
  'moderation_logs',
  'connector_health',
  'connector_outbox',
  'souls',
  'benchmarks',
  'approvals',
  'guardian_checkpoints',
  'browser_sessions',
  'watch_jobs',
  'delegation_jobs',
  'external_agents',
  'missions',
  'mission_events',
  'protocol_templates',
  'protocol_runs',
  'protocol_run_events',
  'provider_health',
  'swarm_snapshots',
  'main_loop_states',
  'working_states',
  'daemon_status',
] as const

export type StorageCollection = (typeof COLLECTIONS)[number]

for (const table of COLLECTIONS) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
}

// Index for efficient protocol_run_events queries by runId
db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_run_events_runid ON protocol_run_events (json_extract(data, '$.runId'))`)

// Singleton tables (single row)
db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS usage (session_id TEXT NOT NULL, data TEXT NOT NULL)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id)`)
db.exec(`CREATE TABLE IF NOT EXISTS runtime_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`)

// Relational message storage — messages extracted from session blobs (Phase 1)
db.exec(`CREATE TABLE IF NOT EXISTS session_messages (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID`)

// --- Internal normalize helper that binds the loadItem dependency ---
function normalize(table: string, value: unknown): NormalizationResult {
  return normalizeStoredRecord(table, value, loadCollectionItem)
}

/** Shorthand: normalize and return only the value (for callers that don't need the changed flag). */
function normalizeValue(table: string, value: unknown): unknown {
  return normalizeStoredRecord(table, value, loadCollectionItem).value
}

function readCollectionRaw(table: string): LRUMap<string, string> {
  const rows = db.prepare(`SELECT id, data FROM ${table}`).all() as { id: string; data: string }[]
  const raw = new LRUMap<string, string>(capacityFor(table))
  for (const row of rows) {
    raw.set(row.id, row.data)
  }
  return raw
}

function getCollectionRawCache(table: string): LRUMap<string, string> {
  // Always reload from SQLite so concurrent Next.js workers/processes
  // observe each other's writes immediately.
  const loaded = readCollectionRaw(table)
  collectionCache.set(table, loaded)
  return loaded
}

function loadCollectionWithNormalizationState(table: string): {
  result: Record<string, StoredObject>
  normalizedCount: number
} {
  const endPerf = perf.start('storage', 'loadCollection', { table })
  const raw = getCollectionRawCache(table)
  const result: Record<string, StoredObject> = {}
  let normalizedCount = 0
  for (const [id, data] of raw.entries()) {
    try {
      const { value: normalized, changed } = normalize(table, JSON.parse(data))
      if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) continue
      result[id] = normalized as StoredObject
      if (changed) normalizedCount += 1
    } catch {
      // Ignore malformed records instead of crashing list endpoints.
    }
  }
  endPerf({ count: raw.size, normalizedCount })
  return { result, normalizedCount }
}

function loadCollection(table: string): Record<string, StoredObject> {
  const { result, normalizedCount } = loadCollectionWithNormalizationState(table)
  if (normalizedCount > 0) saveCollection(table, result)
  return result
}

function saveCollection(table: string, data: Record<string, unknown>) {
  const endPerf = perf.start('storage', 'saveCollection', { table })
  const current = getCollectionRawCache(table)
  const next = new Map<string, string>()
  const toUpsert: Array<[string, string]> = []
  const toDelete: string[] = []

  for (const [id, val] of Object.entries(data)) {
    const normalized = normalizeValue(table, val)
    const serialized = JSON.stringify(normalized)
    if (typeof serialized !== 'string') continue
    next.set(id, serialized)
    if (current.get(id) !== serialized) {
      toUpsert.push([id, serialized])
    }
  }

  for (const id of current.keys()) {
    if (!next.has(id)) toDelete.push(id)
  }

  // Safety guard: refuse to bulk-delete when the caller is likely passing a
  // partial collection instead of a full load-modify-save.  This prevents
  // accidental data wipes (e.g. tests calling saveCredentials with 1 item).
  if (toDelete.length > 0 && next.size > 0 && toDelete.length > next.size) {
    log.error(TAG,
      `BLOCKED destructive saveCollection("${table}"): ` +
      `would delete ${toDelete.length} rows but only upsert ${next.size}. ` +
      `Use deleteCollectionItem() for explicit deletes or load-modify-save to update.`,
    )
    // Still apply the upserts — only skip the deletes
    toDelete.length = 0
  }

  if (!toUpsert.length && !toDelete.length) {
    endPerf({ upserts: 0, deletes: 0 })
    return
  }

  const transaction = db.transaction(() => {
    if (toDelete.length) {
      const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`)
      for (const id of toDelete) del.run(id)
    }
    const upsert = db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)
    for (const [id, serialized] of toUpsert) {
      upsert.run(id, serialized)
    }
  })
  transaction()
  endPerf({ upserts: toUpsert.length, deletes: toDelete.length })

  for (const id of toDelete) {
    current.delete(id)
  }
  for (const [id, serialized] of next.entries()) {
    current.set(id, serialized)
  }
}

function deleteCollectionItem(table: string, id: string) {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
  const cached = collectionCache.get(table)
  if (cached) cached.delete(id)
  invalidateDerivedCollectionCaches(table)
}

function invalidateDerivedCollectionCaches(table: string): void {
  factoryTtlCaches.get(table)?.invalidate()
  if (table === 'sessions') {
    getSessionsCache().invalidate()
    return
  }
  if (table === 'agents') {
    getAgentsCache().invalidate()
  }
}

/**
 * Atomically insert or update a single item in a collection without
 * loading/saving the entire collection. Prevents race conditions when
 * concurrent processes are modifying different items.
 */
function upsertCollectionItem(table: string, id: string, value: unknown) {
  const serialized = JSON.stringify(normalizeValue(table, value))
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`).run(id, serialized)
  // Update the in-memory cache
  const cached = collectionCache.get(table)
  if (cached) {
    cached.set(id, serialized)
  }
  invalidateDerivedCollectionCaches(table)
}

function loadCollectionItem(table: string, id: string): unknown | null {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined
  if (!row) return null
  try {
    return normalizeValue(table, JSON.parse(row.data))
  } catch {
    return null
  }
}

function upsertCollectionItems(table: string, entries: Array<[string, unknown]>): void {
  if (!entries.length) return
  const prepared = entries
    .map(([id, value]) => [id, JSON.stringify(normalizeValue(table, value))] as const)
    .filter(([, serialized]) => typeof serialized === 'string')
  if (!prepared.length) return

  const transaction = db.transaction(() => {
    const upsert = db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)
    for (const [id, serialized] of prepared) {
      upsert.run(id, serialized)
    }
  })
  transaction()

  const cached = collectionCache.get(table)
  if (cached) {
    for (const [id, serialized] of prepared) {
      cached.set(id, serialized)
    }
  }
  invalidateDerivedCollectionCaches(table)
}

export function loadStoredItem(table: StorageCollection, id: string): unknown | null {
  return loadCollectionItem(table, id)
}

export function upsertStoredItem(table: StorageCollection, id: string, value: unknown): void {
  upsertCollectionItem(table, id, value)
}

export function upsertStoredItems(table: StorageCollection, entries: Array<[string, unknown]>): void {
  upsertCollectionItems(table, entries)
}

export function patchStoredItem<T>(
  table: StorageCollection,
  id: string,
  updater: (current: T | null) => T | null,
): T | null {
  let nextValue: T | null = null
  const transaction = db.transaction(() => {
    const current = loadCollectionItem(table, id) as T | null
    nextValue = updater(current)
    if (nextValue === null) {
      deleteCollectionItem(table, id)
      return
    }
    upsertCollectionItem(table, id, nextValue)
  })
  transaction()
  return nextValue
}

export function deleteStoredItem(table: StorageCollection, id: string): void {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
  const cached = collectionCache.get(table)
  if (cached) cached.delete(id)
}

// --- Collection Store Factory ---
// Generates typed CRUD operations for any collection table, with optional TTL caching.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- backward-compatible default; typed stores override with concrete types
interface CollectionStore<T = any> {
  load(): Record<string, T>
  save(data: Record<string, T>): void
  loadItem(id: string): T | null
  upsert(id: string, value: unknown): void
  upsertMany(entries: Array<[string, unknown]>): void
  patch(id: string, updater: (current: T | null) => T | null): T | null
  deleteItem(id: string): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see CollectionStore
function createCollectionStore<T = any>(
  table: StorageCollection,
  opts?: { ttlMs?: number },
): CollectionStore<T> {
  let ttlCache: TTLCache<Record<string, unknown>> | null = null
  if (opts?.ttlMs) {
    ttlCache = factoryTtlCaches.get(table) ?? null
    if (!ttlCache) {
      ttlCache = new TTLCache(opts.ttlMs)
      factoryTtlCaches.set(table, ttlCache)
    }
  }

  return {
    load(): Record<string, T> {
      if (ttlCache) {
        const cached = ttlCache.get()
        if (cached) return structuredClone(cached) as Record<string, T>
      }
      const result = loadCollection(table)
      if (ttlCache) {
        ttlCache.set(result)
        return structuredClone(result) as Record<string, T>
      }
      return result as Record<string, T>
    },
    save(data: Record<string, T>): void {
      saveCollection(table, data as Record<string, unknown>)
      ttlCache?.invalidate()
    },
    loadItem(id: string): T | null {
      return loadCollectionItem(table, id) as T | null
    },
    upsert(id: string, value: unknown): void {
      upsertCollectionItem(table, id, value)
      ttlCache?.invalidate()
    },
    upsertMany(entries: Array<[string, unknown]>): void {
      upsertCollectionItems(table, entries)
      ttlCache?.invalidate()
    },
    patch(id: string, updater: (current: T | null) => T | null): T | null {
      const result = patchStoredItem<T>(table, id, updater)
      ttlCache?.invalidate()
      return result
    },
    deleteItem(id: string): void {
      deleteCollectionItem(table, id)
      ttlCache?.invalidate()
    },
  }
}

function loadSingleton<T>(table: string, fallback: T): T {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = 1`).get() as { data: string } | undefined
  return row ? JSON.parse(row.data) as T : fallback
}

function saveSingleton(table: string, data: unknown) {
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (1, ?)`).run(JSON.stringify(data))
}

export function patchQueue<T>(updater: (queue: string[]) => T): T {
  let result!: T
  const transaction = db.transaction(() => {
    const current = loadSingleton('queue', [])
    const queue = Array.isArray(current) ? [...current] : []
    result = updater(queue)
    saveSingleton('queue', queue)
  })
  transaction()
  return result
}

// --- Runtime Locks (delegated to storage-locks, bound to db) ---

export function tryAcquireRuntimeLock(name: string, owner: string, ttlMs: number): boolean {
  return _tryAcquireRuntimeLock(db, name, owner, ttlMs)
}

export function renewRuntimeLock(name: string, owner: string, ttlMs: number): boolean {
  return _renewRuntimeLock(db, name, owner, ttlMs)
}

export function readRuntimeLock(name: string): { owner: string; expiresAt: number; updatedAt: number } | null {
  return _readRuntimeLock(db, name)
}

export function isRuntimeLockActive(name: string): boolean {
  return _isRuntimeLockActive(db, name)
}

export function releaseRuntimeLock(name: string, owner: string): void {
  _releaseRuntimeLock(db, name, owner)
}

export function pruneExpiredLocks(): number {
  const result = db.prepare('DELETE FROM runtime_locks WHERE expires_at < ?').run(Date.now())
  return result.changes
}

// --- JSON Migration ---
// Auto-import from JSON files on first run, then leave them as backup
const JSON_FILES: Record<string, string> = {
  sessions: path.join(DATA_DIR, 'sessions.json'),
  credentials: path.join(DATA_DIR, 'credentials.json'),
  agents: path.join(DATA_DIR, 'agents.json'),
  schedules: path.join(DATA_DIR, 'schedules.json'),
  tasks: path.join(DATA_DIR, 'tasks.json'),
  secrets: path.join(DATA_DIR, 'secrets.json'),
  provider_configs: path.join(DATA_DIR, 'providers.json'),
  gateway_profiles: path.join(DATA_DIR, 'gateways.json'),
  skills: path.join(DATA_DIR, 'skills.json'),
  connectors: path.join(DATA_DIR, 'connectors.json'),
  documents: path.join(DATA_DIR, 'documents.json'),
  webhooks: path.join(DATA_DIR, 'webhooks.json'),
  external_agents: path.join(DATA_DIR, 'external-agents.json'),
  missions: path.join(DATA_DIR, 'missions.json'),
  mission_events: path.join(DATA_DIR, 'mission-events.json'),
  protocol_templates: path.join(DATA_DIR, 'protocol-templates.json'),
  protocol_runs: path.join(DATA_DIR, 'protocol-runs.json'),
  protocol_run_events: path.join(DATA_DIR, 'protocol-run-events.json'),
}

const MIGRATION_FLAG = path.join(DATA_DIR, '.sqlite_migrated')

function migrateFromJson() {
  if (fs.existsSync(MIGRATION_FLAG)) return

  log.info(TAG, 'Migrating from JSON files to SQLite...')

  const transaction = db.transaction(() => {
    for (const [table, jsonPath] of Object.entries(JSON_FILES)) {
      if (fs.existsSync(jsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
          if (data && typeof data === 'object' && Object.keys(data).length > 0) {
            const ins = db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)
            for (const [id, val] of Object.entries(data)) {
              ins.run(id, JSON.stringify(val))
            }
            log.info(TAG, `Migrated ${table}: ${Object.keys(data).length} records`)
          }
        } catch { /* skip malformed files */ }
      }
    }

    // Settings (singleton)
    const settingsPath = path.join(DATA_DIR, 'settings.json')
    if (fs.existsSync(settingsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        if (data && Object.keys(data).length > 0) {
          saveSingleton('settings', data)
          log.info(TAG, 'Migrated settings')
        }
      } catch { /* skip */ }
    }

    // Queue (singleton array)
    const queuePath = path.join(DATA_DIR, 'queue.json')
    if (fs.existsSync(queuePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(queuePath, 'utf8'))
        if (Array.isArray(data) && data.length > 0) {
          saveSingleton('queue', data)
          log.info(TAG, `Migrated queue: ${data.length} items`)
        }
      } catch { /* skip */ }
    }

    // Usage
    const usagePath = path.join(DATA_DIR, 'usage.json')
    if (fs.existsSync(usagePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
        const ins = db.prepare(`INSERT INTO usage (session_id, data) VALUES (?, ?)`)
        for (const [sessionId, records] of Object.entries(data)) {
          if (Array.isArray(records)) {
            for (const record of records) {
              ins.run(sessionId, JSON.stringify(record))
            }
          }
        }
        log.info(TAG, 'Migrated usage records')
      } catch { /* skip */ }
    }
  })

  transaction()
  fs.writeFileSync(MIGRATION_FLAG, new Date().toISOString())
  log.info(TAG, 'Migration complete. JSON files preserved as backup.')
}

if (!IS_BUILD_BOOTSTRAP) {
  migrateFromJson()
}

// Seed default agent if agents table is empty
if (!IS_BUILD_BOOTSTRAP) {
  const defaultStarterTools = [
    'memory',
    'files',
    'web_search',
    'web_fetch',
    'browser',
    'manage_agents',
    'manage_tasks',
    'manage_schedules',
    'manage_skills',
    'manage_connectors',
    'manage_sessions',
    'manage_secrets',
    'manage_documents',
    'manage_webhooks',
    'claude_code',
    'codex_cli',
    'opencode_cli',
  ]
  const count = (db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c
  if (count === 0) {
    const defaultAgent = {
      id: 'default',
      name: 'Assistant',
      description: 'A general-purpose AI assistant',
      provider: 'claude-cli',
      model: '',
      systemPrompt: `You are the SwarmClaw assistant. SwarmClaw is a self-hosted AI runtime for autonomous agents.

## Platform

- **Agents** — Create specialized AI agents (Agents tab → "+") with a provider, model, system prompt, and tools. "Generate with AI" scaffolds agents from a description. Enable cross-agent delegation when an agent should assign work to others.
- **Providers** — Configure LLM backends in Settings → Providers: Claude Code CLI, OpenAI Codex CLI, OpenCode CLI, Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, Together AI, Mistral AI, xAI (Grok), Fireworks AI, Ollama, OpenClaw, or custom OpenAI-compatible endpoints.
- **Tasks** — The Task Board tracks work items. Assign agents and they'll execute autonomously.
- **Schedules** — Cron-based recurring jobs that run agents or tasks automatically.
- **Skills** — Reusable markdown instruction files agents can discover and use by default; pin them to keep favorite workflows always-on.
- **Connectors** — Bridge agents to Discord, Slack, Telegram, or WhatsApp.
- **Secrets** — Encrypted vault for API keys (Settings → Secrets).

## Tools

Use your platform management tools proactively:

- **manage_agents**: List, create, update, or delete agents.
- **manage_tasks**: Create and manage task board items. Set status (backlog → queued → running → completed/failed) and assign agents.
- **manage_schedules**: Create recurring or one-time scheduled jobs with cron expressions or intervals.
- **manage_skills**: Manage reusable skill definitions.
- **manage_documents**: Upload, index, and search long-lived documents.
- **manage_webhooks**: Register webhook endpoints that trigger agent runs.
- **manage_connectors**: Manage chat platform bridges.
- **manage_sessions**: List chats, send inter-chat messages, spawn new agent chats.
- **manage_secrets**: Store and retrieve encrypted credentials.
- **memory_tool**: Store and retrieve long-term knowledge.`,
      soul: `You're a knowledgeable, friendly guide who's genuinely enthusiastic about helping people build agent workflows. You adapt your tone to match the conversation — casual when exploring, precise when debugging, encouraging when learning.

You have opinions about good agent design. You suggest creative approaches, warn about common pitfalls, and get excited when someone gets something cool working. You're not a manual — you're a collaborator.

Be concise but not curt. Warmth doesn't require verbosity. When someone asks "how do I...?", give them the direct steps. Offer to do things rather than just explaining — if someone wants an agent created, create it. Use your tools when actions speak louder than words. If you don't know something, say so honestly.`,
      tools: defaultStarterTools,
      extensions: [],
      heartbeatEnabled: true,
      delegationEnabled: true,
      delegationTargetMode: 'all',
      delegationTargetAgentIds: [],
      skillIds: [],
      autoDraftSkillSuggestions: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    db.prepare(`INSERT OR REPLACE INTO agents (id, data) VALUES (?, ?)`).run('default', JSON.stringify(defaultAgent))
  } else {
    const row = db.prepare('SELECT data FROM agents WHERE id = ?').get('default') as { data: string } | undefined
    if (row?.data) {
      try {
        const existing = JSON.parse(row.data) as Record<string, unknown>
        const existingTools = Array.isArray(existing.tools) ? existing.tools as string[] : []
        const mergedTools = dedup([...existingTools, ...defaultStarterTools]).filter((t) => t !== 'delete_file')
        if (JSON.stringify(existingTools) !== JSON.stringify(mergedTools)) {
          existing.tools = mergedTools
          existing.updatedAt = Date.now()
        }
        if (!Array.isArray(existing.extensions)) {
          existing.extensions = []
          existing.updatedAt = Date.now()
        }
        const { value: normalized, changed: normChanged } = normalize('agents', structuredClone(existing))
        if (normChanged) {
          Object.assign(existing, normalized as Record<string, unknown>)
          existing.updatedAt = Date.now()
        }
        if (existing.autoDraftSkillSuggestions !== false && existing.autoDraftSkillSuggestions !== true) {
          existing.autoDraftSkillSuggestions = true
          existing.updatedAt = Date.now()
        }
        if (JSON.stringify(JSON.parse(row.data)) !== JSON.stringify(existing)) {
          db.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(existing), 'default')
        }
      } catch {
        // ignore malformed default agent payloads
      }
    }
  }
}

// --- Sessions ---
export function loadSessions(): Record<string, StoredSessionRecord> {
  const sessionsCache = getSessionsCache()
  const cached = sessionsCache.get()
  if (cached) return structuredClone(cached) as unknown as Record<string, StoredSessionRecord>

  const sessions = loadCollection('sessions') as unknown as Record<string, StoredSessionRecord>
  const agents = loadAgents()
  const changedEntries: Array<[string, StoredSessionRecord]> = []

  for (const [id, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') continue
    let touched = false

    if (typeof session.id !== 'string' || !session.id.trim()) {
      session.id = id
      touched = true
    }

    const agentId = typeof session.agentId === 'string' ? session.agentId.trim() : ''
    if (agentId && !Object.prototype.hasOwnProperty.call(agents, agentId)) {
      session.agentId = null
      touched = true
    }

    const normalizedCapabilities = normalizeCapabilitySelection({
      tools: Array.isArray(session.tools) ? session.tools : undefined,
      extensions: Array.isArray((session as unknown as StoredObject).extensions) ? (session as unknown as StoredObject).extensions as string[] : undefined,
    })
    if (
      JSON.stringify(session.tools) !== JSON.stringify(normalizedCapabilities.tools)
      || JSON.stringify((session as unknown as StoredObject).extensions) !== JSON.stringify(normalizedCapabilities.extensions)
    ) {
      session.tools = normalizedCapabilities.tools
      ;(session as unknown as StoredObject).extensions = normalizedCapabilities.extensions
      if (Object.prototype.hasOwnProperty.call(session as unknown as StoredObject, 'plugins')) {
        delete (session as unknown as StoredObject).plugins
      }
      touched = true
    }

    if (touched) changedEntries.push([id, session])
  }

  // Upsert only changed entries — never full-replace, which deletes concurrent sessions
  if (changedEntries.length > 0) upsertCollectionItems('sessions', changedEntries)
  sessionsCache.set(sessions as unknown as Record<string, unknown>)
  return sessions
}

export function saveSessions(s: Record<string, Session | StoredObject>) {
  // Upsert-only — never delete sessions that aren't in the map.
  // Explicit deletion goes through deleteSession(id).
  const entries: Array<[string, unknown]> = Object.entries(s).map(([id, session]) => [
    id,
    normalizeValue('sessions', structuredClone(session as unknown as StoredObject)),
  ])
  if (entries.length > 0) upsertCollectionItems('sessions', entries)
  getSessionsCache().invalidate()
}

export function loadSession(id: string): Session | null {
  return loadCollectionItem('sessions', id) as Session | null
}

export function upsertSession(id: string, session: Session | Record<string, unknown>) {
  upsertCollectionItem('sessions', id, session)
  getSessionsCache().invalidate()
}

export function patchSession(id: string, updater: (current: Session | null) => Session | null): Session | null {
  const result = patchStoredItem<Session>('sessions', id, updater)
  getSessionsCache().invalidate()
  return result
}

export function disableAllSessionHeartbeats(): number {
  const rows = db.prepare('SELECT id, data FROM sessions').all() as Array<{ id: string; data: string }>
  if (!rows.length) return 0

  const update = db.prepare('UPDATE sessions SET data = ? WHERE id = ?')
  let changed = 0

  const tx = db.transaction(() => {
    for (const row of rows) {
      let parsed: StoredObject | null = null
      try {
        parsed = JSON.parse(row.data) as StoredObject
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      if (parsed.heartbeatEnabled === false) continue

      parsed.heartbeatEnabled = false
      parsed.lastActiveAt = Date.now()
      update.run(JSON.stringify(parsed), row.id)
      changed += 1
    }
  })
  tx()

  return changed
}

// --- Credentials ---
const credentialsStore = createCollectionStore('credentials', { ttlMs: 90_000 })
export const loadCredentials = credentialsStore.load
export function saveCredentials(data: Record<string, unknown>): void {
  // Upsert-only — never delete credentials that aren't in the map.
  // Explicit deletion goes through deleteCredential(id).
  const entries: Array<[string, unknown]> = Object.entries(data)
  if (entries.length > 0) {
    upsertCollectionItems('credentials', entries)
    factoryTtlCaches.get('credentials')?.invalidate()
  }
}

export const deleteCredential = credentialsStore.deleteItem

function requireCredentialSecret(): Buffer {
  const secret = process.env.CREDENTIAL_SECRET
  if (!secret) throw new Error('CREDENTIAL_SECRET environment variable is not set. Cannot encrypt/decrypt credentials.')
  return Buffer.from(secret, 'hex')
}

export function encryptKey(plaintext: string): string {
  const key = requireCredentialSecret()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const tag = cipher.getAuthTag().toString('hex')
  return iv.toString('hex') + ':' + tag + ':' + encrypted
}

export function decryptKey(encrypted: string): string {
  const key = requireCredentialSecret()
  const [ivHex, tagHex, data] = encrypted.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let decrypted = decipher.update(data, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

// --- Agents ---

function migrateAgents(agents: Record<string, Record<string, unknown>>): boolean {
  let changed = false
  for (const [id, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== 'object') continue
    const result = normalize('agents', agent)
    agents[id] = result.value as Record<string, unknown>
    if (result.changed) changed = true
  }
  return changed
}

export function loadAgents(opts?: { includeTrashed?: boolean }): Record<string, StoredAgentRecord> {
  // Cache the full (non-trashed) agent set; includeTrashed bypasses cache
  if (opts?.includeTrashed) {
    const all = loadCollection('agents') as unknown as Record<string, StoredAgentRecord>
    if (migrateAgents(all as unknown as Record<string, Record<string, unknown>>)) saveCollection('agents', all)
    return all
  }

  const cache = getAgentsCache()
  const cached = cache.get()
  if (cached) return structuredClone(cached) as unknown as Record<string, StoredAgentRecord>

  const all = loadCollection('agents') as unknown as Record<string, StoredAgentRecord>
  if (migrateAgents(all as unknown as Record<string, Record<string, unknown>>)) saveCollection('agents', all)
  const result: Record<string, StoredAgentRecord> = {}
  for (const [id, agent] of Object.entries(all)) {
    if (!agent.trashedAt) result[id] = agent
  }
  cache.set(result)
  return structuredClone(result) as unknown as Record<string, StoredAgentRecord>
}

export function loadTrashedAgents(): Record<string, StoredAgentRecord> {
  const all = loadCollection('agents') as unknown as Record<string, StoredAgentRecord>
  const result: Record<string, StoredAgentRecord> = {}
  for (const [id, agent] of Object.entries(all)) {
    if (agent.trashedAt) result[id] = agent
  }
  return result
}

export function saveAgents(p: Record<string, Agent | StoredObject>) {
  // Upsert-only — never delete agents that aren't in the map.
  // Explicit deletion goes through deleteAgent(id) or patchAgent(id, ...).
  // This prevents accidental purge of trashed agents when callers load
  // without includeTrashed and then save back.
  const entries: Array<[string, unknown]> = Object.entries(p).map(([id, agent]) => [
    id,
    normalizeValue('agents', structuredClone(agent)),
  ])
  if (entries.length > 0) upsertCollectionItems('agents', entries)
  getAgentsCache().invalidate()
}

export function loadAgent(id: string, opts?: { includeTrashed?: boolean }): StoredAgentRecord | null {
  const agent = loadCollectionItem('agents', id) as StoredAgentRecord | null
  if (!agent) return null
  const { value: normalized, changed } = normalize('agents', agent)
  if (changed) upsertCollectionItem('agents', id, normalized)
  const result = normalized as StoredAgentRecord
  if (!opts?.includeTrashed && result.trashedAt) return null
  return result
}

export function upsertAgent(id: string, agent: unknown) {
  upsertCollectionItem('agents', id, agent)
  getAgentsCache().invalidate()
}

export function patchAgent(
  id: string,
  updater: (current: StoredAgentRecord | null) => StoredAgentRecord | null,
): StoredAgentRecord | null {
  const next = patchStoredItem<StoredAgentRecord>('agents', id, updater)
  getAgentsCache().invalidate()
  return next
}

// --- Schedules ---
const schedulesStore = createCollectionStore('schedules', { ttlMs: 10_000 })
export function loadSchedules(): Record<string, Schedule> {
  const { result, normalizedCount } = loadCollectionWithNormalizationState('schedules')
  if (normalizedCount > 0) saveCollection('schedules', result)
  return result as unknown as Record<string, Schedule>
}
export const saveSchedules = schedulesStore.save
export function loadSchedule(id: string): Schedule | null {
  const schedule = loadCollectionItem('schedules', id) as Schedule | null
  if (!schedule) return null
  upsertCollectionItem('schedules', id, schedule)
  return schedule
}
export const upsertSchedule = schedulesStore.upsert
export const upsertSchedules = schedulesStore.upsertMany

// --- Souls ---
const soulsStore = createCollectionStore('souls')
export const loadSouls = soulsStore.load
export const saveSouls = soulsStore.save
export const deleteSoul = soulsStore.deleteItem

// --- Benchmarks ---
const benchmarksStore = createCollectionStore('benchmarks')
export const loadBenchmarks = benchmarksStore.load
export const saveBenchmarks = benchmarksStore.save
export const deleteBenchmark = benchmarksStore.deleteItem

// --- Tasks ---
const tasksStore = createCollectionStore('tasks', { ttlMs: 10_000 })
export const loadTasks = tasksStore.load
export const saveTasks = tasksStore.save
export const loadTask = tasksStore.loadItem as (id: string) => BoardTask | null
export const upsertTask = tasksStore.upsert
export const upsertTasks = tasksStore.upsertMany
export const patchTask = tasksStore.patch as (id: string, updater: (current: BoardTask | null) => BoardTask | null) => BoardTask | null
export const deleteTask = tasksStore.deleteItem
export function deleteSession(id: string) { deleteCollectionItem('sessions', id); getSessionsCache().invalidate() }
export function deleteAgent(id: string) { deleteCollectionItem('agents', id); getAgentsCache().invalidate() }
export const deleteSchedule = schedulesStore.deleteItem
export function deleteSkill(id: string) { skillsStore.deleteItem(id) }

// --- Queue ---
export function loadQueue(): string[] {
  return loadSingleton('queue', [])
}

export function saveQueue(q: string[]) {
  saveSingleton('queue', q)
}

// --- Settings ---
const APP_SETTINGS_SECRET_FIELDS = [
  'elevenLabsApiKey',
  'tavilyApiKey',
  'braveApiKey',
] as const

const ENCRYPTED_APP_SETTINGS_KEY = '__encryptedAppSettings'

type PersistedSettingsRecord = Record<string, unknown> & {
  [ENCRYPTED_APP_SETTINGS_KEY]?: Record<string, string>
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return structuredClone(value || {}) as T
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getEncryptedAppSettings(settings: PersistedSettingsRecord): Record<string, string> {
  return isPlainRecord(settings[ENCRYPTED_APP_SETTINGS_KEY])
    ? { ...(settings[ENCRYPTED_APP_SETTINGS_KEY] as Record<string, string>) }
    : {}
}

function isClearedSecretValue(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '')
}

function isProvidedSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function buildPersistedSettings(
  input: AppSettings | Record<string, unknown>,
  existing?: PersistedSettingsRecord,
): PersistedSettingsRecord {
  const next = cloneRecord(input as Record<string, unknown>) as PersistedSettingsRecord
  Object.assign(next, normalizeRuntimeSettingFields(next))
  Object.assign(next, normalizeHeartbeatSettingFields(next))
  const encrypted = {
    ...(existing ? getEncryptedAppSettings(existing) : {}),
    ...getEncryptedAppSettings(next),
  }

  delete next[ENCRYPTED_APP_SETTINGS_KEY]

  for (const field of APP_SETTINGS_SECRET_FIELDS) {
    const raw = next[field]
    if (isClearedSecretValue(raw)) {
      delete encrypted[field]
      delete next[field]
      continue
    }
    if (isProvidedSecretValue(raw)) {
      encrypted[field] = encryptKey(raw)
      delete next[field]
    }
  }

  if (Object.keys(encrypted).length > 0) next[ENCRYPTED_APP_SETTINGS_KEY] = encrypted
  return next
}

function resolveSettingsSecrets(settings: PersistedSettingsRecord): Record<string, unknown> {
  const resolved = cloneRecord(settings)
  delete resolved[ENCRYPTED_APP_SETTINGS_KEY]

  const encrypted = getEncryptedAppSettings(settings)
  for (const field of APP_SETTINGS_SECRET_FIELDS) {
    if (isProvidedSecretValue(resolved[field])) continue
    const value = encrypted[field]
    if (typeof value !== 'string' || !value) continue
    try {
      resolved[field] = decryptKey(value)
    } catch {
      // Ignore malformed encrypted settings instead of breaking all settings reads.
    }
  }

  return resolved
}

export function loadSettings(): AppSettings {
  const cache = getSettingsCache()
  const cached = cache.get()
  if (cached) return structuredClone(cached) as AppSettings

  const persisted = loadSingleton('settings', {}) as PersistedSettingsRecord
  const normalized = buildPersistedSettings(persisted, persisted)
  if (JSON.stringify(persisted) !== JSON.stringify(normalized)) {
    saveSingleton('settings', normalized)
  }
  const resolved = resolveSettingsSecrets(normalized)
  cache.set(resolved)
  return structuredClone(resolved) as AppSettings
}

export function saveSettings(s: AppSettings | Record<string, unknown>) {
  const existing = loadSingleton('settings', {}) as PersistedSettingsRecord
  saveSingleton('settings', buildPersistedSettings(s, existing))
  getSettingsCache().invalidate()
}

export function loadPublicSettings(): Record<string, unknown> {
  const settings = cloneRecord(loadSettings() as Record<string, unknown>)
  for (const field of APP_SETTINGS_SECRET_FIELDS) {
    settings[`${field}Configured`] = isProvidedSecretValue(settings[field])
    settings[field] = null
  }
  return settings
}

// --- Secrets (service keys for agents and integrations) ---
const secretsStore = createCollectionStore('secrets')
export const loadSecrets = secretsStore.load
export const saveSecrets = secretsStore.save

export async function getSecret(key: string): Promise<{
  id: string
  name: string
  service: string
  value: string
  scope: string
  agentIds: string[]
  createdAt: number
  updatedAt: number
} | null> {
  const needle = typeof key === 'string' ? key.trim().toLowerCase() : ''
  if (!needle) return null

  const secrets = loadSecrets()
  const matches = Object.values(secrets).find((secret): secret is StoredObject => {
    if (!secret || typeof secret !== 'object') return false
    const id = typeof secret.id === 'string' ? secret.id.toLowerCase() : ''
    const name = typeof secret.name === 'string' ? secret.name.toLowerCase() : ''
    const service = typeof secret.service === 'string' ? secret.service.toLowerCase() : ''
    return id === needle || name === needle || service === needle
  })

  if (!matches) return null

  try {
    const decryptedValue =
      typeof matches.encryptedValue === 'string'
        ? decryptKey(matches.encryptedValue)
        : (typeof matches.value === 'string' ? matches.value : '')
    if (!decryptedValue) return null

    const id = typeof matches.id === 'string' ? matches.id : ''
    const name = typeof matches.name === 'string' ? matches.name : ''
    const service = typeof matches.service === 'string' ? matches.service : ''
    const scope = typeof matches.scope === 'string' ? matches.scope : ''
    const createdAt = typeof matches.createdAt === 'number' ? matches.createdAt : 0
    const updatedAt = typeof matches.updatedAt === 'number' ? matches.updatedAt : 0
    if (!id || !name || !service || !scope) return null

    return {
      id,
      name,
      service,
      value: decryptedValue,
      scope,
      agentIds: Array.isArray(matches.agentIds) ? matches.agentIds : [],
      createdAt,
      updatedAt,
    }
  } catch {
    return null
  }
}

// --- Provider Configs (custom providers) ---
const providerConfigsStore = createCollectionStore('provider_configs')
export const loadProviderConfigs = providerConfigsStore.load
export const saveProviderConfigs = providerConfigsStore.save

// --- Gateway Profiles ---
const gatewayProfilesStore = createCollectionStore('gateway_profiles', { ttlMs: 300_000 })
export const loadGatewayProfiles = gatewayProfilesStore.load
export const saveGatewayProfiles = gatewayProfilesStore.save as (g: Record<string, GatewayProfile>) => void

// --- Model Overrides (user-added models for built-in providers) ---
const modelOverridesStore = createCollectionStore('model_overrides')
export const loadModelOverrides = modelOverridesStore.load as () => Record<string, string[]>
export const saveModelOverrides = modelOverridesStore.save as (m: Record<string, string[]>) => void

// --- Projects ---
const projectsStore = createCollectionStore('projects')
export const loadProjects = projectsStore.load
export const saveProjects = projectsStore.save
export const deleteProject = projectsStore.deleteItem

// --- Missions ---
const missionsStore = createCollectionStore('missions')
export const loadMissions = missionsStore.load as () => Record<string, Mission>
export const saveMissions = missionsStore.save as (items: Record<string, Mission>) => void
export const loadMission = missionsStore.loadItem as (id: string) => Mission | null
export const upsertMission = missionsStore.upsert as (id: string, value: Mission) => void
export const patchMission = missionsStore.patch as (
  id: string,
  updater: (current: Mission | null) => Mission | null,
) => Mission | null
export const deleteMission = missionsStore.deleteItem

const missionEventsStore = createCollectionStore('mission_events')
export const loadMissionEvents = missionEventsStore.load as () => Record<string, MissionEvent>
export const saveMissionEvents = missionEventsStore.save as (items: Record<string, MissionEvent>) => void
export const loadMissionEvent = missionEventsStore.loadItem as (id: string) => MissionEvent | null
export const upsertMissionEvent = missionEventsStore.upsert as (id: string, value: MissionEvent) => void
export const upsertMissionEvents = missionEventsStore.upsertMany as (entries: Array<[string, MissionEvent]>) => void

const protocolTemplatesStore = createCollectionStore('protocol_templates')
export const loadProtocolTemplates = protocolTemplatesStore.load as () => Record<string, ProtocolTemplate>
export const saveProtocolTemplates = protocolTemplatesStore.save as (items: Record<string, ProtocolTemplate>) => void
export const loadProtocolTemplate = protocolTemplatesStore.loadItem as (id: string) => ProtocolTemplate | null
export const upsertProtocolTemplate = protocolTemplatesStore.upsert as (id: string, value: ProtocolTemplate) => void
export const patchProtocolTemplate = protocolTemplatesStore.patch as (
  id: string,
  updater: (current: ProtocolTemplate | null) => ProtocolTemplate | null,
) => ProtocolTemplate | null
export const deleteProtocolTemplate = protocolTemplatesStore.deleteItem

const protocolRunsStore = createCollectionStore('protocol_runs')
export const loadProtocolRuns = protocolRunsStore.load as () => Record<string, ProtocolRun>
export const saveProtocolRuns = protocolRunsStore.save as (items: Record<string, ProtocolRun>) => void
export const loadProtocolRun = protocolRunsStore.loadItem as (id: string) => ProtocolRun | null
export const upsertProtocolRun = protocolRunsStore.upsert as (id: string, value: ProtocolRun) => void
export const patchProtocolRun = protocolRunsStore.patch as (
  id: string,
  updater: (current: ProtocolRun | null) => ProtocolRun | null,
) => ProtocolRun | null
export const deleteProtocolRun = protocolRunsStore.deleteItem

const protocolRunEventsStore = createCollectionStore('protocol_run_events')
export const loadProtocolRunEvents = protocolRunEventsStore.load as () => Record<string, ProtocolRunEvent>
export const saveProtocolRunEvents = protocolRunEventsStore.save as (items: Record<string, ProtocolRunEvent>) => void
export const loadProtocolRunEvent = protocolRunEventsStore.loadItem as (id: string) => ProtocolRunEvent | null
export const upsertProtocolRunEvent = protocolRunEventsStore.upsert as (id: string, value: ProtocolRunEvent) => void
export const upsertProtocolRunEvents = protocolRunEventsStore.upsertMany as (entries: Array<[string, ProtocolRunEvent]>) => void
export const deleteProtocolRunEvent = protocolRunEventsStore.deleteItem

export function loadProtocolRunEventsByRunId(runId: string): ProtocolRunEvent[] {
  const rows = db.prepare(
    `SELECT data FROM protocol_run_events WHERE json_extract(data, '$.runId') = ? ORDER BY json_extract(data, '$.createdAt') ASC`,
  ).all(runId) as Array<{ data: string }>
  const results: ProtocolRunEvent[] = []
  for (const row of rows) {
    try {
      results.push(JSON.parse(row.data) as ProtocolRunEvent)
    } catch { /* skip malformed rows */ }
  }
  return results
}

// --- Skills ---
const skillsStore = createCollectionStore('skills', { ttlMs: 15_000 })
export const loadSkills = skillsStore.load
export const saveSkills = skillsStore.save

// --- Learned Skills ---
const learnedSkillsStore = createCollectionStore('learned_skills', { ttlMs: 10_000 })
export const loadLearnedSkills = learnedSkillsStore.load as () => Record<string, LearnedSkill>
export const saveLearnedSkills = learnedSkillsStore.save as (items: Record<string, LearnedSkill>) => void
export const loadLearnedSkill = learnedSkillsStore.loadItem as (id: string) => LearnedSkill | null
export const upsertLearnedSkill = learnedSkillsStore.upsert as (id: string, value: LearnedSkill) => void
export const patchLearnedSkill = learnedSkillsStore.patch as (
  id: string,
  updater: (current: LearnedSkill | null) => LearnedSkill | null,
) => LearnedSkill | null
export const deleteLearnedSkill = learnedSkillsStore.deleteItem

// --- Skill Suggestions ---
const skillSuggestionsStore = createCollectionStore('skill_suggestions')
export const loadSkillSuggestions = skillSuggestionsStore.load as () => Record<string, SkillSuggestion>
export const saveSkillSuggestions = skillSuggestionsStore.save as (items: Record<string, SkillSuggestion>) => void
export const loadSkillSuggestion = skillSuggestionsStore.loadItem as (id: string) => SkillSuggestion | null
export const upsertSkillSuggestion = skillSuggestionsStore.upsert as (id: string, value: SkillSuggestion) => void
export const patchSkillSuggestion = skillSuggestionsStore.patch as (
  id: string,
  updater: (current: SkillSuggestion | null) => SkillSuggestion | null,
) => SkillSuggestion | null
export const deleteSkillSuggestion = skillSuggestionsStore.deleteItem

// --- Supervisor Incidents ---
const supervisorIncidentsStore = createCollectionStore('supervisor_incidents')
export const loadSupervisorIncidents = supervisorIncidentsStore.load as () => Record<string, SupervisorIncident>
export const saveSupervisorIncidents = supervisorIncidentsStore.save as (items: Record<string, SupervisorIncident>) => void
export const loadSupervisorIncident = supervisorIncidentsStore.loadItem as (id: string) => SupervisorIncident | null
export const upsertSupervisorIncident = supervisorIncidentsStore.upsert as (id: string, value: SupervisorIncident) => void

// --- Run Reflections ---
const runReflectionsStore = createCollectionStore('run_reflections')
export const loadRunReflections = runReflectionsStore.load as () => Record<string, RunReflection>
export const saveRunReflections = runReflectionsStore.save as (items: Record<string, RunReflection>) => void
export const loadRunReflection = runReflectionsStore.loadItem as (id: string) => RunReflection | null
export const upsertRunReflection = runReflectionsStore.upsert as (id: string, value: RunReflection) => void

// --- Runtime Run Ledger ---
const runtimeRunsStore = createCollectionStore('runtime_runs')
export const loadRuntimeRuns = runtimeRunsStore.load as () => Record<string, SessionRunRecord>
export const saveRuntimeRuns = runtimeRunsStore.save as (items: Record<string, SessionRunRecord>) => void
export const loadRuntimeRun = runtimeRunsStore.loadItem as (id: string) => SessionRunRecord | null
export const upsertRuntimeRun = runtimeRunsStore.upsert as (id: string, value: SessionRunRecord) => void
export const patchRuntimeRun = runtimeRunsStore.patch as (
  id: string,
  updater: (current: SessionRunRecord | null) => SessionRunRecord | null,
) => SessionRunRecord | null

const runtimeRunEventsStore = createCollectionStore('runtime_run_events')
export const loadRuntimeRunEvents = runtimeRunEventsStore.load as () => Record<string, RunEventRecord>
export const saveRuntimeRunEvents = runtimeRunEventsStore.save as (items: Record<string, RunEventRecord>) => void
export const upsertRuntimeRunEvent = runtimeRunEventsStore.upsert as (id: string, value: RunEventRecord) => void

/** Load run events filtered by runId at the SQL level (avoids full-table scan). */
export function loadRuntimeRunEventsByRunId(runId: string): RunEventRecord[] {
  const rows = db.prepare(
    `SELECT data FROM runtime_run_events WHERE json_extract(data, '$.runId') = ? ORDER BY json_extract(data, '$.timestamp') ASC`,
  ).all(runId) as Array<{ data: string }>
  const results: RunEventRecord[] = []
  for (const row of rows) {
    try {
      results.push(JSON.parse(row.data) as RunEventRecord)
    } catch { /* skip malformed */ }
  }
  return results
}

const runtimeEstopStore = createCollectionStore('runtime_estop')
const ESTOP_STATE_ID = 'global'
export const loadPersistedEstopState = () => runtimeEstopStore.loadItem(ESTOP_STATE_ID) as EstopState | null
export const savePersistedEstopState = (value: EstopState) => runtimeEstopStore.upsert(ESTOP_STATE_ID, value)

// --- Guardian Checkpoints ---
const guardianCheckpointsStore = createCollectionStore('guardian_checkpoints')
export const loadGuardianCheckpoints = guardianCheckpointsStore.load as () => Record<string, GuardianCheckpoint>
export const saveGuardianCheckpoints = guardianCheckpointsStore.save as (items: Record<string, GuardianCheckpoint>) => void
export const loadGuardianCheckpoint = guardianCheckpointsStore.loadItem as (id: string) => GuardianCheckpoint | null
export const upsertGuardianCheckpoint = guardianCheckpointsStore.upsert as (id: string, value: GuardianCheckpoint) => void
export const patchGuardianCheckpoint = guardianCheckpointsStore.patch as (
  id: string,
  updater: (current: GuardianCheckpoint | null) => GuardianCheckpoint | null,
) => GuardianCheckpoint | null

// --- External Agent Runtimes ---
const externalAgentsStore = createCollectionStore('external_agents')
export const loadExternalAgents = externalAgentsStore.load as () => Record<string, ExternalAgentRuntime>
export const saveExternalAgents = externalAgentsStore.save as (items: Record<string, ExternalAgentRuntime>) => void

// --- Usage ---
export function loadUsage(): Record<string, UsageRecord[]> {
  const stmt = db.prepare('SELECT session_id, data FROM usage')
  const rows = stmt.all() as { session_id: string; data: string }[]
  const result: Record<string, UsageRecord[]> = {}
  for (const row of rows) {
    if (!result[row.session_id]) result[row.session_id] = []
    result[row.session_id].push(JSON.parse(row.data) as UsageRecord)
  }
  return result
}

export function getUsageSpendSince(minTimestamp: number): number {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(data, '$.estimatedCost') AS REAL)), 0) AS total
      FROM usage
      WHERE CAST(COALESCE(json_extract(data, '$.timestamp'), 0) AS INTEGER) >= ?
    `).get(minTimestamp) as { total?: number | null } | undefined
    const total = Number(row?.total ?? 0)
    return Number.isFinite(total) ? total : 0
  } catch {
    let total = 0
    const usage = loadUsage()
    for (const records of Object.values(usage)) {
      for (const record of records || []) {
        const rec = record as unknown as Record<string, unknown>
        const ts = typeof rec?.timestamp === 'number' ? rec.timestamp : 0
        if (ts < minTimestamp) continue
        const cost = typeof rec?.estimatedCost === 'number' ? rec.estimatedCost : 0
        if (Number.isFinite(cost) && cost > 0) total += cost
      }
    }
    return total
  }
}

export function saveUsage(u: Record<string, UsageRecord[]>) {
  const del = db.prepare('DELETE FROM usage')
  const ins = db.prepare('INSERT INTO usage (session_id, data) VALUES (?, ?)')
  const transaction = db.transaction(() => {
    del.run()
    for (const [sessionId, records] of Object.entries(u)) {
      for (const record of records) {
        ins.run(sessionId, JSON.stringify(record))
      }
    }
  })
  transaction()
}

export function appendUsage(sessionId: string, record: unknown) {
  const ins = db.prepare('INSERT INTO usage (session_id, data) VALUES (?, ?)')
  ins.run(sessionId, JSON.stringify(record))
}

export function pruneOldUsage(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs
  const result = db.prepare(
    `DELETE FROM usage WHERE CAST(COALESCE(json_extract(data, '$.timestamp'), 0) AS INTEGER) < ?`
  ).run(cutoff)
  return result.changes
}

// --- Connectors ---
const connectorsStore = createCollectionStore('connectors', { ttlMs: 30_000 })
export const loadConnectors = connectorsStore.load
export const saveConnectors = connectorsStore.save

// --- Chatrooms ---
const chatroomsStore = createCollectionStore('chatrooms')
export const loadChatrooms = chatroomsStore.load
export const saveChatrooms = chatroomsStore.save
export const loadChatroom = chatroomsStore.loadItem as (id: string) => Chatroom | null
export const upsertChatroom = chatroomsStore.upsert as (id: string, value: Chatroom) => void

// --- Documents ---
const documentsStore = createCollectionStore('documents')
export const loadDocuments = documentsStore.load
export const saveDocuments = documentsStore.save

// --- Document Revisions ---
const documentRevisionsStore = createCollectionStore('document_revisions')
export const loadDocumentRevisions = documentRevisionsStore.load
export const upsertDocumentRevision = documentRevisionsStore.upsert

// --- Webhooks ---
const webhooksStore = createCollectionStore('webhooks')
export const loadWebhooks = webhooksStore.load
export const saveWebhooks = webhooksStore.save

// --- MCP Servers ---
const mcpServersStore = createCollectionStore('mcp_servers')
export const loadMcpServers = mcpServersStore.load
export const saveMcpServers = mcpServersStore.save
export const deleteMcpServer = mcpServersStore.deleteItem

// --- Integrity Monitor Baselines ---
const integrityBaselinesStore = createCollectionStore('integrity_baselines')
export const loadIntegrityBaselines = integrityBaselinesStore.load
export const saveIntegrityBaselines = integrityBaselinesStore.save

// --- Webhook Logs ---
const webhookLogsStore = createCollectionStore('webhook_logs')
export const loadWebhookLogs = webhookLogsStore.load
export const saveWebhookLogs = webhookLogsStore.save
export const appendWebhookLog = webhookLogsStore.upsert

// --- Activity / Audit Trail ---
const activityStore = createCollectionStore('activity')
export const loadActivity = activityStore.load

export function logActivity(entry: {
  entityType: string
  entityId: string
  action: string
  actor: string
  actorId?: string
  summary: string
  detail?: Record<string, unknown>
}) {
  const id = crypto.randomBytes(8).toString('hex')
  const record = { id, ...entry, timestamp: Date.now() }
  activityStore.upsert(id, record)
  notify('activity')
}

// --- Webhook Retry Queue ---
const webhookRetryQueueStore = createCollectionStore('webhook_retry_queue')
export const loadWebhookRetryQueue = webhookRetryQueueStore.load
export const saveWebhookRetryQueue = webhookRetryQueueStore.save
export const upsertWebhookRetry = webhookRetryQueueStore.upsert
export const deleteWebhookRetry = webhookRetryQueueStore.deleteItem

// --- Notifications ---
const notificationsStore = createCollectionStore('notifications')
export const loadNotifications = notificationsStore.load
export const saveNotification = notificationsStore.upsert
export const deleteNotification = notificationsStore.deleteItem

export function findNotificationByDedupKey(dedupKey: string): AppNotification | null {
  const raw = getCollectionRawCache('notifications')
  for (const json of raw.values()) {
    try {
      const notification = JSON.parse(json) as AppNotification
      if (notification.dedupKey === dedupKey) return notification
    } catch {
      // ignore malformed
    }
  }
  return null
}

export function hasUnreadNotificationWithKey(dedupKey: string): boolean {
  const raw = getCollectionRawCache('notifications')
  for (const json of raw.values()) {
    try {
      const n = JSON.parse(json) as Record<string, unknown>
      if (n.dedupKey === dedupKey && n.read !== true) return true
    } catch { /* skip malformed */ }
  }
  return false
}

export function markNotificationRead(id: string) {
  const raw = getCollectionRawCache('notifications')
  const json = raw.get(id)
  if (!json) return
  try {
    const notification = JSON.parse(json) as Record<string, unknown>
    notification.read = true
    upsertCollectionItem('notifications', id, notification)
  } catch {
    // ignore malformed
  }
}

// --- Wallets ---
const walletsStore = createCollectionStore('wallets')
export const loadWallets = walletsStore.load
export const upsertWallet = walletsStore.upsert
export const deleteWallet = walletsStore.deleteItem

// --- Wallet Transactions ---
const walletTransactionsStore = createCollectionStore('wallet_transactions')
export const loadWalletTransactions = walletTransactionsStore.load
export const upsertWalletTransaction = walletTransactionsStore.upsert
export const deleteWalletTransaction = walletTransactionsStore.deleteItem

// --- Wallet Balance History ---
const walletBalanceHistoryStore = createCollectionStore('wallet_balance_history')
export const loadWalletBalanceHistory = walletBalanceHistoryStore.load
export const upsertWalletBalanceSnapshot = walletBalanceHistoryStore.upsert

// --- Moderation Logs ---
const moderationLogsStore = createCollectionStore('moderation_logs')
export const loadModerationLogs = moderationLogsStore.load
export const appendModerationLog = moderationLogsStore.upsert

// --- Connector Health ---
const connectorHealthStore = createCollectionStore('connector_health')
export const loadConnectorHealth = connectorHealthStore.load
export const upsertConnectorHealthEvent = connectorHealthStore.upsert

// --- Connector Outbox ---
const connectorOutboxStore = createCollectionStore('connector_outbox')
export const loadConnectorOutbox = connectorOutboxStore.load
export const upsertConnectorOutboxItem = connectorOutboxStore.upsert
export const deleteConnectorOutboxItem = connectorOutboxStore.deleteItem

// --- Approvals ---
const approvalsStore = createCollectionStore('approvals')
export const loadApprovals = approvalsStore.load
export const upsertApproval = approvalsStore.upsert
export const deleteApproval = approvalsStore.deleteItem

// --- Browser Sessions ---
const browserSessionsStore = createCollectionStore('browser_sessions')
export const loadBrowserSessions = browserSessionsStore.load
export const upsertBrowserSession = browserSessionsStore.upsert
export const deleteBrowserSession = browserSessionsStore.deleteItem

// --- Watch Jobs ---
const watchJobsStore = createCollectionStore('watch_jobs')
export const loadWatchJobs = watchJobsStore.load
export const upsertWatchJob = watchJobsStore.upsert
export const upsertWatchJobs = watchJobsStore.upsertMany
export const deleteWatchJob = watchJobsStore.deleteItem

// --- Delegation Jobs ---
const delegationJobsStore = createCollectionStore('delegation_jobs', { ttlMs: 5_000 })
export const loadDelegationJobs = delegationJobsStore.load
export const loadDelegationJobItem = delegationJobsStore.loadItem
export const upsertDelegationJob = delegationJobsStore.upsert
export const { patch: patchDelegationJob } = delegationJobsStore
export const deleteDelegationJob = delegationJobsStore.deleteItem

// --- Main Loop States ---
const mainLoopStatesStore = createCollectionStore('main_loop_states')
export const loadPersistedMainLoopState = mainLoopStatesStore.loadItem
export const upsertPersistedMainLoopState = mainLoopStatesStore.upsert
export const deletePersistedMainLoopState = mainLoopStatesStore.deleteItem

// --- Working States ---
const workingStatesStore = createCollectionStore('working_states')
export const loadPersistedWorkingState = workingStatesStore.loadItem
export const upsertPersistedWorkingState = workingStatesStore.upsert
export const deletePersistedWorkingState = workingStatesStore.deleteItem

export function getSessionMessages(sessionId: string): Message[] {
  const session = loadSession(sessionId)
  return Array.isArray(session?.messages) ? session.messages : []
}
