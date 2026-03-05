const PLUGIN_ALIAS_GROUPS: string[][] = [
  ['shell', 'execute_command', 'process_tool', 'process'],
  ['files', 'read_file', 'write_file', 'list_files', 'copy_file', 'move_file', 'delete_file', 'send_file'],
  ['edit_file'],
  ['web', 'web_search', 'web_fetch'],
  ['browser', 'openclaw_browser'],
  ['delegate', 'claude_code', 'codex_cli', 'opencode_cli', 'gemini_cli', 'delegate_to_claude_code', 'delegate_to_codex_cli', 'delegate_to_opencode_cli', 'delegate_to_gemini_cli'],
  ['manage_platform', 'manage_agents', 'manage_tasks', 'manage_schedules', 'manage_skills', 'manage_documents', 'manage_webhooks', 'manage_secrets', 'manage_sessions'],
  ['manage_connectors', 'connectors', 'connector_message_tool'],
  ['manage_chatrooms', 'chatroom'],
  ['spawn_subagent', 'subagent', 'delegate_to_agent'],
  ['manage_sessions', 'session_info', 'sessions_tool', 'whoami_tool', 'search_history_tool'],
  ['schedule_wake', 'schedule'],
  ['http_request', 'http'],
  ['memory', 'memory_tool'],
  ['sandbox', 'sandbox_exec', 'sandbox_list_runtimes'],
  ['wallet', 'wallet_tool'],
  ['monitor', 'monitor_tool'],
  ['sample_ui', 'show_plugin_card'],
  ['context_mgmt', 'context_status', 'context_summarize'],
  ['openclaw_workspace'],
  ['openclaw_nodes'],
  ['image_gen', 'generate_image'],
  ['email', 'send_email'],
  ['calendar', 'calendar_events'],
  ['replicate', 'replicate_run', 'replicate_models'],
]

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

export function expandPluginIds(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return []
  const expanded = new Set<string>()
  const queue: string[] = values
    .map((id) => normalizePluginId(id))
    .filter(Boolean)

  while (queue.length > 0) {
    const next = queue.shift()!
    if (expanded.has(next)) continue
    expanded.add(next)
    const aliases = PLUGIN_ALIAS_MAP.get(next)
    if (!aliases) continue
    for (const alias of aliases) {
      if (!expanded.has(alias)) queue.push(alias)
    }
  }

  return Array.from(expanded)
}

export function pluginIdMatches(enabledPlugins: string[] | null | undefined, pluginId: string): boolean {
  const normalized = normalizePluginId(pluginId)
  if (!normalized) return false
  return expandPluginIds(enabledPlugins).includes(normalized)
}

/** @deprecated Use normalizePluginId */
export const normalizeToolId = normalizePluginId
/** @deprecated Use expandPluginIds */
export const expandToolIds = expandPluginIds
/** @deprecated Use pluginIdMatches */
export const toolIdMatches = pluginIdMatches

