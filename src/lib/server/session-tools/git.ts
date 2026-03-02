import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ToolBuildContext } from './context'
import { findBinaryOnPath, safePath, truncate, MAX_OUTPUT } from './context'

const execFileAsync = promisify(execFile)

const GIT_ACTIONS = [
  'status', 'log', 'diff', 'commit', 'add', 'push', 'pull',
  'branch', 'checkout', 'stash', 'merge', 'clone', 'remote',
  'tag', 'reset', 'show',
] as const

export function buildGitTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasTool('git')) return []

  const gitPath = findBinaryOnPath('git')
  if (!gitPath) return []

  return [
    tool(
      async ({ action, args, repoPath, timeoutSec }) => {
        try {
          const cwd = repoPath ? safePath(bctx.cwd, repoPath) : bctx.cwd
          const timeout = Math.max(5, Math.min(timeoutSec ?? 60, 300)) * 1000

          // Verify we're in a git repo (except for clone)
          if (action !== 'clone') {
            try {
              await execFileAsync(gitPath, ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 })
            } catch {
              return JSON.stringify({ error: `Not a git repository: ${cwd}` })
            }
          }

          const cmdArgs = [action, ...(args ?? [])]
          const result = await execFileAsync(gitPath, cmdArgs, {
            cwd,
            timeout,
            maxBuffer: MAX_OUTPUT,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          })
          return JSON.stringify({
            exitCode: 0,
            stdout: truncate(result.stdout ?? '', MAX_OUTPUT),
            stderr: truncate(result.stderr ?? '', MAX_OUTPUT),
          })
        } catch (err: unknown) {
          const execErr = err as { code?: number; stdout?: string; stderr?: string; message?: string }
          return JSON.stringify({
            exitCode: execErr.code ?? 1,
            stdout: truncate(execErr.stdout ?? '', MAX_OUTPUT),
            stderr: truncate(execErr.stderr ?? execErr.message ?? String(err), MAX_OUTPUT),
          })
        }
      },
      {
        name: 'git',
        description: 'Run git operations. Verify the repo exists before committing or pushing. Use args for subcommand flags (e.g. args: ["-m", "message"] for commit).',
        schema: z.object({
          action: z.enum(GIT_ACTIONS).describe('Git subcommand to run'),
          args: z.array(z.string()).optional().describe('Additional arguments (e.g. ["-m", "fix: typo"], ["--oneline", "-n", "5"])'),
          repoPath: z.string().optional().describe('Relative path to git repo (defaults to working directory)'),
          timeoutSec: z.number().optional().describe('Timeout in seconds (default 60, max 300)'),
        }),
      },
    ),
  ]
}
