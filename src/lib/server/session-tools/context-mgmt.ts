import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { HumanMessage } from '@langchain/core/messages'
import { loadSessions, saveSessions } from '../storage'
import { buildChatModel } from '../build-llm'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks, Session } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

interface ContextToolContext {
  ctx?: { agentId?: string | null; sessionId?: string | null }
  resolveCurrentSession?: () => Session | null
}

/**
 * Core Context Management Execution Logic
 */
async function executeContextStatus(bctx: ContextToolContext) {
  try {
    const { getContextStatus } = await import('../context-manager')
    const session = bctx.resolveCurrentSession?.()
    if (!session) return 'Error: no current session context.'
    const status = getContextStatus(session.messages || [], 2000, session.provider as string, session.model as string)
    return JSON.stringify(status)
  } catch (err: unknown) { return `Error: ${err instanceof Error ? err.message : String(err)}` }
}

async function executeContextSummarize(args: { keepLastN?: number }, bctx: ContextToolContext) {
  try {
    const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
    const { summarizeAndCompact } = await import('../context-manager')
    const session = bctx.resolveCurrentSession?.()
    if (!session || !bctx.ctx?.sessionId) return 'Error: no session context.'
    
    const messages = session.messages || []
    const keepLastN = normalized.keepLastN as number | undefined
    const keep = Math.max(2, Math.min(keepLastN || 10, messages.length))
    if (messages.length <= keep) return JSON.stringify({ status: 'no_action' })

    const generateSummary = async (prompt: string): Promise<string> => {
      const llm = buildChatModel({ provider: session.provider, model: session.model, apiKey: null })
      const res = await llm.invoke([new HumanMessage(prompt)])
      return typeof res.content === 'string' ? res.content : ''
    }

    const result = await summarizeAndCompact({
      messages, keepLastN: keep, agentId: bctx.ctx.agentId ?? null, sessionId: bctx.ctx.sessionId ?? '',
      provider: session.provider, model: session.model, generateSummary
    })

    const sessions = loadSessions()
    if (sessions[bctx.ctx.sessionId]) {
      sessions[bctx.ctx.sessionId].messages = result.messages
      saveSessions(sessions)
    }
    return JSON.stringify({ status: 'compacted', remaining: result.messages.length })
  } catch (err: unknown) { return `Error: ${err instanceof Error ? err.message : String(err)}` }
}

/**
 * Register as a Built-in Plugin
 */
const ContextPlugin: Plugin = {
  name: 'Core Context',
  description: 'Manage and optimize the agent conversation context window.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'context_status',
      description: 'Check token usage and context window limits.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => executeContextStatus({ resolveCurrentSession: () => context.session as unknown as Session })
    },
    {
      name: 'context_summarize',
      description: 'Compact conversation history to free up space.',
      parameters: {
        type: 'object',
        properties: { keepLastN: { type: 'number' } }
      },
      execute: async (args, context) => executeContextSummarize(args as { keepLastN?: number }, { ctx: { sessionId: context.session.id, agentId: context.session.agentId ?? null }, resolveCurrentSession: () => context.session as unknown as Session })
    }
  ]
}

getPluginManager().registerBuiltin('context_mgmt', ContextPlugin)

/**
 * Legacy Bridge
 */
export function buildContextTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    tool(
      async () => executeContextStatus(bctx),
      { name: 'context_status', description: ContextPlugin.tools![0].description, schema: z.object({}).passthrough() }
    ),
    tool(
      async (args) => executeContextSummarize(args as { keepLastN?: number }, bctx),
      { name: 'context_summarize', description: ContextPlugin.tools![1].description, schema: z.object({}).passthrough() }
    )
  ]
}
