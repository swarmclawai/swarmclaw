import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import Database from 'better-sqlite3'

import { DATA_DIR, WORKSPACE_DIR } from './data-dir'
import type { Message } from '@/types'
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')

// --- LRU Cache ---

const DEFAULT_LRU_CAPACITY = 5000

/** Per-collection capacity overrides from COLLECTION_CACHE_LIMITS env var (JSON). */
function parseCacheLimits(): Record<string, number> {
  const raw = process.env.COLLECTION_CACHE_LIMITS
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && v > 0) result[k] = v
    }
    return result
  } catch {
    return {}
  }
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
const IS_BUILD_BOOTSTRAP = process.env.SWARMCLAW_BUILD_MODE === '1'
const DB_PATH = IS_BUILD_BOOTSTRAP ? ':memory:' : path.join(DATA_DIR, 'swarmclaw.db')
const db = new Database(DB_PATH)
if (!IS_BUILD_BOOTSTRAP) {
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
}
db.pragma('foreign_keys = ON')

const collectionCacheKey = '__swarmclaw_storage_collection_cache__' as const
type StorageGlobals = typeof globalThis & {
  [collectionCacheKey]?: Map<string, LRUMap<string, string>>
}
const storageGlobals = globalThis as StorageGlobals
const collectionCache: Map<string, LRUMap<string, string>> =
  storageGlobals[collectionCacheKey]
  ?? (storageGlobals[collectionCacheKey] = new Map<string, LRUMap<string, string>>())

// Collection tables (id → JSON blob)
const COLLECTIONS = [
  'sessions',
  'credentials',
  'agents',
  'schedules',
  'tasks',
  'secrets',
  'provider_configs',
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
  'souls',
  'benchmarks',
  'approvals',
] as const

for (const table of COLLECTIONS) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
}

// Singleton tables (single row)
db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS usage (session_id TEXT NOT NULL, data TEXT NOT NULL)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id)`)

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

function loadCollection(table: string): Record<string, any> {
  const raw = getCollectionRawCache(table)
  const result: Record<string, any> = {}
  for (const [id, data] of raw.entries()) {
    try {
      result[id] = JSON.parse(data)
    } catch {
      // Ignore malformed records instead of crashing list endpoints.
    }
  }
  return result
}

function saveCollection(table: string, data: Record<string, any>) {
  const current = getCollectionRawCache(table)
  const next = new Map<string, string>()
  const toUpsert: Array<[string, string]> = []
  const toDelete: string[] = []

  for (const [id, val] of Object.entries(data)) {
    const serialized = JSON.stringify(val)
    if (typeof serialized !== 'string') continue
    next.set(id, serialized)
    if (current.get(id) !== serialized) {
      toUpsert.push([id, serialized])
    }
  }

  for (const id of current.keys()) {
    if (!next.has(id)) toDelete.push(id)
  }

  if (!toUpsert.length && !toDelete.length) return

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
}

/**
 * Atomically insert or update a single item in a collection without
 * loading/saving the entire collection. Prevents race conditions when
 * concurrent processes are modifying different items.
 */
function upsertCollectionItem(table: string, id: string, value: any) {
  const serialized = JSON.stringify(value)
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`).run(id, serialized)
  // Update the in-memory cache
  const cached = collectionCache.get(table)
  if (cached) {
    cached.set(id, serialized)
  }
}

function loadSingleton(table: string, fallback: any): any {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id = 1`).get() as { data: string } | undefined
  return row ? JSON.parse(row.data) : fallback
}

function saveSingleton(table: string, data: any) {
  db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (1, ?)`).run(JSON.stringify(data))
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
  skills: path.join(DATA_DIR, 'skills.json'),
  connectors: path.join(DATA_DIR, 'connectors.json'),
  documents: path.join(DATA_DIR, 'documents.json'),
  webhooks: path.join(DATA_DIR, 'webhooks.json'),
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

