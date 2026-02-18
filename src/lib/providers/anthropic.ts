import https from 'https'
import type { StreamChatOptions } from './index'

export function streamAnthropicChat({ session, message, apiKey, systemPrompt, write, active, loadHistory }: StreamChatOptions): Promise<string> {
  return new Promise((resolve) => {
    const messages = buildMessages(session, message, loadHistory)
    const model = session.model || 'claude-sonnet-4-6'

    const body: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      messages,
      stream: true,
    }
    if (systemPrompt) {
      body.system = systemPrompt
    }

    const payload = JSON.stringify(body)
    const abortController = { aborted: false }
    let fullResponse = ''

    const apiReq = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = ''
        apiRes.on('data', (c: Buffer) => errBody += c)
        apiRes.on('end', () => {
          console.error(`[${session.id}] anthropic error ${apiRes.statusCode}:`, errBody.slice(0, 200))
          let errMsg = `Anthropic API error (${apiRes.statusCode})`
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
          if (!data) continue
          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullResponse += parsed.delta.text
              write(`data: ${JSON.stringify({ t: 'd', text: parsed.delta.text })}\n\n`)
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
      console.error(`[${session.id}] anthropic request error:`, e.message)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      active.delete(session.id)
      resolve(fullResponse)
    })

    apiReq.end(payload)
  })
}

function buildMessages(session: any, message: string, loadHistory: (id: string) => any[]) {
  const msgs: Array<{ role: string; content: string }> = []

  if (loadHistory) {
    const history = loadHistory(session.id)
    for (const m of history) {
      msgs.push({ role: m.role, content: m.text })
    }
  }

  msgs.push({ role: 'user', content: message })
  return msgs
}
