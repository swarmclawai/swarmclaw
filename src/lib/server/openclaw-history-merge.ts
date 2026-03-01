import type { Message, GatewaySessionPreview } from '@/types'

/** Merge gateway history messages into local messages, deduplicating by timestamp */
export function mergeHistoryMessages(
  localMessages: Message[],
  preview: GatewaySessionPreview,
): Message[] {
  const localTimestamps = new Set(localMessages.map((m) => m.time))

  const newMessages: Message[] = []
  for (const gm of preview.messages) {
    // Skip if we already have a message at this timestamp
    if (localTimestamps.has(gm.ts)) continue

    const role = gm.role === 'user' ? 'user' as const : 'assistant' as const
    newMessages.push({
      role,
      text: gm.content,
      time: gm.ts,
      kind: 'chat',
    })
  }

  if (newMessages.length === 0) return localMessages

  // Merge and sort by timestamp
  const merged = [...localMessages, ...newMessages]
  merged.sort((a, b) => a.time - b.time)

  return merged
}

/** Validate a session key matches expected format */
export function isValidSessionKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length < 256
}
