import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, isStderrNoise } from './cli-utils'

export const OPENCODE_CLI_STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']

export function buildOpenCodeCliNoOutputMessage(code: number | null, sig: NodeJS.Signals | null, stderrText: string, eventCount: number): string {
  const codeText = code ?? 'unknown'
  const signalText = sig ? ` (${sig})` : ''
  const stderr = stderrText.trim()
  if (stderr) {
    return `OpenCode CLI exited with code ${codeText}${signalText}: ${stderr.slice(0, 1200)}`
  }
  if (eventCount > 0) {
    const eventWord = eventCount === 1 ? 'event' : 'events'
    return `OpenCode CLI exited with code ${codeText}${signalText} after ${eventCount} ${eventWord} but returned no text output.`
  }
  return `OpenCode CLI exited with code ${codeText}${signalText} and returned no output.`
}

/**
 * OpenCode CLI provider — spawns `opencode run <message> --format json` for non-interactive usage.
 * Tracks `session.opencodeSessionId` from streamed JSON events to support multi-turn continuity.
 */
export function streamOpenCodeCliChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('opencode')
  if (!binary) {
    const msg = 'OpenCode CLI not found. Install it and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const cwd = session.cwd || process.cwd()
  const promptParts: string[] = []
  if (systemPrompt && !session.opencodeSessionId) {
    promptParts.push(`[System instructions]\n${systemPrompt}`)
  }
  promptParts.push(message)
  const prompt = promptParts.join('\n\n')

  const env = buildCliEnv()

  // Set model via env if specified
  if (session.model) {
    env.OPENCODE_MODEL = session.model
  }

  // Auth probe
  const auth = probeCliAuth(binary, 'opencode', env, cwd)
  if (!auth.authenticated) {
    log.error('opencode-cli', auth.errorMessage || 'Auth failed')
    write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'OpenCode CLI is not authenticated.' })}\n\n`)
    return Promise.resolve('')
  }

  const args = ['run', prompt, '--format', 'json']
  if (session.opencodeSessionId) args.push('--session', session.opencodeSessionId)
  if (session.model) args.push('--model', session.model)
  if (imagePath) args.push('--file', imagePath)

  log.info('opencode-cli', `Spawning: ${binary}`, {
    args: args.map((a, i) => {
      if (i === 1) return `(${prompt.length} chars)`
      if (a.length > 120) return `${a.slice(0, 120)}...`
      return a
    }),
    cwd,
    hasSystemPrompt: !!systemPrompt,
    hasImage: !!imagePath,
    resumeSessionId: session.opencodeSessionId || null,
  })

  const proc = spawn(binary, args, {
    cwd,
    env,
    // stdin must be closed: OpenCode CLI can wait forever on a connected pipe
    // even when the prompt is passed via argv.
    stdio: OPENCODE_CLI_STDIO,
    timeout: processTimeoutMs,
  })

  log.info('opencode-cli', `Process spawned: pid=${proc.pid}`)
  active.set(session.id, proc)
  attachAbortHandler(proc, signal)

  let fullResponse = ''
  let stderrText = ''
  let stdoutBuf = ''
  let eventCount = 0
  const eventErrors: string[] = []

  proc.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stdoutBuf += text
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>
        eventCount += 1
        const sid = typeof ev.sessionID === 'string' ? ev.sessionID.trim()
          : typeof ev.sessionId === 'string' ? ev.sessionId.trim()
            : null
        if (sid) session.opencodeSessionId = sid

        if (ev.type === 'text' && typeof (ev.part as Record<string, unknown>)?.text === 'string') {
          const partText = (ev.part as Record<string, unknown>).text as string
          fullResponse += partText
          write(`data: ${JSON.stringify({ t: 'd', text: partText })}\n\n`)
          continue
        }

        if (ev.type === 'error') {
          const msg = typeof ev.error === 'string'
            ? ev.error
            : typeof ev.message === 'string'
              ? ev.message
              : 'Unknown OpenCode event error'
          eventErrors.push(msg)
          write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
          continue
        }
      } catch {
        // Raw fallback line from the CLI.
        fullResponse += `${line}\n`
        write(`data: ${JSON.stringify({ t: 'd', text: `${line}\n` })}\n\n`)
      }
    }
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderrText += text
    if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000)
    if (isStderrNoise(text)) {
      log.debug('opencode-cli', `stderr noise [${session.id}]`, text.slice(0, 500))
    } else {
      log.warn('opencode-cli', `stderr [${session.id}]`, text.slice(0, 500))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      log.info('opencode-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      if (!fullResponse.trim() && eventErrors.length === 0) {
        const msg = buildOpenCodeCliNoOutputMessage(code, sig, stderrText, eventCount)
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse.trim())
    })

    proc.on('error', (e) => {
      log.error('opencode-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}
