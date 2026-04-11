import { errorMessage } from '@/lib/shared-utils'
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import { loadSessions, saveSessions, loadAgents } from '../storage'
import type { ToolBuildContext } from './context'
import type { ActiveProjectContext } from '@/lib/server/project-context'
import type { SessionToolPolicyDecision } from '@/lib/server/tool-capability-policy'
import type { Agent, Extension, ExtensionHooks, Session } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { getEnabledCapabilityIds, getEnabledCapabilitySelection } from '@/lib/capability-selection'
import { getExtensionManager } from '@/lib/server/extensions'
import { canonicalizeExtensionId, expandExtensionIds } from '@/lib/server/tool-aliases'
import { resolvePromptMode } from '@/lib/server/chat-execution/prompt-mode'
import { resolveActiveProjectContext } from '@/lib/server/project-context'
import { resolveSessionLineageIds } from '@/lib/server/sessions/session-lineage'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { resolveSessionToolPolicy } from '@/lib/server/tool-capability-policy'

/**
 * Core Session Info Execution Logic
 */
async function executeWhoAmI(context: { sessionId?: string; agentId?: string }) {
  try {
    const sessions = loadSessions()
    const current = context.sessionId ? sessions[context.sessionId] : null
    const agents = loadAgents()
    const agentRecord = (context.agentId ? agents[context.agentId] : null) || (current?.agentId ? agents[current.agentId] : null) || null
    const { toolPolicy, enabledExtensions } = resolveSessionIdentityAccess(current)
    const activeProjectContext = resolveActiveProjectContext(current || { agentId: context.agentId || null, cwd: null, projectId: null })
    const { rootSessionId } = resolveSessionLineageIds(current || { id: context.sessionId || '', parentSessionId: null })
    return JSON.stringify(buildSessionIdentityPayload({
      context,
      currentSession: current,
      currentAgent: agentRecord || null,
      activeProjectContext,
      enabledExtensions,
      toolPolicy,
      rootSessionId,
    }))
  } catch (err: unknown) { return `Error: ${errorMessage(err)}` }
}

function normalizeRuntimeExtensionId(extensionId: string): string {
  const normalized = extensionId.trim().toLowerCase()
  if (!normalized) return ''
  if (normalized === 'delegate_to_claude_code' || normalized === 'claude_code') return 'claude_code'
  if (normalized === 'delegate_to_codex_cli' || normalized === 'codex_cli') return 'codex_cli'
  if (normalized === 'delegate_to_opencode_cli' || normalized === 'opencode_cli') return 'opencode_cli'
  if (normalized === 'delegate_to_gemini_cli' || normalized === 'gemini_cli') return 'gemini_cli'
  if (normalized === 'delegate_to_copilot_cli' || normalized === 'copilot_cli') return 'copilot_cli'
  if (normalized === 'delegate_to_cursor_cli' || normalized === 'cursor_cli') return 'cursor_cli'
  if (normalized === 'delegate_to_qwen_code_cli' || normalized === 'qwen_code_cli') return 'qwen_code_cli'
  if (['session_info', 'sessions_tool', 'whoami_tool', 'search_history_tool'].includes(normalized)) return 'manage_sessions'
  return canonicalizeExtensionId(normalized)
}

function canonicalizeEnabledExtensions(enabledExtensions: string[]): string[] {
  const seen = new Set<string>()
  const values: string[] = []
  for (const extensionId of enabledExtensions) {
    const normalized = normalizeRuntimeExtensionId(extensionId)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    values.push(normalized)
  }
  return values
}

function resolveSessionIdentityAccess(current: Session | null): {
  toolPolicy: SessionToolPolicyDecision
  enabledExtensions: string[]
} {
  const rawExtensions = getEnabledCapabilityIds(current)
  const hasShellCapability = rawExtensions.some((toolId) => ['shell', 'execute_command'].includes(String(toolId)))
  const extensionManager = getExtensionManager()
  const requestedExtensions = expandExtensionIds([
    ...rawExtensions,
    ...(hasShellCapability ? ['process'] : []),
  ]).filter((id) => !extensionManager.isExplicitlyDisabled(id))
  const toolPolicy = resolveSessionToolPolicy(requestedExtensions, loadSettings())
  const blockedExtensionIds = new Set(expandExtensionIds(toolPolicy.blockedExtensions.map((entry) => entry.tool)))
  const enabledExtensions = canonicalizeEnabledExtensions(
    expandExtensionIds(toolPolicy.enabledExtensions)
      .filter((id) => !blockedExtensionIds.has(id))
      .filter((id) => !extensionManager.isExplicitlyDisabled(id)),
  )
  return { toolPolicy, enabledExtensions }
}

