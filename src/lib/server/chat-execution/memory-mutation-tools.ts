import type { MessageToolEvent } from '@/types'
import { canonicalizePluginId } from '@/lib/server/tool-aliases'
import { extractSuggestions } from '@/lib/server/suggestions'

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

export function isSuccessfulMemoryMutationToolEvent(event: Pick<MessageToolEvent, 'name' | 'input' | 'output'> | null | undefined): boolean {
  if (!event || typeof event.name !== 'string') return false
  return shouldTerminateOnSuccessfulMemoryMutation({
    toolName: event.name,
    toolInput: event.input,
    toolOutput: typeof event.output === 'string' ? event.output : '',
  })
}

export function hasOnlySuccessfulMemoryMutationToolEvents(toolEvents: MessageToolEvent[] | undefined): boolean {
  const events = Array.isArray(toolEvents) ? toolEvents : []
  return events.length > 0 && events.every((event) => isSuccessfulMemoryMutationToolEvent(event))
}
