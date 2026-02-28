import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadSessions, saveSessions } from '../storage'
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
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'context_status',
          description: 'Check current context window usage for this session. Returns estimated tokens used, provider context limit, percentage used, and compaction strategy recommendation.',
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

            const generateSummary = async (text: string): Promise<string> => {
              const lines = text.split('\n\n').filter(Boolean)
              const keyLines: string[] = []
              for (const line of lines) {
                if (line.length > 20) {
                  keyLines.push(line.slice(0, 200))
                }
              }
              let summary = ''
              for (const line of keyLines) {
                if (summary.length + line.length > 2000) break
                summary += line + '\n'
              }
              return summary.trim() || 'Previous conversation context was pruned.'
            }

            const result = await summarizeAndCompact({
              messages,
              keepLastN: keep,
              agentId: ctx?.agentId || session.agentId || null,
              sessionId: ctx.sessionId,
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
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'context_summarize',
          description: 'Summarize and compact the conversation history to free context window space. Old messages are consolidated to memory (preserving decisions, key facts, results) and replaced with a summary. Use context_status first to check if compaction is needed.',
          schema: z.object({
            keepLastN: z.number().optional().describe('Number of recent messages to keep (default 10, min 2).'),
          }),
        },
      ),
    )
  }

  return tools
}
