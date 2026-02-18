import type { SSEEvent } from '../types'
import { getStoredAccessKey } from './api-client'

export async function streamChat(
  sessionId: string,
  message: string,
  imagePath?: string,
  imageUrl?: string,
  onEvent?: (event: SSEEvent) => void,
): Promise<void> {
  const key = getStoredAccessKey()
  const res = await fetch(`/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Access-Key': key } : {}),
    },
    body: JSON.stringify({ message, imagePath, imageUrl }),
  })

  if (res.status === 409) {
    onEvent?.({ t: 'err', text: 'Session is busy. Please wait.' })
    onEvent?.({ t: 'done' })
    return
  }

  if (!res.ok || !res.body) {
    onEvent?.({ t: 'err', text: `Request failed (${res.status})` })
    onEvent?.({ t: 'done' })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const event = JSON.parse(line.slice(6)) as SSEEvent
        // Forward all event types including tool_call and tool_result
        onEvent?.(event)
      } catch {
        // skip malformed
      }
    }
  }
}
