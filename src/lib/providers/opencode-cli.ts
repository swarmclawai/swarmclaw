import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '../server/runtime-settings'

function findOpencode(): string {
  const locations = [
    path.join(os.homedir(), '.local/bin/opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ]
  // Check nvm paths
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
  try {
    const versions = fs.readdirSync(path.join(nvmDir, 'versions/node'))
    for (const v of versions) {
      locations.push(path.join(nvmDir, 'versions/node', v, 'bin/opencode'))
    }
  } catch { /* nvm not installed */ }
  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      log.info('opencode-cli', `Found opencode at: ${loc}`)
      return loc
    }
  }
  log.warn('opencode-cli', 'opencode binary not found in known locations, falling back to PATH')
  return 'opencode'
}

const OPENCODE = findOpencode()

function extractSessionId(raw: unknown): string | null {
  if (!raw) return null
  const text = String(raw).trim()
  return text ? text : null
}

/**
 * OpenCode CLI provider — spawns `opencode run <message> --format json` for non-interactive usage.
 * Tracks `session.opencodeSessionId` from streamed JSON events to support multi-turn continuity.
 */
export function streamOpenCodeCliChat({ session, message, imagePath, systemPrompt, write, active }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const cwd = session.cwd || process.cwd()
  const promptParts: string[] = []
  if (systemPrompt && !session.opencodeSessionId) {
    promptParts.push(`[System instructions]\n${systemPrompt}`)
  }
  promptParts.push(message)
  const prompt = promptParts.join('\n\n')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'dumb',
    NO_COLOR: '1',
  }
  // Set model via env if specified
  if (session.model) {
    env.OPENCODE_MODEL = session.model
  }

  const args = ['run', prompt, '--format', 'json']
  if (session.opencodeSessionId) args.push('--session', session.opencodeSessionId)
  if (session.model) args.push('--model', session.model)
  if (imagePath) args.push('--file', imagePath)

  log.info('opencode-cli', `Spawning: ${OPENCODE}`, {
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

  const proc = spawn(OPENCODE, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('opencode-cli', `Process spawned: pid=${proc.pid}`)
  active.set(session.id, proc)

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
        const ev = JSON.parse(trimmed) as any
        eventCount += 1
        const discoveredSessionId = extractSessionId(ev?.sessionID ?? ev?.sessionId)
        if (discoveredSessionId) session.opencodeSessionId = discoveredSessionId

        if (ev?.type === 'text' && typeof ev?.part?.text === 'string') {
          fullResponse += ev.part.text
          write(`data: ${JSON.stringify({ t: 'd', text: ev.part.text })}\n\n`)
          continue
        }

        if (ev?.type === 'error') {
          const msg = typeof ev?.error === 'string'
            ? ev.error
            : typeof ev?.message === 'string'
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
    log.warn('opencode-cli', `stderr [${session.id}]`, text.slice(0, 500))
  })

  return new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      log.info('opencode-cli', `Process closed: code=${code} signal=${signal} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      if ((code ?? 0) !== 0 && !fullResponse.trim() && eventErrors.length === 0) {
        const msg = stderrText.trim()
          ? `OpenCode CLI exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `OpenCode CLI exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''} and returned no output.`
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
