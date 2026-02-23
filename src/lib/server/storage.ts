import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import Database from 'better-sqlite3'

const DATA_DIR = path.join(process.cwd(), 'data')
export const UPLOAD_DIR = path.join(os.tmpdir(), 'swarmclaw-uploads')

// Ensure directories exist
for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// --- SQLite Database ---
const DB_PATH = path.join(DATA_DIR, 'swarmclaw.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const collectionCacheKey = '__swarmclaw_storage_collection_cache__' as const
type StorageGlobals = typeof globalThis & {
  [collectionCacheKey]?: Map<string, Map<string, string>>
}
const storageGlobals = globalThis as StorageGlobals
const collectionCache: Map<string, Map<string, string>> =
  storageGlobals[collectionCacheKey]
  ?? (storageGlobals[collectionCacheKey] = new Map<string, Map<string, string>>())

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
] as const

for (const table of COLLECTIONS) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
}

// Singleton tables (single row)
db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
db.exec(`CREATE TABLE IF NOT EXISTS usage (session_id TEXT NOT NULL, data TEXT NOT NULL)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id)`)

function readCollectionRaw(table: string): Map<string, string> {
  const rows = db.prepare(`SELECT id, data FROM ${table}`).all() as { id: string; data: string }[]
  const raw = new Map<string, string>()
  for (const row of rows) {
    raw.set(row.id, row.data)
  }
  return raw
}

function getCollectionRawCache(table: string): Map<string, string> {
  const cached = collectionCache.get(table)
  if (cached) return cached
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
    const upsert = db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)
    const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`)
    for (const [id, serialized] of toUpsert) {
      upsert.run(id, serialized)
    }
    for (const id of toDelete) {
      del.run(id)
    }
  })
  transaction()
  collectionCache.set(table, next)
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

migrateFromJson()

// Seed default agent if agents table is empty
{
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
  ]
  const count = (db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c
  if (count === 0) {
    const defaultAgent = {
      id: 'default',
      name: 'Assistant',
      description: 'A general-purpose AI assistant',
      provider: 'claude-cli',
      model: '',
      systemPrompt: `You are the default SwarmClaw assistant. SwarmClaw is a self-hosted AI agent orchestration dashboard.

Help users get started with the platform:
- **Agents**: Create specialized AI agents (Agents tab → "+"). Each agent has a provider, model, system prompt, and optional tools (shell, files, web search, browser). Use "Generate with AI" to scaffold agents from a description.
- **Orchestrators**: Toggle "Orchestrator" when creating an agent to let it delegate tasks to other agents. Orchestrators coordinate multi-agent workflows automatically.
- **Providers**: Configure LLM backends in Settings → Providers. Built-in providers: Claude Code CLI, OpenAI Codex CLI, OpenCode CLI, Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, Together AI, Mistral AI, xAI (Grok), Fireworks AI, Ollama (local or cloud), and OpenClaw. You can also add custom OpenAI-compatible endpoints.
- **Tasks**: Use the Task Board to create, assign, and track work items. Agents can be assigned to tasks and will execute them autonomously.
- **Schedules**: Set up cron-based schedules to run agents or tasks on a recurring basis (Schedules tab).
- **Skills**: Create reusable skill files (markdown instructions) in the Skills tab and attach them to agents to specialize their behavior.
- **Connectors**: Bridge agents to Discord, Slack, Telegram, or WhatsApp so they can respond in chat platforms.
- **Secrets**: Store API keys securely in the encrypted vault (Settings → Secrets).

## Platform Tools

You have access to platform management tools. Here's how to use them:

- **manage_agents**: List, create, update, or delete agents. Use action "list" to see all agents, "create" with a JSON data payload to add new ones.
- **manage_tasks**: Create and manage task board items. Set "agentId" to assign a task to an agent, "status" to track progress (backlog → queued → running → completed/failed). Use action "create" with data like \`{"title": "...", "description": "...", "agentId": "...", "status": "backlog"}\`.
- **manage_schedules**: Create recurring or one-time scheduled jobs. Set "scheduleType" to "cron", "interval", or "once". Provide "taskPrompt" for what the agent should do and "agentId" for who runs it.
- **manage_skills**: List, create, or update reusable skill definitions that can be attached to agents.
- **manage_documents**: Upload/index/search long-lived docs (PDFs, markdown, notes) for retrieval.
- **manage_webhooks**: Register external webhook endpoints that trigger agent runs.
- **manage_connectors**: Manage chat platform bridges (Discord, Slack, Telegram, WhatsApp).
- **manage_sessions**: Session-level operations. Use \`sessions_tool\` to list sessions, send inter-session messages, spawn new agent sessions, and inspect status/history.
- **manage_secrets**: Store and retrieve encrypted service tokens/API credentials for durable reuse.
- **memory_tool**: Store and retrieve long-term memories. Use "store" to save knowledge, "search" to find relevant memories.

Be concise and helpful. When users ask how to do something, guide them to the specific UI location and explain the steps.`,
      soul: '',
      isOrchestrator: false,
      tools: defaultStarterTools,
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
        const existing = JSON.parse(row.data) as Record<string, any>
        const existingTools = Array.isArray(existing.tools) ? existing.tools : []
        const mergedTools = Array.from(new Set([...existingTools, ...defaultStarterTools])).filter((t) => t !== 'delete_file')
        if (JSON.stringify(existingTools) !== JSON.stringify(mergedTools)) {
          existing.tools = mergedTools
          existing.updatedAt = Date.now()
          db.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(existing), 'default')
        }
      } catch {
        // ignore malformed default agent payloads
      }
    }
  }
}

