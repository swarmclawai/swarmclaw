import type { MessageToolEvent } from '@/types'
import { canonicalizeExtensionId } from '@/lib/server/tool-aliases'
import { extractSuggestions } from '@/lib/server/suggestions'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'
import {
  buildSuccessfulMemoryMutationResponse,
  resolveToolAction,
  shouldTerminateOnSuccessfulMemoryMutation,
} from '@/lib/server/chat-execution/memory-mutation-tools'

const EXPLICIT_WORKSPACE_TARGET_RE = /(?:^|[\s("'`])((?:\/|~\/|\.\/)[^\s,'"`]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)|[a-z0-9._/-]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh))(?=$|[\s)'",`])/i

function hasExplicitWorkspaceTarget(userMessage: string): boolean {
  return EXPLICIT_WORKSPACE_TARGET_RE.test(userMessage)
}

export function isLikelyToolErrorOutput(output: string): boolean {
  const trimmed = String(output || '').trim()
  if (!trimmed) return false
  if (/^(Error(?::|\s*\(exit\b[^)]*\):?)|error:)/i.test(trimmed)) return true
  if (/\b(MCP error|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION_REFUSED|ENOENT|EACCES|AbortError)\b/i.test(trimmed)) return true
  if (/\b(timeout|timed?\s*out|aborted|target closed|execution context was destroyed|temporarily unavailable)\b/i.test(trimmed)) return true
  if (/\binvalid_type\b/i.test(trimmed) && /\b(issue|issues|expected|required|received|zod)\b/i.test(trimmed)) return true
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const status = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : ''
    if (status === 'error' || status === 'failed') return true
    if (typeof parsed.error === 'string' && parsed.error.trim()) return true
  } catch {
    // Ignore non-JSON tool output.
  }
  return false
}

export function getExplicitRequiredToolNames(userMessage: string, enabledExtensions: string[]): string[] {
  const normalized = userMessage.toLowerCase()
  const required: string[] = []
  const hasEnabledTool = (toolId: string) => enabledExtensions.some((enabled) => (canonicalizeExtensionId(enabled) || enabled) === toolId)
  const explicitEmailDeliveryRequest = /\b(?:send|deliver|forward)\b[\s\S]{0,40}\b(?:email|message|reply|draft|note|summary|update|sequence|newsletter)\b/.test(normalized)
    || /\bsend (?:an?|the) email\b/.test(normalized)
    || /\bemail (?:it|this|them|the draft|the summary)\b/.test(normalized)

  if (hasEnabledTool('ask_human')
    && (/\bask_human\b/.test(normalized) || /ask the human/.test(normalized) || /request_input/.test(normalized))) {
    required.push('ask_human')
  }

  if (hasEnabledTool('email')
    && explicitEmailDeliveryRequest) {
    required.push('email')
  }

  if (
    hasEnabledTool('shell')
    && (
      /\bcurl request\b/.test(normalized)
      || /\b(?:run|execute|do|use|try)\b[\s\S]{0,40}\bcurl\b/.test(normalized)
      || /\brun (?:this )?command\b/.test(normalized)
      || /\buse (?:the )?(?:shell|terminal)\b/.test(normalized)
      || /\bin (?:the )?terminal\b/.test(normalized)
    )
  ) {
    required.push('shell')
  }

  if (hasExplicitWorkspaceTarget(normalized)) {
    if (hasEnabledTool('files')) required.push('files')
    else if (hasEnabledTool('edit_file')) required.push('edit_file')
    else if (hasEnabledTool('shell')) required.push('shell')
  }

  return required
}

export function shouldForceExternalServiceSummary(_params: {
  userMessage: string
  finalResponse: string
  hasToolCalls: boolean
  toolEventCount: number
  classification?: MessageClassification | null
}): boolean {
  return false
}

