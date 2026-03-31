import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, symlinkConfigFiles, isStderrNoise } from './cli-utils'

/**
 * GitHub Copilot CLI provider — spawns `copilot -p <message> --output-format=json -s --yolo`.
 * Tracks `session.copilotSessionId` from streamed JSON events to support multi-turn continuity.
 */
export function streamCopilotCliChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('copilot')
  if (!binary) {
    const msg = 'Copilot CLI not found. Install it (brew install copilot-cli, npm i -g @github/copilot, or https://gh.io/copilot-install) and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const env = buildCliEnv()

  // Pass GitHub token if available via session API key
  if (session.apiKey) {
    env.GH_TOKEN = session.apiKey
  }

  // Auth probe
  if (!session.apiKey) {
    const auth = probeCliAuth(binary, 'copilot', env, session.cwd)
    if (!auth.authenticated) {
      log.error('copilot-cli', auth.errorMessage || 'Auth failed')
      write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Copilot CLI is not authenticated.' })}\n\n`)
      return Promise.resolve('')
    }
  }

  // Build prompt with optional system instructions
  const promptParts: string[] = []
  if (imagePath) {
    promptParts.push(`[The user has shared an image at: ${imagePath}]`)
  }
  promptParts.push(message)
  const prompt = promptParts.join('\n\n')

  const args = ['-p', prompt, '--output-format=json', '-s', '--yolo']
  if (session.copilotSessionId) args.push('--resume', session.copilotSessionId)
  if (session.model) args.push('--model', session.model)

  // System prompt: write temp AGENTS.override.md in a temp config dir
  // Symlink auth files from the real config dir so auth still works
  let tempCopilotHome: string | null = null
  if (systemPrompt && !session.copilotSessionId) {
    const realCopilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
    tempCopilotHome = path.join(os.tmpdir(), `swarmclaw-copilot-${session.id}`)
    fs.mkdirSync(tempCopilotHome, { recursive: true })

    // Symlink auth/config files from real home into temp dir
    symlinkConfigFiles(realCopilotHome, tempCopilotHome)

    // Write system prompt as AGENTS.override.md
    fs.writeFileSync(path.join(tempCopilotHome, 'AGENTS.override.md'), systemPrompt)
    env.COPILOT_HOME = tempCopilotHome
  }

  log.info('copilot-cli', `Spawning: ${binary}`, {
    args: args.map((a) => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    resumeSessionId: session.copilotSessionId || null,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('copilot-cli', `Process spawned: pid=${proc.pid}`)
  active.set(session.id, proc)
  attachAbortHandler(proc, signal)

  let fullResponse = ''
  let buf = ''
  let eventCount = 0
  let stderrText = ''

  proc.stdout!.on('data', (chunk: Buffer) => {
    const raw = chunk.toString()
    buf += raw

    if (eventCount === 0) {
      log.debug('copilot-cli', `First stdout chunk (${raw.length} bytes)`, raw.slice(0, 500))
    }

    const lines = buf.split('\n')
    buf = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        eventCount++

        // Capture session ID from init event
        if (ev.type === 'init' && typeof ev.session_id === 'string') {
          session.copilotSessionId = ev.session_id
          log.info('copilot-cli', `Got session_id: ${ev.session_id}`)
        }

        // Streaming text deltas
        if (ev.type === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown> | undefined
          if (typeof delta?.text === 'string') {
            fullResponse += delta.text
            write(`data: ${JSON.stringify({ t: 'd', text: delta.text })}\n\n`)
          }
        }

        // Agent message chunks (ACP format)
        else if (ev.type === 'agent_message_chunk' && typeof ev.text === 'string') {
          fullResponse += ev.text
          write(`data: ${JSON.stringify({ t: 'd', text: ev.text })}\n\n`)
        }

        // Assistant message content
        else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
          fullResponse += ev.content
          write(`data: ${JSON.stringify({ t: 'd', text: ev.content })}\n\n`)
        }

        // Completed item with agent_message
        else if (ev.type === 'item.completed' && (ev.item as Record<string, unknown>)?.type === 'agent_message') {
          const item = ev.item as Record<string, unknown>
          if (typeof item.text === 'string') {
            fullResponse = item.text
            write(`data: ${JSON.stringify({ t: 'r', text: item.text })}\n\n`)
            log.debug('copilot-cli', `Agent message (${item.text.length} chars)`)
          }
        }

        // Final result
        else if (ev.type === 'result' && typeof ev.result === 'string') {
          fullResponse = ev.result
          write(`data: ${JSON.stringify({ t: 'r', text: ev.result })}\n\n`)
          log.debug('copilot-cli', `Result event (${ev.result.length} chars)`)
        }

        // Error result
        else if (ev.type === 'result' && ev.status === 'error') {
          const errMsg = typeof ev.error === 'string' ? ev.error : 'Copilot error'
          write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
          log.warn('copilot-cli', `Error result: ${errMsg}`)
        }

        // Event error
        else if (ev.type === 'error') {
          const errMsg = typeof ev.message === 'string'
            ? ev.message
            : typeof ev.error === 'string'
              ? ev.error
              : 'Unknown Copilot error'
          write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
          log.warn('copilot-cli', `Event error: ${errMsg}`)
        }

        else if (eventCount <= 10) {
          log.debug('copilot-cli', `Event: ${String(ev.type)}`)
        }
      } catch {
        if (line.trim()) {
          log.debug('copilot-cli', `Non-JSON stdout line`, line.slice(0, 300))
          fullResponse += line + '\n'
          write(`data: ${JSON.stringify({ t: 'd', text: line + '\n' })}\n\n`)
        }
      }
    }
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderrText += text
    if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000)
    if (isStderrNoise(text)) {
      log.debug('copilot-cli', `stderr noise [${session.id}]`, text.slice(0, 500))
    } else {
      log.warn('copilot-cli', `stderr [${session.id}]`, text.slice(0, 500))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      log.info('copilot-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      // Clean up temp config dir
      if (tempCopilotHome) {
        try { fs.rmSync(tempCopilotHome, { recursive: true }) } catch { /* ignore */ }
      }
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Copilot CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Copilot CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      log.error('copilot-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      if (tempCopilotHome) {
        try { fs.rmSync(tempCopilotHome, { recursive: true }) } catch { /* ignore */ }
      }
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}
