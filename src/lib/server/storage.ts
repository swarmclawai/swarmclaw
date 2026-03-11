import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import type { ChildProcess } from 'node:child_process'
import Database from 'better-sqlite3'

import { perf } from '@/lib/server/runtime/perf'
import { DATA_DIR, IS_BUILD_BOOTSTRAP, WORKSPACE_DIR } from './data-dir'
import { safeJsonParseObject } from './json-utils'
import { normalizeHeartbeatSettingFields } from '@/lib/runtime/heartbeat-defaults'
import { normalizeRuntimeSettingFields } from '@/lib/runtime/runtime-loop'
import { normalizeAgentSandboxConfig } from '@/lib/agent-sandbox-defaults'
import type { AppNotification, BoardTask, ExternalAgentRuntime, GatewayProfile, Message, Session } from '@/types'
import { dedup, hmrSingleton } from '@/lib/shared-utils'
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')

// --- TTL Cache (read-through with write-through invalidation) ---

interface TTLEntry<T> {
  value: T
  expiresAt: number
}

/**
 * Simple TTL cache for hot-path reads that rarely change.
 * Stored on globalThis so HMR doesn't reset it.
 */
class TTLCache<T> {
  private entry: TTLEntry<T> | null = null
  constructor(private readonly ttlMs: number) {}

  get(): T | undefined {
    if (!this.entry) return undefined
    if (Date.now() > this.entry.expiresAt) {
      this.entry = null
      return undefined
    }
    return this.entry.value
  }

  set(value: T): void {
    this.entry = { value, expiresAt: Date.now() + this.ttlMs }
  }

  invalidate(): void {
    this.entry = null
  }
}

type TTLCacheStore = {
  settings?: TTLCache<Record<string, unknown>>
  agents?: TTLCache<Record<string, unknown>>
}
const ttlCaches: TTLCacheStore = hmrSingleton<TTLCacheStore>('__swarmclaw_ttl_caches__', () => ({}))

function getSettingsCache() { return ttlCaches.settings ?? (ttlCaches.settings = new TTLCache(60_000)) }
function getAgentsCache() { return ttlCaches.agents ?? (ttlCaches.agents = new TTLCache(15_000)) }

// --- LRU Cache ---

const DEFAULT_LRU_CAPACITY = 5000

/** Per-collection capacity overrides from COLLECTION_CACHE_LIMITS env var (JSON). */
function parseCacheLimits(): Record<string, number> {
  const raw = process.env.COLLECTION_CACHE_LIMITS
  if (!raw) return {}
  const parsed = safeJsonParseObject(raw)
  if (!parsed) return {}
  const result: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && v > 0) result[k] = v
  }
  return result
}

const cacheLimits = parseCacheLimits()

function capacityFor(collection: string): number {
  return cacheLimits[collection] ?? DEFAULT_LRU_CAPACITY
}

/**
 * A Map wrapper with LRU eviction. JS Maps iterate in insertion order,
 * so the *first* key is the least-recently-used entry.
 */
class LRUMap<K, V> {
  private readonly map = new Map<K, V>()
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)!
    // Move to end (most-recently-used)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key)
    }
    this.map.set(key, value)
    // Evict oldest if over capacity
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
    return this
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  keys(): MapIterator<K> {
    return this.map.keys()
  }

  values(): MapIterator<V> {
    return this.map.values()
  }

  entries(): MapIterator<[K, V]> {
    return this.map.entries()
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.map[Symbol.iterator]()
  }
}

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
}
db.pragma('foreign_keys = ON')

type StoredObject = Record<string, unknown>
type ActiveProcess = ChildProcess | {
  runId?: string | null
  source?: string
  kill: (signal?: NodeJS.Signals | number) => boolean | void
}
const collectionCache: Map<string, LRUMap<string, string>> =
  hmrSingleton('__swarmclaw_storage_collection_cache__', () => new Map<string, LRUMap<string, string>>())

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
  'connectors',
  'documents',
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
  'browser_sessions',
  'watch_jobs',
  'delegation_jobs',
  'external_agents',
] as const

