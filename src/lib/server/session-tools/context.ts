import type { StructuredToolInterface } from '@langchain/core/tools'

export const MAX_OUTPUT = 50 * 1024 // 50KB
export const MAX_FILE = 100 * 1024 // 100KB

export interface ToolContext {
  agentId?: string | null
  sessionId?: string | null
  platformAssignScope?: 'self' | 'all'
  mcpServerIds?: string[]
}

export interface SessionToolsResult {
  tools: StructuredToolInterface[]
  cleanup: () => Promise<void>
}

export interface ToolBuildContext {
  cwd: string
  ctx: ToolContext | undefined
  hasTool: (name: string) => boolean
  cleanupFns: (() => Promise<void>)[]
  commandTimeoutMs: number
  claudeTimeoutMs: number
  cliProcessTimeoutMs: number
  persistDelegateResumeId: (key: 'claudeCode' | 'codex' | 'opencode', id: string | null | undefined) => void
  readStoredDelegateResumeId: (key: 'claudeCode' | 'codex' | 'opencode') => string | null
  resolveCurrentSession: () => any | null
  activeTools: string[]
}

export function safePath(cwd: string, filePath: string): string {
  const resolved = require('path').resolve(cwd, filePath)
  if (!resolved.startsWith(require('path').resolve(cwd))) {
    throw new Error('Path traversal not allowed')
  }
  return resolved
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n... [truncated at ${max} bytes]`
}

export function tail(text: string, max = 4000): string {
  if (!text) return ''
  return text.length <= max ? text : text.slice(text.length - max)
}

export function extractResumeIdentifier(text: string): string | null {
  if (!text) return null
  const patterns = [
    /session[_\s-]?id["'\s]*[:=]\s*["']?([A-Za-z0-9._:-]{6,})/i,
    /thread[_\s-]?id["'\s]*[:=]\s*["']?([A-Za-z0-9._:-]{6,})/i,
    /resume(?:\s+with)?\s+([A-Za-z0-9._:-]{6,})/i,
  ]
  for (const pattern of patterns) {
    const m = text.match(pattern)
    if (m?.[1]) return m[1]
  }
  return null
}

const binaryLookupCache = new Map<string, { checkedAt: number; path: string | null }>()
const BINARY_LOOKUP_TTL_MS = 30_000

export function findBinaryOnPath(binaryName: string): string | null {
  const now = Date.now()
  const cached = binaryLookupCache.get(binaryName)
  if (cached && now - cached.checkedAt < BINARY_LOOKUP_TTL_MS) return cached.path

  const { spawnSync } = require('child_process')
  const probe = spawnSync('/bin/zsh', ['-lc', `command -v ${binaryName} 2>/dev/null`], {
    encoding: 'utf-8',
    timeout: 2000,
  })
  const resolved = (probe.stdout || '').trim() || null
  binaryLookupCache.set(binaryName, { checkedAt: now, path: resolved })
  return resolved
}

export function coerceEnvMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export function listDirRecursive(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return []
  const fs = require('fs')
  const path = require('path')
  const entries: string[] = []
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue
      const rel = item.name
      if (item.isDirectory()) {
        entries.push(rel + '/')
        const sub = listDirRecursive(path.join(dir, item.name), depth + 1, maxDepth)
        entries.push(...sub.map((s: string) => `  ${rel}/${s}`))
      } else {
        entries.push(rel)
      }
    }
  } catch {
    // permission error etc
  }
  return entries
}