export function buildSessionIdentityPayload(params: {
  context: { sessionId?: string; agentId?: string }
  currentSession: Session | null
  currentAgent?: Agent | null
  activeProjectContext?: ActiveProjectContext | null
  enabledExtensions?: string[]
  toolPolicy?: SessionToolPolicyDecision | null
  rootSessionId?: string | null
}): Record<string, unknown> {
  const current = params.currentSession
  const currentAgent = params.currentAgent || null
  const activeProjectContext = params.activeProjectContext || null
  const enabledExtensions = Array.isArray(params.enabledExtensions) ? params.enabledExtensions : []
  const toolPolicy = params.toolPolicy || null
  const delegationEnabled = enabledExtensions.some((extensionId) => ['delegate', 'spawn_subagent', 'claude_code', 'codex_cli', 'opencode_cli', 'gemini_cli', 'cursor_cli', 'qwen_code_cli'].includes(extensionId))

  return {
    sessionId: params.context.sessionId || undefined,
    sessionName: current?.name || undefined,
    sessionType: current?.sessionType || undefined,
    sessionKind: current?.parentSessionId ? 'delegated_child' : 'root_chat',
    promptMode: current ? resolvePromptMode(current) : undefined,
    user: current?.user || undefined,
    agentId: params.context.agentId || current?.agentId || undefined,
    agentName: typeof currentAgent?.name === 'string' ? currentAgent.name : undefined,
    parentSessionId: current?.parentSessionId || undefined,
    rootSessionId: params.rootSessionId || current?.id || undefined,
    cwd: current?.cwd || undefined,
    projectId: activeProjectContext?.projectId || undefined,
    projectName: activeProjectContext?.project?.name || undefined,
    provider: current?.provider || undefined,
    model: current?.model || undefined,
    enabledExtensions,
    blockedExtensions: toolPolicy?.blockedExtensions || [],
    delegationEnabled,
    delegationTargetMode: delegationEnabled
      ? (currentAgent?.delegationTargetMode === 'selected' ? 'selected' : 'all')
      : undefined,
    delegationTargetAgentIds: delegationEnabled && Array.isArray(currentAgent?.delegationTargetAgentIds)
      ? currentAgent.delegationTargetAgentIds
      : [],
  }
}

function inferSessionsAction(
  normalized: Record<string, unknown>,
  context: { sessionId?: string; agentId?: string },
): string | undefined {
  const explicit = typeof normalized.action === 'string' ? normalized.action.trim() : ''
  if (explicit) return explicit

  const hasUpdates = !!normalized.updates && typeof normalized.updates === 'object'
  const hasSpawnTarget = typeof normalized.agentId === 'string' || typeof normalized.agent_id === 'string'
  const hasHistoryTarget =
    typeof normalized.sessionId === 'string'
    || typeof normalized.session_id === 'string'
    || typeof normalized.limit === 'number'
    || !!context.sessionId

  if (hasUpdates) return 'update'
  if (hasSpawnTarget) return 'spawn'
  if (hasHistoryTarget) return 'history'
  return 'list'
}

/** @deprecated Use sessions_tool with action "identity" instead */
export { executeWhoAmI }

