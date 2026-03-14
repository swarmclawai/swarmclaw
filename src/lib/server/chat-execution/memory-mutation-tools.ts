import type { MessageToolEvent } from '@/types'
import { canonicalizePluginId } from '@/lib/server/tool-aliases'
import { extractSuggestions } from '@/lib/server/suggestions'
import { renderMemoryContent } from '@/lib/server/chat-execution/direct-memory-intent'

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

function parseStructuredMemoryRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function normalizeMemoryMutationInput(raw: unknown): Record<string, unknown> {
  const base = parseStructuredMemoryRecord(raw) || {}
  const normalized = { ...base }
  for (const key of ['value', 'query', 'key', 'input', 'data', 'payload', 'parameters'] as const) {
    const nested = parseStructuredMemoryRecord(normalized[key])
    if (!nested) continue
    for (const [nestedKey, nestedValue] of Object.entries(nested)) {
      if (normalized[nestedKey] === undefined || normalized[nestedKey] === null || normalized[nestedKey] === '') {
        normalized[nestedKey] = nestedValue
      }
    }
    if ((normalized.value === undefined || normalized.value === null || normalized.value === '')
      && typeof nested.content === 'string') {
      normalized.value = nested.content
    }
    if ((normalized.title === undefined || normalized.title === null || normalized.title === '')
      && typeof nested.name === 'string') {
      normalized.title = nested.name
    }
  }
  if (normalized.value === undefined || normalized.value === null || normalized.value === '') {
    for (const alias of ['content', 'note', 'body', 'text', 'memory'] as const) {
      if (typeof normalized[alias] === 'string' && normalized[alias].trim()) {
        normalized.value = normalized[alias]
        break
      }
    }
  }
  return normalized
}

function normalizeComparableText(value: string): string {
  let trimmed = String(value || '').trim().toLowerCase()
  while (trimmed.endsWith('.') || trimmed.endsWith('!') || trimmed.endsWith('?')) {
    trimmed = trimmed.slice(0, -1).trimEnd()
  }
  return trimmed
}

export function buildSuccessfulMemoryMutationResponse(params: {
  toolName: string
  toolInput: unknown
}): string {
  const exactToolName = String(params.toolName || '').trim().toLowerCase()
  const action = exactToolName === 'memory_update'
    ? 'update'
    : exactToolName === 'memory_store'
      ? 'store'
      : resolveToolAction(params.toolInput)

  const normalizedInput = normalizeMemoryMutationInput(params.toolInput)
  const rawValue = typeof normalizedInput.value === 'string' ? normalizedInput.value.trim() : ''
  if (rawValue) {
    const renderedValue = renderMemoryContent(rawValue)
    if (normalizeComparableText(renderedValue) !== normalizeComparableText(rawValue)) {
      return renderedValue
    }
  }

  return action === 'update'
    ? 'I\'ll use that updated detail going forward.'
    : 'I\'ll remember that.'
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
