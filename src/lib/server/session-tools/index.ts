import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Session } from '@/types'
import { dedup, errorMessage } from '@/lib/shared-utils'
import { loadSettings, loadSession, loadAgent, loadMcpServers, patchAgent, patchSession } from '../storage'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { log } from '../logger'
import { resolveSessionToolPolicy } from '../tool-capability-policy'
import { expandExtensionIds } from '../tool-aliases'
import type { ToolContext, SessionToolsResult, ToolBuildContext, AbortSignalRef } from './context'

// Import all tool modules to trigger their builtin registration
import { buildShellTools } from './shell'
import { buildFileTools } from './file'
import { buildEditFileTools } from './edit_file'
import { buildDelegateTools } from './delegate'
import { buildWebTools, sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser } from './web'
import { buildMemoryTools } from './memory'
import { buildChatroomTools } from './chatroom'
import { buildProtocolTools } from './protocol'
import { buildSubagentTools } from './subagent'
import { buildOpenClawWorkspaceTools } from './openclaw-workspace'
import { buildScheduleTools } from './schedule'
import { buildPlatformTools } from './platform'
import { buildCrudTools } from './crud'
import { buildSessionInfoTools } from './session-info'
import { buildOpenClawNodeTools } from './openclaw-nodes'
import { buildContextTools } from './context-mgmt'
import { buildDiscoveryTools } from './discovery'
import { buildMonitorTools } from './monitor'
import { buildExtensionCreatorTools } from './extension-creator'
import { buildImageGenTools } from './image-gen'
import { buildEmailTools } from './email'
import { buildReplicateTools } from './replicate'
import { buildMailboxTools } from './mailbox'
import { buildHumanLoopTools } from './human-loop'
import { buildGoogleWorkspaceTools } from './google-workspace'
import { buildSkillRuntimeTools } from './skill-runtime'
import { buildConnectorTools } from './connector'
import { buildPeerQueryTools } from './peer-query'
import { buildTeamContextTools } from './team-context'
import { buildExecuteTools } from './execute'
import { buildSkillsTools } from './skills-tool'
import { buildFilesTools } from './files-tool'
import { buildMemoryTool } from './memory-tool'
import { buildPlatformV2Tools } from './platform-tool'
import { buildSwarmFeedTools } from './swarmfeed'
import { buildSwarmDockTools } from './swarmdock'
import './connector'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { enforceFileAccessPolicy } from './file-access-policy'

import { getExtensionManager } from '../extensions'
import { runCapabilityBeforeToolCall, runCapabilityHook } from '../native-capabilities'
import { jsonSchemaToZod } from '../mcp-client'
import {
  getEnabledCapabilitySelection,
  isExternalExtensionId,
  splitCapabilityIds,
} from '@/lib/capability-selection'
import { setSpanAttributes, withServerSpan } from '@/lib/server/observability/otel-tracing'

export type { ToolContext, SessionToolsResult }
export { sweepOrphanedBrowsers, cleanupSessionBrowser, getActiveBrowserCount, hasActiveBrowser }

const TAG = 'session-tools'

const DELEGATION_TOOL_NAMES = new Set([
  'delegate',
  'spawn_subagent',
  'delegate_to_agent',
  'delegate_to_claude_code',
  'delegate_to_codex_cli',
  'delegate_to_opencode_cli',
  'delegate_to_gemini_cli',
  'delegate_to_copilot_cli',
  'delegate_to_cursor_cli',
  'delegate_to_qwen_code_cli',
])

