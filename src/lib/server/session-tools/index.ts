import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadSettings, loadSessions, saveSessions, loadMcpServers } from '../storage'
import { loadRuntimeSettings } from '../runtime-settings'
import { log } from '../logger'
import { resolveSessionToolPolicy } from '../tool-capability-policy'
import type { ToolContext, SessionToolsResult, ToolBuildContext } from './context'
import { buildShellTools } from './shell'
import { buildFileTools } from './file'
import { buildDelegateTools } from './delegate'
import { buildWebTools, sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser } from './web'
import { buildMemoryTools } from './memory'
import { buildCrudTools } from './crud'
import { buildSessionInfoTools } from './session-info'
import { buildConnectorTools } from './connector'
import { buildContextTools } from './context-mgmt'
import { buildSandboxTools } from './sandbox'
import { buildOpenClawNodeTools } from './openclaw-nodes'

export type { ToolContext, SessionToolsResult }
export { sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser }

export async function buildSessionTools(cwd: string, enabledTools: string[], ctx?: ToolContext): Promise<SessionToolsResult> {
  const tools: StructuredToolInterface[] = []
  const cleanupFns: (() => Promise<void>)[] = []
  const runtime = loadRuntimeSettings()
  const commandTimeoutMs = runtime.shellCommandTimeoutMs
  const claudeTimeoutMs = runtime.claudeCodeTimeoutMs
  const cliProcessTimeoutMs = runtime.cliProcessTimeoutMs
  const appSettings = loadSettings()
  const toolPolicy = resolveSessionToolPolicy(enabledTools, appSettings)
  const activeTools = toolPolicy.enabledTools
  const hasTool = (toolName: string) => activeTools.includes(toolName)

  if (toolPolicy.blockedTools.length > 0) {
    log.info('session-tools', 'Capability policy blocked tool families', {
      sessionId: ctx?.sessionId || null,
      agentId: ctx?.agentId || null,
      blockedTools: toolPolicy.blockedTools.map((entry) => `${entry.tool}:${entry.reason}`),
    })
  }

  const resolveCurrentSession = (): any | null => {
    if (!ctx?.sessionId) return null
    const sessions = loadSessions()
    return sessions[ctx.sessionId] || null
  }

  const readStoredDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode'): string | null => {
    const session = resolveCurrentSession()
    if (!session?.delegateResumeIds || typeof session.delegateResumeIds !== 'object') return null
    const raw = session.delegateResumeIds[key]
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null
  }

  const persistDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode', resumeId: string | null | undefined): void => {
    const normalized = typeof resumeId === 'string' ? resumeId.trim() : ''
    if (!normalized || !ctx?.sessionId) return
    const sessions = loadSessions()
    const target = sessions[ctx.sessionId]
    if (!target) return
    const current = (target.delegateResumeIds && typeof target.delegateResumeIds === 'object')
      ? target.delegateResumeIds
      : {}
    target.delegateResumeIds = {
      ...current,
      [key]: normalized,
    }
    target.updatedAt = Date.now()
    sessions[ctx.sessionId] = target
    saveSessions(sessions)
  }

  const bctx: ToolBuildContext = {
    cwd,
    ctx,
    hasTool,
    cleanupFns,
    commandTimeoutMs,
    claudeTimeoutMs,
    cliProcessTimeoutMs,
    persistDelegateResumeId,
    readStoredDelegateResumeId,
    resolveCurrentSession,
    activeTools,
  }

  tools.push(
    ...buildShellTools(bctx),
    ...buildFileTools(bctx),
    ...buildDelegateTools(bctx),
    ...buildWebTools(bctx),
    ...buildMemoryTools(bctx),
    ...buildCrudTools(bctx),
    ...buildSessionInfoTools(bctx),
    ...buildConnectorTools(bctx),
    ...buildContextTools(bctx),
    ...buildSandboxTools(bctx),
    ...buildOpenClawNodeTools(bctx),
  )

  // ---------------------------------------------------------------------------
  // MCP server tools — first-class injection (each MCP tool becomes its own LangChain tool)
  // ---------------------------------------------------------------------------
  const disabledMcpToolNames = new Set<string>(ctx?.mcpDisabledTools ?? [])

  if (ctx?.mcpServerIds?.length) {
    const mcpConnections: Array<{ client: any; transport: any }> = []
    const allMcpServers = loadMcpServers()

    for (const serverId of ctx.mcpServerIds) {
      const config = allMcpServers[serverId]
      if (!config) continue
      try {
        const { connectMcpServer, mcpToolsToLangChain } = await import('../mcp-client')
        const conn = await connectMcpServer(config)
        mcpConnections.push(conn)
        const mcpLcTools = await mcpToolsToLangChain(conn.client, config.name)
        for (const t of mcpLcTools) {
          if (!disabledMcpToolNames.has(t.name)) {
            tools.push(t)
          }
        }
      } catch (err: any) {
        log.warn('session-tools', `Failed to connect MCP server "${config.name}"`, { serverId, error: err.message })
      }
    }

    // Register cleanup for all MCP connections
    cleanupFns.push(async () => {
      const { disconnectMcpServer } = await import('../mcp-client')
      for (const conn of mcpConnections) {
        await disconnectMcpServer(conn.client, conn.transport)
      }
    })
  }

  // request_tool_access: always available
  tools.push(
    tool(
      async ({ toolId, reason }) => {
        return JSON.stringify({
          type: 'tool_request',
          toolId,
          reason,
          message: `Tool access request sent to user for "${toolId}". The user will be prompted to grant access — once granted, a follow-up message will arrive and you should immediately proceed with the original task using the newly available tool.`,
        })
      },
      {
        name: 'request_tool_access',
        description: 'Request access to a tool that is currently disabled. The user will be prompted to grant access, and a follow-up "Continue" message will be sent automatically once granted. End your current response after calling this — do NOT tell the user to "let you know" or ask them to confirm; the continuation is automatic.',
        schema: z.object({
          toolId: z.string().describe('The tool ID to request access for (e.g. manage_tasks, shell, claude_code)'),
          reason: z.string().describe('Brief explanation of why you need this tool'),
        }),
      },
    ),
  )

  return {
    tools,
    cleanup: async () => {
      for (const fn of cleanupFns) {
        try { await fn() } catch { /* ignore */ }
      }
    },
  }
}
