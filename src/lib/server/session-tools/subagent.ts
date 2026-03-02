import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import { loadAgents, loadSessions, saveSessions } from '../storage'
import { executeSessionChatTurn } from '../chat-execution'
import { log } from '../logger'
import type { ToolBuildContext } from './context'

const MAX_RECURSION_DEPTH = 3

function getSessionDepth(sessionId: string | undefined): number {
  if (!sessionId) return 0
  const sessions = loadSessions()
  let depth = 0
  let current = sessionId
  while (current && depth < MAX_RECURSION_DEPTH + 1) {
    const session = sessions[current]
    if (!session?.parentSessionId) break
    current = session.parentSessionId
    depth++
  }
  return depth
}

export function buildSubagentTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const { ctx, hasTool } = bctx
  if (!hasTool('spawn_subagent')) return []

  return [
    tool(
      async ({ agentId, message, cwd }) => {
        try {
          // Validate agent exists
          const agents = loadAgents()
          const agent = agents[agentId]
          if (!agent) return `Error: Agent "${agentId}" not found. Available agents: ${Object.values(agents).map((a) => `"${a.id}" (${a.name})`).join(', ')}`

          // Check recursion depth
          const depth = getSessionDepth(ctx?.sessionId ?? undefined)
          if (depth >= MAX_RECURSION_DEPTH) {
            return `Error: Maximum subagent recursion depth (${MAX_RECURSION_DEPTH}) reached. Cannot spawn further subagents.`
          }

          // Create ephemeral session
          const sessionId = genId()
          const now = Date.now()
          const sessions = loadSessions()
          sessions[sessionId] = {
            id: sessionId,
            name: `subagent-${agent.name}-${sessionId.slice(0, 6)}`,
            cwd: cwd || bctx.cwd,
            user: 'agent',
            provider: agent.provider,
            model: agent.model,
            credentialId: agent.credentialId || null,
            fallbackCredentialIds: agent.fallbackCredentialIds || [],
            apiEndpoint: agent.apiEndpoint || null,
            claudeSessionId: null,
            messages: [],
            createdAt: now,
            lastActiveAt: now,
            sessionType: 'orchestrated',
            agentId: agent.id,
            parentSessionId: ctx?.sessionId || null,
            tools: agent.tools || [],
          }
          saveSessions(sessions)

          log.info('subagent', `Spawning subagent "${agent.name}" (depth=${depth + 1})`, {
            parentSessionId: ctx?.sessionId,
            childSessionId: sessionId,
            agentId,
          })

          // Execute the chat turn
          const result = await executeSessionChatTurn({
            sessionId,
            message,
            internal: true,
            source: 'subagent',
          })

          return JSON.stringify({
            agentId,
            agentName: agent.name,
            sessionId,
            response: result.text.slice(0, 8000),
            toolEvents: result.toolEvents?.length || 0,
            error: result.error || null,
          })
        } catch (err: unknown) {
          return `Error spawning subagent: ${err instanceof Error ? err.message : String(err)}`
        }
      },
      {
        name: 'spawn_subagent',
        description: `Delegate a task to another agent. The subagent runs independently and returns its response. Use this to leverage specialized agents for subtasks. Max recursion depth: ${MAX_RECURSION_DEPTH}.`,
        schema: z.object({
          agentId: z.string().describe('ID of the agent to delegate to'),
          message: z.string().describe('The message/task to send to the subagent'),
          cwd: z.string().optional().describe('Optional working directory for the subagent (defaults to current)'),
        }),
      },
    ),
  ]
}
