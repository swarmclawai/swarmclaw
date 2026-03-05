import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Session } from '@/types'
import { loadSettings, loadSessions, saveSessions, loadMcpServers } from '../storage'
import { loadRuntimeSettings } from '../runtime-settings'
import { log } from '../logger'
import { resolveSessionToolPolicy } from '../tool-capability-policy'
import { expandToolIds } from '../tool-aliases'
import type { ToolContext, SessionToolsResult, ToolBuildContext } from './context'

// Import all tool modules to trigger their builtin registration
import { buildShellTools } from './shell'
import { buildFileTools } from './file'
import { buildEditFileTools } from './edit_file'
import { buildDelegateTools } from './delegate'
import { buildWebTools, sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser } from './web'
import { buildMemoryTools } from './memory'
import { buildSandboxTools } from './sandbox'
import { buildChatroomTools } from './chatroom'
import { buildSubagentTools } from './subagent'
import { buildCanvasTools } from './canvas'
import { buildHttpTools } from './http'
import { buildGitTools } from './git'
import { buildWalletTools } from './wallet'
import { buildOpenClawWorkspaceTools } from './openclaw-workspace'
import { buildScheduleTools } from './schedule'
import { buildPlatformTools } from './platform'
import { buildSessionInfoTools } from './session-info'
import { buildOpenClawNodeTools } from './openclaw-nodes'
import { buildContextTools } from './context-mgmt'
import { buildConnectorTools } from './connector'
import { buildDiscoveryTools } from './discovery'
import { buildMonitorTools } from './monitor'
import { buildSampleUITools } from './sample-ui'
import { buildPluginCreatorTools } from './plugin-creator'
import { normalizeToolInputArgs } from './normalize-tool-args'

import { getPluginManager } from '../plugins'
import { jsonSchemaToZod } from '../mcp-client'

export type { ToolContext, SessionToolsResult }
export { sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser }

export async function buildSessionTools(cwd: string, enabledTools: string[], ctx?: ToolContext): Promise<SessionToolsResult> {
  const tools: StructuredToolInterface[] = []
  const cleanupFns: (() => Promise<void>)[] = []
  
  try {
    const runtime = loadRuntimeSettings()
    const commandTimeoutMs = runtime.shellCommandTimeoutMs
    const claudeTimeoutMs = runtime.claudeCodeTimeoutMs
    const cliProcessTimeoutMs = runtime.cliProcessTimeoutMs
    const appSettings = loadSettings()
    const toolPolicy = resolveSessionToolPolicy(enabledTools, appSettings)
    const expandedEnabledTools = expandToolIds(toolPolicy.enabledTools)
    const expandedBlockedTools = expandToolIds(toolPolicy.blockedTools.map((entry) => entry.tool))
    const blockedToolSet = new Set(expandedBlockedTools)
    const filteredEnabledTools = expandedEnabledTools.filter((toolId) => !blockedToolSet.has(toolId))
    const activeTools = filteredEnabledTools.includes('shell')
      && !filteredEnabledTools.includes('process')
      && !blockedToolSet.has('process')
      ? [...filteredEnabledTools, 'process']
      : filteredEnabledTools
    const activeToolSet = new Set(activeTools)
    const hasTool = (toolName: string) => activeToolSet.has(toolName)

    if (toolPolicy.blockedTools.length > 0) {
      log.info('session-tools', 'Capability policy blocked tool families', {
        sessionId: ctx?.sessionId || null,
        agentId: ctx?.agentId || null,
        blockedTools: toolPolicy.blockedTools.map((entry) => `${entry.tool}:${entry.reason}`),
      })
    }

    const resolveCurrentSession = (): Session | null => {
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

    // 1. Build Native Bridge Tools (Legacy enablement)
    tools.push(
      ...buildShellTools(bctx),
      ...buildFileTools(bctx),
      ...buildEditFileTools(bctx),
      ...buildDelegateTools(bctx),
      ...buildWebTools(bctx),
      ...buildMemoryTools(bctx),
      ...buildPlatformTools(bctx),
      ...buildSandboxTools(bctx),
      ...buildChatroomTools(bctx),
      ...buildSubagentTools(bctx),
      ...buildCanvasTools(bctx),
      ...buildHttpTools(bctx),
      ...buildGitTools(bctx),
      ...buildWalletTools(bctx),
      ...buildOpenClawWorkspaceTools(bctx),
      ...buildScheduleTools(bctx),
      ...buildSessionInfoTools(bctx),
      ...buildOpenClawNodeTools(bctx),
      ...buildContextTools(bctx),
      ...buildConnectorTools(bctx),
      ...buildDiscoveryTools(bctx),
      ...buildMonitorTools(bctx),
      ...buildSampleUITools(bctx),
      ...buildPluginCreatorTools(bctx),
    )

    // 2. Build Plugin Tools (Built-in + External)
    try {
      const pluginManager = getPluginManager()
      const pluginTools = pluginManager.getTools(activeTools)
      const existingNames = new Set(tools.map((t) => t.name))
      
      for (const entry of pluginTools) {
        const pt = entry.tool
        if (existingNames.has(pt.name)) {
          log.warn('session-tools', 'Skipping plugin tool due to duplicate name', {
            toolName: pt.name,
            pluginId: entry.pluginId,
          })
          continue
        }
        existingNames.add(pt.name)

        tools.push(
          tool(
            async (args) => {
              if (!pluginManager.isEnabled(entry.pluginId)) {
                throw new Error(`Plugin "${entry.pluginId}" is disabled`)
              }
              try {
                const normalizedArgs = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
                const res = await pt.execute(normalizedArgs, {
                  session: { ...ctx, cwd } as any,
                  message: '',
                })
                pluginManager.recordExternalToolSuccess(entry.pluginId)
                return typeof res === 'string' ? res : JSON.stringify(res)
              } catch (err: unknown) {
                pluginManager.recordExternalToolFailure(entry.pluginId, pt.name, err)
                throw err
              }
            },
            {
              name: pt.name,
              description: pt.description,
              schema: jsonSchemaToZod(pt.parameters),
            }
          )
        )
      }
    } catch (err: unknown) {
      log.error('session-tools', 'Failed to load plugin tools', { error: err instanceof Error ? err.message : String(err) })
    }

    // 3. MCP server tools
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
      cleanupFns.push(async () => {
        const { disconnectMcpServer } = await import('../mcp-client')
        for (const conn of mcpConnections) {
          await disconnectMcpServer(conn.client, conn.transport)
        }
      })
    }

    // 4. Always available: request_tool_access
    tools.push(
      tool(
        async (args) => {
          const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
          const toolId = normalized.toolId as string | undefined
          const reason = normalized.reason as string | undefined
          return JSON.stringify({
            type: 'tool_request',
            toolId,
            reason,
            message: `Tool access request sent to user for "${toolId}". The user will be prompted to grant access — once granted, a follow-up message will arrive and you should immediately proceed with the original task using the newly available tool.`,
          })
        },
        {
          name: 'request_tool_access',
          description: 'Ask the user for access to a plugin I don\'t currently have.',
          schema: z.object({
            toolId: z.string().describe('The plugin ID to request access for'),
            reason: z.string().describe('Brief explanation of why you need this plugin'),
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
  } catch (err: any) {
    console.error('[session-tools] buildSessionTools critical failure:', err.message)
    throw err
  }
}
