import type { Message } from '@/types'

/**
 * Repairs a conversation transcript by ensuring that tool events remain associated
 * with their parent assistant messages during pruning or manipulation.
 * 
 * In SwarmClaw, toolEvents are nested within the Message object, so "orphaning"
 * is less of a structural risk than in OpenClaw, but we still need to ensure
 * consistency during context management.
 */
export function repairTranscriptConsistency(messages: Message[]): Message[] {
  // SwarmClaw specific: ensure that 'system' messages like [Context Summary]
  // are preserved correctly and that nested toolEvents are valid.
  return messages.map(m => {
    if (m.role === 'assistant' && m.toolEvents) {
      // Filter out empty or malformed tool events that might cause LLM confusion
      const validTools = m.toolEvents.filter(t => t.name && t.input)
      if (validTools.length !== m.toolEvents.length) {
        return { ...m, toolEvents: validTools }
      }
    }
    return m
  })
}

/**
 * Checks for and repairs common transcript issues that cause LLM provider errors.
 * (e.g. consecutive user messages, trailing assistant messages without text).
 */
export function finalProviderTranscriptSanityCheck(messages: Message[]): Message[] {
  if (messages.length === 0) return []

  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    
    // 1. Skip messages marked as suppressed
    if (m.suppressed) continue

    // 2. Prevent consecutive messages of same role (some providers are strict)
    const prev = out.at(-1)
    if (prev && prev.role === m.role) {
      if (m.role === 'user') {
        // Merge consecutive user messages
        prev.text = `${prev.text}\n\n${m.text}`
        if (m.imagePath) prev.imagePath = m.imagePath
        if (m.imageUrl) prev.imageUrl = m.imageUrl
        continue
      } else {
        // Assistant consecutive? Keep the one with tool events or the longer one
        const mTools = m.toolEvents?.length || 0
        const pTools = prev.toolEvents?.length || 0
        if (mTools > pTools || m.text.length > prev.text.length) {
          out[out.length - 1] = m
        }
        continue
      }
    }

    out.push(m)
  }

  // 3. Ensure the transcript doesn't end with an empty assistant message
  if (out.length > 0 && out.at(-1)?.role === 'assistant') {
    const last = out.at(-1)!
    if (!last.text.trim() && (!last.toolEvents || last.toolEvents.length === 0)) {
      out.pop()
    }
  }

  return out
}
