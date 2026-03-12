import { dedup } from '@/lib/shared-utils'
import { getPluginManager } from './plugins'

const UNIVERSAL_CORE_PLUGIN_IDS = [
  'shell',
  'files',
  'edit_file',
  'delegate',
  'web',
  'browser',
  'memory',
  'sandbox',
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
  'canvas',
  'http_request',
  'git',
  'wallet',
  'monitor',
  'openclaw_workspace',
  'openclaw_nodes',
  'schedule_wake',
  'context_mgmt',
  'discovery',
  'plugin_creator',
  'image_gen',
  'email',
  'calendar',
  'replicate',
  'mailbox',
  'ask_human',
  'document',
  'extract',
  'table',
  'crawl',
] as const

function normalizePluginList(value: string[] | undefined | null): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
}

export function listUniversalToolAccessPluginIds(extraPlugins?: string[] | null): string[] {
  const installedPluginIds = getPluginManager()
    .listPlugins()
    .filter((meta) => meta.isBuiltin || meta.enabled !== false)
    .map((meta) => meta.filename)

  return dedup([
    ...UNIVERSAL_CORE_PLUGIN_IDS,
    ...installedPluginIds,
    ...normalizePluginList(extraPlugins),
  ])
}
