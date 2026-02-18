import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'

function findClaude(): string {
  const locations = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      log.info('claude-cli', `Found claude at: ${loc}`)
      return loc
    }
  }
  log.warn('claude-cli', 'Claude binary not found in known locations, falling back to PATH')
  return 'claude'
}

const CLAUDE = findClaude()

export function streamClaudeCliChat({ session, message, imagePath, systemPrompt, write, active }: StreamChatOptions): Promise<string> {
  let prompt = message
  if (imagePath) {
    prompt = `[The user has shared an image at: ${imagePath}]\n\n${message}`
  }

  const args = ['-p', '-', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
  if (session.claudeSessionId) args.push('--resume', session.claudeSessionId)
  if (session.model) args.push('--model', session.model)

  // Inject agent system prompt
  if (systemPrompt && !session.claudeSessionId) {
    args.push('--system-prompt', systemPrompt)
  }

  // Add MCP servers for enabled tools
  const tools: string[] = session.tools || []
  if (tools.includes('browser')) {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'] }
      }
    })
    args.push('--mcp-config', mcpConfig)
  }

  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' } as NodeJS.ProcessEnv
  delete (env as Record<string, unknown>)['CLAUDECODE']
  delete (env as Record<string, unknown>)['CLAUDE_CODE_SESSION']
  delete (env as Record<string, unknown>)['CLAUDE_CODE_ENTRYPOINT']

  log.info('claude-cli', `Spawning: ${CLAUDE}`, {
    args: args.map(a => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    systemPromptLen: systemPrompt?.length || 0,
  })

  const proc = spawn(CLAUDE, args, {
    cwd: session.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300000,
  })

  log.info('claude-cli', `Process spawned: pid=${proc.pid}`)

  proc.stdin!.write(prompt)
  proc.stdin!.end()

  active.set(session.id, proc)
  let fullResponse = ''
  let buf = ''
  let eventCount = 0

  proc.stdout!.on('data', (chunk: Buffer) => {
    const raw = chunk.toString()
    buf += raw

    // Log first chunk for debugging
    if (eventCount === 0) {
      log.debug('claude-cli', `First stdout chunk (${raw.length} bytes)`, raw.slice(0, 500))
    }

    const lines = buf.split('\n')
    buf = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        eventCount++

        if (ev.session_id && !session.claudeSessionId) {
          session.claudeSessionId = ev.session_id
          log.info('claude-cli', `Got session_id: ${ev.session_id}`)
        }

        if (ev.type === 'result') {
          if (ev.session_id) session.claudeSessionId = ev.session_id
          if (ev.result) {
            fullResponse = ev.result
            write(`data: ${JSON.stringify({ t: 'r', text: ev.result })}\n\n`)
            log.debug('claude-cli', `Result event (${ev.result.length} chars)`)
          }
        } else if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              fullResponse = block.text
              write(`data: ${JSON.stringify({ t: 'md', text: block.text })}\n\n`)
              log.debug('claude-cli', `Assistant text block (${block.text.length} chars)`)
            }
          }
        } else if (ev.type === 'content_block_delta' && ev.delta?.text) {
          fullResponse += ev.delta.text
          write(`data: ${JSON.stringify({ t: 'd', text: ev.delta.text })}\n\n`)
        } else {
          // Log other event types we see
          if (eventCount <= 5) {
            log.debug('claude-cli', `Event type: ${ev.type}`, ev.type === 'system' ? ev : undefined)
          }
        }
      } catch {
        if (line.trim()) {
          log.debug('claude-cli', `Non-JSON stdout line`, line.slice(0, 300))
          fullResponse += line + '\n'
          write(`data: ${JSON.stringify({ t: 'd', text: line + '\n' })}\n\n`)
        }
      }
    }
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    log.warn('claude-cli', `stderr [${session.id}]`, text.slice(0, 500))
    console.error(`[${session.id}] stderr:`, text.slice(0, 200))
  })

  return new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      log.info('claude-cli', `Process closed: code=${code} signal=${signal} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      log.error('claude-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}
