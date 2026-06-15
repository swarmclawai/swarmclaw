import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { getEnabledToolIds } from '@/lib/capability-selection'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, isStderrNoise } from './cli-utils'

const TAG = 'provider-claude-cli'

export function streamClaudeCliChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('claude')
  if (!binary) {
    const msg = 'Claude CLI not found. Install it and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  let prompt = message
  if (imagePath) {
    prompt = `[The user has shared an image at: ${imagePath}]\n\n${message}`
  }

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
  const resumeSessionId = typeof session.claudeSessionId === 'string' ? session.claudeSessionId : ''
  const selectedModel = typeof session.model === 'string' ? session.model : ''
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  if (selectedModel) args.push('--model', selectedModel)

  // Inject agent system prompt
  if (systemPrompt && !resumeSessionId) {
    args.push('--system-prompt', systemPrompt)
  }

  // Add MCP servers for enabled tools
  const tools = getEnabledToolIds(session as { tools?: string[] | null } | null)
  let mcpConfigPath: string | null = null
  if (tools.includes('browser')) {
    const proxyScript = path.join(process.cwd(), 'src/lib/server/playwright-proxy.mjs')
    const uploadDir = path.join(os.tmpdir(), 'swarmclaw-uploads')
    const mcpConfig = JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'node',
          args: [proxyScript],
          env: { SWARMCLAW_UPLOAD_DIR: uploadDir },
        }
      }
    })
    mcpConfigPath = path.join(os.tmpdir(), `swarmclaw-mcp-${session.id}.json`)
    fs.writeFileSync(mcpConfigPath, mcpConfig)
    args.push('--mcp-config', mcpConfigPath)
  }

  const env = buildCliEnv()

  // Auth probe
  const auth = probeCliAuth(binary, 'claude', env, session.cwd)
  if (!auth.authenticated) {
    log.error('claude-cli', auth.errorMessage || 'Auth failed')
    write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Claude CLI is not authenticated.' })}\n\n`)
    return Promise.resolve('')
  }

  log.info('claude-cli', `Spawning: ${binary}`, {
    args: args.map(a => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    systemPromptLen: systemPrompt?.length || 0,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('claude-cli', `Process spawned: pid=${proc.pid}`)

  proc.stdin!.write(prompt)
  proc.stdin!.end()

  active.set(session.id, proc)
  attachAbortHandler(proc, signal)

  let fullResponse = ''
  let buf = ''
  let eventCount = 0
  let stderrText = ''
  // Map Claude CLI tool_use ids to their tool name so tool_result events
  // (which only reference tool_use_id) can be matched back to a tool name.
  const toolUseNames = new Map<string, string>()
  // The CLI hides raw thinking tokens, but the agent narrates between steps as
  // text blocks. Capture the most recent narration so it can be attached to the
  // next tool call and shown interleaved with the tool steps.
  let pendingReasoning = ''

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
              // Hold the narration; if a tool follows it is that tool's reasoning,
              // otherwise it is the final answer text (already streamed below).
              pendingReasoning = block.text
              write(`data: ${JSON.stringify({ t: 'md', text: block.text })}\n\n`)
              log.debug('claude-cli', `Assistant text block (${block.text.length} chars)`)
            } else if (block.type === 'tool_use' && block.name) {
              // Surface the CLI's internal tool calls as SwarmClaw tool events
              if (block.id) toolUseNames.set(block.id, block.name)
              let toolInput = ''
              try { toolInput = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}) } catch { toolInput = '' }
              const reasoning = pendingReasoning.trim()
              pendingReasoning = ''
              write(`data: ${JSON.stringify({ t: 'tool_call', toolName: block.name, toolInput, toolCallId: block.id, reasoning: reasoning || undefined })}\n\n`)
              log.debug('claude-cli', `Tool call: ${block.name}`)
            }
          }
        } else if (ev.type === 'user' && ev.message?.content) {
          // Tool results come back as user-role messages with tool_result blocks
          for (const block of ev.message.content) {
            if (block.type === 'tool_result') {
              const toolName = (block.tool_use_id && toolUseNames.get(block.tool_use_id)) || 'unknown'
              let toolOutput = ''
              const c = block.content
              if (typeof c === 'string') {
                toolOutput = c
              } else if (Array.isArray(c)) {
                toolOutput = c.map((p: { type?: string; text?: string }) => (p?.type === 'text' && p.text) ? p.text : '').filter(Boolean).join('\n')
              }
              if (block.is_error && toolOutput && !/^error/i.test(toolOutput.trim())) toolOutput = `Error: ${toolOutput}`
              write(`data: ${JSON.stringify({ t: 'tool_result', toolName, toolOutput, toolCallId: block.tool_use_id })}\n\n`)
              log.debug('claude-cli', `Tool result: ${toolName} (${toolOutput.length} chars)`)
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
    stderrText += text
    if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000)
    if (isStderrNoise(text)) {
      log.debug('claude-cli', `stderr noise [${session.id}]`, text.slice(0, 500))
    } else {
      log.warn('claude-cli', `stderr [${session.id}]`, text.slice(0, 500))
      log.error(TAG, `[${session.id}] stderr:`, text.slice(0, 200))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      log.info('claude-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath) } catch { /* ignore */ }
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Claude CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Claude CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
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
