import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Session } from '@/types'
import { dedup, errorMessage } from '@/lib/shared-utils'
import { loadSettings, loadSession, loadAgent, loadMcpServers, patchAgent, patchSession } from '../storage'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { log } from '../logger'
import { resolveSessionToolPolicy } from '../tool-capability-policy'
import { expandPluginIds } from '../tool-aliases'
import type { ToolContext, SessionToolsResult, ToolBuildContext, AbortSignalRef } from './context'

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
import { buildGoogleWorkspaceTools } from './google-workspace'
import { buildSkillRuntimeTools } from './skill-runtime'
import './connector'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { enforceFileAccessPolicy } from './file-access-policy'

import { getPluginManager } from '../plugins'
import { jsonSchemaToZod } from '../mcp-client'

export type { ToolContext, SessionToolsResult }
export { sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser }

export async function buildSessionTools(cwd: string, enabledPlugins: string[], ctx?: ToolContext): Promise<SessionToolsResult> {
  const tools: StructuredToolInterface[] = []
  const cleanupFns: (() => Promise<void>)[] = []
  const abortSignalRef: AbortSignalRef = {}

  try {
    const runtime = loadRuntimeSettings()
    const commandTimeoutMs = runtime.shellCommandTimeoutMs
    const claudeTimeoutMs = runtime.claudeCodeTimeoutMs
    const cliProcessTimeoutMs = runtime.cliProcessTimeoutMs
    const appSettings = loadSettings()
    const effectiveEnabledPlugins = dedup(Array.isArray(enabledPlugins) ? enabledPlugins : [])
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

    // Load agent early so fileAccessPolicy is available during tool building (e.g. shell)
    const agentRecord = ctx?.agentId ? loadAgent(ctx.agentId) : null

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

    const filesystemScope = agentRecord?.filesystemScope === 'machine' ? 'machine' as const : 'workspace' as const

    // Auto-inject default blocked paths for machine scope to prevent writes to sensitive locations
    let effectiveFileAccessPolicy = agentRecord?.fileAccessPolicy ?? null
    if (filesystemScope === 'machine' && !effectiveFileAccessPolicy?.blockedPaths?.length) {
      effectiveFileAccessPolicy = {
        ...effectiveFileAccessPolicy,
        blockedPaths: [
          ...(effectiveFileAccessPolicy?.blockedPaths ?? []),
          '/System/**', '/usr/bin/**', '/sbin/**', '/boot/**',
          '**/.ssh/id_*', '**/.env', '**/.env.local', '**/.gnupg/**',
        ],
      }
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
      fileAccessPolicy: effectiveFileAccessPolicy,
      sandboxConfig: agentRecord?.sandboxConfig ?? null,
      filesystemScope,
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
      ['plugin_creator', buildPluginCreatorTools],
      ['image_gen', buildImageGenTools],
      ['email', buildEmailTools],
      ['calendar', buildCalendarTools],
      ['replicate', buildReplicateTools],
      ['google_workspace', buildGoogleWorkspaceTools],
      ['use_skill', buildSkillRuntimeTools],
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
      log.error('session-tools', 'Failed to load plugin tools', { error: errorMessage(err) })
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
          const normalizedToolId = toolId.trim()
          if (ctx?.sessionId) {
            patchSession(ctx.sessionId, (currentSession) => {
              if (!currentSession) return currentSession
              const currentPlugins = Array.isArray(currentSession.plugins) ? currentSession.plugins : []
              if (currentPlugins.includes(normalizedToolId)) return currentSession
              currentSession.plugins = [...currentPlugins, normalizedToolId]
              currentSession.updatedAt = Date.now()
              return currentSession
            })
          } else if (ctx?.agentId) {
            patchAgent(ctx.agentId, (currentAgent) => {
              if (!currentAgent) return currentAgent
              const currentPlugins = Array.isArray(currentAgent.plugins) ? currentAgent.plugins : []
              if (currentPlugins.includes(normalizedToolId)) return currentAgent
              currentAgent.plugins = [...currentPlugins, normalizedToolId]
              currentAgent.updatedAt = Date.now()
              return currentAgent
            })
          }
          return JSON.stringify({
            type: 'tool_access_granted',
            toolId: normalizedToolId,
            reason,
            message: `Tool access for "${normalizedToolId}" was granted immediately. It will be available on the next agent turn.`,
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

    const fileAccessPolicy = agentRecord?.fileAccessPolicy ?? null

    const buildFallbackHookSession = (): Session => ({
      id: ctx?.sessionId || 'plugin-hook-session',
      name: 'Plugin Hook Session',
      cwd,
      user: 'system',
      // Synthetic fallback used only for hook execution when no persisted session exists.
      provider: 'openai',
      model: 'synthetic-hook-context',
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
          // Check abort before executing any tool — prevents wasted work after chat stop
          if (abortSignalRef.signal?.aborted) {
            throw new DOMException('Tool execution aborted', 'AbortError')
          }
          const normalizedArgs = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
          const hookSession = resolveCurrentSession() || buildFallbackHookSession()
          // Enforce file access policy before execution
          if (fileAccessPolicy) {
            const denial = enforceFileAccessPolicy(candidate.name, normalizedArgs, cwd, fileAccessPolicy)
            if (denial) return denial
          }
          let guardedArgs: Record<string, unknown> | null = normalizedArgs
          if (ctx?.beforeToolCall) {
            const guardResult = await ctx.beforeToolCall({
              session: hookSession,
              toolName: candidate.name,
              input: guardedArgs,
              runId: ctx.runId,
            })
            if (guardResult?.warning) {
              ctx.onToolCallWarning?.({
                toolName: candidate.name,
                message: guardResult.warning,
              })
            }
            if (typeof guardResult?.blockReason === 'string' && guardResult.blockReason.trim()) {
              throw new Error(guardResult.blockReason.trim())
            }
            if (guardResult && 'input' in guardResult) {
              guardedArgs = guardResult.input === undefined ? guardedArgs : guardResult.input ?? null
            }
          }
          const hookResult = await pluginManager.runBeforeToolCall(
            {
              session: hookSession,
              toolName: candidate.name,
              input: guardedArgs,
              runId: ctx?.runId || undefined,
            },
            { enabledIds: activePlugins },
          )
          if (hookResult.warning) {
            ctx?.onToolCallWarning?.({
              toolName: candidate.name,
              message: hookResult.warning,
            })
          }
          if (hookResult.blockReason) {
            throw new Error(hookResult.blockReason)
          }
          const effectiveArgs = hookResult.input ?? guardedArgs
          const result = await candidate.invoke(effectiveArgs ?? {})
          const outputText = typeof result === 'string' ? result : JSON.stringify(result)
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
      abortSignalRef,
    }
  } catch (err: any) {
    console.error('[session-tools] buildSessionTools critical failure:', err.message)
    throw err
  }
}
