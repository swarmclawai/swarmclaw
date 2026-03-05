import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import { loadSessions, saveSessions, loadAgents } from '../storage'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

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

async function executeSessionsAction(args: any, context: { sessionId?: string; agentId?: string; cwd: string }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = normalized.action as string | undefined
  const sessionId = (normalized.sessionId ?? normalized.session_id) as string | undefined
  const message = normalized.message as string | undefined
  const limit = normalized.limit as number | undefined
  const agentId = (normalized.agentId ?? normalized.agent_id) as string | undefined
  const name = normalized.name as string | undefined
  try {
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
        messages: [], createdAt: now, lastActiveAt: now, sessionType: 'orchestrated',
        agentId: agent.id, parentSessionId: context.sessionId || undefined, plugins: agent.plugins || agent.tools || [],
      }
      saveSessions(sessions)
      return JSON.stringify({ sessionId: id, name: agent.name })
    }
    return `Unknown action "${action}".`
  } catch (err: any) { return `Error: ${err.message}` }
}

/**
 * Register as a Built-in Plugin
 */
const SessionInfoPlugin: Plugin = {
  name: 'Core Session Info',
  description: 'Identify current session context and manage other agent sessions.',
  hooks: {
    getCapabilityDescription: () => 'I can manage chat sessions (`manage_sessions`, `sessions_tool`, `whoami_tool`, `search_history_tool`) — check my identity, look up past conversations, message other sessions, and coordinate work.',
    getOperatingGuidance: () => 'Inspect existing chats before creating duplicates.',
  } as PluginHooks,
  tools: [
    {
      name: 'whoami_tool',
      description: 'Return identity/runtime context for this agent execution.',
      parameters: { type: 'object', properties: {} },
      execute: async (args, context) => executeWhoAmI({ sessionId: context.session.id, agentId: context.session.agentId ?? undefined })
    },
    {
      name: 'sessions_tool',
      description: 'Manage and interact with other sessions.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'history', 'spawn', 'status', 'stop'] },
          sessionId: { type: 'string' },
          agentId: { type: 'string' },
          message: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['action']
      },
      execute: async (args, context) => executeSessionsAction(args, { sessionId: context.session.id, agentId: context.session.agentId ?? undefined, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('session_info', SessionInfoPlugin)

/**
 * Legacy Bridge
 */
export function buildSessionInfoTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('manage_sessions')) return []
  return [
    tool(
      async () => executeWhoAmI({ sessionId: bctx.ctx?.sessionId || undefined, agentId: bctx.ctx?.agentId || undefined }),
      { name: 'whoami_tool', description: SessionInfoPlugin.tools![0].description, schema: z.object({}).passthrough() }
    ),
    tool(
      async (args) => executeSessionsAction(args, { sessionId: bctx.ctx?.sessionId || undefined, agentId: bctx.ctx?.agentId || undefined, cwd: bctx.cwd }),
      { name: 'sessions_tool', description: SessionInfoPlugin.tools![1].description, schema: z.object({}).passthrough() }
    )
  ]
}
