import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { HumanMessage } from '@langchain/core/messages'
import { buildChatModel } from '../build-llm'
import type { ToolBuildContext } from './context'
import type { Extension, ExtensionHooks, Session } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'
import { updateSessionRunContext } from '@/lib/server/run-context'
import { getMessages, replaceAllMessages } from '@/lib/server/messages/message-repository'

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
    const status = getContextStatus(getMessages(session.id), 2000, session.provider as string, session.model as string, {
      includeToolEvents: false,
    })
    return JSON.stringify(status)
  } catch (err: unknown) { return `Error: ${errorMessage(err)}` }
}

async function executeContextSummarize(args: { keepLastN?: number }, bctx: ContextToolContext) {
  try {
    const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
    const { summarizeAndCompact } = await import('../context-manager')
    const session = bctx.resolveCurrentSession?.()
    if (!session || !bctx.ctx?.sessionId) return 'Error: no session context.'
    
    const messages = getMessages(session.id)
    const keepLastN = normalized.keepLastN as number | undefined
    const keep = Math.max(2, Math.min(keepLastN || 10, messages.length))
    if (messages.length <= keep) return JSON.stringify({ status: 'no_action' })

    const generateSummary = async (prompt: string): Promise<string> => {
      const llm = buildChatModel({
        provider: session.provider,
        model: session.model,
        apiKey: null,
        credentialId: session.credentialId ?? null,
        apiEndpoint: session.apiEndpoint ?? null,
      })
      const res = await llm.invoke([new HumanMessage(prompt)])
      return typeof res.content === 'string' ? res.content : ''
    }

    const result = await summarizeAndCompact({
      messages, keepLastN: keep, agentId: bctx.ctx.agentId ?? null, sessionId: bctx.ctx.sessionId ?? '',
      provider: session.provider, model: session.model, generateSummary
    })

    replaceAllMessages(bctx.ctx.sessionId ?? '', result.messages)
    return JSON.stringify({ status: 'compacted', remaining: result.messages.length })
  } catch (err: unknown) { return `Error: ${errorMessage(err)}` }
}

const PIN_CONTEXT_TYPE_MAP: Record<string, 'keyFacts' | 'failedApproaches' | 'blockers' | 'discoveries'> = {
  fact: 'keyFacts',
  failed_approach: 'failedApproaches',
  blocker: 'blockers',
  discovery: 'discoveries',
}

async function executePinContext(
  args: { type?: string; content?: string },
  bctx: ContextToolContext,
) {
  try {
    const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
    const type = String(normalized.type || '').toLowerCase()
    const content = String(normalized.content || '').slice(0, 300).trim()
    if (!content) return 'Error: content is required.'
    const field = PIN_CONTEXT_TYPE_MAP[type]
    if (!field) return `Error: type must be one of: ${Object.keys(PIN_CONTEXT_TYPE_MAP).join(', ')}`
    const sessionId = bctx.ctx?.sessionId
    if (!sessionId) return 'Error: no session context.'
    updateSessionRunContext(sessionId, (ctx) => {
      ctx[field] = [...ctx[field], content]
      return ctx
    })
    return JSON.stringify({ status: 'pinned', type, field })
  } catch (err: unknown) { return `Error: ${errorMessage(err)}` }
}

/**
 * Register as a Built-in Extension
 */
const ContextExtension: Extension = {
  name: 'Core Context',
  description: 'Manage and optimize the agent conversation context window.',
  hooks: {} as ExtensionHooks,
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
    },
    {
      name: 'pin_context',
      description: 'Pin a fact, failed approach, blocker, or discovery to working memory so it survives context compaction and flows to subagents.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['fact', 'failed_approach', 'blocker', 'discovery'], description: 'What kind of context to pin.' },
          content: { type: 'string', description: 'The content to pin (max 300 chars).' },
        },
        required: ['type', 'content'],
      },
      execute: async (args, context) => executePinContext(args as { type?: string; content?: string }, { ctx: { sessionId: context.session.id, agentId: context.session.agentId ?? null }, resolveCurrentSession: () => context.session as unknown as Session })
    }
  ]
}

registerNativeCapability('context_mgmt', ContextExtension)

/**
 * Legacy Bridge
 */
export function buildContextTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    tool(
      async () => executeContextStatus(bctx),
      { name: 'context_status', description: ContextExtension.tools![0].description, schema: z.object({}).passthrough() }
    ),
    tool(
      async (args) => executeContextSummarize(args as { keepLastN?: number }, bctx),
      { name: 'context_summarize', description: ContextExtension.tools![1].description, schema: z.object({}).passthrough() }
    ),
    tool(
      async (args) => executePinContext(args as { type?: string; content?: string }, bctx),
      {
        name: 'pin_context',
        description: ContextExtension.tools![2].description,
        schema: z.object({
          type: z.enum(['fact', 'failed_approach', 'blocker', 'discovery']).describe('What kind of context to pin.'),
          content: z.string().describe('The content to pin (max 300 chars).'),
        }),
      }
    ),
  ]
}
