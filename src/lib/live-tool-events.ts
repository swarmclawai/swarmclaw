import type { SSEEvent } from '@/types'

export interface StreamingToolEvent {
  id: string
  name: string
  input: string
  output?: string
  status: 'running' | 'done' | 'error'
  toolCallId?: string
}

export function isLikelyToolErrorOutput(output: string): boolean {
  const trimmed = output.trim()
  return /^(Error:|error:|ECONNREFUSED|ETIMEDOUT|timeout|failed)/i.test(trimmed)
    || output.includes('ECONNREFUSED')
    || output.includes('ETIMEDOUT')
    || output.includes('Error:')
}

export function applyStreamingToolCall(
  events: StreamingToolEvent[],
  ev: Pick<SSEEvent, 'toolName' | 'toolInput' | 'toolCallId'>,
  fallbackId: string,
): StreamingToolEvent[] {
  const previous = events[events.length - 1]
  const name = ev.toolName || 'unknown'
  const input = ev.toolInput || ''

  if (
    previous
    && previous.name === name
    && previous.input === input
    && previous.status === 'running'
    && previous.toolCallId === (ev.toolCallId || previous.toolCallId)
  ) {
    return events
  }

  return [...events, {
    id: ev.toolCallId || fallbackId,
    name,
    input,
    status: 'running',
    toolCallId: ev.toolCallId,
  }]
}

export function applyStreamingToolResult(
  events: StreamingToolEvent[],
  ev: Pick<SSEEvent, 'toolName' | 'toolOutput' | 'toolCallId'>,
): StreamingToolEvent[] {
  const index = ev.toolCallId
    ? events.findLastIndex((entry) => entry.toolCallId === ev.toolCallId && entry.status === 'running')
    : events.findLastIndex((entry) => entry.name === (ev.toolName || 'unknown') && entry.status === 'running')

  if (index === -1) return events

  const output = ev.toolOutput || ''
  const nextStatus = isLikelyToolErrorOutput(output) ? 'error' : 'done'
  const current = events[index]

  if (current.output === output && current.status === nextStatus) {
    return events
  }

  const next = [...events]
  next[index] = {
    ...current,
    output,
    status: nextStatus,
  }
  return next
}
