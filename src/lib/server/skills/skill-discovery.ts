import fs from 'fs'
import path from 'path'
import os from 'os'
import { DATA_DIR } from '@/lib/server/data-dir'
import { normalizeSkillPayload, type NormalizedSkill } from '@/lib/server/skills/skills-normalize'

export interface DiscoveredSkill extends NormalizedSkill {
  /** Which layer this skill was found in. */
  source: 'bundled' | 'workspace' | 'project'
  /** Absolute path to the SKILL.md file. */
  sourcePath: string
}

interface DiscoveryCache {
  skills: DiscoveredSkill[]
  ids: string[]
  timestamp: number
  cacheKey: string
}

const CACHE_TTL_MS = 5_000
const BUNDLED_SKILLS_DIR = path.join(process.cwd(), 'bundled-skills')
const LEGACY_BUNDLED_SKILLS_DIR = path.join(DATA_DIR, 'skills')

let cache: DiscoveryCache | null = null

function buildCacheKey(cwd?: string): string {
  return `${cwd || ''}`
}

function scanLayer(
  dir: string,
  source: DiscoveredSkill['source'],
): DiscoveredSkill[] {
  const results: DiscoveredSkill[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const skillDir = path.join(dir, entry)
    let stat: fs.Stats
    try {
      stat = fs.statSync(skillDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue

    const skillFile = path.join(skillDir, 'SKILL.md')
    let content: string
    try {
      content = fs.readFileSync(skillFile, 'utf-8')
    } catch {
      continue
    }

    const normalized = normalizeSkillPayload({
      content,
      filename: `${entry}.md`,
    })

    results.push({
      ...normalized,
      source,
      sourcePath: skillFile,
    })
  }

  return results
}

/**
 * Discover skills from three layers:
 *   1. Bundled: `bundled-skills/` (tracked with the app)
 *      Legacy fallback: `data/skills/`
 *   2. Workspace: `~/.swarmclaw/skills/` (user-installed)
 *   3. Project: `<cwd>/skills/` (project-local)
 *
 * Results are cached with a 5-second TTL. Later layers override
 * earlier ones when names collide (project > workspace > bundled).
 */
export function discoverSkills(opts?: { cwd?: string }): DiscoveredSkill[] {
  const cwd = opts?.cwd
  const cacheKey = buildCacheKey(cwd)
  const now = Date.now()

  if (cache && cache.cacheKey === cacheKey && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.skills
  }

  // Layer 1: Bundled skills
  const bundled = [
    ...scanLayer(LEGACY_BUNDLED_SKILLS_DIR, 'bundled'),
    ...scanLayer(BUNDLED_SKILLS_DIR, 'bundled'),
  ]

  // Layer 2: Workspace skills (~/.swarmclaw/skills/)
  const workspaceDir = path.join(os.homedir(), '.swarmclaw', 'skills')
  const workspace = scanLayer(workspaceDir, 'workspace')

  // Layer 3: Project-local skills (<cwd>/skills/)
  let project: DiscoveredSkill[] = []
  if (cwd) {
    const projectDir = path.join(cwd, 'skills')
    project = scanLayer(projectDir, 'project')
  }

  // Deduplicate: later layers win on name collision
  const byName = new Map<string, DiscoveredSkill>()
  for (const skill of [...bundled, ...workspace, ...project]) {
    byName.set(skill.name.toLowerCase(), skill)
  }
  const skills = Array.from(byName.values())
  const ids = skills.map((s) => s.name)

  cache = { skills, ids, timestamp: now, cacheKey }
  return skills
}

/**
 * Return the names of all currently discovered skills (uses cache if warm).
 */
export function getDiscoveredSkillIds(): string[] {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.ids
  }
  // Cold call without cwd — returns bundled + workspace only
  return discoverSkills().map((s) => s.name)
}