- **Agents** — Create specialized AI agents (Agents tab → "+") with a provider, model, system prompt, and tools. "Generate with AI" scaffolds agents from a description. Toggle "Orchestrator" to let an agent delegate work to others.
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
      isOrchestrator: false,
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
        const mergedPlugins = Array.from(new Set([...existingPlugins, ...defaultStarterTools])).filter((t) => t !== 'delete_file')
        if (JSON.stringify(existingPlugins) !== JSON.stringify(mergedPlugins)) {
          existing.plugins = mergedPlugins
          delete existing.tools
          existing.updatedAt = Date.now()
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
  let changed = false

  for (const [id, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') continue

    if (typeof session.id !== 'string' || !session.id.trim()) {
      session.id = id
      changed = true
    }


    const agentId = typeof session.agentId === 'string' ? session.agentId.trim() : ''
    if (agentId && !Object.prototype.hasOwnProperty.call(agents, agentId)) {
      session.agentId = null
      changed = true
    }

    // Migrate tools → plugins
    if (Array.isArray(session.tools) && !Array.isArray(session.plugins)) {
      session.plugins = session.tools
      delete session.tools
      changed = true
    }
  }

  if (changed) saveCollection('sessions', sessions)
  return sessions
}

export function saveSessions(s: Record<string, any>) {
  saveCollection('sessions', s)
}

export function disableAllSessionHeartbeats(): number {
  const rows = db.prepare('SELECT id, data FROM sessions').all() as Array<{ id: string; data: string }>
  if (!rows.length) return 0

  const update = db.prepare('UPDATE sessions SET data = ? WHERE id = ?')
  let changed = 0

  const tx = db.transaction(() => {
    for (const row of rows) {
      let parsed: any
      try {
        parsed = JSON.parse(row.data)
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
export function loadCredentials(): Record<string, any> {
  return loadCollection('credentials')
}

export function saveCredentials(c: Record<string, any>) {
  saveCollection('credentials', c)
}

export function encryptKey(plaintext: string): string {
  const key = Buffer.from(process.env.CREDENTIAL_SECRET!, 'hex')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const tag = cipher.getAuthTag().toString('hex')
  return iv.toString('hex') + ':' + tag + ':' + encrypted
}

export function decryptKey(encrypted: string): string {
  const key = Buffer.from(process.env.CREDENTIAL_SECRET!, 'hex')
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

/** Migrate legacy `tools` field → `plugins` on agent objects. */
function migrateAgentPlugins(agents: Record<string, Record<string, unknown>>): boolean {
  let changed = false
  for (const agent of Object.values(agents)) {
    if (!agent || typeof agent !== 'object') continue
    if (Array.isArray(agent.tools) && !Array.isArray(agent.plugins)) {
      agent.plugins = agent.tools
      delete agent.tools
      changed = true
    }
  }
  return changed
}

export function loadAgents(opts?: { includeTrashed?: boolean }): Record<string, any> {
  const all = loadCollection('agents')
  if (migrateAgentPlugins(all)) saveCollection('agents', all)
  if (opts?.includeTrashed) return all
  const result: Record<string, any> = {}
  for (const [id, agent] of Object.entries(all)) {
    if (!agent.trashedAt) result[id] = agent
  }
  return result
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
}

// --- Schedules ---
export function loadSchedules(): Record<string, any> {
  return loadCollection('schedules')
}

export function saveSchedules(s: Record<string, any>) {
  saveCollection('schedules', s)
}

// --- Souls ---
export const loadSouls = () => loadCollection('souls')
export const saveSouls = (s: Parameters<typeof saveCollection>[1]) => saveCollection('souls', s)
export const deleteSoul = (id: string) => deleteCollectionItem('souls', id)

// --- Benchmarks ---
export const loadBenchmarks = () => loadCollection('benchmarks')
export const saveBenchmarks = (b: Parameters<typeof saveCollection>[1]) => saveCollection('benchmarks', b)
export const deleteBenchmark = (id: string) => deleteCollectionItem('benchmarks', id)

// --- Tasks ---
export function loadTasks(): Record<string, any> {
  return loadCollection('tasks')
}

export function saveTasks(t: Record<string, any>) {
  saveCollection('tasks', t)
}
export function upsertTask(id: string, task: any) {
  upsertCollectionItem('tasks', id, task)
}
export function deleteTask(id: string) { deleteCollectionItem('tasks', id) }
export function deleteSession(id: string) { deleteCollectionItem('sessions', id) }
export function deleteAgent(id: string) { deleteCollectionItem('agents', id) }
export function deleteSchedule(id: string) { deleteCollectionItem('schedules', id) }
export function deleteSkill(id: string) { deleteCollectionItem('skills', id) }

// --- Queue ---
export function loadQueue(): string[] {
  return loadSingleton('queue', [])
}

export function saveQueue(q: string[]) {
  saveSingleton('queue', q)
}

// --- Settings ---
export function loadSettings(): Record<string, any> {
  return loadSingleton('settings', {})
}

export function saveSettings(s: Record<string, any>) {
  saveSingleton('settings', s)
}

// --- Secrets (service keys for orchestrators) ---
export function loadSecrets(): Record<string, any> {
  return loadCollection('secrets')
}

export function saveSecrets(s: Record<string, any>) {
  saveCollection('secrets', s)
}

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matches = Object.values(secrets).find((secret: any) => {
    if (!secret || typeof secret !== 'object') return false
    const id = typeof secret.id === 'string' ? secret.id.toLowerCase() : ''
    const name = typeof secret.name === 'string' ? secret.name.toLowerCase() : ''
    const service = typeof secret.service === 'string' ? secret.service.toLowerCase() : ''
    return id === needle || name === needle || service === needle
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any | undefined

  if (!matches) return null

  try {
    const decryptedValue =
      typeof matches.encryptedValue === 'string'
        ? decryptKey(matches.encryptedValue)
        : (typeof matches.value === 'string' ? matches.value : '')
    if (!decryptedValue) return null

    return {
      id: matches.id,
      name: matches.name,
      service: matches.service,
      value: decryptedValue,
      scope: matches.scope,
      agentIds: Array.isArray(matches.agentIds) ? matches.agentIds : [],
      createdAt: matches.createdAt,
      updatedAt: matches.updatedAt,
    }
  } catch {
    return null
  }
}

// --- Provider Configs (custom providers) ---
export function loadProviderConfigs(): Record<string, any> {
  return loadCollection('provider_configs')
}

export function saveProviderConfigs(p: Record<string, any>) {
  saveCollection('provider_configs', p)
}

// --- Model Overrides (user-added models for built-in providers) ---
export function loadModelOverrides(): Record<string, string[]> {
  return loadCollection('model_overrides') as Record<string, string[]>
}

export function saveModelOverrides(m: Record<string, string[]>) {
  saveCollection('model_overrides', m)
}

// --- Projects ---
export function loadProjects(): Record<string, any> {
  return loadCollection('projects')
}

export function saveProjects(s: Record<string, any>) {
  saveCollection('projects', s)
}

export function deleteProject(id: string) { deleteCollectionItem('projects', id) }

// --- Skills ---
export function loadSkills(): Record<string, any> {
  return loadCollection('skills')
}

export function saveSkills(s: Record<string, any>) {
  saveCollection('skills', s)
}

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

export function appendUsage(sessionId: string, record: any) {
  const ins = db.prepare('INSERT INTO usage (session_id, data) VALUES (?, ?)')
  ins.run(sessionId, JSON.stringify(record))
}

// --- Connectors ---
export function loadConnectors(): Record<string, any> {
  return loadCollection('connectors')
}

export function saveConnectors(c: Record<string, any>) {
  saveCollection('connectors', c)
}

// --- Chatrooms ---
export function loadChatrooms(): Record<string, any> {
  return loadCollection('chatrooms')
}

export function saveChatrooms(c: Record<string, any>) {
  saveCollection('chatrooms', c)
}

// --- Documents ---
export function loadDocuments(): Record<string, any> {
  return loadCollection('documents')
}

export function saveDocuments(d: Record<string, any>) {
  saveCollection('documents', d)
}

// --- Webhooks ---
export function loadWebhooks(): Record<string, any> {
  return loadCollection('webhooks')
}

export function saveWebhooks(w: Record<string, any>) {
  saveCollection('webhooks', w)
}

// --- Active processes ---
export const active = new Map<string, any>()
export const devServers = new Map<string, { proc: any; url: string }>()

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
export function loadMcpServers(): Record<string, any> {
  return loadCollection('mcp_servers')
}

export function saveMcpServers(m: Record<string, any>) {
  saveCollection('mcp_servers', m)
}

export function deleteMcpServer(id: string) { deleteCollectionItem('mcp_servers', id) }

// --- Integrity Monitor Baselines ---
export function loadIntegrityBaselines(): Record<string, any> {
  return loadCollection('integrity_baselines')
}

export function saveIntegrityBaselines(entries: Record<string, any>) {
  saveCollection('integrity_baselines', entries)
}

// --- Webhook Logs ---
export function loadWebhookLogs(): Record<string, any> {
  return loadCollection('webhook_logs')
}

export function appendWebhookLog(id: string, entry: any) {
  upsertCollectionItem('webhook_logs', id, entry)
}

// --- Activity / Audit Trail ---
export function loadActivity(): Record<string, unknown> {
  return loadCollection('activity')
}

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
  upsertCollectionItem('activity', id, record)
}

// --- Webhook Retry Queue ---
export function loadWebhookRetryQueue(): Record<string, unknown> {
  return loadCollection('webhook_retry_queue')
}

export function upsertWebhookRetry(id: string, entry: unknown) {
  upsertCollectionItem('webhook_retry_queue', id, entry)
}

export function deleteWebhookRetry(id: string) {
  deleteCollectionItem('webhook_retry_queue', id)
}

// --- Notifications ---
export function loadNotifications(): Record<string, unknown> {
  return loadCollection('notifications')
}

export function saveNotification(id: string, data: unknown) {
  upsertCollectionItem('notifications', id, data)
}

export function deleteNotification(id: string) {
  deleteCollectionItem('notifications', id)
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
export function loadWallets(): Record<string, unknown> {
  return loadCollection('wallets')
}

export function upsertWallet(id: string, wallet: unknown) {
  upsertCollectionItem('wallets', id, wallet)
}

export function deleteWallet(id: string) {
  deleteCollectionItem('wallets', id)
}

// --- Wallet Transactions ---
export function loadWalletTransactions(): Record<string, unknown> {
  return loadCollection('wallet_transactions')
}

export function upsertWalletTransaction(id: string, tx: unknown) {
  upsertCollectionItem('wallet_transactions', id, tx)
}

export function deleteWalletTransaction(id: string) {
  deleteCollectionItem('wallet_transactions', id)
}

// --- Wallet Balance History ---
export function loadWalletBalanceHistory(): Record<string, unknown> {
  return loadCollection('wallet_balance_history')
}

export function upsertWalletBalanceSnapshot(id: string, snapshot: unknown) {
  upsertCollectionItem('wallet_balance_history', id, snapshot)
}

// --- Moderation Logs ---
export function loadModerationLogs(): Record<string, unknown> {
  return loadCollection('moderation_logs')
}

export function appendModerationLog(id: string, entry: unknown) {
  upsertCollectionItem('moderation_logs', id, entry)
}

// --- Connector Health ---
export function loadConnectorHealth(): Record<string, unknown> {
  return loadCollection('connector_health')
}

export function upsertConnectorHealthEvent(id: string, event: unknown) {
  upsertCollectionItem('connector_health', id, event)
}

// --- Approvals ---
export function loadApprovals(): Record<string, unknown> {
  return loadCollection('approvals')
}

export function upsertApproval(id: string, approval: unknown) {
  upsertCollectionItem('approvals', id, approval)
}

export function deleteApproval(id: string) {
  deleteCollectionItem('approvals', id)
}

export function getSessionMessages(sessionId: string): Message[] {
  const stmt = db.prepare('SELECT data FROM sessions WHERE id = ?')
  const row = stmt.get(sessionId) as { data: string } | undefined
  if (!row) return []
  const session = JSON.parse(row.data)
  return session?.messages || []
}
