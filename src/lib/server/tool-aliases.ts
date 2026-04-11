const EXTENSION_ALIAS_GROUPS: string[][] = [
  ['shell', 'execute_command', 'process_tool', 'git'],
  ['execute', 'sandbox'],
  ['files', 'read_file', 'write_file', 'list_files', 'copy_file', 'move_file', 'delete_file', 'send_file'],
  ['edit_file'],
  ['web', 'web_search', 'web_fetch', 'http_request', 'http'],
  ['browser', 'openclaw_browser'],
  ['delegate', 'claude_code', 'codex_cli', 'opencode_cli', 'gemini_cli', 'copilot_cli', 'cursor_cli', 'qwen_code_cli', 'delegate_to_claude_code', 'delegate_to_codex_cli', 'delegate_to_opencode_cli', 'delegate_to_gemini_cli', 'delegate_to_copilot_cli', 'delegate_to_cursor_cli', 'delegate_to_qwen_code_cli'],
  ['manage_platform'],
  ['manage_agents'],
  ['manage_projects'],
  ['manage_tasks'],
  ['manage_schedules'],
  ['manage_skills'],
  ['manage_webhooks'],
  ['manage_secrets'],
  ['manage_connectors', 'connectors', 'connector_message_tool'],
  ['manage_chatrooms', 'chatroom'],
  ['manage_protocols', 'protocol'],
  ['spawn_subagent', 'subagent', 'delegate_to_agent'],
  ['manage_sessions', 'session_info', 'sessions_tool', 'whoami_tool', 'search_history_tool'],
  ['schedule_wake', 'schedule'],
  // http_request/http now aliased into web group above
  ['memory', 'memory_tool', 'memory_search', 'memory_get', 'memory_store', 'memory_update'],
  ['monitor', 'monitor_tool'],
  ['context_mgmt', 'context_status', 'context_summarize'],
  ['openclaw_workspace'],
  ['openclaw_nodes'],
  ['image_gen', 'generate_image'],
  ['email', 'send_email'],
  ['replicate', 'replicate_run', 'replicate_models'],
  ['google_workspace', 'gws', 'google-workspace'],
  ['mailbox', 'inbox'],
  ['ask_human', 'human_loop'],
  ['extension_creator'],
  ['extension_creator_tool'],
]

const EXTENSION_IMPLICATIONS: Record<string, string[]> = {
  shell: ['process'],
  manage_platform: [
    'manage_agents',
    'manage_projects',
    'manage_tasks',
    'manage_schedules',
    'manage_skills',
    'manage_webhooks',
    'manage_connectors',
    'manage_sessions',
    'manage_secrets',
  ],
}

const EXTENSION_CANONICAL_MAP = (() => {
  const map = new Map<string, string>()
  for (const group of EXTENSION_ALIAS_GROUPS) {
    const normalized = group.map((id) => id.trim().toLowerCase()).filter(Boolean)
    const canonical = normalized[0]
    if (!canonical) continue
    for (const id of normalized) map.set(id, canonical)
  }
  return map
})()

const EXTENSION_ALIAS_MAP = (() => {
  const map = new Map<string, Set<string>>()
  for (const group of EXTENSION_ALIAS_GROUPS) {
    const normalized = group.map((id) => id.trim().toLowerCase()).filter(Boolean)
    for (const id of normalized) {
      const current = map.get(id) || new Set<string>()
      for (const alias of normalized) current.add(alias)
      map.set(id, current)
    }
  }
  return map
})()

export function normalizeExtensionId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function canonicalizeExtensionId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const normalized = normalizeExtensionId(value)
  if (!normalized) return raw
  return EXTENSION_CANONICAL_MAP.get(normalized) || raw
}

export function getExtensionAliases(value: unknown): string[] {
  const normalized = normalizeExtensionId(value)
  if (!normalized) return []
  const aliases = EXTENSION_ALIAS_MAP.get(normalized)
  if (!aliases) return [normalized]
  return Array.from(aliases)
}

export function expandExtensionIds(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return []
  const expanded = new Set<string>()
  const queue: string[] = values
    .map((id) => typeof id === 'string' ? id.trim() : '')
    .filter(Boolean)

  while (queue.length > 0) {
    const next = queue.shift()!
    const normalized = normalizeExtensionId(next)
    const canonical = canonicalizeExtensionId(next)
    const aliases = EXTENSION_ALIAS_MAP.get(normalized)
    const key = aliases ? normalized : (canonical || next)
    if (expanded.has(key)) continue
    expanded.add(key)
    if (aliases) {
      for (const alias of aliases) {
        if (!expanded.has(alias)) queue.push(alias)
      }
    }
    const implicationSources = [key, normalized, normalizeExtensionId(canonical)]
    for (const source of implicationSources) {
      if (!source) continue
      for (const implied of EXTENSION_IMPLICATIONS[source] || []) {
        if (!expanded.has(implied)) queue.push(implied)
      }
    }
  }

  return Array.from(expanded)
}

export function extensionIdMatches(enabledExtensions: string[] | null | undefined, extensionId: string): boolean {
  const raw = typeof extensionId === 'string' ? extensionId.trim() : ''
  const normalized = normalizeExtensionId(extensionId)
  if (!normalized && !raw) return false
  const expanded = expandExtensionIds(enabledExtensions)
  return expanded.includes(raw) || expanded.includes(normalized) || expanded.includes(canonicalizeExtensionId(extensionId))
}

/** @deprecated Use normalizeExtensionId */
export const normalizeToolId = normalizeExtensionId
/** @deprecated Use canonicalizeExtensionId */
export const canonicalizeToolId = canonicalizeExtensionId
/** @deprecated Use expandExtensionIds */
export const expandToolIds = expandExtensionIds
/** @deprecated Use extensionIdMatches */
export const toolIdMatches = extensionIdMatches
