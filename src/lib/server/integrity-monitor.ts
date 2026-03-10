import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from './data-dir'
import { resolveOpenClawWorkspace } from './openclaw/sync'
import { loadIntegrityBaselines, saveIntegrityBaselines } from './storage'

export interface IntegrityBaselineEntry {
  id: string
  filePath: string
  kind: 'identity' | 'config' | 'plugin'
  present: boolean
  hash: string | null
  size: number | null
  mtimeMs: number | null
  updatedAt: number
}

export interface IntegrityDrift {
  id: string
  filePath: string
  kind: IntegrityBaselineEntry['kind']
  type: 'created' | 'modified' | 'deleted'
  previousHash: string | null
  nextHash: string | null
  checkedAt: number
}

export interface IntegrityMonitorResult {
  enabled: boolean
  checkedAt: number
  checkedFiles: number
  drifts: IntegrityDrift[]
}

interface WatchTarget {
  id: string
  filePath: string
  kind: IntegrityBaselineEntry['kind']
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function fileHash(filePath: string): string {
  const hasher = crypto.createHash('sha256')
  const content = fs.readFileSync(filePath)
  hasher.update(content)
  return hasher.digest('hex')
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function toId(filePath: string): string {
  return crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex')
}

function pushIfExists(targets: WatchTarget[], filePath: string, kind: WatchTarget['kind']): void {
  if (!fs.existsSync(filePath)) return
  targets.push({
    id: toId(filePath),
    filePath: path.resolve(filePath),
    kind,
  })
}

function collectWatchTargets(): WatchTarget[] {
  const targets: WatchTarget[] = []
  const cwd = process.cwd()

  // Core workspace identity/config files.
  pushIfExists(targets, path.join(cwd, 'AGENTS.md'), 'identity')
  pushIfExists(targets, path.join(cwd, 'SOUL.md'), 'identity')
  pushIfExists(targets, path.join(cwd, 'IDENTITY.md'), 'identity')
  pushIfExists(targets, path.join(cwd, '.env.local'), 'config')

  // Repo-level AGENTS.md (one level above app dir when present).
  pushIfExists(targets, path.resolve(cwd, '..', 'AGENTS.md'), 'identity')

  // Plugin files + plugin config.
  pushIfExists(targets, path.join(DATA_DIR, 'plugins.json'), 'config')
  const pluginDir = path.join(DATA_DIR, 'plugins')
  if (fs.existsSync(pluginDir)) {
    for (const entry of fs.readdirSync(pluginDir)) {
      if (!entry.endsWith('.js') && !entry.endsWith('.mjs') && !entry.endsWith('.cjs')) continue
      pushIfExists(targets, path.join(pluginDir, entry), 'plugin')
    }
  }

  // OpenClaw agent identity files.
  try {
    const workspace = resolveOpenClawWorkspace()
    const agentsDir = path.join(workspace, 'agents')
    if (fs.existsSync(agentsDir)) {
      for (const agentDirName of fs.readdirSync(agentsDir)) {
        const dirPath = path.join(agentsDir, agentDirName)
        if (!safeStat(dirPath)?.isDirectory()) continue
        pushIfExists(targets, path.join(dirPath, 'SOUL.md'), 'identity')
        pushIfExists(targets, path.join(dirPath, 'IDENTITY.md'), 'identity')
        pushIfExists(targets, path.join(dirPath, 'TOOLS.md'), 'identity')
        pushIfExists(targets, path.join(dirPath, 'AGENTS.md'), 'identity')
      }
    }
  } catch {
    // OpenClaw workspace is optional.
  }

  // Deduplicate path collisions.
  const seen = new Set<string>()
  return targets.filter((target) => {
    if (seen.has(target.id)) return false
    seen.add(target.id)
    return true
  })
}

function toBaseline(target: WatchTarget, checkedAt: number): IntegrityBaselineEntry {
  const stat = safeStat(target.filePath)
  const present = !!stat && stat.isFile()
  return {
    id: target.id,
    filePath: target.filePath,
    kind: target.kind,
    present,
    hash: present ? fileHash(target.filePath) : null,
    size: present ? stat!.size : null,
    mtimeMs: present ? Math.trunc(stat!.mtimeMs) : null,
    updatedAt: checkedAt,
  }
}

export function runIntegrityMonitor(settings?: Record<string, unknown> | null): IntegrityMonitorResult {
  const enabled = parseBool(settings?.integrityMonitorEnabled, true)
  const checkedAt = Date.now()
  if (!enabled) {
    return {
      enabled: false,
      checkedAt,
      checkedFiles: 0,
      drifts: [],
    }
  }

  const targets = collectWatchTargets()
  const stored = loadIntegrityBaselines() as Record<string, IntegrityBaselineEntry>
  const nextBaselines: Record<string, IntegrityBaselineEntry> = { ...stored }
  const drifts: IntegrityDrift[] = []
  let dirty = false

  for (const target of targets) {
    const previous = stored[target.id]
    const current = toBaseline(target, checkedAt)

    if (!previous) {
      nextBaselines[target.id] = current
      dirty = true
      continue
    }

    const changed = (
      previous.present !== current.present
      || previous.hash !== current.hash
      || previous.filePath !== current.filePath
      || previous.kind !== current.kind
    )

    if (changed) {
      let type: IntegrityDrift['type'] = 'modified'
      if (!previous.present && current.present) type = 'created'
      else if (previous.present && !current.present) type = 'deleted'
      drifts.push({
        id: current.id,
        filePath: current.filePath,
        kind: current.kind,
        type,
        previousHash: previous.hash || null,
        nextHash: current.hash || null,
        checkedAt,
      })
      nextBaselines[target.id] = current
      dirty = true
    }
  }

  if (dirty) {
    saveIntegrityBaselines(nextBaselines)
  }

  return {
    enabled: true,
    checkedAt,
    checkedFiles: targets.length,
    drifts,
  }
}
