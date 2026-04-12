import { dedup } from '@/lib/shared-utils'
import { getExtensionManager } from './extensions'

const UNIVERSAL_CORE_EXTENSION_IDS = [
  'shell',
  'files',
  'edit_file',
  'delegate',
  'web',
  'browser',
  'memory',
  'manage_platform',
  'manage_agents',
  'manage_projects',
  'manage_tasks',
  'manage_schedules',
  'manage_skills',
  'manage_documents',
  'manage_webhooks',
  'manage_connectors',
  'manage_sessions',
  'manage_secrets',
  'manage_chatrooms',
  'spawn_subagent',
  'http_request',
  'wallet',
  'monitor',
  'openclaw_workspace',
  'openclaw_nodes',
  'schedule_wake',
  'context_mgmt',
  'discovery',
  'extension_creator',
  'image_gen',
  'email',
  'replicate',
  'mailbox',
  'ask_human',
] as const

function normalizeExtensionList(value: string[] | undefined | null): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
}

export function listUniversalToolAccessExtensionIds(extraExtensions?: string[] | null): string[] {
  const installedExtensionIds = getExtensionManager()
    .listExtensions()
    .filter((meta) => meta.enabled !== false)
    .map((meta) => meta.filename)

  return dedup([
    ...UNIVERSAL_CORE_EXTENSION_IDS,
    ...installedExtensionIds,
    ...normalizeExtensionList(extraExtensions),
  ])
}

// Minimum extensions that a 'scoped' agent always gets regardless of its
// declared tool list. Memory + context management are required for the agent
// to function (remembering things, noticing when it's out of context), and
// ask_human lets it escalate to the user when stuck. Everything else is
// filterable through agent.tools.
const SCOPED_TOOL_BASELINE = ['memory', 'context_mgmt', 'ask_human'] as const

/**
 * Returns the set of enabled extension IDs for a scoped-access agent: the
 * intersection of `listUniversalToolAccessExtensionIds()` with the agent's
 * declared tools, plus the non-negotiable baseline. Use this when an agent
 * has opted into `toolAccessMode: 'scoped'` to shrink per-turn context.
 */
export function listScopedToolAccessExtensionIds(
  declaredTools: string[] | null | undefined,
  extraExtensions?: string[] | null,
): string[] {
  const universe = new Set(listUniversalToolAccessExtensionIds(extraExtensions))
  const declared = normalizeExtensionList(declaredTools)
  const scoped = declared.filter((tool) => universe.has(tool))
  return dedup([...SCOPED_TOOL_BASELINE, ...scoped])
}
