import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Session } from '@/types'
import { loadApprovals, loadSettings, loadSession, loadMcpServers, patchSession } from '../storage'
import { loadRuntimeSettings } from '../runtime-settings'
import { log } from '../logger'
import { resolveSessionToolPolicy } from '../tool-capability-policy'
import { expandPluginIds } from '../tool-aliases'
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
import { buildCrudTools } from './crud'
import { buildSessionInfoTools } from './session-info'
import { buildOpenClawNodeTools } from './openclaw-nodes'
import { buildContextTools } from './context-mgmt'
import { buildDiscoveryTools } from './discovery'
import { buildMonitorTools } from './monitor'
import { buildSampleUITools } from './sample-ui'
import { buildPluginCreatorTools } from './plugin-creator'
import { buildImageGenTools } from './image-gen'
import { buildEmailTools } from './email'
import { buildCalendarTools } from './calendar'
import { buildReplicateTools } from './replicate'
import { buildMailboxTools } from './mailbox'
import { buildHumanLoopTools } from './human-loop'
import { buildDocumentTools } from './document'
import { buildExtractTools } from './extract'
import { buildTableTools } from './table'
import { buildCrawlTools } from './crawl'
import './connector'
import { normalizeToolInputArgs } from './normalize-tool-args'

import { getPluginManager } from '../plugins'
import { jsonSchemaToZod } from '../mcp-client'

export type { ToolContext, SessionToolsResult }
export { sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser }

function approvedToolAccessIds(ctx?: ToolContext): string[] {
  if (!ctx?.sessionId && !ctx?.agentId) return []
  const approvals = loadApprovals()
  const granted = new Set<string>()
  for (const request of Object.values(approvals) as Array<Record<string, unknown>>) {
    if (request?.status !== 'approved' || request?.category !== 'tool_access') continue
    const sessionMatch = ctx.sessionId && request.sessionId === ctx.sessionId
    const agentMatch = ctx.agentId && request.agentId === ctx.agentId
    if (!sessionMatch && !agentMatch) continue
    const toolId = typeof request.data === 'object' && request.data && !Array.isArray(request.data)
      ? String((request.data as Record<string, unknown>).toolId || (request.data as Record<string, unknown>).pluginId || '').trim()
      : ''
    if (toolId) granted.add(toolId)
  }
  return [...granted]
}

