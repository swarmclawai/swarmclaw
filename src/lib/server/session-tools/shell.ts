import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import {
  clearManagedProcess,
  getManagedProcess,
  killManagedProcess,
  listManagedProcesses,
  pollManagedProcess,
  readManagedProcessLog,
  removeManagedProcess,
  startManagedProcess,
  writeManagedProcessStdin,
} from '../process-manager'
import type { ToolBuildContext } from './context'
import { safePath, truncate, coerceEnvMap, MAX_OUTPUT } from './context'

export function buildShellTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx, hasTool, commandTimeoutMs } = bctx

  if (hasTool('shell')) {
    tools.push(
      tool(
        async ({ command, background, yieldMs, timeoutSec, env, workdir }) => {
          try {
            const result = await startManagedProcess({
              command,
              cwd: workdir ? safePath(cwd, workdir) : cwd,
              env: coerceEnvMap(env),
              agentId: ctx?.agentId || null,
              sessionId: ctx?.sessionId || null,
              background: !!background,
              yieldMs: typeof yieldMs === 'number' ? yieldMs : undefined,
              timeoutMs: typeof timeoutSec === 'number'
                ? Math.max(1, Math.trunc(timeoutSec)) * 1000
                : commandTimeoutMs,
            })
            if (result.status === 'completed') {
              return truncate(result.output || '(no output)', MAX_OUTPUT)
            }
            return JSON.stringify({
              status: 'running',
              processId: result.processId,
              tail: result.tail || '',
            }, null, 2)
          } catch (err: any) {
            return truncate(`Error: ${err.message || String(err)}`, MAX_OUTPUT)
          }
        },
        {
          name: 'execute_command',
          description: 'Execute a shell command in the session working directory. Supports background mode and timeout/yield controls.',
          schema: z.object({
            command: z.string().describe('The shell command to execute'),
            background: z.boolean().optional().describe('If true, start command in background immediately'),
            yieldMs: z.number().optional().describe('If command runs longer than this, return a running process id instead of blocking'),
            timeoutSec: z.number().optional().describe('Per-command timeout in seconds'),
            workdir: z.string().optional().describe('Relative working directory override'),
            env: z.record(z.string(), z.string()).optional().describe('Environment variable overrides'),
          }),
        },
      ),
    )
  }

  if (hasTool('process')) {
    tools.push(
      tool(
        async ({ action, processId, offset, limit, data, eof, signal }) => {
          try {
            if (action === 'list') {
              return JSON.stringify(listManagedProcesses(ctx?.agentId || null).map((p) => ({
                id: p.id,
                command: p.command,
                status: p.status,
                pid: p.pid,
                startedAt: p.startedAt,
                endedAt: p.endedAt,
                exitCode: p.exitCode,
                signal: p.signal,
              })), null, 2)
            }

            if (!processId) return 'Error: processId is required for this action.'

            const ownerCheck = getManagedProcess(processId)
            if (ownerCheck && ctx?.sessionId && ownerCheck.sessionId && ownerCheck.sessionId !== ctx.sessionId) {
              return `Error: process ${processId} belongs to a different session.`
            }

            if (action === 'poll') {
              const res = pollManagedProcess(processId)
              if (!res) return `Process not found: ${processId}`
              return JSON.stringify({
                id: res.process.id,
                status: res.process.status,
                exitCode: res.process.exitCode,
                signal: res.process.signal,
                chunk: res.chunk,
              }, null, 2)
            }

            if (action === 'log') {
              const res = readManagedProcessLog(processId, offset, limit)
              if (!res) return `Process not found: ${processId}`
              return JSON.stringify({
                id: res.process.id,
                status: res.process.status,
                totalLines: res.totalLines,
                text: res.text,
              }, null, 2)
            }

            if (action === 'write') {
              const out = writeManagedProcessStdin(processId, data || '', !!eof)
              return out.ok ? `Wrote to process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'kill') {
              const out = killManagedProcess(processId, (signal as NodeJS.Signals) || 'SIGTERM')
              return out.ok ? `Killed process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'clear') {
              const out = clearManagedProcess(processId)
              return out.ok ? `Cleared process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'remove') {
              const out = removeManagedProcess(processId)
              return out.ok ? `Removed process ${processId}` : `Error: ${out.error}`
            }

            if (action === 'status') {
              const p = getManagedProcess(processId)
              if (!p) return `Process not found: ${processId}`
              return JSON.stringify({
                id: p.id,
                status: p.status,
                pid: p.pid,
                startedAt: p.startedAt,
                endedAt: p.endedAt,
                exitCode: p.exitCode,
                signal: p.signal,
              }, null, 2)
            }

            return `Unknown action "${action}".`
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'process_tool',
          description: 'Manage long-running shell processes started by execute_command. Supports list, status, poll, log, write, kill, clear, and remove.',
          schema: z.object({
            action: z.enum(['list', 'status', 'poll', 'log', 'write', 'kill', 'clear', 'remove']),
            processId: z.string().optional(),
            offset: z.number().optional(),
            limit: z.number().optional(),
            data: z.string().optional(),
            eof: z.boolean().optional(),
            signal: z.string().optional().describe('Signal for kill action, e.g. SIGTERM or SIGKILL'),
          }),
        },
      ),
    )
  }

  return tools
}