export type StorageCollection = (typeof COLLECTIONS)[number]

for (const table of COLLECTIONS) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
}

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
  result: Record<string, any>
  normalizedCount: number
} {
  const endPerf = perf.start('storage', 'loadCollection', { table })
  const raw = getCollectionRawCache(table)
  const result: Record<string, any> = {}
  let normalizedCount = 0
  for (const [id, data] of raw.entries()) {
    try {
      const normalized = normalizeStoredRecord(table, JSON.parse(data))
      result[id] = normalized
      if (JSON.stringify(normalized) !== data) normalizedCount += 1
    } catch {
      // Ignore malformed records instead of crashing list endpoints.
    }
  }
  endPerf({ count: raw.size, normalizedCount })
  return { result, normalizedCount }
}

function normalizeStoredRecord(table: string, value: unknown): unknown {
  if (table === 'agents') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value

    const agent = value as StoredObject
    if (Array.isArray(agent.tools) && !Array.isArray(agent.plugins)) {
      agent.plugins = agent.tools
      delete agent.tools
    }
    agent.sandboxConfig = normalizeAgentSandboxConfig(agent.sandboxConfig)
    return agent
  }

  if (table !== 'sessions') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value

  const session = value as StoredObject
  if (session.sessionType !== 'human') session.sessionType = 'human'
  const isLegacyShortcut = (
    (typeof session.id === 'string' && session.id.startsWith('agent-thread-'))
    || (typeof session.name === 'string' && session.name.startsWith('agent-thread:'))
  )
  if (
    isLegacyShortcut
    && typeof session.agentId === 'string'
    && session.agentId.trim()
    && (!session.shortcutForAgentId || session.shortcutForAgentId !== session.agentId)
  ) {
    session.shortcutForAgentId = session.agentId
  }
  if (Array.isArray(session.tools) && !Array.isArray(session.plugins)) {
    session.plugins = [...session.tools]
  }
  if ('mainLoopState' in session) delete session.mainLoopState
  return session
}

function loadCollection(table: string): Record<string, any> {
  return loadCollectionWithNormalizationState(table).result
}

function saveCollection(table: string, data: Record<string, any>) {
  const endPerf = perf.start('storage', 'saveCollection', { table })
  const current = getCollectionRawCache(table)
  const next = new Map<string, string>()
  const toUpsert: Array<[string, string]> = []
  const toDelete: string[] = []

  for (const [id, val] of Object.entries(data)) {
    const normalized = normalizeStoredRecord(table, val)
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
  factoryTtlCaches.get(table)?.invalidate()
}

/**
 * Atomically insert or update a single item in a collection without
 * loading/saving the entire collection. Prevents race conditions when
 * concurrent processes are modifying different items.
 */
function upsertCollectionItem(table: string, id: string, value: unknown) {
  const serialized = JSON.stringify(normalizeStoredRecord(table, value))
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`).run(id, serialized)
  // Update the in-memory cache
  const cached = collectionCache.get(table)
  if (cached) {
    cached.set(id, serialized)
  }
  factoryTtlCaches.get(table)?.invalidate()
}

function loadCollectionItem(table: string, id: string): unknown | null {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined
  if (!row) return null
  try {
    return normalizeStoredRecord(table, JSON.parse(row.data))
  } catch {
    return null
  }
}

function upsertCollectionItems(table: string, entries: Array<[string, unknown]>): void {
  if (!entries.length) return
  const prepared = entries
    .map(([id, value]) => [id, JSON.stringify(normalizeStoredRecord(table, value))] as const)
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
  factoryTtlCaches.get(table)?.invalidate()
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

const factoryTtlCaches = hmrSingleton('__swarmclaw_factory_ttl__', () => new Map<string, TTLCache<Record<string, unknown>>>())

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

function normalizeLockTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return 1_000
  return Math.max(1_000, Math.trunc(ttlMs))
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

export function tryAcquireRuntimeLock(name: string, owner: string, ttlMs: number): boolean {
  let acquired = false
  const now = Date.now()
  const expiresAt = now + normalizeLockTtlMs(ttlMs)
  const transaction = db.transaction(() => {
    const row = db.prepare('SELECT owner, expires_at FROM runtime_locks WHERE name = ?').get(name) as
      | { owner: string; expires_at: number }
      | undefined
    if (!row || row.owner === owner || row.expires_at <= now) {
      db.prepare(`
        INSERT OR REPLACE INTO runtime_locks (name, owner, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(name, owner, expiresAt, now)
      acquired = true
    }
  })
  transaction()
  return acquired
}