export async function buildSessionTools(cwd: string, enabledPlugins: string[], ctx?: ToolContext): Promise<SessionToolsResult> {
  const tools: StructuredToolInterface[] = []
  const cleanupFns: (() => Promise<void>)[] = []

  try {
    const runtime = loadRuntimeSettings()
    const commandTimeoutMs = runtime.shellCommandTimeoutMs
    const claudeTimeoutMs = runtime.claudeCodeTimeoutMs
    const cliProcessTimeoutMs = runtime.cliProcessTimeoutMs
    const appSettings = loadSettings()
    const grantedToolIds = approvedToolAccessIds(ctx)
    const effectiveEnabledPlugins = Array.from(new Set([
      ...(Array.isArray(enabledPlugins) ? enabledPlugins : []),
      ...grantedToolIds,
    ]))
    if (ctx?.sessionId && grantedToolIds.length > 0) {
      patchSession(ctx.sessionId, (currentSession) => {
        if (!currentSession) return currentSession
        const currentPlugins = Array.isArray(currentSession.plugins) ? currentSession.plugins : []
        const mergedPlugins = Array.from(new Set([...currentPlugins, ...grantedToolIds]))
        if (mergedPlugins.length === currentPlugins.length) return currentSession
        currentSession.plugins = mergedPlugins
        currentSession.updatedAt = Date.now()
        return currentSession
      })
    }
    const toolPolicy = resolveSessionToolPolicy(effectiveEnabledPlugins, appSettings)
    const expandedEnabled = expandPluginIds(toolPolicy.enabledPlugins)
    const expandedBlocked = expandPluginIds(toolPolicy.blockedPlugins.map((entry) => entry.tool))
    const blockedSet = new Set(expandedBlocked)
    const filteredEnabled = expandedEnabled.filter((id) => !blockedSet.has(id))
    const pluginManager = getPluginManager()
    const activePlugins = (filteredEnabled.includes('shell')
      && !filteredEnabled.includes('process')
      && !blockedSet.has('process')
      ? [...filteredEnabled, 'process']
      : filteredEnabled).filter((pluginId) => !pluginManager.isExplicitlyDisabled(pluginId))
    const activePluginSet = new Set(activePlugins)
    const hasPlugin = (pluginName: string) => activePluginSet.has(pluginName)
    /** @deprecated Use hasPlugin */
    const hasTool = hasPlugin

    if (toolPolicy.blockedPlugins.length > 0) {
      log.info('session-tools', 'Capability policy blocked plugin families', {
        sessionId: ctx?.sessionId || null,
        agentId: ctx?.agentId || null,
        blockedPlugins: toolPolicy.blockedPlugins.map((entry) => `${entry.tool}:${entry.reason}`),
      })
    }

    const resolveCurrentSession = (): Session | null => {
      if (!ctx?.sessionId) return null
      return loadSession(ctx.sessionId)
    }

    const readStoredDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini'): string | null => {
      const session = resolveCurrentSession()
      if (!session?.delegateResumeIds || typeof session.delegateResumeIds !== 'object') return null
      const raw = session.delegateResumeIds[key]
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null
    }

    const persistDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini', resumeId: string | null | undefined): void => {
      const normalized = typeof resumeId === 'string' ? resumeId.trim() : ''
      if (!normalized || !ctx?.sessionId) return
      patchSession(ctx.sessionId, (target) => {
        if (!target) return target
        const current = (target.delegateResumeIds && typeof target.delegateResumeIds === 'object')
          ? target.delegateResumeIds
          : {}
        target.delegateResumeIds = {
          ...current,
          [key]: normalized,
        }
        target.updatedAt = Date.now()
        return target
      })
    }

    const bctx: ToolBuildContext = {
      cwd,
      ctx,
      hasPlugin,
      hasTool,
      cleanupFns,
      commandTimeoutMs,
      claudeTimeoutMs,
      cliProcessTimeoutMs,
      persistDelegateResumeId,
      readStoredDelegateResumeId,
      resolveCurrentSession,
      activePlugins,
    }

    // 1. Build Native Bridge Tools (Legacy enablement)
    const toolToPluginMap: Record<string, string> = {}

    const nativeBuilders: Array<[string, (ctx: ToolBuildContext) => StructuredToolInterface[]]> = [
      ['shell', buildShellTools],
      ['files', buildFileTools],
      ['edit_file', buildEditFileTools],
      ['delegate', buildDelegateTools],
      ['web', buildWebTools],
      ['memory', buildMemoryTools],
      ['manage_platform', buildPlatformTools],
      ['sandbox', buildSandboxTools],
      ['manage_chatrooms', buildChatroomTools],
      ['spawn_subagent', buildSubagentTools],
      ['canvas', buildCanvasTools],
      ['http', buildHttpTools],
      ['git', buildGitTools],
      ['wallet', buildWalletTools],
      ['openclaw_workspace', buildOpenClawWorkspaceTools],
      ['schedule', buildScheduleTools],
      ['manage_sessions', buildSessionInfoTools],
      ['openclaw_nodes', buildOpenClawNodeTools],
      ['context_mgmt', buildContextTools],
      ['discovery', buildDiscoveryTools],
      ['monitor', buildMonitorTools],
      ['sample_ui', buildSampleUITools],
      ['plugin_creator', buildPluginCreatorTools],
      ['image_gen', buildImageGenTools],
      ['email', buildEmailTools],
      ['calendar', buildCalendarTools],
      ['replicate', buildReplicateTools],
      ['mailbox', buildMailboxTools],
      ['ask_human', buildHumanLoopTools],
      ['document', buildDocumentTools],
      ['extract', buildExtractTools],
      ['table', buildTableTools],
      ['crawl', buildCrawlTools],
    ]

    for (const [pluginId, builder] of nativeBuilders) {
      const builtTools = builder(bctx)
      for (const t of builtTools) {
        toolToPluginMap[t.name] = pluginId
      }
      tools.push(...builtTools)
    }

    const crudTools = buildCrudTools(bctx)
    for (const toolEntry of crudTools) {
      toolToPluginMap[toolEntry.name] = toolEntry.name
    }
    tools.push(...crudTools)

    // 2. Build Plugin Tools (Built-in + External)
    try {
      const pluginTools = pluginManager.getTools(activePlugins)
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
        toolToPluginMap[pt.name] = entry.pluginId

        tools.push(
          tool(
            async (args) => {
              if (pluginManager.isExplicitlyDisabled(entry.pluginId)) {
                throw new Error(`Plugin "${entry.pluginId}" is disabled`)
              }
              try {
                const normalizedArgs = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
                const res = await pt.execute(normalizedArgs, {
                  session: { ...(ctx || {}), ...bctx } as any,
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
              toolToPluginMap[t.name] = `mcp:${serverId}`
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
    toolToPluginMap['request_tool_access'] = '_system'
    tools.push(
      tool(
        async (args) => {
          const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
          const toolId = normalized.toolId as string | undefined
          const reason = normalized.reason as string | undefined
          if (!toolId?.trim()) {
            return JSON.stringify({
              error: 'toolId is required',
              message: 'Specify the exact plugin ID to request access for.',
            })
          }
          const { requestApprovalMaybeAutoApprove } = await import('../approvals')
          const approval = await requestApprovalMaybeAutoApprove({
            category: 'tool_access',
            title: `Enable Plugin: ${toolId}`,
            description: reason || `Agent is requesting access to "${toolId}".`,
            data: { toolId, pluginId: toolId, reason: reason || '' },
            agentId: ctx?.agentId,
            sessionId: ctx?.sessionId,
          })
          if (approval.status === 'approved') {
            return JSON.stringify({
              type: 'tool_request',
              toolId,
              autoApproved: true,
              message: `Tool access for "${toolId}" was granted. It will be available on the next agent turn.`,
            })
          }
          return JSON.stringify({
            type: 'tool_request',
            toolId,
            reason,
            message: `Tool access request sent to user for "${toolId}". Once granted, use it on the next agent turn.`,
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

    const buildFallbackHookSession = (): Session => ({
      id: ctx?.sessionId || 'plugin-hook-session',
      name: 'Plugin Hook Session',
      cwd,
      user: 'system',
      provider: 'openai',
      model: 'unknown',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      agentId: ctx?.agentId || null,
      plugins: [...activePlugins],
    })

    const wrappedTools = tools.map((candidate) => {
      const schema = (candidate as unknown as { schema?: z.ZodTypeAny }).schema || z.object({}).passthrough()
      return tool(
        async (args) => {
          const normalizedArgs = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
          const nextArgs = await pluginManager.runBeforeToolExec(
            { toolName: candidate.name, input: normalizedArgs },
            { enabledIds: activePlugins },
          )
          const effectiveArgs = nextArgs ?? normalizedArgs
          const result = await candidate.invoke(effectiveArgs)
          const outputText = typeof result === 'string' ? result : JSON.stringify(result)
          const hookSession = resolveCurrentSession() || buildFallbackHookSession()
          await pluginManager.runHook(
            'afterToolExec',
            { session: hookSession, toolName: candidate.name, input: effectiveArgs, output: outputText },
            { enabledIds: activePlugins },
          )
          return outputText
        },
        {
          name: candidate.name,
          description: candidate.description,
          schema,
        },
      )
    })

    return {
      tools: wrappedTools,
      cleanup: async () => {
        for (const fn of cleanupFns) {
          try { await fn() } catch { /* ignore */ }
        }
      },
      toolToPluginMap,
    }
  } catch (err: any) {
    console.error('[session-tools] buildSessionTools critical failure:', err.message)
    throw err
  }
}
