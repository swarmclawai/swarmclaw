import type { MessageToolEvent, SSEEvent } from '@/types'

export function extractEventJson(line: string): SSEEvent | null {
  if (!line.startsWith('data: ')) return null
  try {
    return JSON.parse(line.slice(6).trim()) as SSEEvent
  } catch {
    return null
  }
}

export function isLikelyToolErrorOutput(output: string): boolean {
  const trimmed = String(output || '').trim()
  if (!trimmed) return false
  if (/^(Error(?::|\s*\(exit\b[^)]*\):?)|error:)/i.test(trimmed)) return true
  if (/\b(MCP error|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION_REFUSED|ENOENT|EACCES)\b/i.test(trimmed)) return true
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

export function collectToolEvent(ev: SSEEvent, bag: MessageToolEvent[]) {
  if (ev.t === 'tool_call') {
    const previous = bag[bag.length - 1]
    if (
      previous
      && previous.name === (ev.toolName || 'unknown')
      && previous.input === (ev.toolInput || '')
      && previous.toolCallId === (ev.toolCallId || previous.toolCallId)
      && !previous.output
    ) {
      return
    }
    bag.push({
      name: ev.toolName || 'unknown',
      input: ev.toolInput || '',
      toolCallId: ev.toolCallId,
    })
    return
  }
  if (ev.t === 'tool_result') {
    const idx = ev.toolCallId
      ? bag.findLastIndex((event) => event.toolCallId === ev.toolCallId && !event.output)
      : bag.findLastIndex((event) => event.name === (ev.toolName || 'unknown') && !event.output)
    if (idx === -1) return
    const output = ev.toolOutput || ''
    bag[idx] = {
      ...bag[idx],
      output,
      error: isLikelyToolErrorOutput(output) || undefined,
    }
  }
}

export function dedupeConsecutiveToolEvents(events: MessageToolEvent[]): MessageToolEvent[] {
  const sameEvent = (left: MessageToolEvent, right: MessageToolEvent): boolean => (
    left.name === right.name
    && left.input === right.input
    && (left.output || '') === (right.output || '')
    && (left.error === true) === (right.error === true)
  )
  const sameBlock = (startA: number, startB: number, size: number): boolean => {
    for (let offset = 0; offset < size; offset += 1) {
      if (!sameEvent(events[startA + offset], events[startB + offset])) return false
    }
    return true
  }

  const deduped: MessageToolEvent[] = []
  for (let index = 0; index < events.length;) {
    const remaining = events.length - index
    let collapsed = false
    for (let blockSize = Math.floor(remaining / 2); blockSize >= 1; blockSize -= 1) {
      if (!sameBlock(index, index + blockSize, blockSize)) continue
      for (let offset = 0; offset < blockSize; offset += 1) deduped.push(events[index + offset])
      const blockStart = index
      index += blockSize
      while (index + blockSize <= events.length && sameBlock(blockStart, index, blockSize)) {
        index += blockSize
      }
      collapsed = true
      break
    }
    if (collapsed) continue
    deduped.push(events[index])
    index += 1
  }
  return deduped
}

export function deriveTerminalRunError(params: {
  errorMessage?: string
  fullResponse: string
  streamErrors: string[]
  toolEvents: MessageToolEvent[]
  internal: boolean
}): string | undefined {
  if (params.errorMessage) return params.errorMessage

  if (params.streamErrors.length > 0 && !params.fullResponse.trim()) {
    return params.streamErrors[params.streamErrors.length - 1]
  }

  if (!params.internal && !params.fullResponse.trim() && params.toolEvents.length === 0) {
    return 'Run completed without any response text, tool calls, or explicit error details. Check the provider configuration and try again.'
  }

  return undefined
}
