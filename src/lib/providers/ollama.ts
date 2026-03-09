import fs from 'fs'
import http from 'http'
import https from 'https'
import type { StreamChatOptions } from './index'
import { resolveOllamaRuntimeConfig } from '@/lib/server/ollama-runtime'
import { resolveImagePath } from '@/lib/server/resolve-image'

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i
const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|yml|yaml|toml|env|log|sh|sql|css|scss)$/i

export function streamOllamaChat({ session, message, imagePath, apiKey, write, active, loadHistory, onUsage, signal }: StreamChatOptions): Promise<string> {
  return new Promise((resolve) => {
    const messages = buildMessages(session, message, imagePath, loadHistory)
    const runtime = resolveOllamaRuntimeConfig({
      model: session.model,
      apiKey,
      apiEndpoint: session.apiEndpoint,
    })
    const model = runtime.model || 'llama3'
    const endpoint = runtime.endpoint
    if (runtime.useCloud && !runtime.apiKey) {
      write(`data: ${JSON.stringify({ t: 'err', text: 'Ollama Cloud model requires an API key. Set OLLAMA_API_KEY or attach an Ollama credential.' })}\n\n`)
      active.delete(session.id)
      resolve('')
      return
    }

    const parsed = new URL(endpoint)
    const isHttps = parsed.protocol === 'https:'
    const transport = isHttps ? https : http
    const defaultPort = isHttps ? 443 : 11434

    const payload = JSON.stringify({
      model,
      messages,
      stream: true,
    })

    const abortController = { aborted: false }
    let fullResponse = ''
    let apiReqRef: ReturnType<typeof http.request> | null = null

    if (signal) {
      if (signal.aborted) {
        abortController.aborted = true
      } else {
        signal.addEventListener('abort', () => {
          abortController.aborted = true
          apiReqRef?.destroy()
        }, { once: true })
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (runtime.apiKey) {
      headers['Authorization'] = `Bearer ${runtime.apiKey}`
    }

    const apiReq = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || defaultPort,
      path: '/api/chat',
      method: 'POST',
      headers,
    }, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = ''
        apiRes.on('data', (c: Buffer) => errBody += c)
        apiRes.on('end', () => {
          console.error(`[${session.id}] ollama error ${apiRes.statusCode}:`, errBody.slice(0, 200))
          write(`data: ${JSON.stringify({ t: 'err', text: `Ollama error (${apiRes.statusCode}): ${errBody.slice(0, 100)}` })}\n\n`)
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
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line)
            const content = parsed.message?.content
            if (content) {
              fullResponse += content
              write(`data: ${JSON.stringify({ t: 'd', text: content })}\n\n`)
            }
            // Final chunk (done: true) carries token counts
            if (parsed.done && onUsage) {
              const input = parsed.prompt_eval_count || 0
              const output = parsed.eval_count || 0
              if (input > 0 || output > 0) {
                onUsage({ inputTokens: input, outputTokens: output })
              }
            }
          } catch {}
        }
      })

      apiRes.on('end', () => {
        active.delete(session.id)
        resolve(fullResponse)
      })
    })

    apiReqRef = apiReq
    active.set(session.id, { kill: () => { abortController.aborted = true; apiReq.destroy() } })

    apiReq.on('error', (e: NodeJS.ErrnoException) => {
      console.error(`[${session.id}] ollama request error:`, e.message)
      let errMsg = e.message
      if (e.code === 'ECONNREFUSED') {
        errMsg = `Cannot connect to Ollama at ${endpoint}. Is Ollama running?`
      }
      write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
      active.delete(session.id)
      resolve(fullResponse)
    })

    apiReq.end(payload)
  })
}

function fileToOllamaMsg(text: string, filePath?: string): { content: string; images?: string[] } {
  if (!filePath || !fs.existsSync(filePath)) return { content: text }
  if (IMAGE_EXTS.test(filePath)) {
    const data = fs.readFileSync(filePath).toString('base64')
    return { content: text, images: [data] }
  }
  if (TEXT_EXTS.test(filePath) || filePath.endsWith('.pdf')) {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8')
      const name = filePath.split('/').pop() || 'file'
      return { content: `[Attached file: ${name}]\n\n${fileContent}\n\n${text}` }
    } catch { return { content: text } }
  }
  return { content: `[Attached file: ${filePath.split('/').pop()}]\n\n${text}` }
}

function buildMessages(session: Record<string, unknown>, message: string, imagePath: string | undefined, loadHistory: (id: string) => Record<string, unknown>[]) {
  const msgs: Array<{ role: string; content: string; images?: string[] }> = []

  if (loadHistory) {
    const history = loadHistory(session.id as string).slice(-40)
    for (const m of history) {
      const histImagePath = resolveImagePath(m.imagePath as string | undefined, m.imageUrl as string | undefined)
      if (m.role === 'user' && histImagePath) {
        msgs.push({ role: 'user', ...fileToOllamaMsg(m.text as string, histImagePath) })
      } else {
        msgs.push({ role: m.role as string, content: m.text as string })
      }
    }
  }

  const resolvedPath = resolveImagePath(imagePath)
  msgs.push({ role: 'user', ...fileToOllamaMsg(message, resolvedPath ?? undefined) })
  return msgs
}
