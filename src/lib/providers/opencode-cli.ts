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

/**
 * OpenCode CLI provider — spawns `opencode -p "prompt"` for non-interactive usage.
 * System prompt is injected via a temporary .opencode/instructions.md file.
 * Output is plain text (no JSON streaming mode).
 */
export function streamOpenCodeCliChat({ session, message, imagePath, systemPrompt, write, active }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  let prompt = message
  if (imagePath) {
    prompt = `[The user has shared a file at: ${imagePath}]\n\n${message}`
  }

  // OpenCode uses .opencode/instructions.md for system prompts.
  // Create a temp project dir with the instructions file if we have a system prompt.
  let tmpDir: string | null = null
  const cwd = session.cwd || process.cwd()

  if (systemPrompt) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ember-opencode-'))
    const instructionsDir = path.join(tmpDir, '.opencode')
    fs.mkdirSync(instructionsDir, { recursive: true })
    fs.writeFileSync(path.join(instructionsDir, 'instructions.md'), systemPrompt)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'dumb',
    NO_COLOR: '1',
  }

  // Set model via env if specified
  if (session.model) {
    env.OPENCODE_MODEL = session.model
  }

  const args = ['-p', prompt]

  log.info('opencode-cli', `Spawning: ${OPENCODE}`, {
    args: ['-p', `(${prompt.length} chars)`],
    cwd: tmpDir || cwd,
    hasSystemPrompt: !!systemPrompt,
  })

  const proc = spawn(OPENCODE, args, {
    cwd: tmpDir || cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('opencode-cli', `Process spawned: pid=${proc.pid}`)
  active.set(session.id, proc)

  let fullResponse = ''
  let stderrText = ''

  proc.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    fullResponse += text
    // Stream chunks as deltas
    write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderrText += text
    if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000)
    log.warn('opencode-cli', `stderr [${session.id}]`, text.slice(0, 500))
  })

  return new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      log.info('opencode-cli', `Process closed: code=${code} signal=${signal} response=${fullResponse.length}chars`)
      active.delete(session.id)
      // Clean up temp dir
      if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `OpenCode CLI exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `OpenCode CLI exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      log.error('opencode-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
      resolve(fullResponse)
    })
  })
}
