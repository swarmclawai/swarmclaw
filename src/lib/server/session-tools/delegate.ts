import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { loadAgents, loadTasks, upsertTask } from '../storage'
import { log } from '../logger'
import type { ToolBuildContext } from './context'
import { truncate, tail, extractResumeIdentifier, findBinaryOnPath, MAX_OUTPUT } from './context'

export function buildDelegateTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx, claudeTimeoutMs, cliProcessTimeoutMs, persistDelegateResumeId, readStoredDelegateResumeId } = bctx

  const wantsClaudeDelegate = bctx.hasTool('claude_code')
  const wantsCodexDelegate = bctx.hasTool('codex_cli')
  const wantsOpenCodeDelegate = bctx.hasTool('opencode_cli')

  if (wantsClaudeDelegate || wantsCodexDelegate || wantsOpenCodeDelegate) {
    const claudeBinary = findBinaryOnPath('claude')
    const codexBinary = findBinaryOnPath('codex')
    const opencodeBinary = findBinaryOnPath('opencode')

    if (wantsClaudeDelegate && !claudeBinary) {
      log.warn('session-tools', 'Claude delegation enabled but claude binary not found', {
        sessionId: ctx?.sessionId || null,
        agentId: ctx?.agentId || null,
      })
    }
    if (wantsCodexDelegate && !codexBinary) {
      log.warn('session-tools', 'Codex delegation enabled but codex binary not found', {
        sessionId: ctx?.sessionId || null,
        agentId: ctx?.agentId || null,
      })
    }
    if (wantsOpenCodeDelegate && !opencodeBinary) {
      log.warn('session-tools', 'OpenCode delegation enabled but opencode binary not found', {
        sessionId: ctx?.sessionId || null,
        agentId: ctx?.agentId || null,
      })
    }

    if (claudeBinary && wantsClaudeDelegate) {
    tools.push(
      tool(
        async ({ task, resume, resumeId }) => {
          try {
            const env: NodeJS.ProcessEnv = { ...process.env }
            // Running inside Claude environments can block nested `claude` launches.
            // Strip all CLAUDE* vars so delegation can run as an independent subprocess.
            const removedClaudeEnvKeys: string[] = []
            for (const key of Object.keys(env)) {
              if (key.toUpperCase().startsWith('CLAUDE')) {
                removedClaudeEnvKeys.push(key)
                delete env[key]
              }
            }

            // Fast preflight: when Claude isn't authenticated, surface a clear error immediately.
            const authProbe = spawnSync(claudeBinary, ['auth', 'status'], {
              cwd,
              env,
              encoding: 'utf-8',
              timeout: 8000,
            })
            if ((authProbe.status ?? 1) !== 0) {
              let loggedIn = false
              try {
                const parsed = JSON.parse(authProbe.stdout || '{}') as { loggedIn?: boolean }
                loggedIn = parsed.loggedIn === true
              } catch {
                // ignore parse issues and fall back to a generic auth guidance
              }
              if (!loggedIn) {
                return 'Error: Claude Code CLI is not authenticated. Run `claude auth login` (or `claude setup-token`) on this machine, then retry.'
              }
            }

            const storedResumeId = readStoredDelegateResumeId('claudeCode')
            const resumeIdToUse = typeof resumeId === 'string' && resumeId.trim()
              ? resumeId.trim()
              : (resume ? storedResumeId : null)

            log.info('session-tools', 'delegate_to_claude_code start', {
              sessionId: ctx?.sessionId || null,
              agentId: ctx?.agentId || null,
              cwd,
              timeoutMs: claudeTimeoutMs,
              removedClaudeEnvKeys,
              resumeRequested: !!resume || !!resumeId,
              resumeId: resumeIdToUse || null,
              taskPreview: (task || '').slice(0, 200),
            })

            return new Promise<string>((resolve) => {
              const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
              if (resumeIdToUse) args.push('--resume', resumeIdToUse)
              const child = spawn(claudeBinary, args, {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
              })
              let stdout = ''
              let stderr = ''
              let stdoutBuf = ''
              let assistantText = ''
              let discoveredSessionId: string | null = null
              let settled = false
              let timedOut = false
              const startedAt = Date.now()

              const finish = (result: string) => {
                if (settled) return
                settled = true
                resolve(truncate(result, MAX_OUTPUT))
              }

              const timeoutHandle = setTimeout(() => {
                timedOut = true
                try { child.kill('SIGTERM') } catch { /* ignore */ }
                setTimeout(() => {
                  try { child.kill('SIGKILL') } catch { /* ignore */ }
                }, 5000)
              }, claudeTimeoutMs)

              log.info('session-tools', 'delegate_to_claude_code spawned', {
                sessionId: ctx?.sessionId || null,
                pid: child.pid || null,
                args,
              })
              child.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString()
                stdout += text
                if (stdout.length > MAX_OUTPUT * 8) stdout = tail(stdout, MAX_OUTPUT * 8)
                stdoutBuf += text
                const lines = stdoutBuf.split('\n')
                stdoutBuf = lines.pop() || ''
                for (const line of lines) {
                  if (!line.trim()) continue
                  try {
                    const ev = JSON.parse(line)
                    if (typeof ev?.session_id === 'string' && ev.session_id.trim()) {
                      discoveredSessionId = ev.session_id.trim()
                    }
                    if (ev?.type === 'result' && typeof ev?.result === 'string') {
                      assistantText = ev.result
                    } else if (ev?.type === 'assistant' && Array.isArray(ev?.message?.content)) {
                      const textBlocks = ev.message.content
                        .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
                        .map((block: any) => block.text)
                        .join('')
                      if (textBlocks) assistantText = textBlocks
                    } else if (ev?.type === 'content_block_delta' && typeof ev?.delta?.text === 'string') {
                      assistantText += ev.delta.text
                    }
                  } catch {
                    // keep raw stdout fallback when parsing fails
                  }
                }
              })
              child.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString()
                if (stderr.length > MAX_OUTPUT * 8) stderr = tail(stderr, MAX_OUTPUT * 8)
              })
              child.on('error', (err) => {
                clearTimeout(timeoutHandle)
                log.error('session-tools', 'delegate_to_claude_code child error', {
                  sessionId: ctx?.sessionId || null,
                  error: err?.message || String(err),
                })
                finish(`Error: failed to start Claude Code CLI: ${err?.message || String(err)}`)
              })
              child.on('close', (code, signal) => {
                clearTimeout(timeoutHandle)
                const durationMs = Date.now() - startedAt
                if (!discoveredSessionId) {
                  const guessed = extractResumeIdentifier(`${stdout}\n${stderr}`)
                  if (guessed) discoveredSessionId = guessed
                }
                if (discoveredSessionId) persistDelegateResumeId('claudeCode', discoveredSessionId)
                log.info('session-tools', 'delegate_to_claude_code child close', {
                  sessionId: ctx?.sessionId || null,
                  code,
                  signal: signal || null,
                  timedOut,
                  durationMs,
                  stdoutLen: stdout.length,
                  stderrLen: stderr.length,
                  discoveredSessionId,
                  stderrPreview: tail(stderr, 240),
                })
                if (timedOut) {
                  const msg = [
                    `Error: Claude Code CLI timed out after ${Math.round(claudeTimeoutMs / 1000)}s.`,
                    stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                    stdout.trim() ? `stdout:\n${tail(stdout, 1500)}` : '',
                    'Try increasing "Claude Code Timeout (sec)" in Settings.',
                  ].filter(Boolean).join('\n\n')
                  finish(msg)
                  return
                }

                const successText = assistantText.trim() || stdout.trim() || stderr.trim()
                if (code === 0 && successText) {
                  const out = discoveredSessionId
                    ? `${successText}\n\n[delegate_meta]\nresume_id=${discoveredSessionId}`
                    : successText
                  finish(out)
                  return
                }

                const msg = [
                  `Error: Claude Code CLI exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`,
                  stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                  stdout.trim() ? `stdout:\n${tail(stdout, 1500)}` : '',
                ].filter(Boolean).join('\n\n')
                finish(msg || 'Error: Claude Code CLI returned no output.')
              })

              try {
                child.stdin?.write(task)
                child.stdin?.end()
              } catch (err: any) {
                clearTimeout(timeoutHandle)
                finish(`Error: failed to send task to Claude Code CLI: ${err?.message || String(err)}`)
              }
            })
          } catch (err: any) {
            return `Error delegating to Claude Code: ${err.message}`
          }
        },
        {
          name: 'delegate_to_claude_code',
          description: 'Delegate a complex task to Claude Code CLI. Use for tasks that need deep code understanding, multi-file refactoring, or running tests. The task runs in the session working directory.',
          schema: z.object({
            task: z.string().describe('Detailed description of the task for Claude Code'),
            resume: z.boolean().optional().describe('If true, try to resume the last saved Claude delegation session for this SwarmClaw session'),
            resumeId: z.string().optional().describe('Explicit Claude session id to resume (overrides resume=true memory)'),
          }),
        },
      ),
    )
    }

    if (codexBinary && wantsCodexDelegate) {
    tools.push(
      tool(
        async ({ task, resume, resumeId }) => {
          try {
            const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
            const removedCodexEnvKeys: string[] = []
            for (const key of Object.keys(env)) {
              if (key.toUpperCase().startsWith('CODEX')) {
                removedCodexEnvKeys.push(key)
                delete env[key]
              }
            }

            const hasApiKey = typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim().length > 0
            if (!hasApiKey) {
              const loginProbe = spawnSync(codexBinary, ['login', 'status'], {
                cwd,
                env,
                encoding: 'utf-8',
                timeout: 8000,
              })
              const probeText = `${loginProbe.stdout || ''}\n${loginProbe.stderr || ''}`.toLowerCase()
              const loggedIn = probeText.includes('logged in')
              if ((loginProbe.status ?? 1) !== 0 || !loggedIn) {
                return 'Error: Codex CLI is not authenticated. Run `codex login` (or set OPENAI_API_KEY), then retry.'
              }
            }

            const storedResumeId = readStoredDelegateResumeId('codex')
            const resumeIdToUse = typeof resumeId === 'string' && resumeId.trim()
              ? resumeId.trim()
              : (resume ? storedResumeId : null)

            log.info('session-tools', 'delegate_to_codex_cli start', {
              sessionId: ctx?.sessionId || null,
              agentId: ctx?.agentId || null,
              cwd,
              timeoutMs: cliProcessTimeoutMs,
              removedCodexEnvKeys,
              resumeRequested: !!resume || !!resumeId,
              resumeId: resumeIdToUse || null,
              taskPreview: (task || '').slice(0, 200),
            })

            return new Promise<string>((resolve) => {
              const args = ['exec']
              if (resumeIdToUse) args.push('resume', resumeIdToUse)
              args.push('--json', '--full-auto', '--skip-git-repo-check', '-')
              const child = spawn(codexBinary, args, {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
              })
              let stdout = ''
              let stderr = ''
              let settled = false
              let timedOut = false
              const startedAt = Date.now()
              let agentText = ''
              let discoveredThreadId: string | null = null
              const eventErrors: string[] = []
              let stdoutBuf = ''

              const finish = (result: string) => {
                if (settled) return
                settled = true
                resolve(truncate(result, MAX_OUTPUT))
              }

              const timeoutHandle = setTimeout(() => {
                timedOut = true
                try { child.kill('SIGTERM') } catch { /* ignore */ }
                setTimeout(() => {
                  try { child.kill('SIGKILL') } catch { /* ignore */ }
                }, 5000)
              }, cliProcessTimeoutMs)

              log.info('session-tools', 'delegate_to_codex_cli spawned', {
                sessionId: ctx?.sessionId || null,
                pid: child.pid || null,
                args,
              })

              child.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString()
                stdout += text
                if (stdout.length > MAX_OUTPUT * 8) stdout = tail(stdout, MAX_OUTPUT * 8)

                stdoutBuf += text
                const lines = stdoutBuf.split('\n')
                stdoutBuf = lines.pop() || ''
                for (const line of lines) {
                  if (!line.trim()) continue
                  try {
                    const ev = JSON.parse(line)
                    if (typeof ev?.thread_id === 'string' && ev.thread_id.trim()) {
                      discoveredThreadId = ev.thread_id.trim()
                    }
                    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item?.text === 'string') {
                      agentText = ev.item.text
                    } else if (ev.type === 'item.completed' && ev.item?.type === 'message' && ev.item?.role === 'assistant') {
                      const content = ev.item.content
                      if (Array.isArray(content)) {
                        const txt = content
                          .filter((c: any) => c?.type === 'output_text' && typeof c?.text === 'string')
                          .map((c: any) => c.text)
                          .join('')
                        if (txt) agentText = txt
                      } else if (typeof content === 'string') {
                        agentText = content
                      }
                    } else if (ev.type === 'error' && ev.message) {
                      eventErrors.push(String(ev.message))
                    } else if (ev.type === 'turn.failed' && ev.error?.message) {
                      eventErrors.push(String(ev.error.message))
                    }
                  } catch {
                    // Ignore non-JSON lines in parser path; raw stdout still captured above.
                  }
                }
              })
              child.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString()
                if (stderr.length > MAX_OUTPUT * 8) stderr = tail(stderr, MAX_OUTPUT * 8)
              })
              child.on('error', (err) => {
                clearTimeout(timeoutHandle)
                log.error('session-tools', 'delegate_to_codex_cli child error', {
                  sessionId: ctx?.sessionId || null,
                  error: err?.message || String(err),
                })
                finish(`Error: failed to start Codex CLI: ${err?.message || String(err)}`)
              })
              child.on('close', (code, signal) => {
                clearTimeout(timeoutHandle)
                const durationMs = Date.now() - startedAt
                if (!discoveredThreadId) {
                  const guessed = extractResumeIdentifier(`${stdout}\n${stderr}`)
                  if (guessed) discoveredThreadId = guessed
                }
                if (discoveredThreadId) persistDelegateResumeId('codex', discoveredThreadId)
                log.info('session-tools', 'delegate_to_codex_cli child close', {
                  sessionId: ctx?.sessionId || null,
                  code,
                  signal: signal || null,
                  timedOut,
                  durationMs,
                  stdoutLen: stdout.length,
                  stderrLen: stderr.length,
                  eventErrorCount: eventErrors.length,
                  discoveredThreadId,
                  stderrPreview: tail(stderr, 240),
                })
                if (timedOut) {
                  const msg = [
                    `Error: Codex CLI timed out after ${Math.round(cliProcessTimeoutMs / 1000)}s.`,
                    stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                    eventErrors.length ? `event errors:\n${tail(eventErrors.join('\n'), 1200)}` : '',
                    'Try increasing "CLI Process Timeout (sec)" in Settings.',
                  ].filter(Boolean).join('\n\n')
                  finish(msg)
                  return
                }
                if (code === 0 && agentText.trim()) {
                  const out = discoveredThreadId
                    ? `${agentText.trim()}\n\n[delegate_meta]\nresume_id=${discoveredThreadId}`
                    : agentText.trim()
                  finish(out)
                  return
                }
                if (code === 0 && stdout.trim() && !eventErrors.length) {
                  const out = discoveredThreadId
                    ? `${stdout.trim()}\n\n[delegate_meta]\nresume_id=${discoveredThreadId}`
                    : stdout.trim()
                  finish(out)
                  return
                }
                const msg = [
                  `Error: Codex CLI exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`,
                  eventErrors.length ? `event errors:\n${tail(eventErrors.join('\n'), 1200)}` : '',
                  stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                  stdout.trim() ? `stdout:\n${tail(stdout, 1500)}` : '',
                ].filter(Boolean).join('\n\n')
                finish(msg || 'Error: Codex CLI returned no output.')
              })

              try {
                child.stdin?.write(task)
                child.stdin?.end()
              } catch (err: any) {
                clearTimeout(timeoutHandle)
                finish(`Error: failed to send task to Codex CLI: ${err?.message || String(err)}`)
              }
            })
          } catch (err: any) {
            return `Error delegating to Codex CLI: ${err.message}`
          }
        },
        {
          name: 'delegate_to_codex_cli',
          description: 'Delegate a complex task to Codex CLI. Use for deep coding/refactor tasks and shell-driven implementation work.',
          schema: z.object({
            task: z.string().describe('Detailed description of the task for Codex CLI'),
            resume: z.boolean().optional().describe('If true, try to resume the last saved Codex delegation thread for this SwarmClaw session'),
            resumeId: z.string().optional().describe('Explicit Codex thread id to resume (overrides resume=true memory)'),
          }),
        },
      ),
    )
    }

    if (opencodeBinary && wantsOpenCodeDelegate) {
    tools.push(
      tool(
        async ({ task, resume, resumeId }) => {
          try {
            const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
            const storedResumeId = readStoredDelegateResumeId('opencode')
            const resumeIdToUse = typeof resumeId === 'string' && resumeId.trim()
              ? resumeId.trim()
              : (resume ? storedResumeId : null)

            log.info('session-tools', 'delegate_to_opencode_cli start', {
              sessionId: ctx?.sessionId || null,
              agentId: ctx?.agentId || null,
              cwd,
              timeoutMs: cliProcessTimeoutMs,
              resumeRequested: !!resume || !!resumeId,
              resumeId: resumeIdToUse || null,
              taskPreview: (task || '').slice(0, 200),
            })

            return new Promise<string>((resolve) => {
              const args = ['run', task, '--format', 'json']
              if (resumeIdToUse) args.push('--session', resumeIdToUse)
              const child = spawn(opencodeBinary, args, {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
              })
              let stdout = ''
              let stderr = ''
              let discoveredSessionId: string | null = null
              let parsedText = ''
              const eventErrors: string[] = []
              let stdoutBuf = ''
              let settled = false
              let timedOut = false
              const startedAt = Date.now()

              const finish = (result: string) => {
                if (settled) return
                settled = true
                resolve(truncate(result, MAX_OUTPUT))
              }

              const timeoutHandle = setTimeout(() => {
                timedOut = true
                try { child.kill('SIGTERM') } catch { /* ignore */ }
                setTimeout(() => {
                  try { child.kill('SIGKILL') } catch { /* ignore */ }
                }, 5000)
              }, cliProcessTimeoutMs)

              log.info('session-tools', 'delegate_to_opencode_cli spawned', {
                sessionId: ctx?.sessionId || null,
                pid: child.pid || null,
                args: resumeIdToUse
                  ? ['run', '(task hidden)', '--format', 'json', '--session', resumeIdToUse]
                  : ['run', '(task hidden)', '--format', 'json'],
              })
              child.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString()
                stdout += text
                if (stdout.length > MAX_OUTPUT * 8) stdout = tail(stdout, MAX_OUTPUT * 8)
                stdoutBuf += text
                const lines = stdoutBuf.split('\n')
                stdoutBuf = lines.pop() || ''
                for (const line of lines) {
                  if (!line.trim()) continue
                  try {
                    const ev = JSON.parse(line)
                    if (typeof ev?.sessionID === 'string' && ev.sessionID.trim()) {
                      discoveredSessionId = ev.sessionID.trim()
                    }
                    if (ev?.type === 'text' && typeof ev?.part?.text === 'string') {
                      parsedText += ev.part.text
                    } else if (ev?.type === 'error') {
                      const msg = typeof ev?.error === 'string'
                        ? ev.error
                        : typeof ev?.message === 'string'
                          ? ev.message
                          : 'Unknown OpenCode event error'
                      eventErrors.push(msg)
                    }
                  } catch {
                    // keep raw stdout fallback
                  }
                }
              })
              child.stderr?.on('data', (chunk: Buffer) => {
                stderr += chunk.toString()
                if (stderr.length > MAX_OUTPUT * 8) stderr = tail(stderr, MAX_OUTPUT * 8)
              })
              child.on('error', (err) => {
                clearTimeout(timeoutHandle)
                log.error('session-tools', 'delegate_to_opencode_cli child error', {
                  sessionId: ctx?.sessionId || null,
                  error: err?.message || String(err),
                })
                finish(`Error: failed to start OpenCode CLI: ${err?.message || String(err)}`)
              })
              child.on('close', (code, signal) => {
                clearTimeout(timeoutHandle)
                const durationMs = Date.now() - startedAt
                const guessed = extractResumeIdentifier(`${stdout}\n${stderr}`)
                if (guessed) discoveredSessionId = guessed
                if (discoveredSessionId) persistDelegateResumeId('opencode', discoveredSessionId)
                log.info('session-tools', 'delegate_to_opencode_cli child close', {
                  sessionId: ctx?.sessionId || null,
                  code,
                  signal: signal || null,
                  timedOut,
                  durationMs,
                  stdoutLen: stdout.length,
                  stderrLen: stderr.length,
                  parsedTextLen: parsedText.length,
                  eventErrorCount: eventErrors.length,
                  discoveredSessionId,
                  stderrPreview: tail(stderr, 240),
                })
                if (timedOut) {
                  const msg = [
                    `Error: OpenCode CLI timed out after ${Math.round(cliProcessTimeoutMs / 1000)}s.`,
                    stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                    eventErrors.length ? `event errors:\n${tail(eventErrors.join('\n'), 1200)}` : '',
                    stdout.trim() ? `stdout:\n${tail(stdout, 1500)}` : '',
                    'Try increasing "CLI Process Timeout (sec)" in Settings.',
                  ].filter(Boolean).join('\n\n')
                  finish(msg)
                  return
                }
                const successText = parsedText.trim() || stdout.trim() || stderr.trim()
                if (code === 0 && successText) {
                  const out = discoveredSessionId
                    ? `${successText}\n\n[delegate_meta]\nresume_id=${discoveredSessionId}`
                    : successText
                  finish(out)
                  return
                }
                const msg = [
                  `Error: OpenCode CLI exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`,
                  eventErrors.length ? `event errors:\n${tail(eventErrors.join('\n'), 1200)}` : '',
                  stderr.trim() ? `stderr:\n${tail(stderr, 1500)}` : '',
                  stdout.trim() ? `stdout:\n${tail(stdout, 1500)}` : '',
                ].filter(Boolean).join('\n\n')
                finish(msg || 'Error: OpenCode CLI returned no output.')
              })
            })
          } catch (err: any) {
            return `Error delegating to OpenCode CLI: ${err.message}`
          }
        },
        {
          name: 'delegate_to_opencode_cli',
          description: 'Delegate a complex task to OpenCode CLI. Use for deep coding/refactor tasks and shell-driven implementation work.',
          schema: z.object({
            task: z.string().describe('Detailed description of the task for OpenCode CLI'),
            resume: z.boolean().optional().describe('If true, try to resume the last saved OpenCode delegation session for this SwarmClaw session'),
            resumeId: z.string().optional().describe('Explicit OpenCode session id to resume (overrides resume=true memory)'),
          }),
        },
      ),
    )
    }
  }

  // delegate_to_agent: requires "Assign to Other Agents" (platformAssignScope: 'all')
  if (ctx?.platformAssignScope === 'all' && ctx?.agentId) {
    tools.push(
      tool(
        async ({ agentId: targetAgentId, task: taskPrompt, description: taskDesc, startImmediately }) => {
          try {
            const agents = loadAgents()
            let target = agents[targetAgentId]
            let resolvedId = targetAgentId
            // Fallback: resolve by name if the ID doesn't match directly
            if (!target) {
              const byName = Object.values(agents).find(
                (a) => a.name.toLowerCase() === targetAgentId.toLowerCase(),
              )
              if (byName) {
                target = byName
                resolvedId = byName.id
              }
            }
            if (!target) return `Error: Agent "${targetAgentId}" not found. Use the agent directory in your system prompt to find valid agent IDs.`

            const taskId = crypto.randomBytes(4).toString('hex')
            const now = Date.now()
            const newTask = {
              id: taskId,
              title: taskPrompt.slice(0, 100),
              description: taskDesc || taskPrompt,
              status: 'todo',
              agentId: resolvedId,
              sourceType: 'delegation' as const,
              delegatedByAgentId: ctx.agentId!,
              createdAt: now,
              updatedAt: now,
              comments: [{
                id: crypto.randomBytes(4).toString('hex'),
                author: agents[ctx.agentId!]?.name || 'Agent',
                agentId: ctx.agentId!,
                text: `Delegated from ${agents[ctx.agentId!]?.name || ctx.agentId}`,
                createdAt: now,
              }],
            }
            // Atomic upsert to avoid race with concurrent queue processing
            upsertTask(taskId, newTask)
            console.log(`[delegate] Created task ${taskId} for agent ${resolvedId}, startImmediately=${startImmediately}`)

            // Verify it persisted
            const verify = loadTasks()
            if (!verify[taskId]) {
              console.error(`[delegate] RACE: task ${taskId} not found after upsert!`)
            }

            if (startImmediately) {
              // Lazy import to avoid circular: session-tools → queue → chat-execution → session-tools
              const { enqueueTask } = await import('../queue')
              enqueueTask(taskId)
              console.log(`[delegate] Enqueued task ${taskId}`)
            }

            return JSON.stringify({
              ok: true,
              taskId,
              agentId: resolvedId,
              agentName: target.name,
              message: startImmediately
                ? `Task delegated to ${target.name} and queued for immediate execution. Task ID: ${taskId}.`
                : `Task delegated to ${target.name}. Task ID: ${taskId}. Status: todo. Ask the user if they want to start it now — call again with startImmediately: true to queue it.`,
            })
          } catch (err: unknown) {
            return `Error delegating task: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'delegate_to_agent',
          description: 'Delegate a task to another agent. Creates a task on the task board. By default the task goes to "todo" status. Set startImmediately=true to queue it for execution right away. Ask the user to confirm before starting immediately.',
          schema: z.object({
            agentId: z.string().describe('ID or name of the target agent to delegate to'),
            task: z.string().describe('What the target agent should do'),
            description: z.string().optional().describe('Optional longer description of the task'),
            startImmediately: z.boolean().optional().default(false).describe('If true, queue the task for immediate execution instead of putting it in todo'),
          }),
        },
      ),
    )
  }

  return tools
}
