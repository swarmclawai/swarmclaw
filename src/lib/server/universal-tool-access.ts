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