export async function buildSessionTools(cwd: string, enabledExtensions: string[], ctx?: ToolContext): Promise<SessionToolsResult> {
  const tools: StructuredToolInterface[] = []
  const cleanupFns: (() => Promise<void>)[] = []
  const abortSignalRef: AbortSignalRef = {}

  try {
    const runtime = loadRuntimeSettings()
    const commandTimeoutMs = runtime.shellCommandTimeoutMs
    const claudeTimeoutMs = runtime.claudeCodeTimeoutMs
    const cliProcessTimeoutMs = runtime.cliProcessTimeoutMs
    const appSettings = loadSettings()
    const effectiveEnabledExtensions = dedup(Array.isArray(enabledExtensions) ? enabledExtensions : [])
    const toolPolicy = resolveSessionToolPolicy(effectiveEnabledExtensions, appSettings)
    const expandedEnabled = expandExtensionIds(toolPolicy.enabledExtensions)
    const expandedBlocked = expandExtensionIds(toolPolicy.blockedExtensions.map((entry) => entry.tool))
    const blockedSet = new Set(expandedBlocked)
    const filteredEnabled = expandedEnabled.filter((id) => !blockedSet.has(id))
    const extensionManager = getExtensionManager()
    const activeExtensions = (filteredEnabled.includes('shell')
      && !filteredEnabled.includes('process')
      && !blockedSet.has('process')
      ? [...filteredEnabled, 'process']
      : filteredEnabled).filter((extensionId) => !extensionManager.isExplicitlyDisabled(extensionId))
    const activeExtensionSet = new Set(activeExtensions)
    const hasExtension = (extensionName: string) => activeExtensionSet.has(extensionName)

    if (toolPolicy.blockedExtensions.length > 0) {
      log.info('session-tools', 'Capability policy blocked extension families', {
        sessionId: ctx?.sessionId || null,
        agentId: ctx?.agentId || null,
        blockedExtensions: toolPolicy.blockedExtensions.map((entry) => `${entry.tool}:${entry.reason}`),
      })
    }

    // Load agent early so fileAccessPolicy is available during tool building (e.g. shell)
    const agentRecord = ctx?.agentId ? loadAgent(ctx.agentId) : null

    const resolveCurrentSession = (): Session | null => {
      if (!ctx?.sessionId) return null
      return loadSession(ctx.sessionId)
    }

    const readStoredDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen'): string | null => {
      const session = resolveCurrentSession()
      if (!session?.delegateResumeIds || typeof session.delegateResumeIds !== 'object') return null
      const raw = session.delegateResumeIds[key]
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null
    }

    const persistDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'cursor' | 'qwen', resumeId: string | null | undefined): void => {
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
      hasExtension,
      hasTool: hasExtension,
      cleanupFns,
      commandTimeoutMs,
      claudeTimeoutMs,
      cliProcessTimeoutMs,
      persistDelegateResumeId,
      readStoredDelegateResumeId,
      resolveCurrentSession,
      activeExtensions,
      fileAccessPolicy: effectiveFileAccessPolicy,
      sandboxConfig: agentRecord?.sandboxConfig ?? null,
      filesystemScope,
    }

    // 1. Build Native Bridge Tools (Legacy enablement)
    const toolToExtensionMap: Record<string, string> = {}

    const nativeBuilders: Array<[string, (ctx: ToolBuildContext) => StructuredToolInterface[]]> = [
      ['shell', buildShellTools],
      ['files', buildFileTools],
      ['edit_file', buildEditFileTools],
      ['delegate', buildDelegateTools],
      ['web', buildWebTools],
      ['memory', buildMemoryTools],
      ['manage_platform', buildPlatformTools],
      ['manage_chatrooms', buildChatroomTools],
      ['manage_protocols', buildProtocolTools],
      ['spawn_subagent', buildSubagentTools],
      ['openclaw_workspace', buildOpenClawWorkspaceTools],
      ['schedule', buildScheduleTools],
      ['manage_sessions', buildSessionInfoTools],
      ['openclaw_nodes', buildOpenClawNodeTools],
      ['context_mgmt', buildContextTools],
      ['discovery', buildDiscoveryTools],
      ['monitor', buildMonitorTools],
      ['manage_connectors', buildConnectorTools],
      ['extension_creator', buildExtensionCreatorTools],
      ['image_gen', buildImageGenTools],
      ['email', buildEmailTools],
      ['replicate', buildReplicateTools],
      ['google_workspace', buildGoogleWorkspaceTools],
      ['use_skill', buildSkillRuntimeTools],
      ['mailbox', buildMailboxTools],
      ['ask_human', buildHumanLoopTools],
      ['peer_query', buildPeerQueryTools],
      ['team_context', buildTeamContextTools],
      ['execute', buildExecuteTools],
      ['skills', buildSkillsTools],
      ['files_v2', buildFilesTools],
      ['memory_v2', buildMemoryTool],
      ['platform_v2', buildPlatformV2Tools],
      ['swarmfeed', buildSwarmFeedTools],
      ['swarmdock', buildSwarmDockTools],
    ]

    for (const [extensionId, builder] of nativeBuilders) {
      const builtTools = builder(bctx)
      for (const t of builtTools) {
        toolToExtensionMap[t.name] = extensionId
      }
      tools.push(...builtTools)
    }

    const crudTools = buildCrudTools(bctx)
    for (const toolEntry of crudTools) {
      toolToExtensionMap[toolEntry.name] = toolEntry.name
    }
    tools.push(...crudTools)

    // 2. Build Extension Tools (Built-in + External)
    try {
      const extensionTools = extensionManager.getTools(activeExtensions)
      const existingNames = new Set(tools.map((t) => t.name))
      
      for (const entry of extensionTools) {
        const pt = entry.tool
        if (!ctx?.delegationEnabled && DELEGATION_TOOL_NAMES.has(pt.name)) {
          continue
        }
        if (existingNames.has(pt.name)) {
          log.warn('session-tools', 'Skipping extension tool due to duplicate name', {
            toolName: pt.name,
            extensionId: entry.extensionId,
          })
          continue
        }
        existingNames.add(pt.name)
        toolToExtensionMap[pt.name] = entry.extensionId

        tools.push(
          tool(
            async (args) => {
              if (extensionManager.isExplicitlyDisabled(entry.extensionId)) {
                throw new Error(`Extension "${entry.extensionId}" is disabled`)
              }
              try {
                const normalizedArgs = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
                const res = await pt.execute(normalizedArgs, {
                  session: { ...(ctx || {}), ...bctx } as any,
                  message: '',
                })
                extensionManager.recordExternalToolSuccess(entry.extensionId)
                return typeof res === 'string' ? res : JSON.stringify(res)
              } catch (err: unknown) {
                extensionManager.recordExternalToolFailure(entry.extensionId, pt.name, err)
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
      log.error('session-tools', 'Failed to load extension tools', { error: errorMessage(err) })
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
              toolToExtensionMap[t.name] = `mcp:${serverId}`
              tools.push(t)
            }
          }
        } catch (err: unknown) {
          log.warn('session-tools', `Failed to connect MCP server "${config.name}"`, { serverId, error: errorMessage(err) })
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
    toolToExtensionMap['request_tool_access'] = '_system'
    tools.push(
      tool(
        async (args) => {
          const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
          const toolId = normalized.toolId as string | undefined
          const reason = normalized.reason as string | undefined
          if (!toolId?.trim()) {
            return JSON.stringify({
              error: 'toolId is required',
              message: 'Specify the exact extension ID to request access for.',
            })
          }
          const normalizedToolId = toolId.trim()
          if (ctx?.sessionId) {
            patchSession(ctx.sessionId, (currentSession) => {
              if (!currentSession) return currentSession
              const selection = getEnabledCapabilitySelection(currentSession)
              const targetList = isExternalExtensionId(normalizedToolId) ? selection.extensions : selection.tools
              if (targetList.includes(normalizedToolId)) return currentSession
              if (isExternalExtensionId(normalizedToolId)) currentSession.extensions = [...selection.extensions, normalizedToolId]
              else currentSession.tools = [...selection.tools, normalizedToolId]
              currentSession.updatedAt = Date.now()
              return currentSession
            })
          } else if (ctx?.agentId) {
            patchAgent(ctx.agentId, (currentAgent) => {
              if (!currentAgent) return currentAgent
              const selection = getEnabledCapabilitySelection(currentAgent)
              const targetList = isExternalExtensionId(normalizedToolId) ? selection.extensions : selection.tools
              if (targetList.includes(normalizedToolId)) return currentAgent
              if (isExternalExtensionId(normalizedToolId)) currentAgent.extensions = [...selection.extensions, normalizedToolId]
              else currentAgent.tools = [...selection.tools, normalizedToolId]
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
          description: 'Ask the user for access to an extension I don\'t currently have.',
          schema: z.object({
            toolId: z.string().describe('The extension ID to request access for'),
            reason: z.string().describe('Brief explanation of why you need this extension'),
          }),
        },
      ),
    )

    const fileAccessPolicy = agentRecord?.fileAccessPolicy ?? null

    const buildFallbackHookSession = (): Session => ({
      id: ctx?.sessionId || 'hook-session',
      name: 'Extension Hook Session',
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
      ...splitCapabilityIds(activeExtensions),
    })

    const wrappedTools = tools.map((candidate) => {
      const schema = (candidate as unknown as { schema?: z.ZodTypeAny }).schema || z.object({}).passthrough()
      return tool(
        async (args) => {
          return withServerSpan('swarmclaw.tool.call', {
            'swarmclaw.tool.name': candidate.name,
            'swarmclaw.session.id': ctx?.sessionId || null,
            'swarmclaw.agent.id': ctx?.agentId || null,
            'swarmclaw.run.id': ctx?.runId || null,
          }, async (span) => {
            // Check abort before executing any tool — prevents wasted work after chat stop
            if (abortSignalRef.signal?.aborted) {
              setSpanAttributes(span, { 'swarmclaw.tool.aborted': true })
              throw new DOMException('Tool execution aborted', 'AbortError')
            }
            const normalizedArgs = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
            const hookSession = resolveCurrentSession() || buildFallbackHookSession()
            if (fileAccessPolicy) {
              const denial = enforceFileAccessPolicy(candidate.name, normalizedArgs, cwd, fileAccessPolicy)
              if (denial) {
                setSpanAttributes(span, { 'swarmclaw.tool.blocked': true })
                return denial
              }
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
                setSpanAttributes(span, { 'swarmclaw.tool.blocked': true })
                throw new Error(guardResult.blockReason.trim())
              }
              if (guardResult && 'input' in guardResult) {
                guardedArgs = guardResult.input === undefined ? guardedArgs : guardResult.input ?? null
              }
            }
            const hookResult = await runCapabilityBeforeToolCall(
              {
                session: hookSession,
                toolName: candidate.name,
                input: guardedArgs,
                runId: ctx?.runId || undefined,
              },
              { enabledIds: activeExtensions },
            )
            if (hookResult.warning) {
              ctx?.onToolCallWarning?.({
                toolName: candidate.name,
                message: hookResult.warning,
              })
            }
            if (hookResult.blockReason) {
              setSpanAttributes(span, { 'swarmclaw.tool.blocked': true })
              throw new Error(hookResult.blockReason)
            }
            const effectiveArgs = hookResult.input ?? guardedArgs
            const result = await candidate.invoke(effectiveArgs ?? {})
            const outputText = typeof result === 'string' ? result : JSON.stringify(result)
            setSpanAttributes(span, {
              'swarmclaw.tool.output_bytes': Buffer.byteLength(outputText, 'utf-8'),
            })
            await runCapabilityHook(
              'afterToolExec',
              { session: hookSession, toolName: candidate.name, input: effectiveArgs, output: outputText },
              { enabledIds: activeExtensions },
            )
            return outputText
          })
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
      toolToExtensionMap,
      abortSignalRef,
    }
  } catch (err: unknown) {
    log.error(TAG, 'buildSessionTools critical failure:', errorMessage(err))
    throw err
  }
}
