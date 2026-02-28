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

export type { ToolContext, SessionToolsResult }
export { sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser }

export function buildSessionTools(cwd: string, enabledTools: string[], ctx?: ToolContext): SessionToolsResult {
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
  )

  // ---------------------------------------------------------------------------
  // MCP server tools — single meta-tool with lazy async connection
  // ---------------------------------------------------------------------------
  if (ctx?.mcpServerIds?.length) {
    const mcpConnections = new Map<string, { client: any; transport: any }>()
    let mcpConfigs: Record<string, any> | null = null

    const getMcpConfigs = () => {
      if (!mcpConfigs) {
        const all = loadMcpServers()
        mcpConfigs = {}
        for (const id of ctx.mcpServerIds!) {
          if (all[id]) mcpConfigs[id] = all[id]
        }
      }
      return mcpConfigs
    }

    const ensureMcpConnection = async (serverId: string) => {
      if (mcpConnections.has(serverId)) return mcpConnections.get(serverId)!
      const configs = getMcpConfigs()
      const config = configs[serverId]
      if (!config) throw new Error(`MCP server "${serverId}" not found`)
      const { connectMcpServer } = await import('../mcp-client')
      const conn = await connectMcpServer(config)
      mcpConnections.set(serverId, conn)
      return conn
    }

    // List available MCP tools across configured servers
    tools.push(
      tool(
        async ({ server_id }) => {
          try {
            const conn = await ensureMcpConnection(server_id)
            const { tools: mcpTools } = await conn.client.listTools()
            return JSON.stringify(
              mcpTools.map((t: any) => ({
                name: t.name,
                description: t.description ?? '',
                inputSchema: t.inputSchema ?? {},
              }))
            )
          } catch (err: any) {
            return JSON.stringify({ error: err.message })
          }
        },
        {
          name: 'mcp_list_tools',
          description:
            'List tools available on an MCP server. Call this first to discover tool names before calling mcp_call.',
          schema: z.object({
            server_id: z.string().describe('The MCP server ID to list tools from'),
          }),
        }
      )
    )

    // Call an MCP tool on a specific server
    tools.push(
      tool(
        async ({ server_id, tool_name, args }) => {
          try {
            const conn = await ensureMcpConnection(server_id)
            const result = await conn.client.callTool({
              name: tool_name,
              arguments: args ?? {},
            })
            const parts = (result.content ?? [])
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
            return parts.join('\n') || '(no output)'
          } catch (err: any) {
            return JSON.stringify({ error: err.message })
          }
        },
        {
          name: 'mcp_call',
          description:
            'Call a tool on an MCP server. Use mcp_list_tools first to discover available tool names and their input schemas.',
          schema: z.object({
            server_id: z.string().describe('The MCP server ID'),
            tool_name: z.string().describe('The tool name to call'),
            args: z.record(z.string(), z.any()).optional().describe('Arguments to pass to the tool'),
          }),
        }
      )
    )

    // Register cleanup for all MCP connections
    cleanupFns.push(async () => {
      const { disconnectMcpServer } = await import('../mcp-client')
      for (const [, conn] of mcpConnections) {
        await disconnectMcpServer(conn.client, conn.transport)
      }
      mcpConnections.clear()
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
          message: `Tool access request sent to user for "${toolId}". Wait for the user to grant access before trying to use it.`,
        })
      },
      {
        name: 'request_tool_access',
        description: 'Request access to a tool that is currently disabled. The user will be prompted to grant access. Use this when you need a tool from the disabled tools list.',
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
