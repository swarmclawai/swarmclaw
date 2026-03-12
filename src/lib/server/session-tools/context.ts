import type { StructuredToolInterface } from '@langchain/core/tools'
import type { Agent, Session } from '@/types'

export const MAX_OUTPUT = 50 * 1024 // 50KB
export const MAX_FILE = 100 * 1024 // 100KB

export interface ToolContext {
  agentId?: string | null
  sessionId?: string | null
  runId?: string | null
  platformAssignScope?: 'self' | 'all'
  mcpServerIds?: string[]
  mcpDisabledTools?: string[]
  projectId?: string | null
  projectRoot?: string | null
  projectName?: string | null
  projectDescription?: string | null
  memoryScopeMode?: 'auto' | 'all' | 'global' | 'agent' | 'session' | 'project' | null
  beforeToolCall?: (params: {
    session: Session
    toolName: string
    input: Record<string, unknown> | null
    runId?: string | null
  }) => Promise<ToolCallGuardResult | void> | ToolCallGuardResult | void
  onToolCallWarning?: (params: { toolName: string; message: string }) => void
}

export interface ToolCallGuardResult {
  input?: Record<string, unknown> | null
  blockReason?: string | null
  warning?: string | null
}

/**
 * Mutable container for an AbortSignal, set after tool build.
 * Allows stream-agent-chat to propagate cancellation to in-flight tools.
 */
export interface AbortSignalRef {
  signal?: AbortSignal
}

export interface SessionToolsResult {
  tools: StructuredToolInterface[]
  cleanup: () => Promise<void>
  /** Maps tool name → plugin ID for attribution in usage tracking */
  toolToPluginMap: Record<string, string>
  /** Set after build to propagate abort from the chat loop to tool executions */
  abortSignalRef: AbortSignalRef
}

/**
 * Compose a parent abort signal with a timeout, returning a signal that fires
 * on whichever triggers first. Useful for tool-level fetch calls.
 */
export function composeAbortSignals(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (!parentSignal) return AbortSignal.timeout(timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs)
  const onParentAbort = () => {
    clearTimeout(timer)
    controller.abort(parentSignal.reason)
  }
  if (parentSignal.aborted) {
    clearTimeout(timer)
    controller.abort(parentSignal.reason)
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }
  // Clean up listener when our signal fires (from timeout)
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer)
    parentSignal.removeEventListener('abort', onParentAbort)
  }, { once: true })
  return controller.signal
}

export interface ToolBuildContext {
  cwd: string
  ctx: ToolContext | undefined
  hasPlugin: (name: string) => boolean
  /** @deprecated Use hasPlugin */
  hasTool: (name: string) => boolean
  cleanupFns: (() => Promise<void>)[]
  commandTimeoutMs: number
  claudeTimeoutMs: number
  cliProcessTimeoutMs: number
  persistDelegateResumeId: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini', id: string | null | undefined) => void
  readStoredDelegateResumeId: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini') => string | null
  resolveCurrentSession: () => any | null
  activePlugins: string[]
  /** Agent's file access policy — passed to shell for command-level enforcement */
  fileAccessPolicy?: { allowedPaths?: string[]; blockedPaths?: string[] } | null
  /** Agent's sandbox config — passed to shell for session-scoped container execution */
  sandboxConfig?: NonNullable<Agent['sandboxConfig']> | null
  /** Agent's filesystem scope — 'machine' allows file access outside the workspace */
  filesystemScope?: 'workspace' | 'machine'
}

function normalizeWorkspaceAlias(cwd: string, filePath: string): string {
  const trimmed = filePath.trim()
  if (!trimmed) return trimmed
  if (trimmed === '/workspace' || trimmed === 'workspace') return cwd
  if (trimmed.startsWith('/workspace/')) return trimmed.slice('/workspace/'.length)
  if (trimmed.startsWith('workspace/')) return trimmed.slice('workspace/'.length)
  return trimmed
}

/**
 * Safe absolute paths that agents are allowed to write to outside the workspace.
 * Kept minimal to prevent accidental writes to sensitive system locations.
 */
const ALLOWED_ABSOLUTE_PREFIXES = ['/tmp/', '/var/tmp/']

export function safePath(cwd: string, filePath: string, scope?: 'workspace' | 'machine'): string {
  const path = require('path')
  const normalized = normalizeWorkspaceAlias(cwd, filePath)
  const resolvedRoot = path.resolve(cwd)
  const resolved = path.resolve(resolvedRoot, normalized)
  // Machine scope: allow any resolved path (blockedPaths enforced separately)
  if (scope === 'machine') return resolved
  // Allow workspace-relative paths
  if (resolved.startsWith(resolvedRoot)) return resolved
  // Allow explicitly safe absolute paths (e.g., /tmp/)
  if (path.isAbsolute(normalized) && ALLOWED_ABSOLUTE_PREFIXES.some((p: string) => resolved.startsWith(p))) {
    return resolved
  }
  throw new Error('Path traversal not allowed')
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
