import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import { DEFAULT_DELEGATION_MAX_DEPTH } from '@/lib/runtime-loop'
import { loadAgents, loadSessions, saveSessions } from '../storage'
import { executeSessionChatTurn } from '../chat-execution'
import { log } from '../logger'
import { loadRuntimeSettings } from '../runtime-settings'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

function getSessionDepth(sessionId: string | undefined, maxDepth: number): number {
  if (!sessionId) return 0
  const sessions = loadSessions()
  let depth = 0
  let current = sessionId
  while (current && depth < maxDepth + 1) {
    const session = sessions[current]
    if (!session?.parentSessionId) break
    current = session.parentSessionId as string
    depth++
  }
  return depth
}

/**
 * Core Subagent Execution Logic
 */
async function executeSubagentAction(args: any, context: { sessionId?: string; cwd: string }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const agentId = (normalized.agentId ?? normalized.agent_id) as string | undefined
  const message = normalized.message as string | undefined
  const cwd = normalized.cwd as string | undefined
  try {
    const runtime = loadRuntimeSettings()
    const maxDepth = runtime.delegationMaxDepth || DEFAULT_DELEGATION_MAX_DEPTH
    const agents = loadAgents()
    if (!agentId) return 'Error: agentId is required.'
    if (!message) return 'Error: message is required.'
    const agent = agents[agentId]
    if (!agent) return `Error: Agent "${agentId}" not found.`

    const depth = getSessionDepth(context.sessionId, maxDepth)
    if (depth >= maxDepth) return `Error: Max subagent depth reached.`

    const sid = genId()
    const now = Date.now()
    const sessions = loadSessions()
    sessions[sid] = {
      id: sid, name: `subagent-${agent.name}`, cwd: cwd || context.cwd, user: 'agent',
      provider: agent.provider, model: agent.model, credentialId: agent.credentialId || null,
      messages: [], createdAt: now, lastActiveAt: now, sessionType: 'orchestrated',
      agentId: agent.id, parentSessionId: context.sessionId || null, plugins: agent.plugins || agent.tools || [],
    }
    saveSessions(sessions)

    const result = await executeSessionChatTurn({ sessionId: sid, message, internal: true, source: 'subagent' })
    return JSON.stringify({ agentId, agentName: agent.name, sessionId: sid, response: result.text.slice(0, 8000) })
  } catch (err: any) { return `Error: ${err.message}` }
}

/**
 * Register as a Built-in Plugin
 */
const SubagentPlugin: Plugin = {
  name: 'Core Subagents',
  description: 'Delegate tasks to other specialized agents.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'spawn_subagent',
      description: 'Delegate a task to another agent.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          message: { type: 'string' },
          cwd: { type: 'string' }
        },
        required: ['agentId', 'message']
      },
      execute: async (args, context) => executeSubagentAction(args, { sessionId: context.session.id, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('subagent', SubagentPlugin)

/**
 * Legacy Bridge
 */
export function buildSubagentTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('spawn_subagent')) return []
  return [
    tool(
      async (args) => executeSubagentAction(args, { sessionId: bctx.ctx?.sessionId || undefined, cwd: bctx.cwd }),
      {
        name: 'spawn_subagent',
        description: SubagentPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