async function executeSessionsAction(args: any, context: { sessionId?: string; agentId?: string; cwd: string }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = inferSessionsAction(normalized, context)
  const sessionId = (normalized.sessionId ?? normalized.session_id) as string | undefined
  const message = normalized.message as string | undefined
  const limit = normalized.limit as number | undefined
  const agentId = (normalized.agentId ?? normalized.agent_id) as string | undefined
  const name = normalized.name as string | undefined
  const updates = normalized.updates as Record<string, unknown> | undefined
  try {
    if (action === 'identity' || action === 'whoami') {
      return executeWhoAmI(context)
    }
    const sessions = loadSessions()
    if (action === 'list') {
      return JSON.stringify(Object.values(sessions).slice(0, limit || 50).map((s: any) => ({ id: s.id, name: s.name })))
    }
    if (action === 'history') {
      const target = sessions[sessionId || context.sessionId || '']
      if (!target) return 'Not found.'
      return JSON.stringify((target.messages || []).slice(-(limit || 20)))
    }
    if (action === 'spawn') {
      if (!agentId) return 'agentId required.'
      const agents = loadAgents()
      const agent = agents[agentId]
      if (!agent) return 'Agent not found.'
      const id = genId()
      const now = Date.now()
      sessions[id] = {
        id, name: (name || `${agent.name} Chat`).trim(), cwd: context.cwd, user: 'system',
        provider: agent.provider, model: agent.model, credentialId: agent.credentialId || null,
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        messages: [], createdAt: now, lastActiveAt: now, sessionType: 'human',
        agentId: agent.id, parentSessionId: context.sessionId || undefined, ...getEnabledCapabilitySelection(agent),
      }
      saveSessions(sessions)
      return JSON.stringify({ sessionId: id, name: agent.name })
    }
    if (action === 'update') {
      const targetId = sessionId || context.sessionId || ''
      if (!targetId) return 'sessionId required.'
      const target = sessions[targetId]
      if (!target) return 'Not found.'
      const allowedKeys = new Set([
        'thinkingLevel',
        'connectorThinkLevel',
        'sessionResetMode',
        'sessionIdleTimeoutSec',
        'sessionMaxAgeSec',
        'sessionDailyResetAt',
        'sessionResetTimezone',
        'connectorSessionScope',
        'connectorReplyMode',
        'connectorThreadBinding',
        'connectorGroupPolicy',
        'connectorIdleTimeoutSec',
        'connectorMaxAgeSec',
        'identityState',
        'provider',
        'model',
      ])
      const patch = updates && typeof updates === 'object' ? updates : {}
      for (const [key, value] of Object.entries(patch)) {
        if (!allowedKeys.has(key)) continue
        ;(target as unknown as Record<string, unknown>)[key] = value
      }
      saveSessions(sessions)
      return JSON.stringify({ sessionId: targetId, updated: Object.keys(patch).filter((key) => allowedKeys.has(key)) })
    }
    return `Unknown action "${action}".`
  } catch (err: unknown) { return `Error: ${errorMessage(err)}` }
}

/**
 * Register as a Built-in Extension
 */
const SessionInfoExtension: Extension = {
  name: 'Core Session Info',
  description: 'Identify current session context and manage other agent sessions.',
  hooks: {
    getCapabilityDescription: () => 'I can manage chat sessions (`sessions_tool`) — inspect live harness/session context with action `identity`, look up past session messages with `history`, spawn sessions, and coordinate work.',
    getOperatingGuidance: () => [
      'Use `sessions_tool` action `identity` when you need live session, project, lineage, or enabled-tool context.',
      'Use `sessions_tool` action `history` only when you need earlier messages from this same session that are not already visible in the current thread.',
      'Inspect existing chats before creating duplicates.',
    ],
  } as ExtensionHooks,
  tools: [
    {
      name: 'sessions_tool',
      description: 'Manage sessions and check identity. Actions: identity (whoami), list, history, spawn, update.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['identity', 'list', 'history', 'spawn', 'status', 'stop', 'update'] },
          sessionId: { type: 'string' },
          agentId: { type: 'string' },
          message: { type: 'string' },
          limit: { type: 'number' },
          updates: { type: 'object' },
        },
        required: ['action']
      },
      execute: async (args, context) => executeSessionsAction(args, { sessionId: context.session.id, agentId: context.session.agentId ?? undefined, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

registerNativeCapability('session_info', SessionInfoExtension)

/**
 * Legacy Bridge
 */
export function buildSessionInfoTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('manage_sessions')) return []
  return [
    tool(
      async (args) => executeSessionsAction(args, { sessionId: bctx.ctx?.sessionId || undefined, agentId: bctx.ctx?.agentId || undefined, cwd: bctx.cwd }),
      { name: 'sessions_tool', description: SessionInfoExtension.tools![0].description, schema: z.object({}).passthrough() }
    )
  ]
}
