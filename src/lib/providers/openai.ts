import https from 'https'
import http from 'http'
import type { StreamChatOptions } from './index'

export function streamOpenAiChat({ session, message, apiKey, systemPrompt, write, active, loadHistory }: StreamChatOptions): Promise<string> {
  return new Promise((resolve) => {
    const messages = buildMessages(session, message, systemPrompt, loadHistory)
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

    const apiReq = transport.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = ''
        apiRes.on('data', (c: Buffer) => errBody += c)
        apiRes.on('end', () => {
          console.error(`[${session.id}] openai error ${apiRes.statusCode}:`, errBody.slice(0, 200))
          let errMsg = `OpenAI API error (${apiRes.statusCode})`
          try {
            const parsed = JSON.parse(errBody)
            if (parsed.error?.message) errMsg = parsed.error.message
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
        active.delete(session.id)
        resolve(fullResponse)
      })
    })

    active.set(session.id, { kill: () => { abortController.aborted = true; apiReq.destroy() } })

    apiReq.on('error', (e) => {
      console.error(`[${session.id}] openai request error:`, e.message)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      active.delete(session.id)
      resolve(fullResponse)
    })

    apiReq.end(payload)
  })
}

function buildMessages(session: any, message: string, systemPrompt: string | undefined, loadHistory: (id: string) => any[]) {
  const msgs: Array<{ role: string; content: string }> = []

  if (systemPrompt) {
    msgs.push({ role: 'system', content: systemPrompt })
  }

  if (loadHistory) {
    const history = loadHistory(session.id)
    for (const m of history) {
      msgs.push({ role: m.role, content: m.text })
    }
  }

  msgs.push({ role: 'user', content: message })
  return msgs
}
