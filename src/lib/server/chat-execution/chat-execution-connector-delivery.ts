import type { MessageToolEvent } from '@/types'
import { dedupeConsecutiveToolEvents } from '@/lib/server/chat-execution/chat-execution-tool-events'

function parseToolJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function summarizeConnectorToolFailure(output: string): string {
  const trimmed = output.trim()
  const withoutPrefix = trimmed.replace(/^Error:\s*/i, '')
  const parsed = parseToolJsonObject(withoutPrefix) || parseToolJsonObject(trimmed)
  if (parsed) {
    const detail = parsed.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const detailRecord = detail as Record<string, unknown>
      const message = typeof detailRecord.message === 'string' ? detailRecord.message.trim() : ''
      if (message) return message
      const code = typeof detailRecord.code === 'string' ? detailRecord.code.trim() : ''
      const status = typeof detailRecord.status === 'string' ? detailRecord.status.trim() : ''
      if (code && status) return `${code}: ${status}`
      if (code) return code
      if (status) return status
    }
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
    if (message) return message
    const error = typeof parsed.error === 'string' ? parsed.error.trim() : ''
    if (error) return error
  }
  return withoutPrefix.replace(/\s+/g, ' ').trim() || 'Connector delivery failed.'
}

function connectorToolEventSucceeded(event: MessageToolEvent): boolean {
  if (!event.output) return false
  const parsed = parseToolJsonObject(event.output)
  const status = typeof parsed?.status === 'string' ? parsed.status.trim().toLowerCase() : ''
  return status === 'sent' || status === 'voice_sent' || status === 'scheduled'
}

const POSITIVE_CONNECTOR_DELIVERY_RE = /\b(?:i(?:'ve| have)?(?: successfully)? sent|i sent|successfully sent|sent to your|voice note (?:has been|was) sent|message (?:has been|was) sent)\b/i
const CONNECTOR_DELIVERY_CONTEXT_RE = /\b(?:connector|whatsapp|voice note|voice notes|message id|recipient|channel id)\b/i
const CONNECTOR_DELIVERY_VERB_RE = /\b(?:sent|delivered|scheduled)\b/i

export function looksLikePositiveConnectorDeliveryText(
  text: string,
  options?: { requireConnectorContext?: boolean },
): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const hasConnectorContext = CONNECTOR_DELIVERY_CONTEXT_RE.test(trimmed)
  if (options?.requireConnectorContext && !hasConnectorContext) return false
  if (POSITIVE_CONNECTOR_DELIVERY_RE.test(trimmed)) {
    return !options?.requireConnectorContext || hasConnectorContext
  }
  return CONNECTOR_DELIVERY_VERB_RE.test(trimmed) && hasConnectorContext
}

export function reconcileConnectorDeliveryText(text: string, events: MessageToolEvent[]): string {
  const trimmed = text.trim()
  const connectorEvents = dedupeConsecutiveToolEvents(events).filter((event) => event.name === 'connector_message_tool')
  if (!looksLikePositiveConnectorDeliveryText(trimmed, {
    requireConnectorContext: connectorEvents.length === 0,
  })) return text
  if (connectorEvents.some((event) => connectorToolEventSucceeded(event))) return text
  if (connectorEvents.length === 0) {
    return `I couldn't confirm that the configured connector actually sent anything. No connector delivery tool call was recorded for this response.`
  }

  const latestFailure = [...connectorEvents]
    .reverse()
    .find((event) => event.error === true && typeof event.output === 'string' && event.output.trim())

  const failureSummary = latestFailure?.output
    ? summarizeConnectorToolFailure(latestFailure.output)
    : 'I could not confirm that the connector actually sent anything.'

  return `I couldn't send that through the configured connector. ${failureSummary}`.trim()
}
