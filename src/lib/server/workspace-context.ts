/**
 * Workspace context injection — injects workspace files into the agent's system prompt.
 *
 * Inspired by OpenClaw's pattern of injecting HEARTBEAT.md, IDENTITY.md, AGENTS.md,
 * SOUL.md, TOOLS.md, USER.md, and BOOTSTRAP.md into every agent turn.
 *
 * This gives agents self-awareness, goals, and context about their operating environment
 * without requiring the user to manually configure everything.
 */

import fs from 'fs'
import { WORKSPACE_DIR } from './data-dir'
import { resolvePathWithinBaseDir } from './path-utils'

/**
 * Workspace files to inject, in priority order.
 * Higher-priority files are injected first and get more budget.
 */
const WORKSPACE_FILES = [
  { name: 'HEARTBEAT.md', maxChars: 2000, section: 'Active Tasks & Heartbeat' },
  { name: 'IDENTITY.md', maxChars: 800, section: 'Agent Identity' },
  { name: 'AGENTS.md', maxChars: 2000, section: 'Agent Directory' },
  { name: 'BOOTSTRAP.md', maxChars: 1500, section: 'Bootstrap Instructions' },
  { name: 'TOOLS.md', maxChars: 1000, section: 'Tool Configuration' },
  { name: 'USER.md', maxChars: 500, section: 'User Preferences' },
] as const

const TOTAL_MAX_CHARS = 8000

interface WorkspaceContextOptions {
  /** Session working directory (overrides global workspace) */
  cwd?: string | null
  /** Maximum total characters for all workspace files */
  maxTotalChars?: number
}

interface InjectedFile {
  name: string
  chars: number
  truncated: boolean
}

interface WorkspaceContextResult {
  /** The assembled context block to inject into the system prompt */
  block: string
  /** Which files were injected and their sizes */
  files: InjectedFile[]
}

function readFileSafe(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const stat = fs.statSync(filePath)
    // Skip files over 50KB
    if (stat.size > 50_000) return null
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return null
  }
}

/**
 * Check if content is effectively empty (only headers, empty list items, whitespace).
 */
function isEffectivelyEmpty(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#+(\s|$)/.test(trimmed)) continue
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue
    return false
  }
  return true
}

/**
 * Build workspace context for injection into the agent's system prompt.
 * Reads workspace files and assembles them into a single context block.
 */
export function buildWorkspaceContext(opts: WorkspaceContextOptions = {}): WorkspaceContextResult {
  const workspaceDir = opts.cwd || WORKSPACE_DIR
  const maxTotal = opts.maxTotalChars || TOTAL_MAX_CHARS
  const files: InjectedFile[] = []
  const sections: string[] = []
  let totalChars = 0

  for (const spec of WORKSPACE_FILES) {
    if (totalChars >= maxTotal) break

    const filePath = resolvePathWithinBaseDir(workspaceDir, spec.name)
    const content = readFileSafe(filePath)
    if (!content || isEffectivelyEmpty(content)) continue

    const budget = Math.min(spec.maxChars, maxTotal - totalChars)
    if (budget <= 0) break

    const truncated = content.length > budget
    const injected = truncated ? content.slice(0, budget) + '\n[...truncated]' : content

    sections.push(`## ${spec.section}\n_Source: ${spec.name}_\n${injected}`)
    files.push({ name: spec.name, chars: injected.length, truncated })
    totalChars += injected.length
  }

  if (sections.length === 0) {
    return { block: '', files: [] }
  }

  const block = `# Workspace Context\n${sections.join('\n\n')}`
  return { block, files }
}
