import fs from 'fs'
import type { StreamChatOptions } from './index'
import { PROVIDER_DEFAULTS, IMAGE_EXTS, TEXT_EXTS, PDF_MAX_CHARS, MAX_HISTORY_MESSAGES, writeSSE } from './provider-defaults'
import { log } from '@/lib/server/logger'
import { resolveImagePath } from '@/lib/server/resolve-image'

const TAG = 'provider-openai'

async function fileToContentParts(filePath: string): Promise<Array<Record<string, unknown>>> {
  if (!filePath || !fs.existsSync(filePath)) return []
  const name = filePath.split('/').pop() || 'file'
  if (IMAGE_EXTS.test(filePath)) {
    const buf = await fs.promises.readFile(filePath)
    if (buf.length === 0) return [{ type: 'text', text: `[Attached image: ${name} — file is empty]` }]
    const data = buf.toString('base64')
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    let mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    if (buf[0] === 0xFF && buf[1] === 0xD8) mimeType = 'image/jpeg'
    else if (buf[0] === 0x89 && buf[1] === 0x50) mimeType = 'image/png'
    else if (buf[0] === 0x47 && buf[1] === 0x49) mimeType = 'image/gif'
    else if (buf[0] === 0x52 && buf[1] === 0x49) mimeType = 'image/webp'
    return [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}`, detail: 'auto' } }]
  }
  if (filePath.endsWith('.pdf')) {
    try {
      // @ts-ignore — pdf-parse types
      const pdfParse = (await import(/* webpackIgnore: true */ 'pdf-parse')).default
      const buf = await fs.promises.readFile(filePath)
      const result = await pdfParse(buf)
      const pdfText = (result.text || '').trim()
      if (!pdfText) return [{ type: 'text', text: `[Attached PDF: ${name} — no extractable text]` }]
      const truncated = pdfText.length > PDF_MAX_CHARS ? pdfText.slice(0, PDF_MAX_CHARS) + '\n\n[... truncated]' : pdfText
      return [{ type: 'text', text: `[Attached PDF: ${name} (${result.numpages} pages)]\n\n${truncated}` }]
    } catch {
      return [{ type: 'text', text: `[Attached PDF: ${name} — could not extract text]` }]
    }
  }
  if (TEXT_EXTS.test(filePath)) {
    try {
      const text = await fs.promises.readFile(filePath, 'utf-8')
      return [{ type: 'text', text: `[Attached file: ${name}]\n\n${text}` }]
    } catch { return [] }
  }
  return [{ type: 'text', text: `[Attached file: ${name}]` }]
}

export function streamOpenAiChat({ session, message, imagePath, imageUrl, apiKey, systemPrompt, write, active, loadHistory, onUsage, signal }: StreamChatOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    ;(async () => {
      try {
        const messages = await buildMessages(session, message, imagePath, systemPrompt, loadHistory, imageUrl)
        const model = session.model || 'gpt-4o'

        let fullResponse = ''

        // Support custom base URLs for custom providers
        const baseUrl = session.apiEndpoint || PROVIDER_DEFAULTS.openai
        const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

        // OpenClaw endpoints behind Hostinger's proxy use express.json() middleware
        // which consumes the request body before http-proxy-middleware can forward it.
        // Sending as text/plain bypasses the body parser while the gateway still parses JSON.
        const contentType = session.contentType || 'application/json'

        const abortController = new AbortController()
        if (signal) {
          if (signal.aborted) abortController.abort()
          else signal.addEventListener('abort', () => abortController.abort(), { once: true })
        }
        active.set(session.id, { kill: () => abortController.abort() })

        try {
          // Try with stream_options first; if the provider rejects with 400, retry without it
          let res: Response | undefined
          let usageEnabled = true
          for (const includeStreamOptions of [true, false]) {
            const payloadObj: Record<string, unknown> = {
              model,
              messages,
              stream: true,
            }
            if (includeStreamOptions) {
              payloadObj.stream_options = { include_usage: true }
            }
            const payload = JSON.stringify(payloadObj)

            res = await fetch(url, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': contentType,
              },
              body: payload,
              signal: abortController.signal,
            })

            if (res.status === 400 && includeStreamOptions) {
              // Provider likely rejected stream_options — retry without it
              usageEnabled = false
              continue
            }
            usageEnabled = includeStreamOptions
            break
          }

          if (!res) {
            active.delete(session.id)
            reject(new Error('No response from provider'))
            return
          }

          // Detect HTML responses (e.g. landing page returned instead of API)
          const resContentType = res.headers.get('content-type') || ''
          if (resContentType.includes('text/html')) {
            const msg = 'Received HTML instead of API response. The endpoint may be misconfigured or returning a landing page.'
            log.error(TAG, `[${session.id}] received HTML instead of API response from ${baseUrl} (provider: ${session.provider})`)
            writeSSE(write, 'err', msg)
            active.delete(session.id)
            reject(new Error(msg))
            return
          }

          if (!res.ok) {
            const errBody = await res.text().catch(() => '')
            log.error(TAG, `[${session.id}] openai error ${res.status}:`, errBody.slice(0, 200))
            let errMsg = `API error (${res.status})`
            try {
              const parsed = JSON.parse(errBody)
              if (parsed.error?.message) errMsg = parsed.error.message
              else if (parsed.message) errMsg = parsed.message
              else if (parsed.detail) errMsg = parsed.detail
            } catch {}
            writeSSE(write, 'err', errMsg)
            active.delete(session.id)
            reject(new Error(`OpenAI error ${res.status}: ${errMsg}`))
            return
          }

          if (!res.body) {
            const msg = `No response body from ${baseUrl}`
            log.error(TAG, `[${session.id}] ${msg}`)
            active.delete(session.id)
            reject(new Error(msg))
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
                  writeSSE(write, 'd', delta)
                }
                // Extract usage from the final chunk (stream_options: include_usage)
                if (usageEnabled && parsed.usage && onUsage) {
                  onUsage({
                    inputTokens: parsed.usage.prompt_tokens || 0,
                    outputTokens: parsed.usage.completion_tokens || 0,
                  })
                }
              } catch {}
            }
          }

          if (!fullResponse) {
            log.error(TAG, `[${session.id}] openai stream ended with no content (provider: ${session.provider}, endpoint: ${baseUrl})`)
          }
        } catch (err: unknown) {
          const errObj = err as { name?: string; message?: string }
          if (errObj.name !== 'AbortError') {
            log.error(TAG, `[${session.id}] openai request error:`, errObj.message)
            writeSSE(write, 'err', `Connection failed: ${errObj.message}`)
          }
          active.delete(session.id)
          reject(err)
          return
        }
        active.delete(session.id)
        resolve(fullResponse)
      } catch (err) { reject(err) }
    })()
  })
}

async function buildMessages(session: Record<string, unknown>, message: string, imagePath: string | undefined, systemPrompt: string | undefined, loadHistory: (id: string) => Record<string, unknown>[], imageUrl?: string) {
  const msgs: Array<{ role: string; content: unknown }> = []

  if (systemPrompt) {
    msgs.push({ role: 'system', content: systemPrompt })
  }

  if (loadHistory) {
    const history = loadHistory(session.id as string).slice(-MAX_HISTORY_MESSAGES)
    for (const m of history) {
      const histImagePath = resolveImagePath(m.imagePath as string | undefined, m.imageUrl as string | undefined)
      if (m.role === 'user' && histImagePath) {
        const parts = await fileToContentParts(histImagePath)
        msgs.push({ role: 'user', content: [...parts, { type: 'text', text: m.text }] })
      } else {
        msgs.push({ role: m.role as string, content: m.text })
      }
    }
  }

  // Current message with optional attachment
  const resolvedPath = resolveImagePath(imagePath, imageUrl)
  if (resolvedPath) {
    const parts = await fileToContentParts(resolvedPath)
    msgs.push({ role: 'user', content: [...parts, { type: 'text', text: message }] })
  } else {
    msgs.push({ role: 'user', content: message })
  }
  return msgs
}
