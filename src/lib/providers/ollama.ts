import fs from 'fs'
import http from 'http'
import https from 'https'
import type { StreamChatOptions } from './index'
import { streamOpenAiChat } from './openai'
import { IMAGE_EXTS, TEXT_EXTS, MAX_HISTORY_MESSAGES, writeSSE } from './provider-defaults'
import { log } from '@/lib/server/logger'
import { resolveOllamaRuntimeConfig } from '@/lib/server/ollama-runtime'
import { resolveImagePath } from '@/lib/server/resolve-image'

const TAG = 'provider-ollama'

/** Ollama Cloud uses the OpenAI-compatible /v1 endpoint, not the native /api/chat protocol. */
const OLLAMA_CLOUD_OPENAI_ENDPOINT = 'https://ollama.com/v1'

export function streamOllamaChat(opts: StreamChatOptions): Promise<string> {
  const { session, apiKey, write, active } = opts
  const runtime = resolveOllamaRuntimeConfig({
    model: session.model,
    ollamaMode: session.ollamaMode,
    apiKey,
    apiEndpoint: session.apiEndpoint,
  })

  if (runtime.useCloud) {
    if (!runtime.apiKey) {
      writeSSE(write, 'err', 'Ollama Cloud model requires an API key. Set OLLAMA_API_KEY or attach an Ollama credential.')
      active.delete(session.id)
      return Promise.resolve('')
    }
    // Delegate to OpenAI-compatible handler with the cloud endpoint
    const cloudSession = { ...session, model: runtime.model || 'llama3', apiEndpoint: OLLAMA_CLOUD_OPENAI_ENDPOINT }
    return streamOpenAiChat({ ...opts, session: cloudSession, apiKey: runtime.apiKey })
  }

  const { message, imagePath, loadHistory, onUsage, signal } = opts
  return new Promise((resolve, reject) => {
    const messages = buildMessages(session, message, imagePath, loadHistory)
    const model = runtime.model || 'llama3'
    const endpoint = runtime.endpoint

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
          const msg = `Ollama error ${apiRes.statusCode}: ${errBody.slice(0, 200)}`
          log.error(TAG, `[${session.id}] ${msg}`)
          writeSSE(write, 'err', msg.slice(0, 120))
          active.delete(session.id)
          reject(new Error(msg))
        })
        return
      }

      let buf = ''
      let malformedChunkLogged = false
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
              writeSSE(write, 'd', content)
            }
            if (parsed.done && onUsage) {
              const input = parsed.prompt_eval_count || 0
              const output = parsed.eval_count || 0
              if (input > 0 || output > 0) {
                onUsage({ inputTokens: input, outputTokens: output })
              }
            }
          } catch {
            if (!malformedChunkLogged) {
              malformedChunkLogged = true
              log.warn(TAG, `[${session.id}] failed to parse Ollama stream chunk`, {
                sample: line.slice(0, 200),
              })
            }
          }
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
      log.error(TAG, `[${session.id}] ollama request error:`, e.message)
      let errMsg = e.message
      if (e.code === 'ECONNREFUSED') {
        errMsg = `Cannot connect to Ollama at ${endpoint}. Is Ollama running?`
      }
      writeSSE(write, 'err', errMsg)
      active.delete(session.id)
      reject(new Error(errMsg))
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
    const history = loadHistory(session.id as string).slice(-MAX_HISTORY_MESSAGES)
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
