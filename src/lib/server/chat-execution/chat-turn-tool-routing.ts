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
import type { AppSettings, MessageToolEvent, SSEEvent } from '@/types'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { buildSessionTools } from '@/lib/server/session-tools'
import { resolveConcreteToolPolicyBlock, type ExtensionPolicyDecision } from '@/lib/server/tool-capability-policy'
import { resolveActiveProjectContext } from '@/lib/server/project-context'
import { resolveEffectiveSessionMemoryScopeMode } from '@/lib/server/memory/session-memory-scope'
import { genId } from '@/lib/id'
import { log } from '@/lib/server/logger'
import { rankDelegatesByHealth } from '@/lib/server/provider-health'
import { routeTaskIntent, type CapabilityRoutingDecision } from '@/lib/server/capability-router'
import { canonicalizeExtensionId, extensionIdMatches } from '@/lib/server/tool-aliases'
import { classifyMessage, type MessageClassification } from '@/lib/server/chat-execution/message-classifier'
import {
  buildDirectMemoryRecallResponse,
  classifyDirectMemoryIntent,
  type DirectMemoryIntent,
  type DirectMemoryIntentClassifierInput,
} from '@/lib/server/chat-execution/direct-memory-intent'
import {
  type DelegateTool,
  type SessionWithTools,
  enabledDelegationTools,
  extractConnectorMessageArgs,
  extractDelegationTask,
  findFirstUrl,
  hasToolEnabled,
  hasDirectLocalCodingTools,
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
  enabledExtensions: string[]
  toolPolicy: ExtensionPolicyDecision
  appSettings: AppSettings | Record<string, unknown>
  internal: boolean
  source: string
  toolEvents: MessageToolEvent[]
  emit: (ev: SSEEvent) => void
  classification?: MessageClassification | null
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

export interface ToolRoutingHooks {
  classifyDirectMemoryIntent?: (input: DirectMemoryIntentClassifierInput) => Promise<DirectMemoryIntent | null>
  memoryIntentTimeoutMs?: number
  invokeTool?: (
    ctx: ToolRoutingContext,
    toolName: string,
    args: Record<string, unknown>,
    failurePrefix: string,
    calledNames: Set<string>,
  ) => Promise<InvokeSessionToolResult>
}

interface InvokeSessionToolResult {
  invoked: boolean
  responseOverride: string | null
  toolOutputText?: string | null
  blockedReason?: string | null
  unavailableReason?: string | null
}

const DEFAULT_MEMORY_INTENT_TIMEOUT_MS = 8_000

async function resolveDirectMemoryIntentWithTimeout(
  ctx: ToolRoutingContext,
  classifyMemoryIntent: (input: DirectMemoryIntentClassifierInput) => Promise<DirectMemoryIntent | null>,
  hooks?: ToolRoutingHooks,
): Promise<DirectMemoryIntent | null> {
  const timeoutMs = Number.isFinite(hooks?.memoryIntentTimeoutMs)
    ? Math.max(1, Math.trunc(hooks?.memoryIntentTimeoutMs as number))
    : DEFAULT_MEMORY_INTENT_TIMEOUT_MS

  let timer: NodeJS.Timeout | null = null
  try {
    const result = await Promise.race<DirectMemoryIntent | null>([
      classifyMemoryIntent({
        sessionId: ctx.sessionId,
        agentId: ctx.session.agentId || null,
        message: ctx.message,
        currentResponse: '',
        currentError: null,
        toolEvents: [],
      }).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveTurnClassification(ctx: ToolRoutingContext): Promise<MessageClassification | null> {
  if (ctx.classification !== undefined) return ctx.classification ?? null
  if (ctx.internal || ctx.source !== 'chat') return null
  return classifyMessage({
    sessionId: ctx.sessionId,
    agentId: ctx.session.agentId || null,
    message: ctx.message,
  }).catch(() => null)
}

export async function runExclusiveDirectMemoryPreflight(
  ctx: ToolRoutingContext,
  hooks?: ToolRoutingHooks,
): Promise<ToolRoutingResult | null> {
  if (ctx.internal || ctx.source !== 'chat') return null
  if (!hasToolEnabled(ctx.session, 'memory')) return null

  const invokeTool = hooks?.invokeTool || invokeSessionTool
  const classifyMemoryIntent = hooks?.classifyDirectMemoryIntent || classifyDirectMemoryIntent
  const calledNames = new Set<string>()

  const directMemoryIntent = await resolveDirectMemoryIntentWithTimeout(ctx, classifyMemoryIntent, hooks)

  if (!directMemoryIntent || directMemoryIntent.action === 'none') return null
  if ((directMemoryIntent.action === 'store' || directMemoryIntent.action === 'update') && directMemoryIntent.exclusiveCompletion !== true) {
    return null
  }

  const toolName = directMemoryIntent.action === 'store'
    ? 'memory_store'
    : directMemoryIntent.action === 'update'
      ? 'memory_update'
      : directMemoryIntent.action === 'list'
        ? 'memory_tool'
        : 'memory_search'

  const args: Record<string, unknown> = directMemoryIntent.action === 'recall'
    ? { query: directMemoryIntent.query, scope: 'auto' }
    : directMemoryIntent.action === 'list'
      ? { action: 'list', key: '', scope: 'auto' }
      : {
          value: directMemoryIntent.value,
          ...(directMemoryIntent.title ? { title: directMemoryIntent.title } : {}),
        }

  const result = await invokeTool(
    ctx,
    toolName,
    args,
    `Forced ${toolName} invocation failed`,
    calledNames,
  )

  if (result.blockedReason) {
    return {
      calledNames,
      fullResponse: buildToolPolicyBlockResponse(toolName, result.blockedReason),
      errorMessage: undefined,
      missedRequestedTools: [],
    }
  }
  if (result.unavailableReason) {
    return {
      calledNames,
      fullResponse: buildToolUnavailableResponse(toolName, result.unavailableReason),
      errorMessage: undefined,
      missedRequestedTools: [],
    }
  }
  if (!result.invoked) return null

  if (isToolErrorText(result.toolOutputText)) {
    return {
      calledNames,
      fullResponse: String(result.toolOutputText || '').trim(),
      errorMessage: String(result.toolOutputText || '').trim() || undefined,
      missedRequestedTools: [],
    }
  }

  if (directMemoryIntent.action === 'list') {
    return {
      calledNames,
      fullResponse: String(result.toolOutputText || '').trim() || 'No memories found.',
      errorMessage: undefined,
      missedRequestedTools: [],
    }
  }

  if (directMemoryIntent.action === 'recall') {
    const recallResponse = result.toolOutputText
      ? buildDirectMemoryRecallResponse(directMemoryIntent, result.toolOutputText)
      : null
    return {
      calledNames,
      fullResponse: recallResponse || directMemoryIntent.missResponse,
      errorMessage: undefined,
      missedRequestedTools: [],
    }
  }

  return {
    calledNames,
    fullResponse: directMemoryIntent.acknowledgement,
    errorMessage: undefined,
    missedRequestedTools: [],
  }
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

function describeToolCapability(toolName: string): string {
  const normalized = toolName.trim().toLowerCase()
  if (normalized.startsWith('web') || normalized === 'http_request' || normalized === 'crawl') return 'web access'
  if (normalized === 'browser' || normalized === 'openclaw_browser') return 'browser automation'
  if (normalized === 'files' || normalized.endsWith('_file') || normalized === 'list_files') return 'workspace file access'
  if (normalized === 'shell' || normalized === 'execute_command' || normalized === 'process' || normalized === 'process_tool') return 'shell execution'
  if (normalized.startsWith('delegate')) return 'delegation'
  if (normalized === 'connector_message_tool' || normalized.includes('connector')) return 'connector messaging'
  if (normalized.startsWith('manage_') || normalized === 'manage_platform') return 'management tools'
  if (normalized.startsWith('memory') || normalized.startsWith('context_')) return 'memory tools'
  return `the ${toolName} tool`
}

function describePolicyBlockReason(blockedReason: string): string {
  const normalized = blockedReason.trim().toLowerCase()
  if (normalized.includes('safety')) return 'it is blocked by the current safety policy'
  if (normalized.includes('not enabled for this chat')) return 'that capability is not enabled in this chat'
  if (normalized.includes('disabled in app settings')) return 'that capability is disabled in app settings'
  if (normalized.includes('policy-blocked') || normalized.includes('explicit policy rule') || normalized.includes('blocked by strict policy') || normalized.includes('blocked by balanced policy')) {
    return 'that capability is blocked by the current runtime policy'
  }
  return 'it is not available in this chat'
}

export function buildToolPolicyBlockResponse(toolName: string, blockedReason: string): string {
  return `I couldn't use ${describeToolCapability(toolName)} because ${describePolicyBlockReason(blockedReason)}.`
}

function describeToolUnavailableReason(toolName: string, unavailableReason: string): string {
  const normalized = unavailableReason.trim().toLowerCase()
  if (normalized.includes('delegat')) return 'delegation is not enabled for this agent right now'
  if (normalized.includes('not available in this session')) return `${describeToolCapability(toolName)} is not available in this chat`
  return unavailableReason.trim()
}

export function buildToolUnavailableResponse(toolName: string, unavailableReason: string): string {
  return `I couldn't use ${describeToolCapability(toolName)} because ${describeToolUnavailableReason(toolName, unavailableReason)}.`
}

function defaultUnavailableReason(toolName: string): string {
  const canonical = canonicalizeExtensionId(toolName) || toolName
  if (canonical === 'delegate') return 'delegation is not enabled for this agent right now'
  return `${describeToolCapability(toolName)} is not available in this chat`
}

function isToolErrorText(outputText: string | null | undefined): boolean {
  return /^error[:\s]/i.test(String(outputText || '').trim())
}

export function resolveRequestedToolPreflightResponse(params: {
  message: string
  enabledExtensions: string[]
  toolPolicy: ExtensionPolicyDecision
  appSettings: AppSettings | Record<string, unknown>
  internal: boolean
  source: string
  session?: { agentId?: string | null } | null
}): string | null {
  if (params.internal || params.source !== 'chat') return null
  const requestedToolNames = requestedToolNamesFromMessage(params.message)
  if (requestedToolNames.length === 0) return null

  const agent = params.session?.agentId ? getAgent(params.session.agentId) : null
  const blockedResponses: string[] = []
  const unavailableResponses: string[] = []
  for (const toolName of requestedToolNames) {
    const blockedReason = resolveConcreteToolPolicyBlock(toolName, params.toolPolicy, params.appSettings)
    if (blockedReason) {
      blockedResponses.push(buildToolPolicyBlockResponse(toolName, blockedReason))
      continue
    }
    if (
      (toolName === 'delegate' || toolName.startsWith('delegate_to_'))
      && params.session?.agentId
      && agent?.delegationEnabled !== true
    ) {
      unavailableResponses.push(buildToolUnavailableResponse(toolName, 'delegation is not enabled for this agent right now'))
      continue
    }
    if (!extensionIdMatches(params.enabledExtensions, toolName)) {
      unavailableResponses.push(buildToolUnavailableResponse(toolName, defaultUnavailableReason(toolName)))
    }
  }

  if (blockedResponses.length > 0) return blockedResponses.join(' ')
  if (unavailableResponses.length > 0) return unavailableResponses.join(' ')
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
): Promise<InvokeSessionToolResult> {
  const blockedReason = resolveConcreteToolPolicyBlock(toolName, ctx.toolPolicy, ctx.appSettings)
  if (blockedReason) {
    log.info('chat-tool-routing', 'Capability policy blocked tool invocation', {
      sessionId: ctx.sessionId,
      source: ctx.source,
      toolName,
      blockedReason,
    })
    return { invoked: false, responseOverride: null, blockedReason }
  }
  if (
    (ctx.appSettings as Record<string, unknown>).safetyRequireApprovalForOutbound === true
    && toolName === 'connector_message_tool'
    && ctx.source !== 'chat'
  ) {
    ctx.emit({ t: 'err', text: 'Outbound connector messaging requires explicit user approval.' })
    return { invoked: false, responseOverride: null }
  }

  const agent = ctx.session.agentId ? getAgent(ctx.session.agentId) : null
  const agentRecord = agent as Record<string, unknown> | null
  const activeProjectContext = resolveActiveProjectContext(ctx.session as unknown as { agentId?: string | null; cwd?: string | null; projectId?: string | null })
  const { tools, cleanup } = await buildSessionTools(ctx.session.cwd, ctx.enabledExtensions, {
    agentId: ctx.session.agentId || null,
    sessionId: ctx.sessionId,
    delegationEnabled: agentRecord?.delegationEnabled === true,
    delegationTargetMode: agentRecord?.delegationTargetMode === 'selected' ? 'selected' : 'all',
    delegationTargetAgentIds: Array.isArray(agentRecord?.delegationTargetAgentIds) ? agentRecord?.delegationTargetAgentIds as string[] : undefined,
    mcpServerIds: agentRecord?.mcpServerIds as string[] | undefined,
    mcpDisabledTools: agentRecord?.mcpDisabledTools as string[] | undefined,
    projectId: activeProjectContext.projectId,
    projectRoot: activeProjectContext.projectRoot,
    projectName: activeProjectContext.project?.name || null,
    projectDescription: activeProjectContext.project?.description || null,
    memoryScopeMode: resolveEffectiveSessionMemoryScopeMode(
      ctx.session,
      (agentRecord?.memoryScopeMode as 'all' | 'auto' | 'global' | 'agent' | 'session' | 'project' | null | undefined) ?? null,
    ),
  })

  try {
    const directTool = tools.find((t) => t?.name === toolName) as StructuredToolInterface | undefined
    const availableToolNames = tools.map((candidate) => candidate?.name).filter(Boolean)
    const translated = directTool
      ? { toolName, args }
      : translateRequestedToolInvocation(toolName, args, ctx.message, availableToolNames)
    const selectedTool = directTool || tools.find((t) => t?.name === translated.toolName) as StructuredToolInterface | undefined
    if (!selectedTool?.invoke) {
      const resolvedName = translated.toolName !== toolName ? translated.toolName : null
      const unavailableReason = resolvedName === 'delegate'
        ? 'delegation is not enabled for this agent right now'
        : resolvedName
          ? `requested tool resolved to "${resolvedName}", but that tool is not available in this session`
          : `tool "${toolName}" is not available in this session`
      return { invoked: false, responseOverride: null, unavailableReason }
    }

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
      return { invoked: true, responseOverride: delegateResponse, toolOutputText: outputText }
    }
    return { invoked: true, responseOverride: null, toolOutputText: outputText }
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
  'delegate_to_copilot_cli',
  'delegate_to_cursor_cli',
  'delegate_to_qwen_code_cli',
]

export async function runPostLlmToolRouting(
  ctx: ToolRoutingContext,
  currentResponse: string,
  currentError: string | undefined,
  hooks?: ToolRoutingHooks,
): Promise<ToolRoutingResult> {
  const invokeTool = hooks?.invokeTool || invokeSessionTool
  const classifyMemoryIntent = hooks?.classifyDirectMemoryIntent || classifyDirectMemoryIntent
  const calledNames = new Set((ctx.toolEvents || []).map((t) => t.name))
  const policyBlockedTools = new Map<string, string>()
  const unavailableRequestedTools = new Map<string, string>()
  let fullResponse = currentResponse
  let errorMessage = currentError
  const classification = await resolveTurnClassification(ctx)

  const requestedToolNames = (!ctx.internal && ctx.source === 'chat')
    ? requestedToolNamesFromMessage(ctx.message)
    : []
  const routingDecision: CapabilityRoutingDecision | null = (!ctx.internal && ctx.source === 'chat')
    ? routeTaskIntent(ctx.message, ctx.enabledExtensions, ctx.appSettings, classification)
    : null

  // --- Forced connector_message_tool ---
  if (requestedToolNames.includes('connector_message_tool') && !calledNames.has('connector_message_tool')) {
    const forcedArgs = extractConnectorMessageArgs(ctx.message)
    if (forcedArgs) {
      const result = await invokeTool(
        ctx, 'connector_message_tool',
        forcedArgs as unknown as Record<string, unknown>,
        'Forced connector_message_tool invocation failed',
        calledNames,
      )
      if (result.blockedReason) policyBlockedTools.set('connector_message_tool', result.blockedReason)
      if (result.unavailableReason) unavailableRequestedTools.set('connector_message_tool', result.unavailableReason)
      if (result.responseOverride) fullResponse = result.responseOverride
    }
  }

  // --- Forced delegation tools ---
  for (const toolName of FORCED_DELEGATION_TOOLS) {
    if (!requestedToolNames.includes(toolName)) continue
    if (calledNames.has(toolName)) continue
    const task = extractDelegationTask(ctx.message, toolName) || ctx.effectiveMessage.trim()
    if (!task) continue
    const result = await invokeTool(ctx, toolName, { task }, `Forced ${toolName} invocation failed`, calledNames)
    if (result.blockedReason) policyBlockedTools.set(toolName, result.blockedReason)
    if (result.unavailableReason) unavailableRequestedTools.set(toolName, result.unavailableReason)
    if (result.responseOverride) fullResponse = result.responseOverride
  }

  const hasMemoryWriteCall = calledNames.has('memory_store') || calledNames.has('memory_update') || calledNames.has('memory_tool')
  const hasMemoryRecallCall = calledNames.has('memory_search') || calledNames.has('memory_get') || calledNames.has('memory_tool')
  const shouldClassifyMemoryIntent = !ctx.internal
    && ctx.source === 'chat'
    && hasToolEnabled(ctx.session, 'memory')
    && !hasMemoryWriteCall
    && !hasMemoryRecallCall
  const directMemoryIntent = shouldClassifyMemoryIntent
    ? await (async () => {
      const timeoutMs = Number.isFinite(hooks?.memoryIntentTimeoutMs)
        ? Math.max(1, Math.trunc(hooks?.memoryIntentTimeoutMs as number))
        : DEFAULT_MEMORY_INTENT_TIMEOUT_MS
      let timer: NodeJS.Timeout | null = null
      try {
        return await Promise.race<DirectMemoryIntent | null>([
          classifyMemoryIntent({
            sessionId: ctx.sessionId,
            agentId: ctx.session.agentId || null,
            message: ctx.message,
            currentResponse: fullResponse,
            currentError: errorMessage,
            toolEvents: ctx.toolEvents,
          }).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
    : null

  if (directMemoryIntent?.action === 'store' || directMemoryIntent?.action === 'update') {
    const toolName = directMemoryIntent.action === 'store' ? 'memory_store' : 'memory_update'
    const args: Record<string, unknown> = { value: directMemoryIntent.value }
    if (directMemoryIntent.title) args.title = directMemoryIntent.title
    const result = await invokeTool(
      ctx,
      toolName,
      args,
      `Forced ${toolName} invocation failed`,
      calledNames,
    )
    if (result.blockedReason) policyBlockedTools.set(toolName, result.blockedReason)
    if (result.unavailableReason) unavailableRequestedTools.set(toolName, result.unavailableReason)
    if (result.invoked) {
      if (isToolErrorText(result.toolOutputText)) {
        fullResponse = String(result.toolOutputText || '').trim()
      } else {
        fullResponse = directMemoryIntent.acknowledgement
        errorMessage = undefined
      }
    }
  }

  if (directMemoryIntent?.action === 'recall') {
    const result = await invokeTool(
      ctx,
      'memory_search',
      { query: directMemoryIntent.query, scope: 'auto' },
      'Forced memory_search invocation failed',
      calledNames,
    )
    if (result.blockedReason) policyBlockedTools.set('memory_search', result.blockedReason)
    if (result.unavailableReason) unavailableRequestedTools.set('memory_search', result.unavailableReason)
    if (result.invoked && result.toolOutputText) {
      if (isToolErrorText(result.toolOutputText)) {
        fullResponse = String(result.toolOutputText || '').trim()
      } else {
        const recallResponse = buildDirectMemoryRecallResponse(directMemoryIntent, result.toolOutputText)
        if (recallResponse) {
          fullResponse = recallResponse
          errorMessage = undefined
        }
      }
    }
  }

  if (directMemoryIntent?.action === 'list') {
    const result = await invokeTool(
      ctx,
      'memory_tool',
      { action: 'list', key: '', scope: 'auto' },
      'Forced memory list invocation failed',
      calledNames,
    )
    if (result.blockedReason) policyBlockedTools.set('memory_tool', result.blockedReason)
    if (result.unavailableReason) unavailableRequestedTools.set('memory_tool', result.unavailableReason)
    if (result.invoked) {
      fullResponse = String(result.toolOutputText || '').trim() || 'No memories found.'
      errorMessage = undefined
    }
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
      const result = await invokeTool(ctx, delegateTool, { task: ctx.effectiveMessage.trim() }, 'Auto-delegation failed', calledNames)
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
      const result = await invokeTool(
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
    const result = await invokeTool(
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
      const result = await invokeTool(ctx, 'web_fetch', { url: routeUrl }, 'Auto web_fetch routing failed', calledNames)
      if (result.responseOverride) fullResponse = result.responseOverride
    } else if (hasToolEnabled(ctx.session, 'web_search')) {
      const result = await invokeTool(ctx, 'web_search', { query: ctx.effectiveMessage.trim(), maxResults: 5 }, 'Auto web_search routing failed', calledNames)
      if (result.responseOverride) fullResponse = result.responseOverride
    }
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
      const result = await invokeTool(
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
  const blockedRequestedTools = requestedToolNames.filter((name) => policyBlockedTools.has(name))
  const missed = requestedToolNames.filter((name) => !calledNames.has(name) && !policyBlockedTools.has(name) && !unavailableRequestedTools.has(name))

  if (blockedRequestedTools.length > 0) {
    fullResponse = blockedRequestedTools
      .map((name) => buildToolPolicyBlockResponse(name, policyBlockedTools.get(name) || 'blocked by policy'))
      .join(' ')
    errorMessage = undefined
  }

  const unavailableRequested = requestedToolNames.filter((name) => unavailableRequestedTools.has(name))
  if (unavailableRequested.length > 0) {
    fullResponse = unavailableRequested
      .map((name) => buildToolUnavailableResponse(name, unavailableRequestedTools.get(name) || 'that capability is unavailable'))
      .join(' ')
    errorMessage = undefined
  }

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
