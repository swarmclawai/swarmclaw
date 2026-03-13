import type {
  Message,
  Plugin,
  PluginBeforeMessageWriteResult,
  PluginHooks,
  PluginMeta,
  PluginModelResolveResult,
  PluginPromptBuildResult,
  PluginSubagentSpawningResult,
  PluginToolCallResult,
  Session,
} from '@/types'
import { hmrSingleton } from '@/lib/shared-utils'
import { errorMessage } from '@/lib/shared-utils'
import { buildPluginHooks } from './plugins-approval-guidance'
import { expandPluginIds } from './tool-aliases'
import { log } from './logger'
import { getPluginManager, type HookExecutionOptions } from './plugins'

type NativeCapabilityRecord = {
  id: string
  plugin: Plugin
  hooks: PluginHooks
}

type HookContext<K extends keyof PluginHooks> =
  PluginHooks[K] extends ((ctx: infer C) => unknown) | undefined ? C : never

const registry = hmrSingleton<Map<string, NativeCapabilityRecord>>(
  '__swarmclaw_native_capabilities__',
  () => new Map<string, NativeCapabilityRecord>(),
)

function resolveEnabledFilter(enabledIds?: string[]): Set<string> | null {
  if (!Array.isArray(enabledIds) || enabledIds.length === 0) return null
  return new Set(expandPluginIds(enabledIds))
}

function enabledEntries(enabledIds?: string[]): NativeCapabilityRecord[] {
  const filter = resolveEnabledFilter(enabledIds)
  return Array.from(registry.values()).filter((entry) => filter === null || filter.has(entry.id))
}

function concatOptionalTextSegments(...segments: Array<string | null | undefined>): string | undefined {
  const normalized = segments
    .map((segment) => (typeof segment === 'string' ? segment.trim() : ''))
    .filter(Boolean)
  return normalized.length > 0 ? normalized.join('\n\n') : undefined
}

function mergePromptBuildResults(
  current: PluginPromptBuildResult | null,
  next: PluginPromptBuildResult | null,
): PluginPromptBuildResult | null {
  if (!current) return next
  if (!next) return current
  return {
    systemPrompt: next.systemPrompt ?? current.systemPrompt,
    prependContext: concatOptionalTextSegments(current.prependContext, next.prependContext),
    prependSystemContext: concatOptionalTextSegments(current.prependSystemContext, next.prependSystemContext),
    appendSystemContext: concatOptionalTextSegments(current.appendSystemContext, next.appendSystemContext),
  }
}