export type TerminalToolBoundary =
  | { kind: 'memory_write'; responseText?: string }
  | { kind: 'durable_wait' }
  | { kind: 'context_compaction' }

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function resolveSuccessfulTerminalToolBoundary(params: {
  toolName: string
  toolInput: unknown
  toolOutput: string
  allowMemoryWriteTerminal?: boolean
}): TerminalToolBoundary | null {
  if (params.allowMemoryWriteTerminal !== false && shouldTerminateOnSuccessfulMemoryMutation(params)) {
    return {
      kind: 'memory_write',
      responseText: buildSuccessfulMemoryMutationResponse({
        toolName: params.toolName,
        toolInput: params.toolInput,
      }),
    }
  }

  const canonicalToolName = canonicalizeExtensionId(params.toolName) || params.toolName
  const exactToolName = String(params.toolName || '').trim().toLowerCase()
  const action = resolveToolAction(params.toolInput)
  const parsedOutput = tryParseJsonObject(extractSuggestions(params.toolOutput || '').clean)

  if (
    canonicalToolName === 'ask_human'
    && (action === 'wait_for_reply' || action === 'wait_for_approval')
    && typeof parsedOutput?.id === 'string'
    && parsedOutput.status === 'active'
  ) {
    return { kind: 'durable_wait' }
  }

  if (
    (exactToolName === 'context_summarize' || canonicalToolName === 'context_summarize')
    && parsedOutput?.status === 'compacted'
  ) {
    return { kind: 'context_compaction' }
  }

  return null
}

export function updateStreamedToolEvents(
  events: MessageToolEvent[],
  event: { type: 'call' | 'result'; name: string; input?: string; output?: string; toolCallId?: string },
) {
  if (event.type === 'call') {
    events.push({
      name: event.name,
      input: event.input || '',
      toolCallId: event.toolCallId,
    })
    return
  }
  const index = event.toolCallId
    ? events.findLastIndex((entry) => entry.toolCallId === event.toolCallId && !entry.output)
    : events.findLastIndex((entry) => entry.name === event.name && !entry.output)
  if (index === -1) return
  events[index] = {
    ...events[index],
    output: event.output || '',
    error: isLikelyToolErrorOutput(event.output || '') || undefined,
  }
}

export function pruneIncompleteToolEvents(events: MessageToolEvent[]): MessageToolEvent[] {
  return events.filter((event) => event.output !== undefined || event.error === true)
}

export function compactThreadRecallText(text: string, maxChars = 180): string {
  const compact = extractSuggestions(text || '').clean.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact
}

// ---------------------------------------------------------------------------
// Functions relocated from stream-agent-chat.ts to avoid circular deps
// ---------------------------------------------------------------------------

const TOOL_SUMMARY_SHORT_RESPONSE_EXEMPT_TOOLS = new Set([
  'use_skill',
])

export function shouldSkipToolSummaryForShortResponse(params: {
  fullText: string
  toolEvents: MessageToolEvent[]
  isConnectorSession?: boolean
}): boolean {
  if (params.isConnectorSession) return false
  if (!params.fullText.trim()) return false
  if (!Array.isArray(params.toolEvents) || params.toolEvents.length === 0) return false
  const toolNames = Array.from(new Set(
    params.toolEvents
      .map((event) => canonicalizeExtensionId(event.name) || event.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0),
  ))
  if (toolNames.length === 0) return false
  return toolNames.every((toolName) => TOOL_SUMMARY_SHORT_RESPONSE_EXEMPT_TOOLS.has(toolName))
}

export async function resolveExclusiveMemoryWriteTerminalAllowance(params: {
  sessionId: string
  agentId?: string | null
  message: string
  classifyMemoryIntent?: (input: import('@/lib/server/chat-execution/direct-memory-intent').DirectMemoryIntentClassifierInput) => Promise<Awaited<ReturnType<typeof import('@/lib/server/chat-execution/direct-memory-intent').classifyDirectMemoryIntent>>>
}): Promise<boolean> {
  try {
    const { classifyDirectMemoryIntent } = await import('@/lib/server/chat-execution/direct-memory-intent')
    const classifier = params.classifyMemoryIntent || classifyDirectMemoryIntent
    const directMemoryIntent = await classifier({
      sessionId: params.sessionId,
      agentId: params.agentId || null,
      message: params.message,
      currentResponse: '',
      currentError: null,
      toolEvents: [],
    })
    return (directMemoryIntent?.action === 'store' || directMemoryIntent?.action === 'update')
      && directMemoryIntent.exclusiveCompletion === true
  } catch {
    return false
  }
}
