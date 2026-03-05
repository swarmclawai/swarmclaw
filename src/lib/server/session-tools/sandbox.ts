import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { UPLOAD_DIR } from '../storage'
import { findBinaryOnPath, truncate, MAX_OUTPUT } from './context'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

function getDenoPath(): string | null {
  return findBinaryOnPath('deno')
}

function getNodePath(): string | null {
  return findBinaryOnPath('node')
}

function getTsxPath(): string | null {
  return findBinaryOnPath('tsx')
}

function getPythonPath(): string | null {
  return findBinaryOnPath('python3') ?? findBinaryOnPath('python')
}

const EXT_MAP: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
}

/**
 * Core Sandbox Execution Logic
 */
async function executeSandboxExec(args: any, context: { sessionId?: string; cwd?: string }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const language = normalized.language as string
  const code = normalized.code as string
  const timeoutSec = normalized.timeoutSec as number | undefined
  const timeout = Math.min(Math.max(timeoutSec ?? 60, 5), 300) * 1000
  const ext = EXT_MAP[language]
  const sessionId = context.sessionId ?? 'unknown'
  const sandboxDir = path.join('/tmp', `swarmclaw-sandbox-${sessionId}-${Date.now()}`)
  const denoPath = getDenoPath()
  const nodePath = getNodePath()
  const tsxPath = getTsxPath()
  const pythonPath = getPythonPath()

  if (language === 'javascript' && !denoPath && !nodePath) {
    return JSON.stringify({ error: 'No JavaScript runtime available. Install Deno or Node.js.' })
  }
  if (language === 'typescript' && !denoPath && !tsxPath) {
    return JSON.stringify({ error: 'No TypeScript runtime available. Install Deno or tsx.' })
  }
  if (language === 'python' && !pythonPath) {
    return JSON.stringify({ error: 'Python is not installed.' })
  }

  try {
    fs.mkdirSync(sandboxDir, { recursive: true })
    const scriptFile = `script.${ext}`
    const scriptPath = path.join(sandboxDir, scriptFile)
    fs.writeFileSync(scriptPath, code, 'utf-8')

    let result: ReturnType<typeof spawnSync>

    if (language === 'javascript') {
      if (denoPath) {
        result = spawnSync(denoPath, [
          'run', '--allow-read=.', '--allow-write=.', '--allow-net', '--deny-env', '--no-prompt', scriptFile,
        ], { cwd: sandboxDir, encoding: 'utf-8', timeout, maxBuffer: MAX_OUTPUT })
      } else {
        result = spawnSync(nodePath!, [scriptPath], {
          cwd: sandboxDir, encoding: 'utf-8', timeout, maxBuffer: MAX_OUTPUT,
          env: { PATH: process.env.PATH || '/usr/bin:/bin' } as any,
        })
      }
    } else if (language === 'typescript') {
      if (denoPath) {
        result = spawnSync(denoPath, [
          'run', '--allow-read=.', '--allow-write=.', '--allow-net', '--deny-env', '--no-prompt', scriptFile,
        ], { cwd: sandboxDir, encoding: 'utf-8', timeout, maxBuffer: MAX_OUTPUT })
      } else {
        result = spawnSync(tsxPath!, [scriptPath], {
          cwd: sandboxDir, encoding: 'utf-8', timeout, maxBuffer: MAX_OUTPUT,
          env: { PATH: process.env.PATH || '/usr/bin:/bin' } as any,
        })
      }
    } else {
      result = spawnSync(pythonPath!, [scriptPath], {
        cwd: sandboxDir, encoding: 'utf-8', timeout, maxBuffer: MAX_OUTPUT,
        env: { PATH: process.env.PATH || '/usr/bin:/bin' } as any,
      })
    }

    const stdout = truncate((result.stdout || '').toString(), MAX_OUTPUT)
    const stderr = truncate((result.stderr || '').toString(), MAX_OUTPUT)
    const exitCode = result.status ?? (result.error ? 1 : 0)
    const timedOut = !!(result.error?.message?.includes('ETIMEDOUT') || result.signal === 'SIGTERM')

    const artifacts: { name: string; url: string }[] = []
    try {
      const files = fs.readdirSync(sandboxDir)
      for (const file of files) {
        if (file === scriptFile) continue
        const src = path.join(sandboxDir, file)
        if (!fs.statSync(src).isFile()) continue
        fs.mkdirSync(UPLOAD_DIR, { recursive: true })
        const destName = `sandbox-${Date.now()}-${file}`
        const dest = path.join(UPLOAD_DIR, destName)
        fs.copyFileSync(src, dest)
        artifacts.push({ name: file, url: `/api/uploads/${encodeURIComponent(destName)}` })
      }
    } catch { /* ignore */ }

    return JSON.stringify({ exitCode, timedOut, stdout, stderr, artifacts })
  } catch (err: any) {
    return JSON.stringify({ error: err.message })
  } finally {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

async function executeListRuntimes() {
  const runtimes: Record<string, any> = {}
  for (const [name, bin] of [['deno', getDenoPath()], ['node', getNodePath()], ['tsx', getTsxPath()], ['python', getPythonPath()]] as const) {
    if (bin) {
      const ver = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 3000 })
      runtimes[name] = { available: true, version: (ver.stdout || '').split('\n')[0]?.trim() || null }
    } else {
      runtimes[name] = { available: false }
    }
  }
  return JSON.stringify(runtimes)
}

