import type { Message } from '@/types'
import { buildToolEventAssistantSummary } from './tool-event-summary'

interface StreamingArtifactWindow {
  minIndex?: number
  minTime?: number
}

function isStreamingAssistantMessage(
  message: Message,
  index: number,
  opts: StreamingArtifactWindow,
): boolean {
  if (message.role !== 'assistant' || message.streaming !== true) return false
  if (typeof opts.minIndex === 'number' && index < opts.minIndex) return false
  if (typeof opts.minTime === 'number') {
    if (typeof message.time !== 'number' || message.time < opts.minTime) return false
  }
  return true
}

export function shouldHidePersistedStreamingAssistantMessage(
  message: Message,
  opts: { localStreaming: boolean; hasLiveArtifacts: boolean },
): boolean {
  return (
    opts.localStreaming
    && message.role === 'assistant'
    && message.streaming === true
    && opts.hasLiveArtifacts
  )
}

export function pruneStreamingAssistantArtifacts(
  messages: Message[],
  opts: StreamingArtifactWindow = {},
): boolean {
  const kept = messages.filter((message, index) => !isStreamingAssistantMessage(message, index, opts))
  if (kept.length === messages.length) return false
  messages.splice(0, messages.length, ...kept)
  return true
}

export function upsertStreamingAssistantArtifact(
  messages: Message[],
  assistantMessage: Message,
  opts: StreamingArtifactWindow = {},
): boolean {
  if (assistantMessage.role !== 'assistant' || assistantMessage.streaming !== true) {
    throw new Error('upsertStreamingAssistantArtifact requires an assistant streaming message')
  }
  pruneStreamingAssistantArtifacts(messages, opts)
  messages.push(assistantMessage)
  return true
}

function normalizeAssistantMergeText(text: string | undefined): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function withPreservedAssistantFields(previous: Message, next: Message): Message {
  const merged: Message = {
    ...previous,
    ...next,
    time: previous.time,
  }
  if (next.kind === undefined && previous.kind !== undefined) merged.kind = previous.kind
  if (next.thinking === undefined && previous.thinking === undefined) delete merged.thinking
  if (next.thinking === undefined && previous.thinking !== undefined) merged.thinking = previous.thinking
  if (next.toolEvents === undefined && previous.toolEvents === undefined) delete merged.toolEvents
  if (next.toolEvents === undefined && previous.toolEvents !== undefined) merged.toolEvents = previous.toolEvents
  if (next.suggestions === undefined && previous.suggestions === undefined) delete merged.suggestions
  if (next.suggestions === undefined && previous.suggestions !== undefined) merged.suggestions = previous.suggestions
  return merged
}

export function materializeStreamingAssistantArtifacts(
  messages: Message[],
  opts: StreamingArtifactWindow = {},
): boolean {
  let changed = false
  let nextMessages: Message[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isStreamingAssistantMessage(message, index, opts)) {
      nextMessages.push(message)
      continue
    }

    const trimmedText = typeof message.text === 'string' ? message.text.trim() : ''
    const toolEvents = Array.isArray(message.toolEvents) ? message.toolEvents : []
    const thinking = typeof message.thinking === 'string' ? message.thinking.trim() : ''
    const fallbackText = !trimmedText && toolEvents.length > 0
      ? buildToolEventAssistantSummary(toolEvents, { interrupted: true })
      : ''
    const nextText = trimmedText || fallbackText

    if (!nextText && !thinking && toolEvents.length === 0) {
      changed = true
      continue
    }

    nextMessages = mergeCompletedAssistantMessage(nextMessages, {
      ...message,
      text: nextText,
      streaming: false,
    })
    changed = true
  }

  if (!changed) return false
  messages.splice(0, messages.length, ...nextMessages)
  return true
}

export function mergeCompletedAssistantMessage(messages: Message[], assistantMessage: Message): Message[] {
  let end = messages.length
  while (end > 0) {
    const candidate = messages[end - 1]
    if (candidate.role !== 'assistant' || candidate.streaming !== true) break
    end -= 1
  }
  const base = messages.slice(0, end)
  const last = base[base.length - 1]
  if (
    last
    && last.role === 'assistant'
    && (last.kind || 'chat') === (assistantMessage.kind || 'chat')
    && normalizeAssistantMergeText(last.text) === normalizeAssistantMergeText(assistantMessage.text)
  ) {
    return [
      ...base.slice(0, -1),
      withPreservedAssistantFields(last, assistantMessage),
    ]
  }
  return [...base, assistantMessage]
}

export function messageReconciliationKey(message: Message): string {
  return JSON.stringify([
    message.role,
    message.kind || '',
    message.text,
    message.streaming === true,
    message.replyToId || '',
    message.bookmarked === true,
    message.suggestions?.join('\u241f') || '',
    (message.toolEvents || []).map((event) => [
      event.name,
      event.input,
      event.output || '',
      event.error === true,
    ]),
  ])
}

export function messagesDiffer(nextMessages: Message[], currentMessages: Message[]): boolean {
  if (nextMessages.length !== currentMessages.length) return true
  for (let i = 0; i < nextMessages.length; i += 1) {
    if (messageReconciliationKey(nextMessages[i]) !== messageReconciliationKey(currentMessages[i])) {
      return true
    }
  }
  return false
}
