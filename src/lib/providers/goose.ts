import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, isStderrNoise } from './cli-utils'

function buildGoosePrompt(message: string, systemPrompt?: string, imagePath?: string): string {
  const parts: string[] = []
  if (systemPrompt) parts.push(`[System instructions]\n${systemPrompt}`)
  if (imagePath) parts.push(`[The user shared an image at: ${imagePath}]`)
  parts.push(message)
  return parts.join('\n\n')
}

function deriveGooseSessionName(sessionId: string): string {
  return `swarmclaw-${sessionId}`
}

function extractGooseText(event: Record<string, unknown>): string | null {
  if (typeof event.result === 'string' && event.result.trim()) return event.result
  if (typeof event.text === 'string' && event.text.trim()) return event.text
  if (typeof event.message === 'string' && event.message.trim()) return event.message

  const message = event.message
  if (message && typeof message === 'object') {
    const record = message as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim()) return record.text
    if (typeof record.content === 'string' && record.content.trim()) return record.content
  }

  const content = event.content
  if (typeof content === 'string' && content.trim()) return content
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim()) return record.text
  }

  return null
}

export function streamGooseChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('goose')
  if (!binary) {
    const msg = 'Goose CLI not found. Install `goose` and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const env = buildCliEnv()
  if (!session.apiKey) {
    const auth = probeCliAuth(binary, 'goose', env, session.cwd)
    if (!auth.authenticated) {
      write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Goose CLI is not configured.' })}\n\n`)
      return Promise.resolve('')
    }
  }
  if (session.apiKey) env.GOOSE_API_KEY = session.apiKey

  const prompt = buildGoosePrompt(message, !session.acpSessionId ? systemPrompt : undefined, imagePath)
  const sessionName = session.acpSessionId || deriveGooseSessionName(session.id)
  const args = ['run', '-t', prompt, '--format', 'json', '--quiet', '--name', sessionName]
  if (session.acpSessionId) args.push('--resume')
  if (session.model && session.model !== 'default') args.push('--model', session.model)

  log.info('goose', `Spawning: ${binary}`, {
    args: args.map((value, index) => index === 2 && value.length > 120 ? `(${value.length} chars)` : value),
    cwd: session.cwd,
    resumeSessionName: session.acpSessionId || null,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  session.acpSessionId = sessionName
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
        const text = extractGooseText(event)
        if (!text) continue

        const eventType = String(event.type || event.event || '')
        if (eventType === 'delta' || eventType === 'content_block_delta' || eventType === 'chunk') {
          fullResponse += text
          write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
        } else if (eventType === 'result' || eventType === 'completed' || eventType === 'assistant') {
          fullResponse = text
          write(`data: ${JSON.stringify({ t: 'r', text })}\n\n`)
        } else {
          fullResponse += text
          write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
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
      log.debug('goose', `stderr noise [${session.id}]`, text.slice(0, 400))
    } else {
      log.warn('goose', `stderr [${session.id}]`, text.slice(0, 400))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      active.delete(session.id)
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Goose CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Goose CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      log.info('goose', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      resolve(fullResponse.trim())
    })

    proc.on('error', (err) => {
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: err.message })}\n\n`)
      resolve(fullResponse.trim())
    })
  })
}
