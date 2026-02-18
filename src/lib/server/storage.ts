import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'

const DATA_DIR = path.join(process.cwd(), 'data')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json')
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json')
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json')
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json')
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json')
const PROVIDER_CONFIGS_FILE = path.join(DATA_DIR, 'providers.json')
const SKILLS_FILE = path.join(DATA_DIR, 'skills.json')
const CONNECTORS_FILE = path.join(DATA_DIR, 'connectors.json')
export const UPLOAD_DIR = path.join(os.tmpdir(), 'swarmclaw-uploads')

// Ensure directories exist
for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}')
if (!fs.existsSync(CREDENTIALS_FILE)) fs.writeFileSync(CREDENTIALS_FILE, '{}')
if (!fs.existsSync(AGENTS_FILE)) fs.writeFileSync(AGENTS_FILE, '{}')
// Seed a default agent if the agents file is empty
{
  const agentsData = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'))
  if (Object.keys(agentsData).length === 0) {
    agentsData.default = {
      id: 'default',
      name: 'Assistant',
      description: 'A general-purpose AI assistant',
      provider: 'claude-cli',
      model: '',
      systemPrompt: 'You are a helpful AI assistant. Be concise, accurate, and friendly.',
      soul: '',
      isOrchestrator: false,
      tools: [],
      skillIds: [],
      subAgentIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agentsData, null, 2))
  }
}
if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, '{}')
if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '{}')
if (!fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, '[]')
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}')
if (!fs.existsSync(SECRETS_FILE)) fs.writeFileSync(SECRETS_FILE, '{}')
if (!fs.existsSync(PROVIDER_CONFIGS_FILE)) fs.writeFileSync(PROVIDER_CONFIGS_FILE, '{}')
if (!fs.existsSync(SKILLS_FILE)) fs.writeFileSync(SKILLS_FILE, '{}')
if (!fs.existsSync(CONNECTORS_FILE)) fs.writeFileSync(CONNECTORS_FILE, '{}')

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
  // Write a persistent flag so the first-time UI shows even after restarts
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
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
}

export function saveSessions(s: Record<string, any>) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2))
}

// --- Credentials ---
export function loadCredentials(): Record<string, any> {
  return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
}

export function saveCredentials(c: Record<string, any>) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(c, null, 2))
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
  return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'))
}

export function saveAgents(p: Record<string, any>) {
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(p, null, 2))
}

// --- Schedules ---
export function loadSchedules(): Record<string, any> {
  return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'))
}

export function saveSchedules(s: Record<string, any>) {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(s, null, 2))
}

// --- Tasks ---
export function loadTasks(): Record<string, any> {
  return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'))
}

export function saveTasks(t: Record<string, any>) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(t, null, 2))
}

// --- Queue ---
export function loadQueue(): string[] {
  return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
}

export function saveQueue(q: string[]) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2))
}

// --- Settings ---
export function loadSettings(): Record<string, any> {
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
}

export function saveSettings(s: Record<string, any>) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2))
}

// --- Secrets (service keys for orchestrators) ---
export function loadSecrets(): Record<string, any> {
  return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'))
}

export function saveSecrets(s: Record<string, any>) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2))
}

// --- Provider Configs (custom providers) ---
export function loadProviderConfigs(): Record<string, any> {
  return JSON.parse(fs.readFileSync(PROVIDER_CONFIGS_FILE, 'utf8'))
}

export function saveProviderConfigs(p: Record<string, any>) {
  fs.writeFileSync(PROVIDER_CONFIGS_FILE, JSON.stringify(p, null, 2))
}

// --- Skills ---
export function loadSkills(): Record<string, any> {
  return JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8'))
}

export function saveSkills(s: Record<string, any>) {
  fs.writeFileSync(SKILLS_FILE, JSON.stringify(s, null, 2))
}

// --- Connectors ---
export function loadConnectors(): Record<string, any> {
  return JSON.parse(fs.readFileSync(CONNECTORS_FILE, 'utf8'))
}

export function saveConnectors(c: Record<string, any>) {
  fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(c, null, 2))
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
  const sessions = loadSessions()
  return sessions[sessionId]?.messages || []
}
