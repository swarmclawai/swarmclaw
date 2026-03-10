/**
 * Chat Turn — Post-LLM Tool Routing
 *
 * After the LLM produces a response, this module handles forced tool
 * invocations (explicitly requested by the user), auto-delegation
 * (routing coding tasks to CLI backends), and auto-routing (browsing,
 * research, memory intents).
 *
 * Extracted from chat-execution.ts for testability and readability.
 */

import path from 'node:path'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { MessageToolEvent, SSEEvent } from '@/types'
import { loadAgents } from '@/lib/server/storage'
import { buildSessionTools } from '@/lib/server/session-tools'
import { resolveConcreteToolPolicyBlock, type PluginPolicyDecision } from '@/lib/server/tool-capability-policy'
import { resolveActiveProjectContext } from '@/lib/server/project-context'
import { genId } from '@/lib/id'
import { rankDelegatesByHealth } from '@/lib/server/provider-health'
import { routeTaskIntent, type CapabilityRoutingDecision } from '@/lib/server/capability-router'
import {
  type DelegateTool,
  type SessionWithTools,
  enabledDelegationTools,
  extractConnectorMessageArgs,
  extractDelegationTask,
  findFirstUrl,
  hasToolEnabled,
  hasDirectLocalCodingTools,
  isMemoryListIntent,
  requestedToolNamesFromMessage,
  translateRequestedToolInvocation,
} from '@/lib/server/chat-execution/chat-execution-utils'
import { errorMessage } from '@/lib/shared-utils'

interface ToolRoutingSession extends SessionWithTools {
  agentId?: string | null
  cwd: string
  memoryScopeMode?: string | null
}

export interface ToolRoutingContext {
  session: ToolRoutingSession
  sessionId: string
  message: string
  effectiveMessage: string
  enabledPlugins: string[]
  toolPolicy: PluginPolicyDecision
  appSettings: Record<string, unknown>
  internal: boolean
  source: string
  toolEvents: MessageToolEvent[]
  emit: (ev: SSEEvent) => void
}

export interface ToolRoutingResult {
  /** Tool names that were actually invoked */
  calledNames: Set<string>
  /** Updated full response (may be modified by delegate output) */
  fullResponse: string
  /** Updated error message (may be cleared on failover success) */
  errorMessage: string | undefined
  /** Missed requested tools (for warning) */
  missedRequestedTools: string[]
}

function extractDelegateResponse(outputText: string): string | null {
  try {
    const parsed = JSON.parse(outputText) as Record<string, unknown>
    if (typeof parsed.response === 'string' && parsed.response.trim()) return parsed.response.trim()
    if (typeof parsed.result === 'string' && parsed.result.trim()) return parsed.result.trim()
    return null
  } catch {
    return null
  }
}

const EXPLICIT_ARTIFACT_TARGET_RE = /\b(?:save|write|output|export)\b[^.!?\n]{0,80}\b(?:to|as|at|in)\b[^.!?\n]{0,60}(\/[^\s,'"]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)|~\/[^\s,'"]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)|\.\/[^\s,'"]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)|[a-z0-9._/-]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)\b)/i

function extractExplicitArtifactTarget(message: string): string | null {
  const match = message.match(EXPLICIT_ARTIFACT_TARGET_RE)
  if (!match) return null
  return String(match[1] || '').trim() || null
}

function extractFencedCodeBlock(text: string, languages: string[]): string | null {
  const fenceRe = /```([a-z0-9_-]+)?\n([\s\S]*?)```/gi
  let fallback: string | null = null
  for (const match of text.matchAll(fenceRe)) {
    const language = String(match[1] || '').trim().toLowerCase()
    const content = String(match[2] || '').trim()
    if (!content) continue
    if (!fallback) fallback = content
    if (!languages.length || languages.includes(language)) return content
  }
  return fallback
}

