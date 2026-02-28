import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import type { StreamChatOptions } from './index'

function findOpenClaw(): string {
  const locations = [
    path.join(process.cwd(), 'node_modules/.bin/openclaw'),
    path.join(__dirname, '../../..', 'node_modules/.bin/openclaw'),
    path.join(os.homedir(), '.local/bin/openclaw'),
    '/usr/local/bin/openclaw',
    '/opt/homebrew/bin/openclaw',
  ]
  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc
  }
  return 'openclaw'
}

const OPENCLAW = findOpenClaw()

export function streamOpenClawChat({ session, message, imagePath, systemPrompt, write, active }: StreamChatOptions): Promise<string> {
  let prompt = message
  if (imagePath) {
    prompt = `[The user has shared an image at: ${imagePath}]\n\n${message}`
  }

  const args = ['agent', '--agent', 'main', '--message', prompt, '--timeout', '120']

  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv

  // Pass the gateway token from the session's API key
  if (session.apiKey) {
    env.OPENCLAW_GATEWAY_TOKEN = session.apiKey
  }

  // If endpoint is configured, derive the WS URL for the gateway
  if (session.apiEndpoint) {
    let endpoint = session.apiEndpoint.replace(/\/+$/, '').replace(/\/v1$/i, '')
    // Auto-prepend protocol if missing
    if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`
    const wsUrl = endpoint.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
    env.OPENCLAW_GATEWAY_URL = wsUrl
  }

  // Check that openclaw CLI exists
  const versionProbe = spawnSync(OPENCLAW, ['--version'], {
    env,
    encoding: 'utf-8',
    timeout: 5000,
  })
  if ((versionProbe.status ?? 1) !== 0 && !versionProbe.stdout?.includes('OpenClaw')) {
    const msg = 'OpenClaw CLI not found. Run `npm install` to restore project dependencies.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const proc = spawn(OPENCLAW, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 130_000,
  })

  proc.stdin!.end()
  active.set(session.id, proc)

  let fullResponse = ''
  let stderrText = ''

  proc.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    fullResponse += text
    write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderrText += text
    if (stderrText.length > 8000) stderrText = stderrText.slice(-8000)
    console.error(`[${session.id}] openclaw stderr:`, text.slice(0, 200))
  })

  return new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      active.delete(session.id)
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const stderr = stderrText.trim()
        let msg = `OpenClaw exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
        if (stderr) msg += `: ${stderr.slice(0, 1200)}`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}
