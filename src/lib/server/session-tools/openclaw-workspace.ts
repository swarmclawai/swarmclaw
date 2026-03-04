import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as os from 'os'
import { loadSettings } from '../storage'
import type { ToolBuildContext } from './context'
import { MAX_OUTPUT } from './context'

const execFileAsync = promisify(execFile)

function resolveWorkspacePath(): string {
  const settings = loadSettings()
  if (typeof settings.openclawWorkspacePath === 'string' && settings.openclawWorkspacePath.trim()) {
    return settings.openclawWorkspacePath.trim()
  }
  return path.join(os.homedir(), '.openclaw', 'workspace')
}

async function gitInWorkspace(args: string[], timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  const cwd = resolveWorkspacePath()
  return execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

export function buildOpenClawWorkspaceTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasTool('openclaw_workspace')) return []

  return [
    tool(
      async ({ message }) => {
        try {
          const workspace = resolveWorkspacePath()
          // Verify it's a git repo
          await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: workspace,
            timeout: 5000,
          })

          const label = message || new Date().toISOString().replace(/[:.]/g, '-')
          await gitInWorkspace(['add', '-A'])

          // Check if there's anything to commit
          const status = await gitInWorkspace(['status', '--porcelain'])
          if (!status.stdout.trim()) {
            return JSON.stringify({ ok: true, commitHash: null, message: 'Nothing to commit — workspace is clean.' })
          }

          await gitInWorkspace(['commit', '-m', `backup: ${label}`])
          const { stdout } = await gitInWorkspace(['rev-parse', 'HEAD'])
          return JSON.stringify({ ok: true, commitHash: stdout.trim() })
        } catch (err: unknown) {
          const execErr = err as { stderr?: string; message?: string }
          return JSON.stringify({ ok: false, error: execErr.stderr || execErr.message || String(err) })
        }
      },
      {
        name: 'openclaw_workspace_backup',
        description: 'Create a git backup of the OpenClaw workspace. Stages all changes and commits.',
        schema: z.object({
          message: z.string().optional().describe('Optional backup message (defaults to timestamp)'),
        }),
      },
    ),
    tool(
      async ({ commitHash }) => {
        try {
          if (!commitHash) {
            // Find first stable commit (skip auto-generated ones)
            const { stdout } = await gitInWorkspace(['log', '--oneline', '--format=%H %s', '-50'])
            const lines = stdout.trim().split('\n').filter(Boolean)
            const autoPattern = /^(rollback|daily-backup|auto-backup|guardian-auto|backup:)/i
            const stable = lines.find((line) => {
              const msg = line.substring(41) // after hash + space
              return !autoPattern.test(msg)
            })
            if (!stable) {
              return JSON.stringify({ ok: false, error: 'No stable commit found to roll back to.' })
            }
            commitHash = stable.substring(0, 40)
          }

          const { stdout: prevHead } = await gitInWorkspace(['rev-parse', 'HEAD'])
          await gitInWorkspace(['reset', '--hard', commitHash])
          return JSON.stringify({ ok: true, rolledBackTo: commitHash, previousHead: prevHead.trim() })
        } catch (err: unknown) {
          const execErr = err as { stderr?: string; message?: string }
          return JSON.stringify({ ok: false, error: execErr.stderr || execErr.message || String(err) })
        }
      },
      {
        name: 'openclaw_workspace_rollback',
        description: 'Roll back the OpenClaw workspace to a specific commit, or automatically find the last stable (non-auto-generated) commit.',
        schema: z.object({
          commitHash: z.string().optional().describe('Target commit hash (if omitted, uses the last stable commit)'),
        }),
      },
    ),
    tool(
      async ({ limit }) => {
        try {
          const count = Math.max(1, Math.min(limit ?? 20, 100))
          const { stdout } = await gitInWorkspace(['log', '--oneline', `--format=%H %s`, `-${count}`])
          const commits = stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => ({
              hash: line.substring(0, 40),
              message: line.substring(41),
            }))
          return JSON.stringify({ commits })
        } catch (err: unknown) {
          const execErr = err as { stderr?: string; message?: string }
          return JSON.stringify({ ok: false, error: execErr.stderr || execErr.message || String(err) })
        }
      },
      {
        name: 'openclaw_workspace_history',
        description: 'List recent git commits in the OpenClaw workspace.',
        schema: z.object({
          limit: z.number().optional().describe('Number of commits to return (default 20, max 100)'),
        }),
      },
    ),
  ]
}
