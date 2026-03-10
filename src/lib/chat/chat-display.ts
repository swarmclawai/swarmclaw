import type { Message } from '@/types'

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatConnectorTimestamp(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return formatClock(ts)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatRelativeTimestamp(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return formatClock(ts)
  if (diff < 604_800_000) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function formatMessageTimestamp(message: Pick<Message, 'time' | 'source'>): string {
  if (!message.time) return ''
  if (message.source?.connectorId) return formatConnectorTimestamp(message.time)
  return formatRelativeTimestamp(message.time)
}

function buildDisplayDedupKey(message: Message): string | null {
  const source = message.source
  if (source?.connectorId && source.messageId) {
    return [
      message.role,
      source.connectorId,
      source.messageId,
      message.historyExcluded === true ? 'history-excluded' : 'normal',
    ].join('|')
  }
  return null
}

export function dedupeMessagesForDisplay(messages: Message[]): Message[] {
  const seen = new Set<string>()
  const deduped: Message[] = []
  for (const message of messages) {
    const key = buildDisplayDedupKey(message)
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    deduped.push(message)
  }
  return deduped
}
