import type { InboundMessage, InboundThreadHistoryEntry } from './types'

function normalizeText(value: unknown, maxChars: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

export function resolveThreadPersonaLabel(msg: Pick<InboundMessage, 'threadPersonaLabel' | 'threadTitle' | 'threadStarterText' | 'threadId' | 'channelName' | 'platform'>): string | null {
  const explicit = normalizeText(msg.threadPersonaLabel, 120)
  if (explicit) return explicit
  const title = normalizeText(msg.threadTitle, 120)
  if (title) return title
  const starter = normalizeText(msg.threadStarterText, 72)
  if (starter) {
    return `${msg.platform} thread: ${starter}`.slice(0, 120)
  }
  const channel = normalizeText(msg.channelName, 64)
  if (msg.threadId && channel) return `${channel} thread`
  if (msg.threadId) return `${msg.platform} thread`
  return null
}

function formatHistoryEntry(entry: InboundThreadHistoryEntry): string {
  const speaker = normalizeText(entry.senderName, 60) || (entry.role === 'assistant' ? 'assistant' : 'user')
  const text = normalizeText(entry.text, 220)
  return `- [${entry.role}] ${speaker}: ${text}`
}

export function buildConnectorThreadContextBlock(
  msg: Pick<
    InboundMessage,
    'platform'
    | 'threadId'
    | 'replyToMessageId'
    | 'threadTitle'
    | 'threadStarterText'
    | 'threadStarterSenderName'
    | 'threadParentChannelName'
    | 'threadHistory'
    | 'threadPersonaLabel'
  >,
  opts?: { isFirstThreadTurn?: boolean },
): string {
  const hasThreadContext = !!(
    msg.threadId
    || msg.replyToMessageId
    || msg.threadTitle
    || msg.threadStarterText
    || (Array.isArray(msg.threadHistory) && msg.threadHistory.length > 0)
  )
  if (!hasThreadContext) return ''

  const persona = resolveThreadPersonaLabel(msg)
  const lines = ['## Native Thread Context']
  if (persona) lines.push(`Thread persona: ${persona}`)
  if (msg.threadTitle) lines.push(`Thread title: ${normalizeText(msg.threadTitle, 140)}`)
  if (msg.threadParentChannelName) lines.push(`Parent channel: ${normalizeText(msg.threadParentChannelName, 100)}`)
  if (opts?.isFirstThreadTurn) {
    lines.push('This is the first turn in a thread-bound session. Treat the starter and history below as earlier context from the same conversation.')
  }
  if (msg.threadStarterText) {
    const speaker = normalizeText(msg.threadStarterSenderName, 60) || 'unknown'
    lines.push(`Thread starter: ${speaker}: ${normalizeText(msg.threadStarterText, 260)}`)
  }
  if (Array.isArray(msg.threadHistory) && msg.threadHistory.length > 0) {
    lines.push('Recent thread history before this turn:')
    for (const entry of msg.threadHistory.slice(-6)) {
      lines.push(formatHistoryEntry(entry))
    }
  }
  lines.push('Respond as part of this ongoing thread, not as if the message started a brand new conversation.')
  return lines.join('\n')
}