function mergeModelResolveResults(
  current: PluginModelResolveResult | null,
  next: PluginModelResolveResult | null,
): PluginModelResolveResult | null {
  if (!current) return next
  if (!next) return current
  return {
    providerOverride: next.providerOverride ?? current.providerOverride,
    modelOverride: next.modelOverride ?? current.modelOverride,
    apiEndpointOverride: next.apiEndpointOverride ?? current.apiEndpointOverride,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isToolCallControlResult(value: unknown): value is PluginToolCallResult {
  if (!isRecord(value)) return false
  return 'input' in value || 'params' in value || 'block' in value || 'blockReason' in value || 'warning' in value
}

function isMessageLike(value: unknown): value is Message {
  return isRecord(value)
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.text === 'string'
    && typeof value.time === 'number'
}

function isBeforeMessageWriteResult(value: unknown): value is PluginBeforeMessageWriteResult {
  return isRecord(value) && ('message' in value || 'block' in value)
}

function isSubagentSpawningResult(value: unknown): value is PluginSubagentSpawningResult {
  return isRecord(value) && (value.status === 'ok' || value.status === 'error')
}

function mergeToolCallInput(
  currentInput: Record<string, unknown> | null,
  nextInput: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (nextInput === undefined) return currentInput
  if (nextInput === null) return null
  if (currentInput && typeof currentInput === 'object') {
    return { ...currentInput, ...nextInput }
  }
  return nextInput
}

export function registerNativeCapability(id: string, plugin: Plugin): void {
  registry.set(id, {
    id,
    plugin,
    hooks: buildPluginHooks(id, plugin.name, plugin.hooks, plugin.tools),
  })
}

export function listNativeCapabilities(): PluginMeta[] {
  return Array.from(registry.values()).map(({ id, plugin, hooks }) => ({
    name: plugin.name,
    description: plugin.description || '',
    filename: id,
    enabled: true,
    isBuiltin: true,
    author: plugin.author || 'SwarmClaw',
    version: plugin.version || '1.0.0',
    source: 'local',
    sourceLabel: 'builtin',
    installSource: 'builtin',
    toolCount: Array.isArray(plugin.tools) ? plugin.tools.length : 0,
    hookCount: Object.values(hooks || {}).filter((fn) => typeof fn === 'function').length,
    hasUI: !!plugin.ui,
    providerCount: Array.isArray(plugin.providers) ? plugin.providers.length : 0,
    connectorCount: Array.isArray(plugin.connectors) ? plugin.connectors.length : 0,
  }))
}

export function getNativeCapabilityTools(enabledIds: string[]): Array<{ capabilityId: string; tool: NonNullable<Plugin['tools']>[number] }> {
  return enabledEntries(enabledIds).flatMap((entry) =>
    (Array.isArray(entry.plugin.tools) ? entry.plugin.tools : [])
      .filter((tool): tool is NonNullable<Plugin['tools']>[number] => !!tool && typeof tool.name === 'string' && typeof tool.execute === 'function')
      .map((tool) => ({ capabilityId: entry.id, tool })),
  )
}

export async function runNativeHook<K extends keyof PluginHooks>(
  hookName: K,
  ctx: HookContext<K>,
  options?: HookExecutionOptions,
): Promise<void> {
  for (const entry of enabledEntries(options?.enabledIds)) {
    const hook = entry.hooks[hookName]
    if (!hook) continue
    try {
      await (hook as (hookCtx: HookContext<K>) => Promise<unknown> | unknown)(ctx)
    } catch (err: unknown) {
      log.error('native-capabilities', 'Capability hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        hookName: String(hookName),
        error: errorMessage(err),
      })
    }
  }
}

async function runNativeBeforePromptBuild(
  params: {
    session: Session
    prompt: string
    message: string
    history: Message[]
    messages: Message[]
  },
  options?: HookExecutionOptions,
): Promise<PluginPromptBuildResult | null> {
  let result: PluginPromptBuildResult | null = null

  for (const entry of enabledEntries(options?.enabledIds)) {
    const hook = entry.hooks.beforePromptBuild
    if (!hook) continue
    try {
      const next = await hook(params)
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        result = mergePromptBuildResults(result, next as PluginPromptBuildResult)
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'beforePromptBuild hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }

  return result
}

async function runNativeBeforeModelResolve(
  params: {
    session: Session
    prompt: string
    message: string
    provider: Session['provider']
    model: string
    apiEndpoint?: string | null
  },
  options?: HookExecutionOptions,
): Promise<PluginModelResolveResult | null> {
  let result: PluginModelResolveResult | null = null

  for (const entry of enabledEntries(options?.enabledIds)) {
    const hook = entry.hooks.beforeModelResolve
    if (!hook) continue
    try {
      const next = await hook(params)
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        result = mergeModelResolveResults(result, next as PluginModelResolveResult)
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'beforeModelResolve hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }

  return result
}

async function runNativeBeforeToolCall(
  params: {
    session: Session
    toolName: string
    input: Record<string, unknown> | null
    runId?: string
    toolCallId?: string
  },
  options?: HookExecutionOptions,
): Promise<{ input: Record<string, unknown> | null; blockReason: string | null; warning: string | null }> {
  let currentInput = params.input
  let blockReason: string | null = null
  let warning: string | null = null

  for (const entry of enabledEntries(options?.enabledIds)) {
    const beforeToolCall = entry.hooks.beforeToolCall
    if (beforeToolCall) {
      try {
        const result = await beforeToolCall({
          session: params.session,
          toolName: params.toolName,
          input: currentInput,
          runId: params.runId,
          toolCallId: params.toolCallId,
        })
        if (isToolCallControlResult(result)) {
          if (result.block === true) {
            blockReason = typeof result.blockReason === 'string' && result.blockReason.trim()
              ? result.blockReason.trim()
              : 'Tool call blocked by native capability hook'
          }
          if (typeof result.warning === 'string' && result.warning.trim()) {
            warning = result.warning.trim()
          }
          currentInput = mergeToolCallInput(
            currentInput,
            isRecord(result.params)
              ? result.params
              : isRecord(result.input)
                ? result.input
                : result.input === null
                  ? null
                  : undefined,
          )
        } else if (result && typeof result === 'object' && !Array.isArray(result)) {
          currentInput = result as Record<string, unknown>
        }
      } catch (err: unknown) {
        log.error('native-capabilities', 'beforeToolCall hook failed', {
          capabilityId: entry.id,
          capabilityName: entry.plugin.name,
          toolName: params.toolName,
          error: errorMessage(err),
        })
      }
    }

    const beforeToolExec = entry.hooks.beforeToolExec
    if (blockReason || !beforeToolExec) continue
    try {
      const result = await beforeToolExec({ toolName: params.toolName, input: currentInput })
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        currentInput = result as Record<string, unknown>
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'beforeToolExec hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        toolName: params.toolName,
        error: errorMessage(err),
      })
    }

    if (blockReason) break
  }

  return { input: currentInput, blockReason, warning }
}

async function runNativeToolResultPersist(
  params: {
    session: Session
    message: Message
    toolName?: string
    toolCallId?: string
    isSynthetic?: boolean
  },
  options?: HookExecutionOptions,
): Promise<Message> {
  let currentMessage = params.message

  for (const entry of enabledEntries(options?.enabledIds)) {
    const hook = entry.hooks.toolResultPersist
    if (!hook) continue
    try {
      const result = await hook({
        session: params.session,
        message: currentMessage,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        isSynthetic: params.isSynthetic,
      })
      if (isMessageLike(result)) {
        currentMessage = result
      } else if (isRecord(result) && isMessageLike(result.message)) {
        currentMessage = result.message
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'toolResultPersist hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }

  return currentMessage
}

async function runNativeBeforeMessageWrite(
  params: {
    session: Session
    message: Message
    phase?: 'user' | 'system' | 'assistant_partial' | 'assistant_final' | 'heartbeat'
    runId?: string
  },
  options?: HookExecutionOptions,
): Promise<{ message: Message; block: boolean }> {
  let currentMessage = params.message
  let block = false

  for (const entry of enabledEntries(options?.enabledIds)) {
    const hook = entry.hooks.beforeMessageWrite
    if (!hook) continue
    try {
      const result = await hook({
        session: params.session,
        message: currentMessage,
        phase: params.phase,
        runId: params.runId,
      })
      if (isMessageLike(result)) {
        currentMessage = result
      } else if (isBeforeMessageWriteResult(result)) {
        if (isMessageLike(result.message)) currentMessage = result.message
        if (result.block === true) {
          block = true
          break
        }
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'beforeMessageWrite hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }

  return { message: currentMessage, block }
}

async function runNativeSubagentSpawning(
  params: {
    parentSessionId?: string | null
    agentId: string
    agentName: string
    message: string
    cwd: string
    mode: 'run' | 'session'
    threadRequested: boolean
  },
  options?: HookExecutionOptions,
): Promise<PluginSubagentSpawningResult> {
  for (const entry of enabledEntries(options?.enabledIds)) {
    const hook = entry.hooks.subagentSpawning
    if (!hook) continue
    try {
      const result = await hook(params)
      if (isSubagentSpawningResult(result) && result.status === 'error') {
        return {
          status: 'error',
          error: typeof result.error === 'string' && result.error.trim()
            ? result.error.trim()
            : 'Subagent spawn blocked by native capability hook',
        }
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'subagentSpawning hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }

  return { status: 'ok' }
}

export async function runCapabilityHook<K extends keyof PluginHooks>(
  hookName: K,
  ctx: HookContext<K>,
  options?: HookExecutionOptions,
): Promise<void> {
  await runNativeHook(hookName, ctx, options)
  await getPluginManager().runHook(hookName, ctx, options)
}

export async function runCapabilityBeforePromptBuild(
  params: {
    session: Session
    prompt: string
    message: string
    history: Message[]
    messages: Message[]
  },
  options?: HookExecutionOptions,
): Promise<PluginPromptBuildResult | null> {
  const nativeResult = await runNativeBeforePromptBuild(params, options)
  const pluginResult = await getPluginManager().runBeforePromptBuild(params, options)
  return mergePromptBuildResults(nativeResult, pluginResult)
}

export async function runCapabilityBeforeModelResolve(
  params: {
    session: Session
    prompt: string
    message: string
    provider: Session['provider']
    model: string
    apiEndpoint?: string | null
  },
  options?: HookExecutionOptions,
): Promise<PluginModelResolveResult | null> {
  const nativeResult = await runNativeBeforeModelResolve(params, options)
  const pluginResult = await getPluginManager().runBeforeModelResolve(params, options)
  return mergeModelResolveResults(nativeResult, pluginResult)
}

export async function runCapabilityBeforeToolCall(
  params: {
    session: Session
    toolName: string
    input: Record<string, unknown> | null
    runId?: string
    toolCallId?: string
  },
  options?: HookExecutionOptions,
): Promise<{ input: Record<string, unknown> | null; blockReason: string | null; warning: string | null }> {
  const nativeResult = await runNativeBeforeToolCall(params, options)
  if (nativeResult.blockReason) return nativeResult
  const pluginResult = await getPluginManager().runBeforeToolCall(
    {
      ...params,
      input: nativeResult.input,
    },
    options,
  )
  return {
    input: pluginResult.input,
    blockReason: pluginResult.blockReason,
    warning: pluginResult.warning || nativeResult.warning,
  }
}

export async function runCapabilityToolResultPersist(
  params: {
    session: Session
    message: Message
    toolName?: string
    toolCallId?: string
    isSynthetic?: boolean
  },
  options?: HookExecutionOptions,
): Promise<Message> {
  const afterNative = await runNativeToolResultPersist(params, options)
  return getPluginManager().runToolResultPersist(
    {
      ...params,
      message: afterNative,
    },
    options,
  )
}

export async function runCapabilityBeforeMessageWrite(
  params: {
    session: Session
    message: Message
    phase?: 'user' | 'system' | 'assistant_partial' | 'assistant_final' | 'heartbeat'
    runId?: string
  },
  options?: HookExecutionOptions,
): Promise<{ message: Message; block: boolean }> {
  const nativeResult = await runNativeBeforeMessageWrite(params, options)
  if (nativeResult.block) return nativeResult
  return getPluginManager().runBeforeMessageWrite(
    {
      ...params,
      message: nativeResult.message,
    },
    options,
  )
}

export async function runCapabilitySubagentSpawning(
  params: {
    parentSessionId?: string | null
    agentId: string
    agentName: string
    message: string
    cwd: string
    mode: 'run' | 'session'
    threadRequested: boolean
  },
  options?: HookExecutionOptions,
): Promise<PluginSubagentSpawningResult> {
  const nativeResult = await runNativeSubagentSpawning(params, options)
  if (nativeResult.status === 'error') return nativeResult
  return getPluginManager().runSubagentSpawning(params, options)
}

export async function transformCapabilityText(
  hookName: 'transformInboundMessage' | 'transformOutboundMessage',
  params: { session: Session; text: string },
  options?: HookExecutionOptions,
): Promise<string> {
  let text = params.text
  for (const entry of enabledEntries(options?.enabledIds)) {
    const hook = entry.hooks[hookName]
    if (!hook) continue
    try {
      const result = await (hook as (ctx: typeof params) => Promise<string> | string)({ ...params, text })
      if (typeof result === 'string') text = result
    } catch (err: unknown) {
      log.error('native-capabilities', 'transform hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        hookName,
        error: errorMessage(err),
      })
    }
  }
  return getPluginManager().transformText(hookName, { ...params, text }, options)
}

export async function collectCapabilityAgentContext(
  session: Session,
  enabledIds: string[],
  message: string,
  history: Message[],
): Promise<string[]> {
  const parts: string[] = []

  for (const entry of enabledEntries(enabledIds)) {
    const hook = entry.hooks.getAgentContext
    if (!hook) continue
    try {
      const result = await hook({ session, enabledPlugins: enabledIds, message, history })
      if (typeof result === 'string' && result.trim()) parts.push(result)
    } catch (err: unknown) {
      log.error('native-capabilities', 'getAgentContext hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }

  const pluginParts = await getPluginManager().collectAgentContext(session, enabledIds, message, history)
  return [...parts, ...pluginParts]
}

export function collectCapabilityDescriptions(enabledIds: string[]): string[] {
  const lines: string[] = []
  for (const entry of enabledEntries(enabledIds)) {
    const hook = entry.hooks.getCapabilityDescription
    if (!hook) continue
    try {
      const result = hook()
      if (typeof result === 'string' && result.trim()) lines.push(`- ${result}`)
    } catch (err: unknown) {
      log.error('native-capabilities', 'getCapabilityDescription hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }
  return [...lines, ...getPluginManager().collectCapabilityDescriptions(enabledIds)]
}

export function collectCapabilityOperatingGuidance(enabledIds: string[]): string[] {
  const lines: string[] = []
  for (const entry of enabledEntries(enabledIds)) {
    const hook = entry.hooks.getOperatingGuidance
    if (!hook) continue
    try {
      const result = hook()
      if (typeof result === 'string' && result.trim()) lines.push(result)
      else if (Array.isArray(result)) {
        for (const line of result) {
          if (typeof line === 'string' && line.trim()) lines.push(line)
        }
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'getOperatingGuidance hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }
  return [...lines, ...getPluginManager().collectOperatingGuidance(enabledIds)]
}

export function collectCapabilityApprovalGuidance(
  enabledIds: string[],
  ctx: {
    approval: import('@/types').ApprovalRequest
    phase: 'request' | 'resume' | 'connector_reminder'
    approved?: boolean
  },
): string[] {
  const lines: string[] = []
  for (const entry of enabledEntries(enabledIds)) {
    const hook = entry.hooks.getApprovalGuidance
    if (!hook) continue
    try {
      const result = hook(ctx)
      if (typeof result === 'string' && result.trim()) lines.push(result)
      else if (Array.isArray(result)) {
        for (const line of result) {
          if (typeof line === 'string' && line.trim()) lines.push(line)
        }
      }
    } catch (err: unknown) {
      log.error('native-capabilities', 'getApprovalGuidance hook failed', {
        capabilityId: entry.id,
        capabilityName: entry.plugin.name,
        error: errorMessage(err),
      })
    }
  }
  return [...lines, ...getPluginManager().collectApprovalGuidance(enabledIds, ctx)]
}