/**
 * Register as a Built-in Plugin
 */
const SandboxPlugin: Plugin = {
  name: 'Core Sandbox',
  description: 'Secure isolated code execution for JS, TS, and Python.',
  hooks: {
    getCapabilityDescription: () => 'I can run code in a sandbox (`sandbox_exec`) — JS/TS via Deno or Python, in an isolated environment. I get stdout, stderr, and any files created.',
  } as PluginHooks,
  tools: [
    {
      name: 'sandbox_exec',
      description: 'Execute code in an isolated sandbox.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'typescript', 'python'] },
          code: { type: 'string' },
          timeoutSec: { type: 'number' }
        },
        required: ['language', 'code']
      },
      execute: async (args, context) => executeSandboxExec(args, { sessionId: context.session.id })
    },
    {
      name: 'sandbox_list_runtimes',
      description: 'List available sandbox runtimes.',
      parameters: { type: 'object', properties: {} },
      execute: async () => executeListRuntimes()
    }
  ]
}

getPluginManager().registerBuiltin('sandbox', SandboxPlugin)

/**
 * Legacy Bridge
 */
export function buildSandboxTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('sandbox')) return []
  const tools: StructuredToolInterface[] = []

  tools.push(
    tool(
      async (args) => executeSandboxExec(args, { sessionId: bctx.ctx?.sessionId || undefined }),
      {
        name: 'sandbox_exec',
        description: SandboxPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    ),
    tool(
      async () => executeListRuntimes(),
      {
        name: 'sandbox_list_runtimes',
        description: SandboxPlugin.tools![1].description,
        schema: z.object({}).passthrough()
      }
    )
  )

  const openclawPath = findBinaryOnPath('openclaw') || findBinaryOnPath('clawdbot')
  if (openclawPath) {
    tools.push(
      tool(
        async (rawArgs) => {
          const normalized = normalizeToolInputArgs((rawArgs ?? {}) as Record<string, unknown>)
          const code = normalized.code as string | undefined
          const explain = normalized.explain as boolean | undefined
          try {
            if (!code) return JSON.stringify({ error: 'code is required' })
            const args = explain ? ['sandbox', 'explain', code] : ['sandbox', 'run', code]
            const result = spawnSync(openclawPath, args, { encoding: 'utf-8', timeout: 60_000, maxBuffer: MAX_OUTPUT })
            return JSON.stringify({ exitCode: result.status ?? 0, stdout: truncate(result.stdout || '', MAX_OUTPUT), stderr: truncate(result.stderr || '', MAX_OUTPUT) })
          } catch (err: any) { return JSON.stringify({ error: err.message }) }
        },
        {
          name: 'openclaw_sandbox',
          description: 'Execute or explain code through OpenClaw CLI.',
          schema: z.object({ code: z.string(), explain: z.boolean().optional() }),
        }
      )
    )
  }

  return tools
}
