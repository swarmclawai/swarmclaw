import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { HumanMessage } from '@langchain/core/messages'
import { loadSessions, saveSessions, loadCredentials, decryptKey } from '../storage'
import { buildChatModel } from '../build-llm'
import { getProvider } from '@/lib/providers'
import type { ToolBuildContext } from './context'

export function buildContextTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { ctx, activeTools, resolveCurrentSession } = bctx

  if (activeTools.length > 0) {
    tools.push(
      tool(
        async () => {
          try {
            const { getContextStatus } = await import('../context-manager')
            const session = resolveCurrentSession()
            if (!session) return 'Error: no current session context.'
            const messages = session.messages || []
            const systemPromptTokens = 2000
            const status = getContextStatus(messages, systemPromptTokens, session.provider, session.model)
            return JSON.stringify(status)
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'context_status',
          description: 'Check how much of my context window I\'ve used. Returns my token usage, the model\'s limit, percentage used, and whether I should compact.',
          schema: z.object({}),
        },
      ),
    )

    tools.push(
      tool(
        async ({ keepLastN }) => {
          try {
            const { summarizeAndCompact } = await import('../context-manager')
            const session = resolveCurrentSession()
            if (!session) return 'Error: no current session context.'
            if (!ctx?.sessionId) return 'Error: no session id in context.'
            const messages = session.messages || []
            const keep = Math.max(2, Math.min(keepLastN || 10, messages.length))

            if (messages.length <= keep) {
              return JSON.stringify({ status: 'no_action', reason: 'Not enough messages to compact', messageCount: messages.length })
            }

            // Resolve API key for the session's provider
            let apiKey: string | null = null
            const providerInfo = getProvider(session.provider)
            if ((providerInfo?.requiresApiKey || providerInfo?.optionalApiKey) && session.credentialId) {
              try {
                const creds = loadCredentials()
                const cred = creds[session.credentialId]
                if (cred) apiKey = decryptKey(cred.encryptedKey)
              } catch { /* continue without key */ }
            }

            // Build LLM summarizer using the session's provider/model
            const generateSummary = async (prompt: string): Promise<string> => {
              const llm = buildChatModel({
                provider: session.provider,
                model: session.model,
                apiKey,
                apiEndpoint: session.apiEndpoint,
              })
              const response = await llm.invoke([new HumanMessage(prompt)])
              if (typeof response.content === 'string') return response.content
              if (Array.isArray(response.content)) {
                return response.content
                  .map((b: Record<string, unknown>) => (typeof b.text === 'string' ? b.text : ''))
                  .join('')
              }
              return ''
            }

            const result = await summarizeAndCompact({
              messages,
              keepLastN: keep,
              agentId: ctx?.agentId || session.agentId || null,
              sessionId: ctx.sessionId,
              provider: session.provider,
              model: session.model,
              generateSummary,
            })

            const sessions = loadSessions()
            const target = sessions[ctx.sessionId]
            if (target) {
              target.messages = result.messages
              saveSessions(sessions)
            }

            return JSON.stringify({
              status: 'compacted',
              prunedCount: result.prunedCount,
              memoriesStored: result.memoriesStored,
              summaryAdded: result.summaryAdded,
              remainingMessages: result.messages.length,
            })
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'context_summarize',
          description: 'Compact my conversation history to free up context space. I\'ll save important decisions, facts, and results to memory, then replace older messages with a summary. I should check context_status first to see if this is needed.',
          schema: z.object({
            keepLastN: z.number().optional().describe('Number of recent messages to keep (default 10, min 2).'),
          }),
        },
      ),
    )
  }

  return tools
}