function extractAutosaveContent(targetPath: string, response: string): string | null {
  const ext = path.extname(targetPath).toLowerCase()
  const trimmed = response.trim()
  if (!trimmed) return null

  if (ext === '.html' || ext === '.htm') {
    const htmlFence = extractFencedCodeBlock(trimmed, ['html'])
    if (htmlFence && /<html[\s>]/i.test(htmlFence)) return htmlFence
    const htmlMatch = trimmed.match(/<!doctype html[\s\S]*<\/html>|<html[\s\S]*<\/html>/i)
    if (htmlMatch) return htmlMatch[0].trim()
    return null
  }

  if (['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sh', '.sql'].includes(ext)) {
    const languageMap: Record<string, string[]> = {
      '.py': ['python', 'py'],
      '.ts': ['typescript', 'ts'],
      '.tsx': ['tsx', 'typescript'],
      '.js': ['javascript', 'js'],
      '.jsx': ['jsx', 'javascript'],
      '.mjs': ['javascript', 'js'],
      '.cjs': ['javascript', 'js'],
      '.sh': ['bash', 'sh', 'shell'],
      '.sql': ['sql'],
    }
    return extractFencedCodeBlock(trimmed, languageMap[ext] || [])
  }

  if (ext === '.json') {
    const jsonFence = extractFencedCodeBlock(trimmed, ['json'])
    if (jsonFence) return jsonFence
    if (/^[\[{][\s\S]*[\]}]$/.test(trimmed)) return trimmed
    return null
  }

  if (ext === '.md' || ext === '.txt') {
    const genericFence = extractFencedCodeBlock(trimmed, ext === '.md' ? ['markdown', 'md'] : [])
    if (genericFence) return genericFence
    if (trimmed.length >= 400) return trimmed
  }

  return null
}

// ---------------------------------------------------------------------------
// Core: Invoke a single session tool
// ---------------------------------------------------------------------------

async function invokeSessionTool(
  ctx: ToolRoutingContext,
  toolName: string,
  args: Record<string, unknown>,
  failurePrefix: string,
  calledNames: Set<string>,
): Promise<{ invoked: boolean; responseOverride: string | null }> {
  const blockedReason = resolveConcreteToolPolicyBlock(toolName, ctx.toolPolicy, ctx.appSettings)
  if (blockedReason) {
    ctx.emit({ t: 'err', text: `Capability policy blocked tool invocation "${toolName}": ${blockedReason}` })
    return { invoked: false, responseOverride: null }
  }
  if (
    (ctx.appSettings as Record<string, unknown>).safetyRequireApprovalForOutbound === true
    && toolName === 'connector_message_tool'
    && ctx.source !== 'chat'
  ) {
    ctx.emit({ t: 'err', text: 'Outbound connector messaging requires explicit user approval.' })
    return { invoked: false, responseOverride: null }
  }

  const agent = ctx.session.agentId ? loadAgents()[ctx.session.agentId] : null
  const agentRecord = agent as Record<string, unknown> | null
  const activeProjectContext = resolveActiveProjectContext(ctx.session as unknown as { agentId?: string | null; cwd?: string | null; projectId?: string | null })
  const { tools, cleanup } = await buildSessionTools(ctx.session.cwd, ctx.enabledPlugins, {
    agentId: ctx.session.agentId || null,
    sessionId: ctx.sessionId,
    platformAssignScope: (agentRecord?.platformAssignScope as 'self' | 'all') || 'self',
    mcpServerIds: agentRecord?.mcpServerIds as string[] | undefined,
    mcpDisabledTools: agentRecord?.mcpDisabledTools as string[] | undefined,
    projectId: activeProjectContext.projectId,
    projectRoot: activeProjectContext.projectRoot,
    projectName: activeProjectContext.project?.name || null,
    projectDescription: activeProjectContext.project?.description || null,
    memoryScopeMode: (ctx.session.memoryScopeMode ?? agentRecord?.memoryScopeMode as string | null ?? null) as 'all' | 'auto' | 'global' | 'agent' | 'session' | 'project' | null,
  })

  try {
    const directTool = tools.find((t) => t?.name === toolName) as StructuredToolInterface | undefined
    const availableToolNames = tools.map((candidate) => candidate?.name).filter(Boolean)
    const translated = directTool
      ? { toolName, args }
      : translateRequestedToolInvocation(toolName, args, ctx.message, availableToolNames)
    const selectedTool = directTool || tools.find((t) => t?.name === translated.toolName) as StructuredToolInterface | undefined
    if (!selectedTool?.invoke) return { invoked: false, responseOverride: null }

    const toolCallId = genId()
    ctx.emit({ t: 'tool_call', toolName, toolInput: JSON.stringify(translated.args), toolCallId })
    const toolOutput = await selectedTool.invoke(translated.args)
    const outputText = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
    ctx.emit({ t: 'tool_result', toolName, toolOutput: outputText, toolCallId })

    const delegateResponse = (
      toolName === 'delegate'
      || toolName.startsWith('delegate_to_')
    ) ? extractDelegateResponse(outputText) : null

    calledNames.add(toolName)

    if (delegateResponse) {
      return { invoked: true, responseOverride: delegateResponse }
    }
    return { invoked: true, responseOverride: null }
  } catch (forceErr: unknown) {
    ctx.emit({ t: 'err', text: `${failurePrefix}: ${errorMessage(forceErr)}` })
    return { invoked: false, responseOverride: null }
  } finally {
    await cleanup()
  }
}

