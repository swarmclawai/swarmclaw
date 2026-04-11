import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, isStderrNoise } from './cli-utils'

function buildQwenPrompt(message: string, systemPrompt?: string, imagePath?: string): string {
  const parts: string[] = []
  if (systemPrompt) parts.push(`[System instructions]\n${systemPrompt}`)
  if (imagePath) parts.push(`[The user shared an image at: ${imagePath}]`)
  parts.push(message)
  return parts.join('\n\n')
}

function extractQwenAssistantText(event: Record<string, unknown>): string | null {
  if (typeof event.result === 'string' && event.result.trim()) return event.result

  if (event.type === 'assistant') {
    const message = event.message as Record<string, unknown> | undefined
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => typeof entry.text === 'string' ? entry.text : '')
      .join('')
      .trim()
    if (text) return text
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined
    if (typeof delta?.text === 'string' && delta.text.trim()) return delta.text
  }

  return null
}

export function streamQwenCodeCliChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('qwen')
  if (!binary) {
    const msg = 'Qwen Code CLI not found. Install `qwen` and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const env = buildCliEnv()
  if (!session.apiKey) {
    const auth = probeCliAuth(binary, 'qwen', env, session.cwd)
    if (!auth.authenticated) {
      write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Qwen Code CLI is not configured.' })}\n\n`)
      return Promise.resolve('')
    }
  }

  const prompt = buildQwenPrompt(message, !session.qwenSessionId ? systemPrompt : undefined, imagePath)
  const args = ['-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--yolo']
  if (session.qwenSessionId) args.push('--resume', session.qwenSessionId)
  if (session.model && session.model !== 'default') args.push('--model', session.model)

  log.info('qwen-code-cli', `Spawning: ${binary}`, {
    args: args.map((value, index) => index === 1 && value.length > 120 ? `(${value.length} chars)` : value),
    cwd: session.cwd,
    hasSystemPrompt: Boolean(systemPrompt),
    resumeSessionId: session.qwenSessionId || null,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  active.set(session.id, proc)
  attachAbortHandler(proc, signal)

  let fullResponse = ''
  let buf = ''
  let stderrText = ''
  let eventCount = 0

  proc.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        eventCount += 1
        const sessionId = typeof event.session_id === 'string'
          ? event.session_id
          : typeof event.sessionId === 'string'
            ? event.sessionId
            : null
        if (sessionId) session.qwenSessionId = sessionId

        if (event.type === 'result' && event.subtype === 'error') {
          const errText = typeof event.result === 'string' ? event.result : 'Qwen Code error'
          write(`data: ${JSON.stringify({ t: 'err', text: errText })}\n\n`)
          continue
        }

        const text = extractQwenAssistantText(event)
        if (text) {
          if (event.type === 'result' || event.type === 'assistant') {
            fullResponse = text
            write(`data: ${JSON.stringify({ t: 'r', text })}\n\n`)
          } else {
            fullResponse += text
            write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
          }
        }
      } catch {
        fullResponse += `${line}\n`
        write(`data: ${JSON.stringify({ t: 'd', text: `${line}\n` })}\n\n`)
      }
    }
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderrText += text
    if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000)
    if (isStderrNoise(text)) {
      log.debug('qwen-code-cli', `stderr noise [${session.id}]`, text.slice(0, 400))
    } else {
      log.warn('qwen-code-cli', `stderr [${session.id}]`, text.slice(0, 400))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      active.delete(session.id)
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Qwen Code CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Qwen Code CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      log.info('qwen-code-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      resolve(fullResponse.trim())
    })

    proc.on('error', (err) => {
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: err.message })}\n\n`)
      resolve(fullResponse.trim())
    })
  })
}
