import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import { loadSessions, saveSessions, loadAgents } from '../storage'
import type { ToolBuildContext } from './context'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { getEnabledCapabilitySelection } from '@/lib/capability-selection'

/**
 * Core Session Info Execution Logic
 */
async function executeWhoAmI(context: { sessionId?: string; agentId?: string }) {
  try {
    const sessions = loadSessions()
    const current = context.sessionId ? sessions[context.sessionId] : null
    return JSON.stringify({
      sessionId: context.sessionId || undefined,
      sessionName: current?.name || undefined,
      sessionType: current?.sessionType || undefined,
      user: current?.user || undefined,
      agentId: context.agentId || current?.agentId || undefined,
      parentSessionId: current?.parentSessionId || undefined,
    })
  } catch (err: any) { return `Error: ${err.message}` }
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
  } catch (err: any) { return `Error: ${err.message}` }
}

/**
 * Register as a Built-in Extension
 */
const SessionInfoExtension: Extension = {
  name: 'Core Session Info',
  description: 'Identify current session context and manage other agent sessions.',
  hooks: {
    getCapabilityDescription: () => 'I can manage chat sessions (`sessions_tool`) â€” check my identity with action `identity`, look up past conversations, spawn sessions, and coordinate work.',
    getOperatingGuidance: () => 'Inspect existing chats before creating duplicates.',
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
      execute: async (args, context) => executeSessionsAction(args as Record<string, unknown>, { sessionId: context.session.id, agentId: context.session.agentId ?? undefined, cwd: context.session.cwd || process.cwd() })
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
      async (args) => executeSessionsAction(args as Record<string, unknown>, { sessionId: bctx.ctx?.sessionId || undefined, agentId: bctx.ctx?.agentId || undefined, cwd: bctx.cwd }),
      { name: 'sessions_tool', description: SessionInfoExtension.tools![0].description, schema: z.object({}).passthrough() }
    )
  ]
}
