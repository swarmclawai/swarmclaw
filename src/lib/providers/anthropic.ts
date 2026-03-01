import fs from 'fs'
import https from 'https'
import type { StreamChatOptions } from './index'

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i
const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|yml|yaml|toml|env|log|sh|sql|css|scss)$/i

function fileToContentBlocks(filePath: string): any[] {
  if (!filePath || !fs.existsSync(filePath)) return []
  if (IMAGE_EXTS.test(filePath)) {
    const data = fs.readFileSync(filePath).toString('base64')
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }]
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

export function streamAnthropicChat({ session, message, imagePath, apiKey, systemPrompt, write, active, loadHistory }: StreamChatOptions): Promise<string> {
  return new Promise((resolve) => {
    const messages = buildMessages(session, message, imagePath, loadHistory)
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

function buildMessages(session: any, message: string, imagePath: string | undefined, loadHistory: (id: string) => any[]) {
  const msgs: Array<{ role: string; content: any }> = []

  if (loadHistory) {
    const history = loadHistory(session.id).slice(-40)
    for (const m of history) {
      if (m.role === 'user' && m.imagePath) {
        const blocks = fileToContentBlocks(m.imagePath)
        msgs.push({ role: 'user', content: [...blocks, { type: 'text', text: m.text }] })
      } else {
        msgs.push({ role: m.role, content: m.text })
      }
    }
  }

  // Current message with optional attachment
  if (imagePath) {
    const blocks = fileToContentBlocks(imagePath)
    msgs.push({ role: 'user', content: [...blocks, { type: 'text', text: message }] })
  } else {
    msgs.push({ role: 'user', content: message })
  }
  return msgs
}
