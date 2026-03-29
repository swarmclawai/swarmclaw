import type { AppSettings } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { canonicalizeExtensionId } from './tool-aliases'

export type CapabilityPolicyMode = 'permissive' | 'balanced' | 'strict'

export interface CapabilityPolicyBlock {
  tool: string
  reason: string
  source: 'safety' | 'policy'
}

export interface ExtensionPolicyDecision {
  mode: CapabilityPolicyMode
  requestedExtensions: string[]
  enabledExtensions: string[]
  blockedExtensions: CapabilityPolicyBlock[]
}

/** @deprecated Use ExtensionPolicyDecision */
export type SessionToolPolicyDecision = ExtensionPolicyDecision

type CapabilityCategory =
  | 'filesystem'
  | 'execution'
  | 'network'
  | 'browser'
  | 'memory'
  | 'delegation'
  | 'platform'
  | 'outbound'

interface ToolDescriptor {
  categories: CapabilityCategory[]
  concreteTools: string[]
  destructive?: boolean
}

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  shell: { categories: ['execution'], concreteTools: ['shell', 'execute_command'] },
  execute: { categories: ['execution'], concreteTools: ['execute'] },
  process: { categories: ['execution'], concreteTools: ['process', 'process_tool'] },
  files: { categories: ['filesystem'], concreteTools: ['files', 'read_file', 'write_file', 'list_files', 'send_file'] },
  read_file: { categories: ['filesystem'], concreteTools: ['read_file'] },
  write_file: { categories: ['filesystem'], concreteTools: ['write_file'] },
  list_files: { categories: ['filesystem'], concreteTools: ['list_files'] },
  send_file: { categories: ['filesystem'], concreteTools: ['send_file'] },
  copy_file: { categories: ['filesystem'], concreteTools: ['copy_file'] },
  move_file: { categories: ['filesystem'], concreteTools: ['move_file'] },
  edit_file: { categories: ['filesystem'], concreteTools: ['edit_file'] },
  delete_file: { categories: ['filesystem'], concreteTools: ['delete_file'], destructive: true },
  web: { categories: ['network'], concreteTools: ['web', 'web_search', 'web_fetch'] },
  web_search: { categories: ['network'], concreteTools: ['web_search'] },
  web_fetch: { categories: ['network'], concreteTools: ['web_fetch'] },
  browser: { categories: ['browser', 'network'], concreteTools: ['browser', 'openclaw_browser'] },
  delegate: { categories: ['delegation', 'execution'], concreteTools: ['delegate', 'delegate_to_claude_code', 'delegate_to_codex_cli', 'delegate_to_opencode_cli', 'delegate_to_gemini_cli'] },
  claude_code: { categories: ['delegation', 'execution'], concreteTools: ['delegate_to_claude_code'] },
  codex_cli: { categories: ['delegation', 'execution'], concreteTools: ['delegate_to_codex_cli'] },
  opencode_cli: { categories: ['delegation', 'execution'], concreteTools: ['delegate_to_opencode_cli'] },
  gemini_cli: { categories: ['delegation', 'execution'], concreteTools: ['delegate_to_gemini_cli'] },
  memory: { categories: ['memory'], concreteTools: ['memory', 'memory_tool', 'memory_search', 'memory_get', 'memory_store', 'memory_update', 'context_status', 'context_summarize'] },
  // http_request consolidated into web 'api' action — no separate descriptor
  monitor: { categories: ['execution'], concreteTools: ['monitor', 'monitor_tool'] },
  openclaw_workspace: { categories: ['filesystem', 'platform'], concreteTools: ['openclaw_workspace'] },
  openclaw_nodes: { categories: ['platform'], concreteTools: ['openclaw_nodes'] },
  manage_platform: { categories: ['platform'], concreteTools: ['manage_platform', 'manage_agents', 'manage_projects', 'manage_tasks', 'manage_schedules', 'manage_skills', 'manage_documents', 'manage_webhooks', 'manage_connectors', 'manage_sessions', 'manage_secrets'] },
  manage_agents: { categories: ['platform'], concreteTools: ['manage_agents'] },
  manage_projects: { categories: ['platform'], concreteTools: ['manage_projects'] },
  manage_tasks: { categories: ['platform'], concreteTools: ['manage_tasks'] },
  manage_schedules: { categories: ['platform'], concreteTools: ['manage_schedules'] },
  schedule_wake: { categories: ['platform'], concreteTools: ['schedule_wake'] },
  manage_skills: { categories: ['platform'], concreteTools: ['manage_skills'] },
  manage_documents: { categories: ['platform'], concreteTools: ['manage_documents'] },
  manage_webhooks: { categories: ['platform', 'network'], concreteTools: ['manage_webhooks'] },
  connectors: { categories: ['platform', 'outbound'], concreteTools: ['connectors', 'connector_message_tool'] },
  manage_connectors: { categories: ['platform', 'outbound'], concreteTools: ['manage_connectors', 'connector_message_tool'] },
  session_info: { categories: ['platform'], concreteTools: ['session_info', 'sessions_tool', 'search_history_tool', 'whoami_tool'] },
  manage_sessions: { categories: ['platform'], concreteTools: ['manage_sessions', 'sessions_tool', 'search_history_tool', 'whoami_tool'] },
  manage_secrets: { categories: ['platform'], concreteTools: ['manage_secrets'] },
  manage_chatrooms: { categories: ['platform'], concreteTools: ['manage_chatrooms', 'chatroom'] },
  spawn_subagent: { categories: ['delegation', 'platform'], concreteTools: ['spawn_subagent', 'delegate_to_agent'] },
  context_mgmt: { categories: ['memory'], concreteTools: ['context_mgmt', 'context_status', 'context_summarize'] },
  extension_creator: { categories: ['filesystem', 'execution'], concreteTools: ['extension_creator', 'extension_creator_tool'] },
  mailbox: { categories: ['network', 'platform', 'outbound'], concreteTools: ['mailbox', 'inbox'] },
  ask_human: { categories: ['platform'], concreteTools: ['ask_human', 'human_loop'] },
  google_workspace: { categories: ['network'], concreteTools: ['google_workspace', 'gws'] },
}

