import path from 'path'
import type { Agent } from '@/types'

/**
 * File Access Policy Enforcement
 *
 * Checks whether a resolved file path is allowed by the agent's file access policy.
 * Supports glob-like patterns (trailing `*` for prefix matching, `**` for deep matching).
 *
 * For file tools (read_file, write_file, etc.) this catches all path access.
 * For shell commands, the caller extracts paths via regex (see shell.ts) which
 * covers ~80% of obvious patterns but has known limitations:
 * - Variable expansion (`cat $FILE`) — path not resolved at static analysis time
 * - Shell glob expansion (`rm *.log`) — wildcard passed as literal
 * - Command substitution (`cat $(find ...)`) — inner command not parsed
 * - Complex pipelines — paths after `|` not fully traced
 *
 * These are inherent to regex-based command parsing. Sandbox containment
 * (enforcing at the OS level) is immune to all of the above. This layer is
 * best-effort defense-in-depth for non-containerized deployments — not a
 * substitute for proper sandboxing of autonomous agents.
 */

function matchesGlob(filePath: string, pattern: string): boolean {
  // Normalize both to forward slashes for consistent matching
  const normalized = filePath.replace(/\\/g, '/')
  const normalizedPattern = pattern.replace(/\\/g, '/')

  // Exact match
  if (normalized === normalizedPattern) return true

  // Directory prefix: pattern ending with `/` or `/*` matches anything inside
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3)
    return normalized === prefix || normalized.startsWith(prefix + '/')
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2)
    return normalized.startsWith(prefix + '/')
  }
  if (normalizedPattern.endsWith('/')) {
    return normalized.startsWith(normalizedPattern) || normalized === normalizedPattern.slice(0, -1)
  }

  return false
}

export interface FileAccessCheckResult {
  allowed: boolean
  reason?: string
}

/**
 * Check if a file path is allowed by the agent's file access policy.
 * Returns `{ allowed: true }` if no policy is configured or the path passes.
 */
export function checkFileAccess(
  filePath: string,
  cwd: string,
  policy: Agent['fileAccessPolicy'],
): FileAccessCheckResult {
  if (!policy) return { allowed: true }
  const { allowedPaths, blockedPaths } = policy

  const resolved = path.resolve(cwd, filePath)

  // Blocked paths always take precedence
  if (blockedPaths?.length) {
    for (const pattern of blockedPaths) {
      const resolvedPattern = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern)
      if (matchesGlob(resolved, resolvedPattern)) {
        return { allowed: false, reason: `Path "${filePath}" is blocked by file access policy` }
      }
    }
  }

  // If allowedPaths is set, the path must match at least one
  if (allowedPaths?.length) {
    for (const pattern of allowedPaths) {
      const resolvedPattern = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern)
      if (matchesGlob(resolved, resolvedPattern)) {
        return { allowed: true }
      }
    }
    return { allowed: false, reason: `Path "${filePath}" is not in the allowed paths list` }
  }

  return { allowed: true }
}

/** Tool names that operate on file paths */
const FILE_TOOL_NAMES = new Set([
  'read_file', 'write_file', 'edit_file', 'create_file',
  'append_file', 'delete_file', 'list_directory',
])

/**
 * Extract file paths from tool input arguments.
 * Handles common parameter names used by file tools.
 */
function extractFilePaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const key of ['path', 'file_path', 'filePath', 'target', 'destination', 'source']) {
    const val = input[key]
    if (typeof val === 'string' && val.trim()) paths.push(val.trim())
  }
  return paths
}

/**
 * Enforce file access policy for a tool call. Returns null if allowed,
 * or an error string if blocked.
 */
export function enforceFileAccessPolicy(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  policy: Agent['fileAccessPolicy'],
): string | null {
  if (!policy) return null
  if (!FILE_TOOL_NAMES.has(toolName)) return null

  const paths = extractFilePaths(input)
  for (const filePath of paths) {
    const result = checkFileAccess(filePath, cwd, policy)
    if (!result.allowed) return result.reason || 'File access denied by policy'
  }
  return null
}
