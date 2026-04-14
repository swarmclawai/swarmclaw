import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, symlinkConfigFiles, isStderrNoise } from './cli-utils'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { loadMcpServers } from '@/lib/server/storage'

const TAG = 'provider-codex'

function codexModelRequiresReasoningDowngrade(model: string | null | undefined): boolean {
  const value = String(model || '').trim().toLowerCase()
  return value === 'gpt-5-codex' || value === 'gpt-5-codex-mini'
}

export function streamCodexCliChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('codex')
  if (!binary) {
    const msg = 'Codex CLI not found. Install it and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

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

  // Read from stdin
  args.push('-')

  // Build clean env — preserves user's CODEX_HOME for auth
  const env = buildCliEnv()

  // Pass API key if available
  if (session.apiKey) {
    env.OPENAI_API_KEY = session.apiKey
  }

  // Auth probe BEFORE creating temp CODEX_HOME — uses real config dir
  if (!session.apiKey) {
    const auth = probeCliAuth(binary, 'codex', env, session.cwd)
    if (!auth.authenticated) {
      log.error('codex-cli', auth.errorMessage || 'Auth failed')
      write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Codex CLI is not authenticated.' })}\n\n`)
      return Promise.resolve('')
    }
  }

  // System prompt + MCP injection: create a temp CODEX_HOME when needed
  // Symlink auth files from the real config dir so auth still works
  let tempCodexHome: string | null = null
  const agentForMcp = session.agentId ? getAgent(session.agentId as string) : null
  const agentMcpServerIds: string[] = agentForMcp?.mcpServerIds || []
  const needsTempHome = (systemPrompt && !session.codexThreadId) || agentMcpServerIds.length > 0
  if (needsTempHome) {
    const realCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    tempCodexHome = path.join(os.tmpdir(), `swarmclaw-codex-${session.id}`)
    fs.mkdirSync(tempCodexHome, { recursive: true })

    // Symlink auth/config files from real CODEX_HOME into temp dir
    symlinkConfigFiles(realCodexHome, tempCodexHome)

    // Write system prompt as AGENTS.override.md (first turn only)
    if (systemPrompt && !session.codexThreadId) {
      fs.writeFileSync(path.join(tempCodexHome, 'AGENTS.override.md'), systemPrompt)
    }

    // Inject agent-assigned MCP servers into config.toml
    if (agentMcpServerIds.length > 0) {
      try {
        const allMcpServers = loadMcpServers()
        const tomlParts: string[] = []
        for (const serverId of agentMcpServerIds) {
          const config = allMcpServers[serverId]
          if (!config) continue
          const name = config.name.replace(/[^a-zA-Z0-9_]/g, '_')
          if (config.transport === 'stdio' && config.command) {
            tomlParts.push(`[mcp_servers.${name}]`)
            tomlParts.push(`command = ${JSON.stringify(config.command)}`)
            const argsStr = (config.args || []).map((a: string) => JSON.stringify(a)).join(', ')
            tomlParts.push(`args = [${argsStr}]`)
            if (config.cwd) tomlParts.push(`cwd = ${JSON.stringify(config.cwd)}`)
            tomlParts.push('')
            // Env vars go in a separate subsection: [mcp_servers.name.env]
            if (config.env && Object.keys(config.env).length > 0) {
              tomlParts.push(`[mcp_servers.${name}.env]`)
              for (const [k, v] of Object.entries(config.env as Record<string, string>)) {
                tomlParts.push(`${k} = ${JSON.stringify(v)}`)
              }
              tomlParts.push('')
            }
          } else if ((config.transport === 'sse' || config.transport === 'streamable-http') && config.url) {
            tomlParts.push(`[mcp_servers.${name}]`)
            tomlParts.push(`url = ${JSON.stringify(config.url)}`)
            tomlParts.push('')
          }
        }
        if (tomlParts.length > 0) {
          const realConfigPath = path.join(realCodexHome, 'config.toml')
          const existingConfig = fs.existsSync(realConfigPath)
            ? fs.readFileSync(realConfigPath, 'utf-8')
            : ''
          const tempConfigPath = path.join(tempCodexHome, 'config.toml')
          // Remove symlink created by symlinkConfigFiles before writing our own file
          try { fs.unlinkSync(tempConfigPath) } catch { /* no symlink — ignore */ }
          fs.writeFileSync(tempConfigPath, existingConfig + '\n' + tomlParts.join('\n'))
          log.info('codex-cli', `Injecting ${agentMcpServerIds.length} MCP server(s) via config.toml`)
        }
      } catch (mcpErr) {
        log.warn('codex-cli', `Failed to build MCP config: ${mcpErr}`)
      }
    }

    env.CODEX_HOME = tempCodexHome
  }

  log.info('codex-cli', `Spawning: ${binary}`, {
    args: args.map(a => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    tempCodexHome,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('codex-cli', `Process spawned: pid=${proc.pid}`)

  proc.stdin!.write(prompt)
  proc.stdin!.end()

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
            const text = content.filter((c: Record<string, unknown>) => c.type === 'output_text').map((c: Record<string, unknown>) => c.text).join('')
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
    if (isStderrNoise(text)) {
      log.debug('codex-cli', `stderr noise [${session.id}]`, text.slice(0, 500))
    } else {
      log.warn('codex-cli', `stderr [${session.id}]`, text.slice(0, 500))
      log.error(TAG, `[${session.id}] codex stderr:`, text.slice(0, 200))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      log.info('codex-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      // Clean up temp CODEX_HOME
      if (tempCodexHome) {
        try { fs.rmSync(tempCodexHome, { recursive: true }) } catch { /* ignore */ }
      }
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Codex CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Codex CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
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