const CONCRETE_TOOL_TO_SESSION_TOOLS = new Map<string, string[]>()
for (const [sessionTool, descriptor] of Object.entries(TOOL_DESCRIPTORS)) {
  for (const concreteName of descriptor.concreteTools) {
    const existing = CONCRETE_TOOL_TO_SESSION_TOOLS.get(concreteName) || []
    if (!existing.includes(sessionTool)) existing.push(sessionTool)
    CONCRETE_TOOL_TO_SESSION_TOOLS.set(concreteName, existing)
  }
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeMode(value: unknown): CapabilityPolicyMode {
  const mode = normalizeName(value)
  if (mode === 'strict') return 'strict'
  if (mode === 'balanced') return 'balanced'
  return 'permissive'
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    const normalized = normalizeName(entry)
    if (!normalized) continue
    names.push(normalized)
  }
  return dedup(names)
}

function getDescriptor(toolName: string): ToolDescriptor | undefined {
  const normalized = normalizeName(toolName)
  if (!normalized) return undefined
  return TOOL_DESCRIPTORS[normalized] || TOOL_DESCRIPTORS[normalizeName(canonicalizeExtensionId(normalized))]
}

function addComparableName(names: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeName(value)
  if (!normalized) return
  names.add(normalized)
  const canonical = normalizeName(canonicalizeExtensionId(normalized))
  if (canonical) names.add(canonical)
  for (const mappedTool of CONCRETE_TOOL_TO_SESSION_TOOLS.get(normalized) || []) {
    names.add(mappedTool)
  }
}

function collectRequestedExtensionNames(toolName: string, descriptor?: ToolDescriptor): string[] {
  const names = new Set<string>()
  addComparableName(names, toolName)
  for (const concreteName of descriptor?.concreteTools || []) {
    addComparableName(names, concreteName)
  }
  return Array.from(names)
}

