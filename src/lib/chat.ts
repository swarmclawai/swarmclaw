import type { SSEEvent } from '../types'
import { getStoredAccessKey } from './api-client'

interface StreamChatOptions {
  internal?: boolean
  queueMode?: 'followup' | 'steer' | 'collect'
}

export async function streamChat(
  sessionId: string,
  message: string,
  imagePath?: string,
  imageUrl?: string,
  onEvent?: (event: SSEEvent) => void,
  optionsOrFiles?: StreamChatOptions | string[],
  options?: StreamChatOptions,
): Promise<void> {
  // Support both (options) and (attachedFiles, options) as 6th arg
  let attachedFiles: string[] | undefined
  let opts: StreamChatOptions | undefined
  if (Array.isArray(optionsOrFiles)) {
    attachedFiles = optionsOrFiles
    opts = options
  } else {
    opts = optionsOrFiles
  }

  const key = getStoredAccessKey()
  const res = await fetch(`/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Access-Key': key } : {}),
    },
    body: JSON.stringify({
      message,
      imagePath,
      imageUrl,
      attachedFiles,
      internal: !!opts?.internal,
      queueMode: opts?.queueMode,
    }),
  })

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
