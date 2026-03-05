import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as os from 'os'
import { loadSettings } from '../storage'
import type { ToolBuildContext } from './context'
import { MAX_OUTPUT, truncate } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

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

/**
 * Core OpenClaw Workspace Execution Logic
 */
async function executeWorkspaceAction(args: any) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const message = normalized.message as string | undefined
  const commitHash = normalized.commitHash as string | undefined
  const limit = normalized.limit as number | undefined
  const action = typeof normalized.action === 'string' && normalized.action.trim() ? normalized.action.trim() : 'history'
  try {
    const workspace = resolveWorkspacePath()
    const inGitRepo = async (): Promise<boolean> => {
      try {
        await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspace, timeout: 5000 })
        return true
      } catch {
        return false
      }
    }

    if (action === 'backup') {
      if (!(await inGitRepo())) {
        return JSON.stringify({ ok: false, error: `Workspace is not a git repo: ${workspace}` })
      }
      const label = message || new Date().toISOString().replace(/[:.]/g, '-')
      await gitInWorkspace(['add', '-A'])
      const status = await gitInWorkspace(['status', '--porcelain'])
      if (!status.stdout.trim()) return JSON.stringify({ ok: true, message: 'Clean.' })
      await gitInWorkspace(['commit', '-m', `backup: ${label}`])
      const { stdout } = await gitInWorkspace(['rev-parse', 'HEAD'])
      return JSON.stringify({ ok: true, commitHash: stdout.trim() })
    }

    if (action === 'rollback') {
      if (!(await inGitRepo())) {
        return JSON.stringify({ ok: false, error: `Workspace is not a git repo: ${workspace}` })
      }
      let target = commitHash
      if (!target) {
        const { stdout } = await gitInWorkspace(['log', '--oneline', '--format=%H %s', '-50'])
        const lines = stdout.trim().split('\n').filter(Boolean)
        const stable = lines.find(l => !/^(rollback|daily|auto|backup:)/i.test(l.substring(41)))
        if (!stable) return JSON.stringify({ ok: false, error: 'No stable commit.' })
        target = stable.substring(0, 40)
      }
      await gitInWorkspace(['reset', '--hard', target])
      return JSON.stringify({ ok: true, rolledBackTo: target })
    }

    if (action === 'history') {
      if (!(await inGitRepo())) {
        return JSON.stringify({ ok: false, error: `Workspace is not a git repo: ${workspace}` })
      }
      const count = Math.max(1, Math.min(limit ?? 20, 100))
      const { stdout } = await gitInWorkspace(['log', '--oneline', `--format=%H %s`, `-${count}`])
      const commits = stdout.trim().split('\n').filter(Boolean).map(l => ({ hash: l.substring(0, 40), message: l.substring(41) }))
      return JSON.stringify({ commits })
    }

    return `Unknown action "${action}".`
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: err.stderr || err.message })
  }
}

/**
 * Register as a Built-in Plugin
 */
const WorkspacePlugin: Plugin = {
  name: 'OpenClaw Workspace',
  description: 'Manage OpenClaw workspace versioning: backup, rollback, and history.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'openclaw_workspace',
      description: 'Versioning tools for the OpenClaw workspace.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['backup', 'rollback', 'history'] },
          message: { type: 'string' },
          commitHash: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['action']
      },
      execute: async (args) => executeWorkspaceAction(args)
    }
  ]
}

getPluginManager().registerBuiltin('openclaw_workspace', WorkspacePlugin)

/**
 * Legacy Bridge
 */
export function buildOpenClawWorkspaceTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('openclaw_workspace')) return []
  return [
    tool(
      async (args) => executeWorkspaceAction(args),
      {
        name: 'openclaw_workspace',
        description: WorkspacePlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
