import fs from 'fs'
import type { StreamChatOptions } from './index'

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i
const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|yml|yaml|toml|env|log|sh|sql|css|scss)$/i

function fileToContentParts(filePath: string): any[] {
  if (!filePath || !fs.existsSync(filePath)) return []
  if (IMAGE_EXTS.test(filePath)) {
    const data = fs.readFileSync(filePath).toString('base64')
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }]
  }
  if (TEXT_EXTS.test(filePath) || filePath.endsWith('.pdf')) {
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      const name = filePath.split('/').pop() || 'file'
      return [{ type: 'text', text: `[Attached file: ${name}]\n\n${text}` }]
    } catch { return [] }
  }
  return [{ type: 'text', text: `[Attached file: ${filePath.split('/').pop()}]` }]
}

export function streamOpenAiChat({ session, message, imagePath, apiKey, systemPrompt, write, active, loadHistory }: StreamChatOptions): Promise<string> {
  return new Promise(async (resolve) => {
    const messages = buildMessages(session, message, imagePath, systemPrompt, loadHistory)
    const model = session.model || 'gpt-4o'

    const payload = JSON.stringify({
      model,
      messages,
      stream: true,
    })

    let fullResponse = ''

    // Support custom base URLs for custom providers
    const baseUrl = session.apiEndpoint || 'https://api.openai.com/v1'
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

    // OpenClaw endpoints behind Hostinger's proxy use express.json() middleware
    // which consumes the request body before http-proxy-middleware can forward it.
    // Sending as text/plain bypasses the body parser while the gateway still parses JSON.
    const contentType = session.contentType || 'application/json'

    const abortController = new AbortController()
    active.set(session.id, { kill: () => abortController.abort() })

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': contentType,
        },
        body: payload,
        signal: abortController.signal,
      })

      // Detect HTML responses (e.g. landing page returned instead of API)
      const resContentType = res.headers.get('content-type') || ''
      if (resContentType.includes('text/html')) {
        console.error(`[${session.id}] received HTML instead of API response from ${baseUrl} (provider: ${session.provider})`)
        write(`data: ${JSON.stringify({ t: 'err', text: 'Received HTML instead of API response. The endpoint may be misconfigured or returning a landing page.' })}\n\n`)
        active.delete(session.id)
        resolve(fullResponse)
        return
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        console.error(`[${session.id}] openai error ${res.status}:`, errBody.slice(0, 200))
        let errMsg = `API error (${res.status})`
        try {
          const parsed = JSON.parse(errBody)
          if (parsed.error?.message) errMsg = parsed.error.message
          else if (parsed.message) errMsg = parsed.message
          else if (parsed.detail) errMsg = parsed.detail
        } catch {}
        write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
        active.delete(session.id)
        resolve(fullResponse)
        return
      }

      if (!res.body) {
        console.error(`[${session.id}] no response body from ${baseUrl}`)
        active.delete(session.id)
        resolve(fullResponse)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (abortController.signal.aborted) break

        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()!

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta?.content
            if (delta) {
              fullResponse += delta
              write(`data: ${JSON.stringify({ t: 'd', text: delta })}\n\n`)
            }
          } catch {}
        }
      }

      if (!fullResponse) {
        console.error(`[${session.id}] openai stream ended with no content (provider: ${session.provider}, endpoint: ${baseUrl})`)
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error(`[${session.id}] openai request error:`, err.message)
        write(`data: ${JSON.stringify({ t: 'err', text: `Connection failed: ${err.message}` })}\n\n`)
      }
    } finally {
      active.delete(session.id)
      resolve(fullResponse)
    }
  })
}

function buildMessages(session: any, message: string, imagePath: string | undefined, systemPrompt: string | undefined, loadHistory: (id: string) => any[]) {
  const msgs: Array<{ role: string; content: any }> = []

  if (systemPrompt) {
    msgs.push({ role: 'system', content: systemPrompt })
  }

  if (loadHistory) {
    const history = loadHistory(session.id)
    for (const m of history) {
      if (m.role === 'user' && m.imagePath) {
        const parts = fileToContentParts(m.imagePath)
        msgs.push({ role: 'user', content: [...parts, { type: 'text', text: m.text }] })
      } else {
        msgs.push({ role: m.role, content: m.text })
      }
    }
  }

  // Current message with optional attachment
  if (imagePath) {
    const parts = fileToContentParts(imagePath)
    msgs.push({ role: 'user', content: [...parts, { type: 'text', text: message }] })
  } else {
    msgs.push({ role: 'user', content: message })
  }
  return msgs
}
