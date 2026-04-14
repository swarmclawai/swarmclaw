import fs from 'fs'
import type { StreamChatOptions } from './index'
import { PROVIDER_DEFAULTS, IMAGE_EXTS, TEXT_EXTS, ANTHROPIC_MAX_TOKENS, MAX_HISTORY_MESSAGES, writeSSE } from './provider-defaults'
import { log } from '@/lib/server/logger'
import { resolveImagePath } from '@/lib/server/resolve-image'

const TAG = 'provider-anthropic'

async function fileToContentBlocks(filePath: string): Promise<Array<Record<string, unknown>>> {
  if (!filePath || !fs.existsSync(filePath)) return []
  if (IMAGE_EXTS.test(filePath)) {
    const data = (await fs.promises.readFile(filePath)).toString('base64')
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }]
  }
  if (TEXT_EXTS.test(filePath) || filePath.endsWith('.pdf')) {
    try {
      const text = await fs.promises.readFile(filePath, 'utf-8')
      const name = filePath.split('/').pop() || 'file'
      return [{ type: 'text', text: `[Attached file: ${name}]\n\n${text}` }]
    } catch { return [] }
  }
  return [{ type: 'text', text: `[Attached file: ${filePath.split('/').pop()}]` }]
}

export function streamAnthropicChat({ session, message, imagePath, apiKey, systemPrompt, write, active, loadHistory, onUsage, signal }: StreamChatOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    ;(async () => {
      try {
        const messages = await buildMessages(session, message, imagePath, loadHistory)
        const model = session.model || 'claude-sonnet-4-6'
        let usageInput = 0
        let usageOutput = 0

        const body: Record<string, unknown> = {
          model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          messages,
          stream: true,
        }
        if (systemPrompt) {
          body.system = systemPrompt
        }

        const payload = JSON.stringify(body)

        // Support custom base URL (e.g. proxy / gateway)
        const baseUrl = (session.apiEndpoint || PROVIDER_DEFAULTS.anthropic).replace(/\/+$/, '')
        const url = `${baseUrl}/v1/messages`

        const abortController = new AbortController()
        if (signal) {
          if (signal.aborted) abortController.abort()
          else signal.addEventListener('abort', () => abortController.abort(), { once: true })
        }
        active.set(session.id, { kill: () => abortController.abort() })

        let fullResponse = ''

        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'x-api-key': apiKey || '',
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: payload,
            signal: abortController.signal,
          })

          if (!res.ok) {
            const errBody = await res.text().catch(() => '')
            const msg = `Anthropic error ${res.status}: ${errBody.slice(0, 200)}`
            log.error(TAG, `[${session.id}] ${msg}`)
            let errMsg = `Anthropic API error (${res.status})`
            try {
              const parsed = JSON.parse(errBody)
              if (parsed.error?.message) errMsg = parsed.error.message
            } catch {}
            writeSSE(write, 'err', errMsg)
            active.delete(session.id)
            reject(new Error(msg))
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
          let malformedChunkLogged = false

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
              if (!data) continue
              try {
                const parsed = JSON.parse(data)
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  fullResponse += parsed.delta.text
                  writeSSE(write, 'd', parsed.delta.text)
                }
                if (parsed.type === 'message_start' && parsed.message?.usage) {
                  usageInput = parsed.message.usage.input_tokens || 0
                }
                if (parsed.type === 'message_delta' && parsed.usage) {
                  usageOutput = parsed.usage.output_tokens || 0
                }
              } catch {
                if (!malformedChunkLogged) {
                  malformedChunkLogged = true
                  log.warn(TAG, `[${session.id}] failed to parse Anthropic stream chunk`, {
                    sample: data.slice(0, 200),
                  })
                }
              }
            }
          }

          if (onUsage && (usageInput > 0 || usageOutput > 0)) {
            onUsage({ inputTokens: usageInput, outputTokens: usageOutput })
          }
        } catch (err: unknown) {
          const errObj = err as { name?: string; message?: string }
          if (errObj.name !== 'AbortError') {
            log.error(TAG, `[${session.id}] anthropic fetch error:`, errObj.message || '')
            writeSSE(write, 'err', errObj.message || 'Anthropic request failed')
          }
        }

        active.delete(session.id)
        resolve(fullResponse)
      } catch (err) { reject(err) }
    })()
  })
}

async function buildMessages(session: Record<string, unknown> & { id: string }, message: string, imagePath: string | undefined, loadHistory: (id: string) => Record<string, unknown>[]) {
  const msgs: Array<{ role: string; content: unknown }> = []

  if (loadHistory) {
    const history = loadHistory(session.id).slice(-MAX_HISTORY_MESSAGES)
    for (const m of history) {
      const histImagePath = resolveImagePath(m.imagePath as string | undefined, m.imageUrl as string | undefined)
      if (m.role === 'user' && histImagePath) {
        const blocks = await fileToContentBlocks(histImagePath)
        msgs.push({ role: 'user', content: [...blocks, { type: 'text', text: m.text }] })
      } else {
        msgs.push({ role: m.role as string, content: m.text })
      }
    }
  }

  if (imagePath) {
    const blocks = await fileToContentBlocks(imagePath)
    msgs.push({ role: 'user', content: [...blocks, { type: 'text', text: message }] })
  } else {
    msgs.push({ role: 'user', content: message })
  }
  return msgs
}
