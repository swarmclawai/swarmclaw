import type { SessionQueueSnapshot, SessionQueuedTurn } from '@/types'

export interface QueuedSessionMessage extends SessionQueuedTurn {
  optimistic?: boolean
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

export function replaceQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string,
  nextItems: QueuedSessionMessage[],
): QueuedSessionMessage[] {
  return [
    ...queue.filter((item) => item.sessionId !== sessionId),
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
