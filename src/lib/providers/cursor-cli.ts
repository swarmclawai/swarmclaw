import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, isStderrNoise } from './cli-utils'

function buildCursorPrompt(message: string, systemPrompt?: string, imagePath?: string): string {
  const parts: string[] = []
  if (systemPrompt) parts.push(`[System instructions]\n${systemPrompt}`)
  if (imagePath) parts.push(`[The user shared an image at: ${imagePath}]`)
  parts.push(message)
  return parts.join('\n\n')
}

function extractCursorText(event: Record<string, unknown>): string | null {
  if (typeof event.result === 'string' && event.result.trim()) return event.result
  if (typeof event.text === 'string' && event.text.trim()) return event.text

  const message = event.message
  if (typeof message === 'string' && message.trim()) return message
  if (message && typeof message === 'object') {
    const record = message as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim()) return record.text
    if (typeof record.content === 'string' && record.content.trim()) return record.content
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map((entry) => {
          if (typeof entry.text === 'string') return entry.text
          if (typeof entry.content === 'string') return entry.content
          return ''
        })
        .join('')
        .trim()
      if (text) return text
    }
  }

  return null
}

export function streamCursorCliChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('cursor-agent')
  if (!binary) {
    const msg = 'Cursor Agent CLI not found. Install Cursor CLI and ensure `cursor-agent` is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const env = buildCliEnv()
  if (!session.apiKey) {
    const auth = probeCliAuth(binary, 'cursor', env, session.cwd)
    if (!auth.authenticated) {
      write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Cursor Agent CLI is not authenticated.' })}\n\n`)
      return Promise.resolve('')
    }
  }

  const prompt = buildCursorPrompt(message, !session.cursorSessionId ? systemPrompt : undefined, imagePath)
  const args = ['--print', '--output-format', 'stream-json']
  if (session.cursorSessionId) args.push('--resume', session.cursorSessionId)
  if (session.model && session.model !== 'auto') args.push('--model', session.model)
  args.push(prompt)

  log.info('cursor-cli', `Spawning: ${binary}`, {
    args: args.map((value) => value.length > 100 ? `${value.slice(0, 100)}...` : value),
    cwd: session.cwd,
    hasSystemPrompt: Boolean(systemPrompt),
    resumeSessionId: session.cursorSessionId || null,
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
          : typeof event.thread_id === 'string'
            ? event.thread_id
            : typeof event.sessionId === 'string'
              ? event.sessionId
              : null
        if (sessionId) session.cursorSessionId = sessionId

        const eventType = String(event.type || '')
        if (eventType.includes('delta')) {
          const delta = (event.delta && typeof event.delta === 'object'
            ? event.delta
            : event.content && typeof event.content === 'object'
              ? event.content
              : null) as Record<string, unknown> | null
          const text = typeof delta?.text === 'string' ? delta.text : null
          if (text) {
            fullResponse += text
            write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
            continue
          }
        }

        const text = extractCursorText(event)
        if (text) {
          if (eventType === 'result' || eventType === 'completed' || eventType === 'assistant') {
            fullResponse = text
            write(`data: ${JSON.stringify({ t: 'r', text })}\n\n`)
          } else {
            fullResponse += text
            write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
          }
        } else if (eventType === 'error' && typeof event.message === 'string') {
          write(`data: ${JSON.stringify({ t: 'err', text: event.message })}\n\n`)
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
      log.debug('cursor-cli', `stderr noise [${session.id}]`, text.slice(0, 400))
    } else {
      log.warn('cursor-cli', `stderr [${session.id}]`, text.slice(0, 400))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      active.delete(session.id)
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Cursor Agent CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Cursor Agent CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      log.info('cursor-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      resolve(fullResponse.trim())
    })

    proc.on('error', (err) => {
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: err.message })}\n\n`)
      resolve(fullResponse.trim())
    })
  })
}
