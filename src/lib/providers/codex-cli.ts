import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '../server/runtime-settings'

function findCodex(): string {
  const locations = [
    path.join(os.homedir(), '.local/bin/codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(os.homedir(), '.npm-global/bin/codex'),
  ]
  // Check nvm paths
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
  try {
    const versions = fs.readdirSync(path.join(nvmDir, 'versions/node'))
    for (const v of versions) {
      locations.push(path.join(nvmDir, 'versions/node', v, 'bin/codex'))
    }
  } catch { /* nvm not installed */ }
  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      log.info('codex-cli', `Found codex at: ${loc}`)
      return loc
    }
  }
  log.warn('codex-cli', 'Codex binary not found in known locations, falling back to PATH')
  return 'codex'
}

const CODEX = findCodex()

function codexModelRequiresReasoningDowngrade(model: string | null | undefined): boolean {
  const value = String(model || '').trim().toLowerCase()
  // Some Codex models currently reject `model_reasoning_effort = "xhigh"`
  // from global ~/.codex/config.toml. Force a compatible value per request.
  return value === 'gpt-5-codex' || value === 'gpt-5-codex-mini'
}

export function streamCodexCliChat({ session, message, imagePath, systemPrompt, write, active }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const prompt = message

  const args: string[] = ['exec']

  // Session resume
  if (session.codexThreadId) {
    args.push('resume', session.codexThreadId)
  }

  args.push('--json', '--full-auto', '--skip-git-repo-check')

  if (session.model) args.push('-m', session.model)
  if (codexModelRequiresReasoningDowngrade(session.model)) {
    args.push('-c', 'model_reasoning_effort="high"')
  }

  // Attach images via native -i flag
  if (imagePath) {
    args.push('-i', imagePath)
  }

  // System prompt: write temp AGENTS.override.md in a temp CODEX_HOME
  // Codex reads AGENTS.override.md from CODEX_HOME on startup
  let tempCodexHome: string | null = null
  if (systemPrompt && !session.codexThreadId) {
    tempCodexHome = path.join(os.tmpdir(), `swarmclaw-codex-${session.id}`)
    fs.mkdirSync(tempCodexHome, { recursive: true })
    fs.writeFileSync(path.join(tempCodexHome, 'AGENTS.override.md'), systemPrompt)
  }

  // Read from stdin
  args.push('-')

  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('CODEX')) delete (env as Record<string, unknown>)[key]
  }

  // Pass API key if available
  if (session.apiKey) {
    env.OPENAI_API_KEY = session.apiKey
  }

  // Point to temp CODEX_HOME for system prompt injection
  if (tempCodexHome) {
    env.CODEX_HOME = tempCodexHome
  }

  if (!session.apiKey) {
    const loginProbe = spawnSync(CODEX, ['login', 'status'], {
      cwd: session.cwd,
      env,
      encoding: 'utf-8',
      timeout: 8000,
    })
    const probeText = `${loginProbe.stdout || ''}\n${loginProbe.stderr || ''}`.toLowerCase()
    const loggedIn = probeText.includes('logged in')
    if ((loginProbe.status ?? 1) !== 0 || !loggedIn) {
      const msg = 'Codex CLI is not authenticated. Run `codex login` (or set an API key in provider settings) and try again.'
      log.error('codex-cli', msg)
      write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      if (tempCodexHome) {
        try { fs.rmSync(tempCodexHome, { recursive: true }) } catch { /* ignore */ }
      }
      return Promise.resolve('')
    }
  }

  log.info('codex-cli', `Spawning: ${CODEX}`, {
    args: args.map(a => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    tempCodexHome,
  })

  const proc = spawn(CODEX, args, {
    cwd: session.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('codex-cli', `Process spawned: pid=${proc.pid}`)

  proc.stdin!.write(prompt)
  proc.stdin!.end()

  active.set(session.id, proc)
  let fullResponse = ''
  let buf = ''
  let eventCount = 0
  let stderrText = ''

  proc.stdout!.on('data', (chunk: Buffer) => {
    const raw = chunk.toString()
    buf += raw

    if (eventCount === 0) {
      log.debug('codex-cli', `First stdout chunk (${raw.length} bytes)`, raw.slice(0, 500))
    }

    const lines = buf.split('\n')
    buf = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        eventCount++

        // Track thread ID for session resume
        if (ev.type === 'thread.started' && ev.thread_id) {
          session.codexThreadId = ev.thread_id
          log.info('codex-cli', `Got thread_id: ${ev.thread_id}`)
        }

        // Streaming text deltas (if codex adds streaming support)
        if (ev.type === 'item.content_part.delta' && ev.delta?.text) {
          fullResponse += ev.delta.text
          write(`data: ${JSON.stringify({ t: 'd', text: ev.delta.text })}\n\n`)
        }

        // Agent message (codex format: item.type === 'agent_message', text in item.text)
        else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item?.text) {
          fullResponse = ev.item.text
          write(`data: ${JSON.stringify({ t: 'r', text: ev.item.text })}\n\n`)
          log.debug('codex-cli', `Agent message (${ev.item.text.length} chars)`)
        }

        // Fallback: message type with content array (Responses API format)
        else if (ev.type === 'item.completed' && ev.item?.type === 'message' && ev.item?.role === 'assistant') {
          const content = ev.item.content
          if (Array.isArray(content)) {
            const text = content.filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('')
            if (text) {
              fullResponse = text
              write(`data: ${JSON.stringify({ t: 'r', text })}\n\n`)
            }
          } else if (typeof content === 'string') {
            fullResponse = content
            write(`data: ${JSON.stringify({ t: 'r', text: content })}\n\n`)
          }
        }

        // Reasoning items — log but don't send to user
        else if (ev.type === 'item.completed' && ev.item?.type === 'reasoning') {
          log.debug('codex-cli', `Reasoning: ${ev.item.text?.slice(0, 100)}`)
        }

        // Turn completed — log usage
        else if (ev.type === 'turn.completed' && ev.usage) {
          log.info('codex-cli', `Turn completed`, ev.usage)
        }

        else if (ev.type === 'error' && ev.message) {
          write(`data: ${JSON.stringify({ t: 'err', text: String(ev.message) })}\n\n`)
          log.warn('codex-cli', `Event error: ${String(ev.message).slice(0, 300)}`)
        }

        else if (ev.type === 'turn.failed' && ev.error?.message) {
          write(`data: ${JSON.stringify({ t: 'err', text: String(ev.error.message) })}\n\n`)
          log.warn('codex-cli', `Turn failed: ${String(ev.error.message).slice(0, 300)}`)
        }

        // Log other event types for debugging
        else if (eventCount <= 10) {
          log.debug('codex-cli', `Event: ${ev.type}`)
        }
      } catch {
        // Non-JSON line = raw text output (fallback)
        if (line.trim()) {
          log.debug('codex-cli', `Non-JSON stdout line`, line.slice(0, 300))
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
    log.warn('codex-cli', `stderr [${session.id}]`, text.slice(0, 500))
    console.error(`[${session.id}] codex stderr:`, text.slice(0, 200))
  })

  return new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      log.info('codex-cli', `Process closed: code=${code} signal=${signal} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      // Clean up temp CODEX_HOME
      if (tempCodexHome) {
        try { fs.rmSync(tempCodexHome, { recursive: true }) } catch { /* ignore */ }
      }
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Codex CLI exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Codex CLI exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      log.error('codex-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      if (tempCodexHome) {
        try { fs.rmSync(tempCodexHome, { recursive: true }) } catch { /* ignore */ }
      }
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}
