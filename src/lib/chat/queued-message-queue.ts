import type { SessionQueueSnapshot, SessionQueuedTurn } from '@/types'

export interface QueuedSessionMessage extends SessionQueuedTurn {
  optimistic?: boolean
  /** Set when the server has consumed the message but the chat hasn't shown it yet */
  sending?: boolean
}

export interface QueueMessageDraft {
  text: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  replyToId?: string
}

export function nextQueuedMessageId(now = Date.now(), random = Math.random): string {
  return `queued-${now}-${random().toString(36).slice(2, 8)}`
}

export function createOptimisticQueuedMessage(
  sessionId: string,
  draft: QueueMessageDraft,
  position: number,
): QueuedSessionMessage {
  return {
    runId: nextQueuedMessageId(),
    sessionId,
    text: draft.text,
    queuedAt: Date.now(),
    position,
    imagePath: draft.imagePath,
    imageUrl: draft.imageUrl,
    attachedFiles: draft.attachedFiles,
    replyToId: draft.replyToId,
    optimistic: true,
  }
}

export function snapshotToQueuedMessages(snapshot: SessionQueueSnapshot): QueuedSessionMessage[] {
  return snapshot.items.map((item) => ({ ...item }))
}

interface ReplaceQueuedMessagesOptions {
  activeRunId?: string | null
}

export function replaceQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string,
  nextItems: QueuedSessionMessage[],
  options: ReplaceQueuedMessagesOptions = {},
): QueuedSessionMessage[] {
  const otherSessions = queue.filter((item) => item.sessionId !== sessionId)
  const previousForSession = queue.filter((item) => item.sessionId === sessionId && !item.sending)
  // Detect consumed messages: items in local state but not in server snapshot.
  // Keep only the run that actually became active visible as "sending" so it
  // doesn't vanish from the UI before the transcript refresh catches up.
  const nextRunIds = new Set(nextItems.map((item) => item.runId))
  const activeRunId = typeof options.activeRunId === 'string' && options.activeRunId.trim()
    ? options.activeRunId
    : null
  const consumed = previousForSession
    .filter((item) => !item.optimistic && !nextRunIds.has(item.runId) && activeRunId === item.runId)
    .map((item) => ({ ...item, sending: true }))
  return [
    ...otherSessions,
    ...consumed,
    ...nextItems,
  ]
}

export function listQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): QueuedSessionMessage[] {
  if (!sessionId) return []
  return queue
    .filter((item) => item.sessionId === sessionId)
    .sort((left, right) => left.position - right.position || left.queuedAt - right.queuedAt)
}

export function removeQueuedMessageById(
  queue: QueuedSessionMessage[],
  id: string,
): QueuedSessionMessage[] {
  return queue.filter((item) => item.runId !== id)
}

export function clearQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): QueuedSessionMessage[] {
  if (!sessionId) return queue
  return queue.filter((item) => item.sessionId !== sessionId)
}
