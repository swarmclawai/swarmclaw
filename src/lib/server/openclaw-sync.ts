import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from './data-dir'
import { loadSettings, loadAgents, saveAgents, loadSchedules, saveSchedules, loadCredentials, decryptKey, encryptKey } from './storage'
import { getMemoryDb } from './memory-db'
import type { AppSettings, MemoryEntry, Schedule } from '@/types'

export interface OpenClawSyncConfig {
  workspacePath: string
  autoSyncMemory: boolean
  autoSyncSchedules: boolean
}

/** Resolve the OpenClaw workspace directory. Checks settings override, then ~/.openclaw, then ~/.clawdbot */
export function resolveOpenClawWorkspace(): string {
  const settings = loadSettings() as AppSettings
  if (settings.openclawWorkspacePath) {
    const resolved = settings.openclawWorkspacePath.replace(/^~/, process.env.HOME || '')
    if (fs.existsSync(resolved)) return resolved
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim()
  if (override) {
    const resolved = path.resolve(override.replace(/^~/, home))
    if (fs.existsSync(resolved)) return resolved
  }
  const newDir = path.join(home, '.openclaw')
  if (fs.existsSync(newDir)) return newDir
  const legacyDir = path.join(home, '.clawdbot')
  if (fs.existsSync(legacyDir)) return legacyDir
  // Default to creating ~/.openclaw
  return newDir
}

export function loadSyncConfig(): OpenClawSyncConfig {
  const settings = loadSettings() as AppSettings
  return {
    workspacePath: resolveOpenClawWorkspace(),
    autoSyncMemory: settings.openclawAutoSyncMemory ?? false,
    autoSyncSchedules: settings.openclawAutoSyncSchedules ?? false,
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

// --- Memory Sync (Feature 2) ---

export function pushMemoryToOpenClaw(agentId?: string): { written: number } {
  const config = loadSyncConfig()
  const memoryDir = path.join(config.workspacePath, 'memory')
  ensureDir(memoryDir)

  const db = getMemoryDb()
  const entries = db.list(agentId, 500) as MemoryEntry[]
  if (!entries.length) return { written: 0 }

  // Group by date
  const byDate = new Map<string, MemoryEntry[]>()
  for (const entry of entries) {
    const date = new Date(entry.createdAt).toISOString().slice(0, 10)
    const group = byDate.get(date) || []
    group.push(entry)
    byDate.set(date, group)
  }

  let written = 0
  for (const [date, group] of byDate) {
    const lines: string[] = [`# Memory — ${date}`, '']
    for (const entry of group) {
      lines.push(`## ${entry.title}`)
      lines.push(`- Category: ${entry.category}`)
      if (entry.agentId) lines.push(`- Agent: ${entry.agentId}`)
      lines.push('')
      lines.push(entry.content)
      lines.push('')
    }
    fs.writeFileSync(path.join(memoryDir, `${date}.md`), lines.join('\n'))
    written++
  }

  // Write curated MEMORY.md
  const curated = entries
    .filter((e) => e.category !== 'execution' && e.category !== 'working' && e.category !== 'scratch')
    .slice(0, 50)
  if (curated.length > 0) {
    const memoryMdLines: string[] = ['# Memory', '']
    for (const entry of curated) {
      memoryMdLines.push(`- **${entry.title}** (${entry.category}): ${entry.content.slice(0, 200)}`)
    }
    fs.writeFileSync(path.join(config.workspacePath, 'MEMORY.md'), memoryMdLines.join('\n'))
  }

  return { written }
}

export function pullMemoryFromOpenClaw(): { imported: number } {
  const config = loadSyncConfig()
  const memoryDir = path.join(config.workspacePath, 'memory')
  const db = getMemoryDb()
  let imported = 0

  // Build set of existing content hashes for dedup
  const existing = db.list(undefined, 500) as MemoryEntry[]
  const existingHashes = new Set(existing.map((e) => contentHash(`${e.title}|${e.content}`)))

  const files: string[] = []
  if (fs.existsSync(memoryDir)) {
    files.push(...fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md')))
  }

  // Also check MEMORY.md at workspace root
  const memoryMdPath = path.join(config.workspacePath, 'MEMORY.md')
  if (fs.existsSync(memoryMdPath)) {
    const content = fs.readFileSync(memoryMdPath, 'utf8')
    const lines = content.split('\n')
    for (const line of lines) {
      const match = line.match(/^- \*\*(.+?)\*\* \((.+?)\): (.+)/)
      if (match) {
        const [, title, category, text] = match
        const hash = contentHash(`${title}|${text}`)
        if (!existingHashes.has(hash)) {
          db.add({
            agentId: null,
            sessionId: null,
            category: category || 'note',
            title: title || 'Imported',
            content: text || '',
            metadata: { source: 'openclaw-sync' },
          })
          existingHashes.add(hash)
          imported++
        }
      }
    }
  }

  for (const file of files) {
    const content = fs.readFileSync(path.join(memoryDir, file), 'utf8')
    // Parse markdown sections
    const sections = content.split(/^## /m).slice(1)
    for (const section of sections) {
      const lines = section.split('\n')
      const title = (lines[0] || 'Untitled').trim()
      const bodyLines = lines.slice(1).filter((l) => !l.startsWith('- Category:') && !l.startsWith('- Agent:'))
      const body = bodyLines.join('\n').trim()
      if (!body) continue

      const hash = contentHash(`${title}|${body}`)
      if (existingHashes.has(hash)) continue

      const categoryMatch = section.match(/- Category: (.+)/)
      const category = categoryMatch?.[1]?.trim() || 'note'

      db.add({
        agentId: null,
        sessionId: null,
        category,
        title,
        content: body,
        metadata: { source: 'openclaw-sync' },
      })
      existingHashes.add(hash)
      imported++
    }
  }

  return { imported }
}

// --- Workspace File Mapping (Feature 3) ---

export function pushAgentToOpenClaw(agentId: string): { written: string[] } {
  const config = loadSyncConfig()
  const agents = loadAgents()
  const agent = agents[agentId]
  if (!agent) throw new Error(`Agent not found: ${agentId}`)

  const agentDir = path.join(config.workspacePath, 'agents', agent.name.toLowerCase().replace(/\s+/g, '-'))
  ensureDir(agentDir)

  const written: string[] = []

  if (agent.soul) {
    const soulPath = path.join(agentDir, 'SOUL.md')
    fs.writeFileSync(soulPath, agent.soul)
    written.push('SOUL.md')
  }

  const identityLines: string[] = [`# ${agent.name}`, '']
  if (agent.description) identityLines.push(agent.description)
  identityLines.push('')
  identityLines.push(`- Provider: ${agent.provider}`)
  identityLines.push(`- Model: ${agent.model}`)
  if (agent.capabilities?.length) {
    identityLines.push(`- Capabilities: ${agent.capabilities.join(', ')}`)
  }
  const identityPath = path.join(agentDir, 'IDENTITY.md')
  fs.writeFileSync(identityPath, identityLines.join('\n'))
  written.push('IDENTITY.md')

  return { written }
}

export function pullAgentFromOpenClaw(agentId: string): { updated: string[] } {
  const config = loadSyncConfig()
  const agents = loadAgents()
  const agent = agents[agentId]
  if (!agent) throw new Error(`Agent not found: ${agentId}`)

  const agentDir = path.join(config.workspacePath, 'agents', agent.name.toLowerCase().replace(/\s+/g, '-'))
  const updated: string[] = []

  const soulPath = path.join(agentDir, 'SOUL.md')
  if (fs.existsSync(soulPath)) {
    agent.soul = fs.readFileSync(soulPath, 'utf8')
    updated.push('soul')
  }

  const identityPath = path.join(agentDir, 'IDENTITY.md')
  if (fs.existsSync(identityPath)) {
    const content = fs.readFileSync(identityPath, 'utf8')
    // Extract description: everything after the first heading and before the metadata lines
    const lines = content.split('\n')
    const descLines = lines.filter((l) => !l.startsWith('#') && !l.startsWith('- Provider:') && !l.startsWith('- Model:') && !l.startsWith('- Capabilities:'))
    const desc = descLines.join('\n').trim()
    if (desc) {
      agent.description = desc
      updated.push('description')
    }
  }

  if (updated.length > 0) {
    agent.updatedAt = Date.now()
    agents[agentId] = agent
    saveAgents(agents)
  }

  return { updated }
}

// --- Schedule Sync (Feature 6) ---

export function pushSchedulesToOpenClaw(): { written: number } {
  const config = loadSyncConfig()
  const cronDir = path.join(config.workspacePath, 'cron')
  ensureDir(cronDir)

  const schedules = loadSchedules() as Record<string, Schedule>
  const cronSchedules = Object.values(schedules).filter(
    (s) => s.scheduleType === 'cron' && s.status === 'active',
  )

  const jobs = cronSchedules.map((s) => ({
    name: s.name,
    cron: s.cron,
    agentId: s.agentId,
    taskPrompt: s.taskPrompt,
    status: s.status,
  }))

  fs.writeFileSync(path.join(cronDir, 'jobs.json'), JSON.stringify(jobs, null, 2))
  return { written: jobs.length }
}

export function pullSchedulesFromOpenClaw(): { imported: number } {
  const config = loadSyncConfig()
  const jobsPath = path.join(config.workspacePath, 'cron', 'jobs.json')
  if (!fs.existsSync(jobsPath)) return { imported: 0 }

  const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'))
  if (!Array.isArray(raw)) return { imported: 0 }

  const schedules = loadSchedules() as Record<string, Schedule>
  const existingNames = new Set(Object.values(schedules).map((s) => `${s.name}|${s.cron}`))
  let imported = 0

  for (const job of raw) {
    if (!job.name || !job.cron) continue
    const key = `${job.name}|${job.cron}`
    if (existingNames.has(key)) continue

    const id = crypto.randomUUID()
    schedules[id] = {
      id,
      name: job.name,
      agentId: job.agentId || '',
      taskPrompt: job.taskPrompt || '',
      scheduleType: 'cron',
      cron: job.cron,
      status: 'active',
      createdAt: Date.now(),
    }
    existingNames.add(key)
    imported++
  }

  if (imported > 0) saveSchedules(schedules)
  return { imported }
}

// --- Secret/Credential Sync (Feature 7) ---

export async function pullCredentialsFromOpenClaw(): Promise<{ imported: number }> {
  const config = loadSyncConfig()
  const modelsPath = path.join(config.workspacePath, 'agents', 'main', 'agent', 'models.json')
  if (!fs.existsSync(modelsPath)) return { imported: 0 }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any
  try {
    raw = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
  } catch {
    return { imported: 0 }
  }

  const { loadCredentials: loadCreds, saveCredentials } = await import('./storage')
  const creds = loadCreds()
  const existingProviders = new Set(Object.values(creds).map((c: Record<string, unknown>) => c.provider))
  let imported = 0

  // Extract API keys from models.json entries
  const entries = Array.isArray(raw) ? raw : raw?.models ? raw.models : []
  for (const entry of entries) {
    if (!entry.apiKey || !entry.provider) continue
    if (existingProviders.has(`openclaw-${entry.provider}`)) continue

    const id = crypto.randomUUID()
    creds[id] = {
      id,
      provider: `openclaw-${entry.provider}`,
      name: `OpenClaw ${entry.provider}`,
      encryptedKey: encryptKey(entry.apiKey),
      createdAt: Date.now(),
    }
    existingProviders.add(`openclaw-${entry.provider}`)
    imported++
  }

  if (imported > 0) saveCredentials(creds)
  return { imported }
}

export function pushCredentialsToOpenClaw(): { written: boolean } {
  const config = loadSyncConfig()
  const authProfilesPath = path.join(config.workspacePath, 'auth-profiles.json')
  const creds = loadCredentials()

  const profiles: Record<string, string> = {}
  for (const cred of Object.values(creds) as Array<Record<string, string>>) {
    if (!cred.encryptedKey || !cred.provider) continue
    try {
      profiles[cred.provider] = decryptKey(cred.encryptedKey)
    } catch { /* skip undecryptable */ }
  }

  if (Object.keys(profiles).length === 0) return { written: false }

  ensureDir(path.dirname(authProfilesPath))
  fs.writeFileSync(authProfilesPath, JSON.stringify(profiles, null, 2), { mode: 0o600 })
  try { fs.chmodSync(authProfilesPath, 0o600) } catch { /* best effort */ }
  return { written: true }
}

// --- Plugin Sync (Feature 11) ---

export function syncPluginsFromOpenClaw(): { imported: number } {
  const config = loadSyncConfig()
  const openclawPluginDir = path.join(config.workspacePath, 'plugins')
  if (!fs.existsSync(openclawPluginDir)) return { imported: 0 }

  const localPluginDir = path.join(DATA_DIR, 'plugins')
  ensureDir(localPluginDir)

  const files = fs.readdirSync(openclawPluginDir).filter((f) => f.endsWith('.js'))
  const existingHashes = new Set<string>()
  // Hash existing local plugins
  if (fs.existsSync(localPluginDir)) {
    for (const f of fs.readdirSync(localPluginDir).filter((f) => f.endsWith('.js'))) {
      const content = fs.readFileSync(path.join(localPluginDir, f), 'utf8')
      existingHashes.add(contentHash(content))
    }
  }

  let imported = 0
  for (const file of files) {
    const content = fs.readFileSync(path.join(openclawPluginDir, file), 'utf8')
    const hash = contentHash(content)
    if (existingHashes.has(hash)) continue

    const destName = `openclaw-${file}`
    fs.writeFileSync(path.join(localPluginDir, destName), content)
    existingHashes.add(hash)
    imported++
  }

  return { imported }
}

// --- Device Token Cross-Sync (Feature 14) ---

const SHARED_TOKEN_PATH = path.join(DATA_DIR, 'openclaw', 'shared-device-token.json')

export function getSharedDeviceToken(): string | null {
  try {
    if (!fs.existsSync(SHARED_TOKEN_PATH)) return null
    const raw = JSON.parse(fs.readFileSync(SHARED_TOKEN_PATH, 'utf8'))
    return typeof raw?.token === 'string' && raw.token.trim() ? raw.token.trim() : null
  } catch {
    return null
  }
}

export function setSharedDeviceToken(token: string): void {
  const dir = path.dirname(SHARED_TOKEN_PATH)
  ensureDir(dir)
  fs.writeFileSync(SHARED_TOKEN_PATH, JSON.stringify({ token, updatedAt: Date.now() }, null, 2), { mode: 0o600 })
  try { fs.chmodSync(SHARED_TOKEN_PATH, 0o600) } catch { /* best effort */ }
}

// --- Unified Sync Entry Point ---

export type SyncType = 'memory' | 'workspace' | 'schedules' | 'credentials' | 'plugins'

export interface SyncResult {
  type: SyncType
  action: 'push' | 'pull'
  result: Record<string, unknown>
}

export async function runSync(params: {
  action: 'push' | 'pull' | 'both'
  types: SyncType[]
}): Promise<SyncResult[]> {
  const results: SyncResult[] = []

  for (const type of params.types) {
    if (params.action === 'push' || params.action === 'both') {
      switch (type) {
        case 'memory':
          results.push({ type, action: 'push', result: pushMemoryToOpenClaw() })
          break
        case 'workspace': {
          const agents = loadAgents()
          for (const id of Object.keys(agents)) {
            try {
              results.push({ type, action: 'push', result: { agentId: id, ...pushAgentToOpenClaw(id) } })
            } catch { /* skip */ }
          }
          break
        }
        case 'schedules':
          results.push({ type, action: 'push', result: pushSchedulesToOpenClaw() })
          break
        case 'credentials':
          results.push({ type, action: 'push', result: pushCredentialsToOpenClaw() })
          break
        case 'plugins':
          // Plugins only pull from OpenClaw
          break
      }
    }
    if (params.action === 'pull' || params.action === 'both') {
      switch (type) {
        case 'memory':
          results.push({ type, action: 'pull', result: pullMemoryFromOpenClaw() })
          break
        case 'workspace': {
          const agents = loadAgents()
          for (const id of Object.keys(agents)) {
            try {
              results.push({ type, action: 'pull', result: { agentId: id, ...pullAgentFromOpenClaw(id) } })
            } catch { /* skip */ }
          }
          break
        }
        case 'schedules':
          results.push({ type, action: 'pull', result: pullSchedulesFromOpenClaw() })
          break
        case 'credentials':
          results.push({ type, action: 'pull', result: await pullCredentialsFromOpenClaw() })
          break
        case 'plugins':
          results.push({ type, action: 'pull', result: syncPluginsFromOpenClaw() })
          break
      }
    }
  }

  return results
}
