import fs from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadSkills, saveSkills } from '@/lib/server/storage'
import type { ClawHubSkillBundle } from '@/lib/server/skills/clawhub-client'
import { fetchClawHubSkillBundle, fetchSkillContent } from '@/lib/server/skills/clawhub-client'
import { clearDiscoveredSkillsCache, resolveWorkspaceSkillsDir } from '@/lib/server/skills/skill-discovery'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'

function sanitizeSkillDirName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'skill'
}

function normalizeBundlePath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '')
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.includes('\0')) return null
  return normalized
}

function stripSharedTopLevelDir(paths: string[]): string[] {
  const splitPaths = paths.map((filePath) => filePath.split('/').filter(Boolean))
  const sharedRoot = splitPaths[0]?.[0]
  if (!sharedRoot) return paths
  const shouldStrip = splitPaths.every((parts) => parts.length > 1 && parts[0] === sharedRoot)
  return shouldStrip
    ? splitPaths.map((parts) => parts.slice(1).join('/'))
    : paths
}

async function materializeClawHubBundle(url: string): Promise<string | null> {
  const bundle = await fetchClawHubSkillBundle(url)
  if (!bundle) return null
  await writeClawHubBundleToWorkspace(bundle)
  return bundle.content
}

async function writeClawHubBundleToWorkspace(bundle: ClawHubSkillBundle): Promise<void> {
  const normalizedEntries = bundle.files
    .map((file) => ({
      file,
      path: normalizeBundlePath(file.path),
    }))
    .filter((entry): entry is { file: ClawHubSkillBundle['files'][number], path: string } => Boolean(entry.path))

  const workspaceSkillsDir = resolveWorkspaceSkillsDir()
  const targetDir = path.join(workspaceSkillsDir, sanitizeSkillDirName(bundle.slug))
  const normalizedPaths = stripSharedTopLevelDir(normalizedEntries.map((entry) => entry.path))

  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(targetDir, { recursive: true })

  for (let index = 0; index < normalizedEntries.length; index += 1) {
    const relativePath = normalizedPaths[index]
    if (!relativePath) continue
    const destination = path.join(targetDir, relativePath)
    if (!destination.startsWith(targetDir + path.sep) && destination !== targetDir) {
      throw new Error(`Refusing to write bundle file outside the target directory: ${relativePath}`)
    }
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, normalizedEntries[index].file.content)
  }

  clearDiscoveredSkillsCache()
}

export async function POST(req: Request) {
  const body = await req.json()
  const { name, description, url, author, tags } = body
  let { content } = body

  if (!content) {
    try {
      content = await materializeClawHubBundle(url) || await fetchSkillContent(url)
    } catch (err: unknown) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to fetch skill content' },
        { status: 502 }
      )
    }
  }

  const normalized = normalizeSkillPayload({
    name,
    description,
    content,
    sourceUrl: url,
    author,
    tags,
  })

  const skills = loadSkills()
  const duplicate = Object.values(skills).find((skill) => {
    const left = (skill.skillKey || skill.name || '').trim().toLowerCase()
    const right = (normalized.skillKey || normalized.name || '').trim().toLowerCase()
    return left && right && left === right
  })
  const id = duplicate?.id || genId()
  skills[id] = {
    ...(duplicate || {}),
    id,
    name: normalized.name,
    filename: normalized.filename || `skill-${id}.md`,
    content: normalized.content,
    description: normalized.description || '',
    sourceFormat: normalized.sourceFormat,
    sourceUrl: normalized.sourceUrl,
    author: normalized.author || '',
    tags: normalized.tags || [],
    version: normalized.version,
    homepage: normalized.homepage,
    primaryEnv: normalized.primaryEnv,
    skillKey: normalized.skillKey,
    toolNames: normalized.toolNames,
    capabilities: normalized.capabilities,
    always: normalized.always,
    installOptions: normalized.installOptions,
    skillRequirements: normalized.skillRequirements,
    detectedEnvVars: normalized.detectedEnvVars,
    security: normalized.security,
    invocation: normalized.invocation,
    commandDispatch: normalized.commandDispatch,
    frontmatter: normalized.frontmatter,
    createdAt: duplicate?.createdAt || Date.now(),
    updatedAt: Date.now(),
  }
  saveSkills(skills)
  clearDiscoveredSkillsCache()
  return NextResponse.json(skills[id])
}
