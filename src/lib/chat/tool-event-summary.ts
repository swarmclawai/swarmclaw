import type { MessageToolEvent } from '@/types'
import { dedup } from '@/lib/shared-utils'

interface ToolEventAssistantSummaryOptions {
  interrupted?: boolean
}

export function buildToolEventAssistantSummary(
  toolEvents: MessageToolEvent[] | undefined,
  options: ToolEventAssistantSummaryOptions = {},
): string {
  const events = Array.isArray(toolEvents)
    ? toolEvents.filter((event) => typeof event?.name === 'string' && event.name.trim().length > 0)
    : []
  if (events.length === 0) return ''

  const uniqueNames = dedup(events.map((event) => event.name.trim()))
  const visibleNames = uniqueNames.slice(0, 4).map((name) => `\`${name}\``).join(', ')
  const hiddenCount = Math.max(0, uniqueNames.length - 4)
  const pendingCount = events.filter((event) => !event.output).length
  const errorCount = events.filter((event) => event.error === true).length
  const toolWord = events.length === 1 ? 'tool call' : 'tool calls'
  const interrupted = options.interrupted === true

  const namesLabel = hiddenCount > 0
    ? `${visibleNames}, +${hiddenCount} more`
    : visibleNames

  if (interrupted || pendingCount > 0) {
    return `Started ${events.length} ${toolWord} (${namesLabel}). Progress was interrupted before completion.`
  }

  if (errorCount > 0) {
    return `Used ${events.length} ${toolWord} (${namesLabel}). ${errorCount} ${errorCount === 1 ? 'call reported an error' : 'calls reported errors'}. See tool output above for details.`
  }

  return `Used ${events.length} ${toolWord} (${namesLabel}). See tool output above for details.`
}
