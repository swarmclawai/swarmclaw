const PLUGIN_ALIAS_GROUPS: string[][] = [
  ['shell', 'execute_command', 'process_tool'],
  ['files', 'read_file', 'write_file', 'list_files', 'copy_file', 'move_file', 'delete_file', 'send_file'],
  ['edit_file'],
  ['web', 'web_search', 'web_fetch'],
  ['browser', 'openclaw_browser'],
  ['delegate', 'claude_code', 'codex_cli', 'opencode_cli', 'gemini_cli', 'delegate_to_claude_code', 'delegate_to_codex_cli', 'delegate_to_opencode_cli', 'delegate_to_gemini_cli'],
  ['manage_platform'],
  ['manage_agents'],
  ['manage_projects'],
  ['manage_tasks'],
  ['manage_schedules'],
  ['manage_skills'],
  ['manage_documents'],
  ['manage_webhooks'],
  ['manage_secrets'],
  ['manage_connectors', 'connectors', 'connector_message_tool'],
  ['manage_chatrooms', 'chatroom'],
  ['spawn_subagent', 'subagent', 'delegate_to_agent'],
  ['manage_sessions', 'session_info', 'sessions_tool', 'whoami_tool', 'search_history_tool'],
  ['schedule_wake', 'schedule'],
  ['http_request', 'http'],
  ['memory', 'memory_tool', 'memory_search', 'memory_get', 'memory_store', 'memory_update'],
  ['sandbox', 'sandbox_exec', 'sandbox_list_runtimes'],
  ['wallet', 'wallet_tool'],
  ['monitor', 'monitor_tool'],
  ['context_mgmt', 'context_status', 'context_summarize'],
  ['openclaw_workspace'],
  ['openclaw_nodes'],
  ['image_gen', 'generate_image'],
  ['email', 'send_email'],
  ['calendar', 'calendar_events'],
  ['replicate', 'replicate_run', 'replicate_models'],
  ['google_workspace', 'gws', 'google-workspace'],
  ['mailbox', 'inbox'],
  ['ask_human', 'human_loop'],
  ['document', 'ocr_document', 'parse_document'],
  ['extract', 'extract_structured'],
  ['table', 'dataframe'],
  ['crawl', 'site_crawler'],
]

const PLUGIN_IMPLICATIONS: Record<string, string[]> = {
  shell: ['process'],
  manage_platform: [
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
  ],
}

const PLUGIN_CANONICAL_MAP = (() => {
  const map = new Map<string, string>()
  for (const group of PLUGIN_ALIAS_GROUPS) {
    const normalized = group.map((id) => id.trim().toLowerCase()).filter(Boolean)
    const canonical = normalized[0]
    if (!canonical) continue
    for (const id of normalized) map.set(id, canonical)
  }
  return map
})()

const PLUGIN_ALIAS_MAP = (() => {
  const map = new Map<string, Set<string>>()
  for (const group of PLUGIN_ALIAS_GROUPS) {
    const normalized = group.map((id) => id.trim().toLowerCase()).filter(Boolean)
    for (const id of normalized) {
      const current = map.get(id) || new Set<string>()
      for (const alias of normalized) current.add(alias)
      map.set(id, current)
    }
  }
  return map
})()

export function normalizePluginId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function canonicalizePluginId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const normalized = normalizePluginId(value)
  if (!normalized) return raw
  return PLUGIN_CANONICAL_MAP.get(normalized) || raw
}

export function getPluginAliases(value: unknown): string[] {
  const normalized = normalizePluginId(value)
  if (!normalized) return []
  const aliases = PLUGIN_ALIAS_MAP.get(normalized)
  if (!aliases) return [normalized]
  return Array.from(aliases)
}

export function expandPluginIds(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return []
  const expanded = new Set<string>()
  const queue: string[] = values
    .map((id) => typeof id === 'string' ? id.trim() : '')
    .filter(Boolean)

  while (queue.length > 0) {
    const next = queue.shift()!
    const normalized = normalizePluginId(next)
    const canonical = canonicalizePluginId(next)
    const aliases = PLUGIN_ALIAS_MAP.get(normalized)
    const key = aliases ? normalized : (canonical || next)
    if (expanded.has(key)) continue
    expanded.add(key)
    if (aliases) {
      for (const alias of aliases) {
        if (!expanded.has(alias)) queue.push(alias)
      }
    }
    const implicationSources = [key, normalized, normalizePluginId(canonical)]
    for (const source of implicationSources) {
      if (!source) continue
      for (const implied of PLUGIN_IMPLICATIONS[source] || []) {
        if (!expanded.has(implied)) queue.push(implied)
      }
    }
  }

  return Array.from(expanded)
}

export function pluginIdMatches(enabledPlugins: string[] | null | undefined, pluginId: string): boolean {
  const raw = typeof pluginId === 'string' ? pluginId.trim() : ''
  const normalized = normalizePluginId(pluginId)
  if (!normalized && !raw) return false
  const expanded = expandPluginIds(enabledPlugins)
  return expanded.includes(raw) || expanded.includes(normalized) || expanded.includes(canonicalizePluginId(pluginId))
}

/** @deprecated Use normalizePluginId */
export const normalizeToolId = normalizePluginId
/** @deprecated Use canonicalizePluginId */
export const canonicalizeToolId = canonicalizePluginId
/** @deprecated Use expandPluginIds */
export const expandToolIds = expandPluginIds
/** @deprecated Use pluginIdMatches */
export const toolIdMatches = pluginIdMatches
