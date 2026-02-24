import type { AppSettings } from '@/types'

export type CapabilityPolicyMode = 'permissive' | 'balanced' | 'strict'

export interface CapabilityPolicyBlock {
  tool: string
  reason: string
  source: 'safety' | 'policy'
}

export interface SessionToolPolicyDecision {
  mode: CapabilityPolicyMode
  requestedTools: string[]
  enabledTools: string[]
  blockedTools: CapabilityPolicyBlock[]
}

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
  shell: { categories: ['execution'], concreteTools: ['execute_command'] },
  process: { categories: ['execution'], concreteTools: ['process_tool'] },
  files: { categories: ['filesystem'], concreteTools: ['read_file', 'write_file', 'list_files', 'send_file'] },
  read_file: { categories: ['filesystem'], concreteTools: ['read_file'] },
  write_file: { categories: ['filesystem'], concreteTools: ['write_file'] },
  list_files: { categories: ['filesystem'], concreteTools: ['list_files'] },
  send_file: { categories: ['filesystem'], concreteTools: ['send_file'] },
  copy_file: { categories: ['filesystem'], concreteTools: ['copy_file'] },
  move_file: { categories: ['filesystem'], concreteTools: ['move_file'] },
  edit_file: { categories: ['filesystem'], concreteTools: ['edit_file'] },
  delete_file: { categories: ['filesystem'], concreteTools: ['delete_file'], destructive: true },
  web_search: { categories: ['network'], concreteTools: ['web_search'] },
  web_fetch: { categories: ['network'], concreteTools: ['web_fetch'] },
  browser: { categories: ['browser', 'network'], concreteTools: ['browser'] },
  claude_code: { categories: ['delegation', 'execution'], concreteTools: ['delegate_to_claude_code'] },
  codex_cli: { categories: ['delegation', 'execution'], concreteTools: ['delegate_to_codex_cli'] },
  opencode_cli: { categories: ['delegation', 'execution'], concreteTools: ['delegate_to_opencode_cli'] },
  memory: { categories: ['memory'], concreteTools: ['memory_tool', 'context_status', 'context_summarize'] },
  manage_agents: { categories: ['platform'], concreteTools: ['manage_agents'] },
  manage_tasks: { categories: ['platform'], concreteTools: ['manage_tasks'] },
  manage_schedules: { categories: ['platform'], concreteTools: ['manage_schedules'] },
  manage_skills: { categories: ['platform'], concreteTools: ['manage_skills'] },
  manage_documents: { categories: ['platform'], concreteTools: ['manage_documents'] },
  manage_webhooks: { categories: ['platform', 'network'], concreteTools: ['manage_webhooks'] },
  manage_connectors: { categories: ['platform', 'outbound'], concreteTools: ['manage_connectors', 'connector_message_tool'] },
  manage_sessions: { categories: ['platform'], concreteTools: ['manage_sessions', 'sessions_tool', 'search_history_tool', 'whoami_tool'] },
  manage_secrets: { categories: ['platform'], concreteTools: ['manage_secrets'] },
}

const CONCRETE_TOOL_TO_SESSION_TOOL = new Map<string, string>()
for (const [sessionTool, descriptor] of Object.entries(TOOL_DESCRIPTORS)) {
  for (const concreteName of descriptor.concreteTools) {
    CONCRETE_TOOL_TO_SESSION_TOOL.set(concreteName, sessionTool)
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
  return Array.from(new Set(names))
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
  if (safetyBlocked.has(toolName)) return true
  if (!descriptor) return false
  for (const concreteName of descriptor.concreteTools) {
    if (safetyBlocked.has(concreteName)) return true
  }
  if (toolName === 'memory' && safetyBlocked.has('memory_tool')) return true
  if (toolName === 'manage_connectors' && safetyBlocked.has('connector_message_tool')) return true
  if (toolName === 'manage_sessions' && (
    safetyBlocked.has('sessions_tool')
    || safetyBlocked.has('search_history_tool')
    || safetyBlocked.has('whoami_tool')
  )) return true
  if (toolName === 'claude_code' && safetyBlocked.has('delegate_to_claude_code')) return true
  if (toolName === 'codex_cli' && safetyBlocked.has('delegate_to_codex_cli')) return true
  if (toolName === 'opencode_cli' && safetyBlocked.has('delegate_to_opencode_cli')) return true
  return false
}

function policyMatchesTool(blockedNames: Set<string>, toolName: string, descriptor?: ToolDescriptor): boolean {
  if (blockedNames.has(toolName)) return true
  if (!descriptor) return false
  return descriptor.concreteTools.some((concreteName) => blockedNames.has(concreteName))
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

  const requestedTools = Array.isArray(sessionTools)
    ? Array.from(new Set(sessionTools.map((tool) => normalizeName(tool)).filter(Boolean)))
    : []

  const enabledTools: string[] = []
  const blockedTools: CapabilityPolicyBlock[] = []

  for (const toolName of requestedTools) {
    const descriptor = TOOL_DESCRIPTORS[toolName]

    if (safetyMatchesTool(safetyBlocked, toolName, descriptor)) {
      blockedTools.push({ tool: toolName, reason: 'blocked by safety policy', source: 'safety' })
      continue
    }

    if (policyAllowedNames.has(toolName)) {
      enabledTools.push(toolName)
      continue
    }

    if (policyMatchesTool(policyBlockedNames, toolName, descriptor)) {
      blockedTools.push({ tool: toolName, reason: 'blocked by explicit policy rule', source: 'policy' })
      continue
    }

    const categoryReason = categoryBlockReason(blockedCategories, descriptor)
    if (categoryReason) {
      blockedTools.push({ tool: toolName, reason: categoryReason, source: 'policy' })
      continue
    }

    const modeReason = modeBlocksTool(mode, toolName, descriptor)
    if (modeReason) {
      blockedTools.push({ tool: toolName, reason: modeReason, source: 'policy' })
      continue
    }

    enabledTools.push(toolName)
  }

  return {
    mode,
    requestedTools,
    enabledTools,
    blockedTools,
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

  if (safetyBlocked.has(name)) return 'blocked by safety policy'

  const mappedTool = CONCRETE_TOOL_TO_SESSION_TOOL.get(name)
  if (mappedTool && safetyBlocked.has(mappedTool)) return `blocked because "${mappedTool}" is safety-blocked`

  if (policyBlockedNames.has(name)) return 'blocked by explicit policy rule'
  if (mappedTool && policyBlockedNames.has(mappedTool) && !policyAllowedNames.has(mappedTool)) {
    return `blocked because "${mappedTool}" is policy-blocked`
  }

  if (mappedTool) {
    const blockedRoot = decision.blockedTools.find((entry) => entry.tool === mappedTool)
    if (blockedRoot) return blockedRoot.reason

    const enabledRoot = decision.enabledTools.includes(mappedTool)
    if (!enabledRoot) return `tool family "${mappedTool}" is not enabled for this session`
  }

  return null
}
