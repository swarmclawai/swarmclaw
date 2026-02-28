import fs from 'fs'
import https from 'https'
import http from 'http'
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
  return new Promise((resolve) => {
    const messages = buildMessages(session, message, imagePath, systemPrompt, loadHistory)
    const model = session.model || 'gpt-4o'

    const payload = JSON.stringify({
      model,
      messages,
      stream: true,
    })

    const abortController = { aborted: false }
    let fullResponse = ''

    // Support custom base URLs for custom providers
    const baseUrl = session.apiEndpoint || 'https://api.openai.com/v1'
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`)
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    // OpenClaw endpoints behind Hostinger's proxy use express.json() middleware
    // which consumes the request body before http-proxy-middleware can forward it.
    // Sending as text/plain bypasses the body parser while the gateway still parses JSON.
    const contentType = session.contentType || 'application/json'

    const apiReq = transport.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': contentType,
      },
    }, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = ''
        apiRes.on('data', (c: Buffer) => errBody += c)
        apiRes.on('end', () => {
          console.error(`[${session.id}] openai error ${apiRes.statusCode}:`, errBody.slice(0, 200))
          let errMsg = `API error (${apiRes.statusCode})`
          try {
            const parsed = JSON.parse(errBody)
            if (parsed.error?.message) errMsg = parsed.error.message
            else if (parsed.message) errMsg = parsed.message
            else if (parsed.detail) errMsg = parsed.detail
          } catch {}
          write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
          active.delete(session.id)
          resolve(fullResponse)
        })
        return
      }

      let buf = ''
      apiRes.on('data', (chunk: Buffer) => {
        if (abortController.aborted) return
        buf += chunk.toString()
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
      })

      apiRes.on('end', () => {
        if (!fullResponse) {
          console.error(`[${session.id}] openai stream ended with no content (provider: ${session.provider}, endpoint: ${baseUrl})`)
        }
        active.delete(session.id)
        resolve(fullResponse)
      })
    })

    active.set(session.id, { kill: () => { abortController.aborted = true; apiReq.destroy() } })

    apiReq.on('error', (e) => {
      console.error(`[${session.id}] openai request error:`, e.message)
      write(`data: ${JSON.stringify({ t: 'err', text: `Connection failed: ${e.message}` })}\n\n`)
      active.delete(session.id)
      resolve(fullResponse)
    })

    apiReq.end(payload)
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
