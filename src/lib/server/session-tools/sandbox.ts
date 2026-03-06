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

const EXT_MAP: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
}

function sandboxUnavailableError(reason: string): string {
  return JSON.stringify({
    error: reason,
    guidance: [
      'Install Deno or run `npm run setup:easy` to enable sandbox_exec.',
      'Use http_request for straightforward API calls.',
      'Use plugin_creator plus manage_schedules for recurring automations.',
    ],
  })
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

  if (language !== 'javascript' && language !== 'typescript') {
    return sandboxUnavailableError('sandbox_exec currently supports only JavaScript and TypeScript via Deno.')
  }

  if (!denoPath) {
    return sandboxUnavailableError('Deno is required for sandbox_exec. Unsafe Node/Python fallbacks are disabled.')
  }

  try {
    fs.mkdirSync(sandboxDir, { recursive: true })
    const scriptFile = `script.${ext}`
    const scriptPath = path.join(sandboxDir, scriptFile)
    fs.writeFileSync(scriptPath, code, 'utf-8')

    const result = spawnSync(denoPath, [
      'run',
      '--allow-read=.',
      '--allow-write=.',
      '--allow-net',
      '--deny-env',
      '--no-prompt',
      scriptFile,
    ], { cwd: sandboxDir, encoding: 'utf-8', timeout, maxBuffer: MAX_OUTPUT })

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
  const denoPath = getDenoPath()
  if (!denoPath) {
    return sandboxUnavailableError('Deno is not available for sandbox_exec.')
  }
  const ver = spawnSync(denoPath, ['--version'], { encoding: 'utf-8', timeout: 3000 })
  return JSON.stringify({
    deno: {
      available: true,
      version: (ver.stdout || '').split('\n')[0]?.trim() || null,
    },
    sandboxReady: true,
  })
}

/**
 * Register as a Built-in Plugin
 */
const SandboxPlugin: Plugin = {
  name: 'Core Sandbox',
  description: 'Deno-based isolated code execution for JavaScript and TypeScript when custom code is necessary.',
  hooks: {
    getCapabilityDescription: () => 'I can run JavaScript or TypeScript in a Deno sandbox (`sandbox_exec`) when custom code is necessary. For straightforward API calls, use `http_request` instead.',
    getOperatingGuidance: () => [
      'Use `http_request` for straightforward REST/JSON API calls instead of writing code in `sandbox_exec`.',
      'Use `sandbox_exec` only when custom parsing or transformation code is actually needed.',
      'For recurring automations, prefer `plugin_creator` plus `manage_schedules` over repeated sandbox runs.',
    ],
  } as PluginHooks,
  tools: [
    {
      name: 'sandbox_exec',
      description: 'Execute JavaScript or TypeScript in a Deno sandbox when custom code is necessary.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'typescript'] },
          code: { type: 'string' },
          timeoutSec: { type: 'number' }
        },
        required: ['language', 'code']
      },
      execute: async (args, context) => executeSandboxExec(args, { sessionId: context.session.id })
    },
    {
      name: 'sandbox_list_runtimes',
      description: 'Report whether the Deno sandbox runtime is available.',
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
        schema: z.object({
          language: z.enum(['javascript', 'typescript']),
          code: z.string(),
          timeoutSec: z.number().optional(),
        })
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

  return tools
}