// Backfill/seed a practical CodeReviewer agent profile.
{
  const REVIEWER_SOUL = 'You are CodeReviewer: a rigorous, concise software reviewer who prioritizes correctness, security, regressions, and test gaps over stylistic commentary.'
  const REVIEWER_PROMPT = [
    'You are a senior code review specialist.',
    'Primary objective: find bugs, behavioral regressions, security risks, and missing tests.',
    'When reviewing work:',
    '- Lead with concrete findings ordered by severity.',
    '- Include file references and explain user impact.',
    '- Call out risky assumptions and edge cases.',
    '- If no critical findings exist, explicitly say so and list residual risks.',
    'Keep feedback direct and actionable.',
  ].join('\n')
  const REVIEWER_TOOLS = ['files', 'edit_file', 'web_search', 'web_fetch', 'memory']

  const rows = db.prepare('SELECT id, data FROM agents').all() as { id: string; data: string }[]
  let found = false
  for (const row of rows) {
    let parsed: Record<string, any>
    try {
      parsed = JSON.parse(row.data)
    } catch {
      continue
    }
    const name = String(parsed?.name || '').toLowerCase()
    const isReviewer = row.id === 'code-reviewer'
      || name === 'codereviewer'
      || name === 'code reviewer'
    if (!isReviewer) continue

    found = true
    const currentTools = Array.isArray(parsed.tools) ? parsed.tools : []
    const mergedTools = Array.from(new Set([...currentTools, ...REVIEWER_TOOLS]))

    let changed = false
    if (!String(parsed.description || '').trim()) {
      parsed.description = 'Finds defects, regressions, and test gaps with actionable recommendations.'
      changed = true
    }
    if (!String(parsed.soul || '').trim()) {
      parsed.soul = REVIEWER_SOUL
      changed = true
    }
    if (!String(parsed.systemPrompt || '').trim()) {
      parsed.systemPrompt = REVIEWER_PROMPT
      changed = true
    }
    if (JSON.stringify(currentTools) !== JSON.stringify(mergedTools)) {
      parsed.tools = mergedTools
      changed = true
    }
    if (changed) {
      parsed.updatedAt = Date.now()
      db.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(parsed), row.id)
    }
  }

  if (!found) {
    const now = Date.now()
    const seeded = {
      id: 'code-reviewer',
      name: 'CodeReviewer',
      description: 'Finds defects, regressions, and test gaps with actionable recommendations.',
      provider: 'ollama',
      model: 'glm-5',
      systemPrompt: REVIEWER_PROMPT,
      soul: REVIEWER_SOUL,
      isOrchestrator: false,
      tools: REVIEWER_TOOLS,
      platformAssignScope: 'self',
      skillIds: [],
      subAgentIds: [],
      createdAt: now,
      updatedAt: now,
    }
    db.prepare('INSERT OR REPLACE INTO agents (id, data) VALUES (?, ?)').run(seeded.id, JSON.stringify(seeded))
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
loadEnv()

// Auto-generate CREDENTIAL_SECRET if missing
if (!process.env.CREDENTIAL_SECRET) {
  const secret = crypto.randomBytes(32).toString('hex')
  const envPath = path.join(process.cwd(), '.env.local')
  fs.appendFileSync(envPath, `\nCREDENTIAL_SECRET=${secret}\n`)
  process.env.CREDENTIAL_SECRET = secret
  console.log('[credentials] Generated CREDENTIAL_SECRET in .env.local')
}

// Auto-generate ACCESS_KEY if missing (used for simple auth)
const SETUP_FLAG = path.join(DATA_DIR, '.setup_pending')
if (!process.env.ACCESS_KEY) {
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
  return loadCollection('sessions')
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
export function loadAgents(): Record<string, any> {
  return loadCollection('agents')
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

// --- Tasks ---
export function loadTasks(): Record<string, any> {
  return loadCollection('tasks')
}

export function saveTasks(t: Record<string, any>) {
  saveCollection('tasks', t)
}

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
  const matches = Object.values(secrets).find((secret: any) => {
    if (!secret || typeof secret !== 'object') return false
    const id = typeof secret.id === 'string' ? secret.id.toLowerCase() : ''
    const name = typeof secret.name === 'string' ? secret.name.toLowerCase() : ''
    const service = typeof secret.service === 'string' ? secret.service.toLowerCase() : ''
    return id === needle || name === needle || service === needle
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

export function getSessionMessages(sessionId: string): any[] {
  const stmt = db.prepare('SELECT data FROM sessions WHERE id = ?')
  const row = stmt.get(sessionId) as { data: string } | undefined
  if (!row) return []
  const session = JSON.parse(row.data)
  return session?.messages || []
}