export function renewRuntimeLock(name: string, owner: string, ttlMs: number): boolean {
  const now = Date.now()
  const expiresAt = now + normalizeLockTtlMs(ttlMs)
  const result = db.prepare(`
    UPDATE runtime_locks
    SET expires_at = ?, updated_at = ?
    WHERE name = ? AND owner = ?
  `).run(expiresAt, now, name, owner)
  return result.changes > 0
}

export function readRuntimeLock(name: string): { owner: string; expiresAt: number; updatedAt: number } | null {
  const row = db.prepare('SELECT owner, expires_at, updated_at FROM runtime_locks WHERE name = ?').get(name) as
    | { owner: string; expires_at: number; updated_at: number }
    | undefined
  if (!row) return null
  return {
    owner: row.owner,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  }
}

export function isRuntimeLockActive(name: string): boolean {
  const row = readRuntimeLock(name)
  return Boolean(row && row.expiresAt > Date.now())
}

export function releaseRuntimeLock(name: string, owner: string): void {
  db.prepare('DELETE FROM runtime_locks WHERE name = ? AND owner = ?').run(name, owner)
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
}

const MIGRATION_FLAG = path.join(DATA_DIR, '.sqlite_migrated')

function migrateFromJson() {
  if (fs.existsSync(MIGRATION_FLAG)) return

  console.log('[storage] Migrating from JSON files to SQLite...')

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
            console.log(`[storage]   Migrated ${table}: ${Object.keys(data).length} records`)
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
          console.log('[storage]   Migrated settings')
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
          console.log(`[storage]   Migrated queue: ${data.length} items`)
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
        console.log('[storage]   Migrated usage records')
      } catch { /* skip */ }
    }
  })

  transaction()
  fs.writeFileSync(MIGRATION_FLAG, new Date().toISOString())
  console.log('[storage] Migration complete. JSON files preserved as backup.')
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
      systemPrompt: `You are the SwarmClaw assistant. SwarmClaw is a self-hosted AI agent orchestration dashboard.

## Platform

- **Agents** — Create specialized AI agents (Agents tab → "+") with a provider, model, system prompt, and tools. "Generate with AI" scaffolds agents from a description. Enable cross-agent delegation when an agent should assign work to others.
- **Providers** — Configure LLM backends in Settings → Providers: Claude Code CLI, OpenAI Codex CLI, OpenCode CLI, Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, Together AI, Mistral AI, xAI (Grok), Fireworks AI, Ollama, OpenClaw, or custom OpenAI-compatible endpoints.
- **Tasks** — The Task Board tracks work items. Assign agents and they'll execute autonomously.
- **Schedules** — Cron-based recurring jobs that run agents or tasks automatically.
- **Skills** — Reusable markdown instruction files you attach to agents to specialize them.
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
      isOrchestrator: true,
      plugins: defaultStarterTools,
      heartbeatEnabled: true,
      platformAssignScope: 'all',
      skillIds: [],
      subAgentIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    db.prepare(`INSERT OR REPLACE INTO agents (id, data) VALUES (?, ?)`).run('default', JSON.stringify(defaultAgent))
  } else {
    const row = db.prepare('SELECT data FROM agents WHERE id = ?').get('default') as { data: string } | undefined
    if (row?.data) {
      try {
        const existing = JSON.parse(row.data) as Record<string, unknown>
        const existingPlugins = Array.isArray(existing.plugins) ? existing.plugins : Array.isArray(existing.tools) ? existing.tools : []
        const mergedPlugins = dedup([...existingPlugins, ...defaultStarterTools]).filter((t) => t !== 'delete_file')
        if (JSON.stringify(existingPlugins) !== JSON.stringify(mergedPlugins)) {
          existing.plugins = mergedPlugins
          delete existing.tools
          existing.updatedAt = Date.now()
        }
        if (existing.platformAssignScope === 'all' || existing.platformAssignScope === 'self') {
          const derivedIsOrchestrator = existing.platformAssignScope === 'all'
          if (existing.isOrchestrator !== derivedIsOrchestrator) {
            existing.isOrchestrator = derivedIsOrchestrator
            existing.updatedAt = Date.now()
          }
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

// --- .env loading ---
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [k, ...v] = line.split('=')
      if (k && v.length) process.env[k.trim()] = v.join('=').trim()
    })
  }
}
if (!IS_BUILD_BOOTSTRAP) {
  loadEnv()
}

// Auto-generate CREDENTIAL_SECRET if missing
if (!IS_BUILD_BOOTSTRAP && !process.env.CREDENTIAL_SECRET) {
  const secret = crypto.randomBytes(32).toString('hex')
  const envPath = path.join(process.cwd(), '.env.local')
  fs.appendFileSync(envPath, `\nCREDENTIAL_SECRET=${secret}\n`)
  process.env.CREDENTIAL_SECRET = secret
  console.log('[credentials] Generated CREDENTIAL_SECRET in .env.local')
}

// Auto-generate ACCESS_KEY if missing (used for simple auth)
const SETUP_FLAG = path.join(DATA_DIR, '.setup_pending')
if (!IS_BUILD_BOOTSTRAP && !process.env.ACCESS_KEY) {
  const key = crypto.randomBytes(16).toString('hex')
  const envPath = path.join(process.cwd(), '.env.local')
  fs.appendFileSync(envPath, `\nACCESS_KEY=${key}\n`)
  process.env.ACCESS_KEY = key
  fs.writeFileSync(SETUP_FLAG, key)
  console.log(`\n${'='.repeat(50)}`)
  console.log(`  ACCESS KEY: ${key}`)
  console.log(`  Use this key to connect from the browser.`)
  console.log(`${'='.repeat(50)}\n`)
}

export function getAccessKey(): string {
  return process.env.ACCESS_KEY || ''
}

export function validateAccessKey(key: string): boolean {
  return key === process.env.ACCESS_KEY
}

export function isFirstTimeSetup(): boolean {
  return fs.existsSync(SETUP_FLAG)
}

export function markSetupComplete(): void {
  if (fs.existsSync(SETUP_FLAG)) fs.unlinkSync(SETUP_FLAG)
}

// --- Sessions ---
export function loadSessions(): Record<string, any> {
  const sessions = loadCollection('sessions')
  const agents = loadCollection('agents')
  const changedEntries: Array<[string, any]> = []

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

    // Migrate tools → plugins
    if (Array.isArray(session.tools) && !Array.isArray(session.plugins)) {
      session.plugins = session.tools
      delete session.tools
      touched = true
    }

    if (touched) changedEntries.push([id, session])
  }

  // Upsert only changed entries — never full-replace, which deletes concurrent sessions
  if (changedEntries.length > 0) upsertCollectionItems('sessions', changedEntries)
  return sessions
}

export function saveSessions(s: Record<string, any>) {
  // Upsert-only — never delete sessions that aren't in the map.
  // Explicit deletion goes through deleteSession(id).
  const entries = Object.entries(s)
  if (entries.length > 0) upsertCollectionItems('sessions', entries)
}

export function loadSession(id: string): Session | null {
  return loadCollectionItem('sessions', id) as Session | null
}

export function upsertSession(id: string, session: Session | Record<string, unknown>) {
  upsertCollectionItem('sessions', id, session)
}

export function patchSession(id: string, updater: (current: Session | null) => Session | null): Session | null {
  return patchStoredItem<Session>('sessions', id, updater)
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
export const saveCredentials = credentialsStore.save

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
    const before = JSON.stringify(agent)
    const normalized = normalizeStoredRecord('agents', agent) as Record<string, unknown>
    agents[id] = normalized
    if (JSON.stringify(normalized) !== before) changed = true
  }
  return changed
}

export function loadAgents(opts?: { includeTrashed?: boolean }): Record<string, any> {
  // Cache the full (non-trashed) agent set; includeTrashed bypasses cache
  if (opts?.includeTrashed) {
    const all = loadCollection('agents')
    if (migrateAgents(all)) saveCollection('agents', all)
    return all
  }

  const cache = getAgentsCache()
  const cached = cache.get()
  if (cached) return structuredClone(cached) as Record<string, unknown>

  const all = loadCollection('agents')
  if (migrateAgents(all)) saveCollection('agents', all)
  const result: Record<string, any> = {}
  for (const [id, agent] of Object.entries(all)) {
    if (!agent.trashedAt) result[id] = agent
  }
  cache.set(result)
  return structuredClone(result) as Record<string, unknown>
}

export function loadTrashedAgents(): Record<string, any> {
  const all = loadCollection('agents')
  const result: Record<string, any> = {}
  for (const [id, agent] of Object.entries(all)) {
    if (agent.trashedAt) result[id] = agent
  }
  return result
}

export function saveAgents(p: Record<string, any>) {
  saveCollection('agents', p)
  getAgentsCache().invalidate()
}

export function loadAgent(id: string, opts?: { includeTrashed?: boolean }): Record<string, any> | null {
  const agent = loadCollectionItem('agents', id) as Record<string, any> | null
  if (!agent) return null
  const before = JSON.stringify(agent)
  const normalized = normalizeStoredRecord('agents', agent) as Record<string, any>
  if (JSON.stringify(normalized) !== before) upsertCollectionItem('agents', id, normalized)
  if (!opts?.includeTrashed && normalized.trashedAt) return null
  return normalized
}

export function upsertAgent(id: string, agent: unknown) {
  upsertCollectionItem('agents', id, agent)
  getAgentsCache().invalidate()
}

export function patchAgent(
  id: string,
  updater: (current: Record<string, any> | null) => Record<string, any> | null,
): Record<string, any> | null {
  const next = patchStoredItem<Record<string, any>>('agents', id, updater)
  getAgentsCache().invalidate()
  return next
}

// --- Schedules ---
const schedulesStore = createCollectionStore('schedules')
export const loadSchedules = schedulesStore.load
export const saveSchedules = schedulesStore.save
export const loadSchedule = schedulesStore.loadItem
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
const tasksStore = createCollectionStore('tasks')
export const loadTasks = tasksStore.load
export const saveTasks = tasksStore.save
export const loadTask = tasksStore.loadItem as (id: string) => BoardTask | null
export const upsertTask = tasksStore.upsert
export const upsertTasks = tasksStore.upsertMany
export const patchTask = tasksStore.patch as (id: string, updater: (current: BoardTask | null) => BoardTask | null) => BoardTask | null
export const deleteTask = tasksStore.deleteItem
export function deleteSession(id: string) { deleteCollectionItem('sessions', id) }
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

type PersistedSettingsRecord = Record<string, any> & {
  [ENCRYPTED_APP_SETTINGS_KEY]?: Record<string, string>
}

function cloneRecord<T extends Record<string, any>>(value: T): T {
  return structuredClone(value || {}) as T
}

function isPlainRecord(value: unknown): value is Record<string, any> {
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

function buildPersistedSettings(input: Record<string, any>, existing?: PersistedSettingsRecord): PersistedSettingsRecord {
  const next = cloneRecord(input) as PersistedSettingsRecord
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

function resolveSettingsSecrets(settings: PersistedSettingsRecord): Record<string, any> {
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

export function loadSettings(): Record<string, any> {
  const cache = getSettingsCache()
  const cached = cache.get()
  if (cached) return structuredClone(cached) as Record<string, unknown>

  const persisted = loadSingleton('settings', {}) as PersistedSettingsRecord
  const normalized = buildPersistedSettings(persisted, persisted)
  if (JSON.stringify(persisted) !== JSON.stringify(normalized)) {
    saveSingleton('settings', normalized)
  }
  const resolved = resolveSettingsSecrets(normalized)
  cache.set(resolved)
  return structuredClone(resolved) as Record<string, unknown>
}

export function saveSettings(s: Record<string, any>) {
  const existing = loadSingleton('settings', {}) as PersistedSettingsRecord
  saveSingleton('settings', buildPersistedSettings(s, existing))
  getSettingsCache().invalidate()
}

export function loadPublicSettings(): Record<string, any> {
  const settings = cloneRecord(loadSettings())
  for (const field of APP_SETTINGS_SECRET_FIELDS) {
    settings[`${field}Configured`] = isProvidedSecretValue(settings[field])
    settings[field] = null
  }
  return settings
}

// --- Secrets (service keys for orchestrators) ---
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

// --- Skills ---
const skillsStore = createCollectionStore('skills')
export const loadSkills = skillsStore.load
export const saveSkills = skillsStore.save

// --- External Agent Runtimes ---
const externalAgentsStore = createCollectionStore('external_agents')
export const loadExternalAgents = externalAgentsStore.load as () => Record<string, ExternalAgentRuntime>
export const saveExternalAgents = externalAgentsStore.save as (items: Record<string, ExternalAgentRuntime>) => void

// --- Usage ---
export function loadUsage(): Record<string, any[]> {
  const stmt = db.prepare('SELECT session_id, data FROM usage')
  const rows = stmt.all() as { session_id: string; data: string }[]
  const result: Record<string, any[]> = {}
  for (const row of rows) {
    if (!result[row.session_id]) result[row.session_id] = []
    result[row.session_id].push(JSON.parse(row.data))
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
        const rec = record as Record<string, unknown>
        const ts = typeof rec?.timestamp === 'number' ? rec.timestamp : 0
        if (ts < minTimestamp) continue
        const cost = typeof rec?.estimatedCost === 'number' ? rec.estimatedCost : 0
        if (Number.isFinite(cost) && cost > 0) total += cost
      }
    }
    return total
  }
}

export function saveUsage(u: Record<string, any[]>) {
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

// --- Connectors ---
const connectorsStore = createCollectionStore('connectors', { ttlMs: 30_000 })
export const loadConnectors = connectorsStore.load
export const saveConnectors = connectorsStore.save

// --- Chatrooms ---
const chatroomsStore = createCollectionStore('chatrooms')
export const loadChatrooms = chatroomsStore.load
export const saveChatrooms = chatroomsStore.save

// --- Documents ---
const documentsStore = createCollectionStore('documents')
export const loadDocuments = documentsStore.load
export const saveDocuments = documentsStore.save

// --- Webhooks ---
const webhooksStore = createCollectionStore('webhooks')
export const loadWebhooks = webhooksStore.load
export const saveWebhooks = webhooksStore.save

// --- Active processes ---
export const active = new Map<string, ActiveProcess>()
export const devServers = new Map<string, { proc: ChildProcess; url: string }>()

// --- Utilities ---
export function localIP(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    if (!ifaces) continue
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return 'localhost'
}

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
const delegationJobsStore = createCollectionStore('delegation_jobs')
export const loadDelegationJobs = delegationJobsStore.load
export const upsertDelegationJob = delegationJobsStore.upsert
export const { patch: patchDelegationJob } = delegationJobsStore
export const deleteDelegationJob = delegationJobsStore.deleteItem

export function getSessionMessages(sessionId: string): Message[] {
  const session = loadSession(sessionId)
  return Array.isArray(session?.messages) ? session.messages : []
}
