import type { MessageToolEvent } from '@/types'
import { canonicalizePluginId } from './tool-aliases'
import { extractSuggestions } from './suggestions'
import { isDirectMemoryWriteRequest } from './memory-policy'
import {
  isBroadGoal,
  looksLikeExternalWalletTask,
  looksLikeOpenEndedDeliverableTask,
} from './stream-continuation'

export function getExplicitRequiredToolNames(userMessage: string, enabledPlugins: string[]): string[] {
  const normalized = userMessage.toLowerCase()
  const required: string[] = []

  if (enabledPlugins.includes('ask_human')
    && (/\bask_human\b/.test(normalized) || /ask the human/.test(normalized) || /request_input/.test(normalized))) {
    required.push('ask_human')
  }

  if (enabledPlugins.includes('email')
    && (/\bemail\b/.test(normalized) || /send a welcome email/.test(normalized) || /send an email/.test(normalized))) {
    required.push('email')
  }

  return required
}

export function shouldForceExternalServiceSummary(params: {
  userMessage: string
  finalResponse: string
  hasToolCalls: boolean
  toolEventCount: number
}): boolean {
  if (!looksLikeExternalWalletTask(params.userMessage)) return false
  if (!params.hasToolCalls || params.toolEventCount === 0) return false
  const trimmed = params.finalResponse.trim()
  if (!trimmed) return true
  if (/\b(blocker|blocked|cannot|can't|requires|need|missing|last reversible step|next step)\b/i.test(trimmed)) return false
  if (trimmed.length >= 240 && !/(let me|i'll|i will|checking|verify|promising|look into|explore|access their interface)/i.test(trimmed)) return false
  return /:$/.test(trimmed) || /(let me|i'll|i will|checking|verify|promising|look into|explore|access their interface)/i.test(trimmed) || trimmed.length < 240
}

export function resolveToolAction(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const action = (input as Record<string, unknown>).action
    return typeof action === 'string' ? action.trim().toLowerCase() : ''
  }
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  if (!trimmed.startsWith('{')) return ''
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    return typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : ''
  } catch {
    return ''
  }
}

export function shouldTerminateOnSuccessfulMemoryMutation(params: {
  toolName: string
  toolInput: unknown
  toolOutput: string
}): boolean {
  const canonicalToolName = canonicalizePluginId(params.toolName) || params.toolName
  if (canonicalToolName !== 'memory') return false
  const exactToolName = String(params.toolName || '').trim().toLowerCase()
  const action = exactToolName === 'memory_store'
    ? 'store'
    : exactToolName === 'memory_update'
      ? 'update'
      : resolveToolAction(params.toolInput)
  if (action !== 'store' && action !== 'update') return false
  const output = extractSuggestions(params.toolOutput || '').clean.trim()
  if (!output || /^error[:\s]/i.test(output)) return false
  if (!/^(stored|updated) memory\b/i.test(output)) return false
  return /no further memory lookup is needed unless the user asked you to verify/i.test(output)
}

export function getWalletApprovalBoundaryAction(output: string): string | null {
  if (!output.includes('plugin_wallet_')) return null
  if (/"type":"plugin_wallet_transfer_request"/.test(output)) return 'send'
  const actionMatch = output.match(/"action":"([^"]+)"/)
  const action = actionMatch?.[1] || ''
  if (!action) return null
  const readOnlyActions = new Set([
    'balance',
    'address',
    'transactions',
    'encode_contract_call',
    'simulate_transaction',
  ])
  return readOnlyActions.has(action) ? null : action
}

export function isWalletSimulationResult(toolName: string, output: string): boolean {
  return toolName === 'wallet_tool' && /"status":"simulated"/.test(output)
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
  }
}

export function compactThreadRecallText(text: string, maxChars = 180): string {
  const compact = extractSuggestions(text || '').clean.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact
}

const DIRECT_MEMORY_WRITE_CONFIRMATION_ONLY_RE = /\b(?:then|and then|after that)?\s*(?:confirm|recap|repeat|summarize|tell me|say)\b[\s\S]{0,120}\b(?:stored|saved|updated|remembered|wrote|write)\b/i
const DIRECT_MEMORY_WRITE_EXTRA_ACTION_RE = /\b(?:then|and then|after that|also)\b[\s\S]{0,160}\b(?:write|create|send|email|message|delegate|research|search|browse|open|edit|build|schedule|plan|review|analy[sz]e)\b/i

export function isNarrowDirectMemoryWriteTurn(message: string): boolean {
  const trimmed = String(message || '').trim()
  if (!trimmed || !isDirectMemoryWriteRequest(trimmed)) return false
  if (looksLikeOpenEndedDeliverableTask(trimmed)) return false
  if (DIRECT_MEMORY_WRITE_EXTRA_ACTION_RE.test(trimmed) && !DIRECT_MEMORY_WRITE_CONFIRMATION_ONLY_RE.test(trimmed)) {
    return false
  }
  return !isBroadGoal(trimmed) || DIRECT_MEMORY_WRITE_CONFIRMATION_ONLY_RE.test(trimmed) || !/[?]$/.test(trimmed)
}

const CURRENT_THREAD_RECALL_BLOCKED_TOOL_IDS = new Set([
  'memory',
  'manage_sessions',
  'web',
  'context_mgmt',
])

export function shouldAllowToolForCurrentThreadRecall(toolName: string): boolean {
  const canonicalToolName = canonicalizePluginId(toolName) || toolName.trim().toLowerCase()
  return !CURRENT_THREAD_RECALL_BLOCKED_TOOL_IDS.has(canonicalToolName)
}

const DIRECT_MEMORY_WRITE_ALLOWED_TOOL_IDS = new Set([
  'memory_store',
  'memory_update',
])

export function shouldAllowToolForDirectMemoryWrite(toolName: string): boolean {
  const rawToolName = toolName.trim().toLowerCase()
  return DIRECT_MEMORY_WRITE_ALLOWED_TOOL_IDS.has(rawToolName)
}
