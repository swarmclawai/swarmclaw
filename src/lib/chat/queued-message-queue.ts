export interface QueuedSessionMessage {
  id: string
  sessionId: string
  text: string
}

export function nextQueuedMessageId(now = Date.now(), random = Math.random): string {
  return `queued-${now}-${random().toString(36).slice(2, 8)}`
}

export function listQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): QueuedSessionMessage[] {
  if (!sessionId) return []
  return queue.filter((item) => item.sessionId === sessionId)
}

export function removeQueuedMessageById(
  queue: QueuedSessionMessage[],
  id: string,
): QueuedSessionMessage[] {
  return queue.filter((item) => item.id !== id)
}

export function clearQueuedMessagesForSession(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): QueuedSessionMessage[] {
  if (!sessionId) return queue
  return queue.filter((item) => item.sessionId !== sessionId)
}

export function shiftQueuedMessageForSession(
  queue: QueuedSessionMessage[],
  sessionId: string | null | undefined,
): {
  next?: QueuedSessionMessage
  queue: QueuedSessionMessage[]
} {
  if (!sessionId) return { queue }
  const index = queue.findIndex((item) => item.sessionId === sessionId)
  if (index === -1) return { queue }
  const next = queue[index]
  return {
    next,
    queue: queue.filter((_, itemIndex) => itemIndex !== index),
  }
}