function entryMatchesSessionTool(entry: string, sessionTool: string): boolean {
  const normalizedEntry = normalizeName(entry)
  const normalizedTool = normalizeName(sessionTool)
  if (!normalizedEntry || !normalizedTool) return false
  if (normalizedEntry === normalizedTool) return true
  if (!CONCRETE_TOOL_TO_SESSION_TOOLS.has(normalizedEntry)) {
    return normalizeName(canonicalizeExtensionId(normalizedEntry)) === normalizedTool
  }
  return false
}

function matchesConcreteToolSetting(configuredNames: Set<string>, concreteToolName: string): boolean {
  const normalizedName = normalizeName(concreteToolName)
  if (!normalizedName || configuredNames.size === 0) return false
  if (configuredNames.has(normalizedName)) return true
  for (const sessionTool of CONCRETE_TOOL_TO_SESSION_TOOLS.get(normalizedName) || []) {
    for (const entry of configuredNames) {
      if (entryMatchesSessionTool(entry, sessionTool)) return true
    }
  }
  return false
}

function getSettingsList(settings: Record<string, unknown>, key: string): string[] {
  return normalizeList(settings[key])
}

function modeBlocksTool(mode: CapabilityPolicyMode, toolName: string, descriptor?: ToolDescriptor): string | null {
  if (!descriptor) return null
  if (mode === 'permissive') return null
  if (mode === 'balanced' && descriptor.destructive) {
    return 'blocked by balanced policy (destructive tool)'
  }
  if (mode !== 'strict') return null
  if (descriptor.destructive) return 'blocked by strict policy (destructive tool)'
  if (descriptor.categories.some((c) => ['execution', 'delegation', 'platform', 'outbound', 'filesystem'].includes(c))) {
    return 'blocked by strict policy'
  }
  if (toolName === 'manage_connectors') return 'blocked by strict policy'
  return null
}

function safetyMatchesTool(safetyBlocked: Set<string>, toolName: string, descriptor?: ToolDescriptor): boolean {
  return collectRequestedExtensionNames(toolName, descriptor).some((name) => safetyBlocked.has(name))
}

function policyMatchesTool(blockedNames: Set<string>, toolName: string, descriptor?: ToolDescriptor): boolean {
  return collectRequestedExtensionNames(toolName, descriptor).some((name) => blockedNames.has(name))
}

function categoryBlockReason(blockedCategories: Set<string>, descriptor?: ToolDescriptor): string | null {
  if (!descriptor || !blockedCategories.size) return null
  for (const category of descriptor.categories) {
    if (blockedCategories.has(category)) {
      return `blocked by policy category "${category}"`
    }
  }
  return null
}

function ensureSettings(settings?: AppSettings | Record<string, unknown> | null): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') return {}
  return settings as Record<string, unknown>
}

export function isTaskManagementEnabled(settings?: AppSettings | Record<string, unknown> | null): boolean {
  return ensureSettings(settings).taskManagementEnabled !== false
}

export function isProjectManagementEnabled(settings?: AppSettings | Record<string, unknown> | null): boolean {
  return ensureSettings(settings).projectManagementEnabled !== false
}

function settingsBlockReason(toolName: string, settings?: AppSettings | Record<string, unknown> | null): string | null {
  if (toolName === 'manage_tasks' && !isTaskManagementEnabled(settings)) {
    return 'blocked because task management is disabled in app settings'
  }
  if (toolName === 'manage_projects' && !isProjectManagementEnabled(settings)) {
    return 'blocked because project management is disabled in app settings'
  }
  return null
}

function parsePolicyConfig(settings: Record<string, unknown>) {
  const mode = normalizeMode(settings.capabilityPolicyMode)
  const safetyBlocked = new Set(getSettingsList(settings, 'safetyBlockedTools'))
  const policyBlockedNames = new Set(getSettingsList(settings, 'capabilityBlockedTools'))
  const policyAllowedNames = new Set(getSettingsList(settings, 'capabilityAllowedTools'))
  const blockedCategories = new Set(getSettingsList(settings, 'capabilityBlockedCategories'))
  return {
    mode,
    safetyBlocked,
    policyBlockedNames,
    policyAllowedNames,
    blockedCategories,
  }
}

