import path from 'path'
import os from 'os'
import { DATA_DIR, WORKSPACE_DIR } from './data-dir'

export interface NormalizeLegacyWorkspacePathOptions {
  workspaceRoot?: string
  taskId?: string | null
}

function splitSegments(p: string): string[] {
  return path.normalize(p).split(path.sep).filter(Boolean)
}

/**
 * Remaps a path persisted under a previous workspace root (e.g.
 * /root/.swarmclaw/workspace/tasks/<id>) onto the current WORKSPACE_DIR.
 *
 * Only remaps when a safety signal identifies the path as a SwarmClaw-managed
 * workspace location; intentional custom cwds pass through unchanged:
 * - the prefix before a `workspace` segment contains a `.swarmclaw` segment
 * - the tail after a `workspace` segment is `tasks/<taskId>` (or under it)
 * - the prefix matches a known default workspace root that differs from the
 *   current one (`~/.swarmclaw/workspace`, `DATA_DIR/workspace`)
 */
export function normalizeLegacyWorkspacePath(
  raw: string | null | undefined,
  options: NormalizeLegacyWorkspacePathOptions = {},
): string {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (!input || !path.isAbsolute(input)) return input

  const workspaceRoot = path.resolve(options.workspaceRoot ?? WORKSPACE_DIR)
  const resolved = path.resolve(input)
  const rel = path.relative(workspaceRoot, resolved)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return input

  const segments = splitSegments(resolved)
  const taskId = typeof options.taskId === 'string' ? options.taskId.trim() : ''
  const knownDefaultRoots = new Set(
    [path.join(os.homedir(), '.swarmclaw', 'workspace'), path.join(DATA_DIR, 'workspace')]
      .map((p) => path.resolve(p))
      .filter((p) => p !== workspaceRoot),
  )

  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== 'workspace') continue
    const prefixSegments = segments.slice(0, i)
    const tailSegments = segments.slice(i + 1)
    const legacyRoot = tailSegments.length > 0
      ? path.resolve(resolved, ...tailSegments.map(() => '..'))
      : resolved
    const hasSwarmclawMarker = prefixSegments.includes('.swarmclaw')
    const matchesTaskTail = Boolean(taskId) && tailSegments[0] === 'tasks' && tailSegments[1] === taskId
    const isKnownDefaultRoot = knownDefaultRoots.has(legacyRoot)
    if (!hasSwarmclawMarker && !matchesTaskTail && !isKnownDefaultRoot) continue
    return tailSegments.length > 0 ? path.join(workspaceRoot, ...tailSegments) : workspaceRoot
  }

  return input
}