// ---------------------------------------------------------------------------
// Main: Run all post-LLM tool routing
// ---------------------------------------------------------------------------

const FORCED_DELEGATION_TOOLS: DelegateTool[] = [
  'delegate_to_claude_code',
  'delegate_to_codex_cli',
  'delegate_to_opencode_cli',
  'delegate_to_gemini_cli',
]

export async function runPostLlmToolRouting(
  ctx: ToolRoutingContext,
  currentResponse: string,
  currentError: string | undefined,
): Promise<ToolRoutingResult> {
  const calledNames = new Set((ctx.toolEvents || []).map((t) => t.name))
  let fullResponse = currentResponse
  let errorMessage = currentError

  const requestedToolNames = (!ctx.internal && ctx.source === 'chat')
    ? requestedToolNamesFromMessage(ctx.message)
    : []
  const routingDecision: CapabilityRoutingDecision | null = (!ctx.internal && ctx.source === 'chat')
    ? routeTaskIntent(ctx.message, ctx.enabledPlugins, ctx.appSettings)
    : null

  // --- Forced connector_message_tool ---
  if (requestedToolNames.includes('connector_message_tool') && !calledNames.has('connector_message_tool')) {
    const forcedArgs = extractConnectorMessageArgs(ctx.message)
    if (forcedArgs) {
      const result = await invokeSessionTool(
        ctx, 'connector_message_tool',
        forcedArgs as unknown as Record<string, unknown>,
        'Forced connector_message_tool invocation failed',
        calledNames,
      )
      if (result.responseOverride) fullResponse = result.responseOverride
    }
  }

  // --- Forced delegation tools ---
  for (const toolName of FORCED_DELEGATION_TOOLS) {
    if (!requestedToolNames.includes(toolName)) continue
    if (calledNames.has(toolName)) continue
    const task = extractDelegationTask(ctx.message, toolName)
    if (!task) continue
    const result = await invokeSessionTool(ctx, toolName, { task }, `Forced ${toolName} invocation failed`, calledNames)
    if (result.responseOverride) fullResponse = result.responseOverride
  }

  // --- Auto-delegation for coding intent ---
  const hasDelegationCall = FORCED_DELEGATION_TOOLS.some((t) => calledNames.has(t))
  const enabledDelegates = enabledDelegationTools(ctx.session)
  const shouldAutoDelegateCoding = (!ctx.internal && ctx.source === 'chat')
    && enabledDelegates.length > 0
    && !hasDelegationCall
    && calledNames.size === 0
    && !requestedToolNames.length
    && !hasDirectLocalCodingTools(ctx.session)
    && routingDecision?.intent === 'coding'

  if (shouldAutoDelegateCoding) {
    const baseDelegationOrder = routingDecision?.preferredDelegates?.length
      ? routingDecision.preferredDelegates
      : FORCED_DELEGATION_TOOLS
    const delegationOrder = rankDelegatesByHealth(baseDelegationOrder as DelegateTool[])
      .filter((tool) => enabledDelegates.includes(tool))
    for (const delegateTool of delegationOrder) {
      const result = await invokeSessionTool(ctx, delegateTool, { task: ctx.effectiveMessage.trim() }, 'Auto-delegation failed', calledNames)
      if (result.invoked) {
        if (result.responseOverride) fullResponse = result.responseOverride
        break
      }
    }
  }

  // --- Provider failover via delegation ---
  const shouldFailoverDelegate = (!ctx.internal && ctx.source === 'chat')
    && !!errorMessage
    && !(fullResponse || '').trim()
    && enabledDelegates.length > 0
    && !hasDelegationCall
    && (routingDecision?.intent === 'coding' || routingDecision?.intent === 'general')
  if (shouldFailoverDelegate) {
    const preferred = routingDecision?.preferredDelegates?.length
      ? routingDecision.preferredDelegates
      : FORCED_DELEGATION_TOOLS
    const fallbackOrder = rankDelegatesByHealth(preferred as DelegateTool[])
      .filter((tool) => enabledDelegates.includes(tool))
    for (const delegateTool of fallbackOrder) {
      const result = await invokeSessionTool(
        ctx, delegateTool,
        { task: ctx.effectiveMessage.trim() },
        `Provider failover via ${delegateTool} failed`,
        calledNames,
      )
      if (result.invoked) {
        if (result.responseOverride) fullResponse = result.responseOverride
        errorMessage = undefined
        break
      }
    }
  }

  // --- Auto-routing: browsing, research, memory ---
  const canAutoRoute = (!ctx.internal && ctx.source === 'chat')
    && !!routingDecision
    && calledNames.size === 0
    && requestedToolNames.length === 0

  if (canAutoRoute && routingDecision?.intent === 'browsing' && routingDecision.primaryUrl && hasToolEnabled(ctx.session, 'browser')) {
    const result = await invokeSessionTool(
      ctx, 'browser',
      { action: 'read_page', url: routingDecision.primaryUrl },
      'Auto browser routing failed',
      calledNames,
    )
    if (result.responseOverride) fullResponse = result.responseOverride
  }

  if (canAutoRoute && routingDecision?.intent === 'research') {
    const routeUrl = routingDecision.primaryUrl || findFirstUrl(ctx.message)
    if (routeUrl && hasToolEnabled(ctx.session, 'web_fetch')) {
      const result = await invokeSessionTool(ctx, 'web_fetch', { url: routeUrl }, 'Auto web_fetch routing failed', calledNames)
      if (result.responseOverride) fullResponse = result.responseOverride
    } else if (hasToolEnabled(ctx.session, 'web_search')) {
      const result = await invokeSessionTool(ctx, 'web_search', { query: ctx.effectiveMessage.trim(), maxResults: 5 }, 'Auto web_search routing failed', calledNames)
      if (result.responseOverride) fullResponse = result.responseOverride
    }
  }

  if (canAutoRoute && calledNames.size === 0 && hasToolEnabled(ctx.session, 'memory') && isMemoryListIntent(ctx.message)) {
    const result = await invokeSessionTool(
      ctx, 'memory_tool',
      { action: 'list', key: '', scope: 'auto' },
      'Auto memory listing failed',
      calledNames,
    )
    if (result.responseOverride) fullResponse = result.responseOverride
  }

  const explicitArtifactTarget = extractExplicitArtifactTarget(ctx.message)
  const canAutoSaveArtifact = (!ctx.internal && ctx.source === 'chat')
    && !!explicitArtifactTarget
    && !calledNames.has('files')
    && !calledNames.has('write_file')
    && !calledNames.has('edit_file')
    && hasToolEnabled(ctx.session, 'files')
  if (canAutoSaveArtifact) {
    const artifactContent = extractAutosaveContent(explicitArtifactTarget, fullResponse)
    if (artifactContent) {
      const result = await invokeSessionTool(
        ctx,
        'files',
        {
          action: 'write',
          files: [{ path: explicitArtifactTarget, content: artifactContent }],
        },
        'Auto artifact save failed',
        calledNames,
      )
      if (result.invoked && !fullResponse.includes(explicitArtifactTarget)) {
        const trimmed = fullResponse.trim()
        fullResponse = trimmed
          ? `${trimmed}\n\nSaved \`${explicitArtifactTarget}\` to the workspace.`
          : `Saved \`${explicitArtifactTarget}\` to the workspace.`
      }
    }
  }

  // --- Missed requested tools ---
  const missed = requestedToolNames.filter((name) => !calledNames.has(name))

  // When tool output is the only content and LLM produced nothing, provide a brief notice
  if (calledNames.size > 0 && !fullResponse.trim()) {
    const toolLabel = Array.from(calledNames).pop()?.replace(/_/g, ' ') || 'tool'
    fullResponse = `Used **${toolLabel}** — see tool output above for details.`
  }

  return {
    calledNames,
    fullResponse,
    errorMessage,
    missedRequestedTools: missed,
  }
}