export function resolveSessionToolPolicy(
  sessionTools: string[] | undefined,
  settings?: AppSettings | Record<string, unknown> | null,
): SessionToolPolicyDecision {
  const normalizedSettings = ensureSettings(settings)
  const {
    mode,
    safetyBlocked,
    policyBlockedNames,
    policyAllowedNames,
    blockedCategories,
  } = parsePolicyConfig(normalizedSettings)

  const requestedExtensions = Array.isArray(sessionTools)
    ? dedup(sessionTools.map((id) => normalizeName(id)).filter(Boolean))
    : []

  const enabledExtensions: string[] = []
  const blockedExtensions: CapabilityPolicyBlock[] = []

  for (const extensionName of requestedExtensions) {
    const descriptor = getDescriptor(extensionName)
    const settingsReason = settingsBlockReason(extensionName, normalizedSettings)

    if (settingsReason) {
      blockedExtensions.push({ tool: extensionName, reason: settingsReason, source: 'policy' })
      continue
    }

    if (safetyMatchesTool(safetyBlocked, extensionName, descriptor)) {
      blockedExtensions.push({ tool: extensionName, reason: 'blocked by safety policy', source: 'safety' })
      continue
    }

    if (policyAllowedNames.has(extensionName)) {
      enabledExtensions.push(extensionName)
      continue
    }

    if (policyMatchesTool(policyBlockedNames, extensionName, descriptor)) {
      blockedExtensions.push({ tool: extensionName, reason: 'blocked by explicit policy rule', source: 'policy' })
      continue
    }

    const categoryReason = categoryBlockReason(blockedCategories, descriptor)
    if (categoryReason) {
      blockedExtensions.push({ tool: extensionName, reason: categoryReason, source: 'policy' })
      continue
    }

    const modeReason = modeBlocksTool(mode, extensionName, descriptor)
    if (modeReason) {
      blockedExtensions.push({ tool: extensionName, reason: modeReason, source: 'policy' })
      continue
    }

    enabledExtensions.push(extensionName)
  }

  return {
    mode,
    requestedExtensions,
    enabledExtensions,
    blockedExtensions,
  }
}

export function resolveConcreteToolPolicyBlock(
  concreteToolName: string,
  decision: SessionToolPolicyDecision,
  settings?: AppSettings | Record<string, unknown> | null,
): string | null {
  const name = normalizeName(concreteToolName)
  if (!name) return 'invalid tool name'

  const normalizedSettings = ensureSettings(settings)
  const {
    safetyBlocked,
    policyBlockedNames,
    policyAllowedNames,
  } = parsePolicyConfig(normalizedSettings)
  const settingsReason = settingsBlockReason(name, normalizedSettings)

  if (settingsReason) return settingsReason

  const mappedTools = CONCRETE_TOOL_TO_SESSION_TOOLS.get(name) || []
  if (matchesConcreteToolSetting(safetyBlocked, name)) return 'blocked by safety policy'
  const explicitlyAllowed = matchesConcreteToolSetting(policyAllowedNames, name)
  if (matchesConcreteToolSetting(policyBlockedNames, name) && !explicitlyAllowed) {
    return 'blocked by explicit policy rule'
  }

  if (mappedTools.length > 0) {
    const enabledRoot = mappedTools.find((tool) => decision.enabledExtensions.some((entry) => entryMatchesSessionTool(entry, tool)))
    if (enabledRoot) return null

    const blockedRoot = mappedTools
      .map((tool) => decision.blockedExtensions.find((entry) => entryMatchesSessionTool(entry.tool, tool)))
      .find(Boolean)
    if (blockedRoot) return blockedRoot.reason

    return `tool family "${mappedTools[0]}" is not enabled for this chat`
  }

  return null
}
