import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ToolBuildContext } from './context'
import { findBinaryOnPath, safePath, truncate, MAX_OUTPUT } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

const execFileAsync = promisify(execFile)

const GIT_ACTIONS = [
  'status', 'log', 'diff', 'commit', 'add', 'push', 'pull',
  'branch', 'checkout', 'stash', 'merge', 'clone', 'remote',
  'tag', 'reset', 'show',
] as const

/**
 * Core Git Execution Logic
 */
async function executeGitAction(args: Record<string, unknown>, bctx: { cwd: string; filesystemScope?: 'workspace' | 'machine' }) {
  const normalized = normalizeToolInputArgs(args)
  const action = typeof normalized.action === 'string' ? normalized.action : ''
  const cmdArgsRaw = (normalized.args ?? normalized.commandArgs ?? normalized.cmdArgs) as string[] | undefined
  const repoPath = (normalized.repoPath ?? normalized.path) as string | undefined
  const timeoutSec = (normalized.timeoutSec ?? normalized.timeout) as number | undefined
  const gitPath = findBinaryOnPath('git')
  if (!gitPath) return JSON.stringify({ error: 'Git binary not found on system path' })
  if (!action || !GIT_ACTIONS.includes(action as (typeof GIT_ACTIONS)[number])) {
    return JSON.stringify({ error: `Invalid or missing git action. Allowed: ${GIT_ACTIONS.join(', ')}` })
  }

  try {
    const cwd = repoPath ? safePath(bctx.cwd, repoPath, bctx.filesystemScope) : bctx.cwd
    const timeout = Math.max(5, Math.min(timeoutSec ?? 60, 300)) * 1000

    if (action !== 'clone') {
      try {
        await execFileAsync(gitPath, ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 })
      } catch {
        return JSON.stringify({ error: `Not a git repository: ${cwd}` })
      }
    }

    const cmdArgs = [action, ...(cmdArgsRaw ?? [])]
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
}

/**
 * Register as a Built-in Plugin
 */
const GitPlugin: Plugin = {
  name: 'Core Git',
  description: 'Structured git operations: status, commit, push, diff, and more.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'git',
      description: 'Run git operations in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...GIT_ACTIONS] },
          args: { type: 'array', items: { type: 'string' } },
          repoPath: { type: 'string' },
          timeoutSec: { type: 'number' }
        },
        required: ['action']
      },
      execute: async (args, context) => executeGitAction(args, { cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('git', GitPlugin)

/**
 * Legacy Bridge
 */
export function buildGitTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('git')) return []
  return [
    tool(
      async (args) => executeGitAction(args, { cwd: bctx.cwd, filesystemScope: bctx.filesystemScope }),
      {
        name: 'git',
        description: GitPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
