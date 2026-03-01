import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { UPLOAD_DIR } from '../storage'
import { findBinaryOnPath, truncate, MAX_OUTPUT } from './context'
import type { ToolBuildContext } from './context'

function getDenoPath(): string | null {
  return findBinaryOnPath('deno')
}

function getPythonPath(): string | null {
  return findBinaryOnPath('python3') ?? findBinaryOnPath('python')
}

const EXT_MAP: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
}

export function buildSandboxTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasTool('sandbox')) return []

  const tools: StructuredToolInterface[] = []

  tools.push(
    tool(
      async ({ language, code, timeoutSec }) => {
        const timeout = Math.min(Math.max(timeoutSec ?? 60, 5), 300) * 1000
        const ext = EXT_MAP[language]
        const sessionId = bctx.ctx?.sessionId ?? 'unknown'
        const sandboxDir = path.join('/tmp', `swarmclaw-sandbox-${sessionId}-${Date.now()}`)

        // Check runtime availability
        if ((language === 'javascript' || language === 'typescript') && !getDenoPath()) {
          return JSON.stringify({ error: 'Deno is not installed. Install it with: curl -fsSL https://deno.land/install.sh | sh' })
        }
        if (language === 'python' && !getPythonPath()) {
          return JSON.stringify({ error: 'Python is not installed. Install python3 to use Python sandbox.' })
        }

        try {
          fs.mkdirSync(sandboxDir, { recursive: true })
          const scriptFile = `script.${ext}`
          const scriptPath = path.join(sandboxDir, scriptFile)
          fs.writeFileSync(scriptPath, code, 'utf-8')

          let result: ReturnType<typeof spawnSync>

          if (language === 'javascript' || language === 'typescript') {
            const denoPath = getDenoPath()!
            result = spawnSync(denoPath, [
              'run',
              '--allow-read=.',
              '--allow-write=.',
              '--allow-net',
              '--deny-env',
              '--no-prompt',
              scriptFile,
            ], {
              cwd: sandboxDir,
              encoding: 'utf-8',
              timeout,
              maxBuffer: MAX_OUTPUT,
            })
          } else {
            const pythonPath = getPythonPath()!
            result = spawnSync(pythonPath, [scriptPath], {
              cwd: sandboxDir,
              encoding: 'utf-8',
              timeout,
              maxBuffer: MAX_OUTPUT,
              env: { PATH: process.env.PATH || '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv,
            })
          }

          const stdout = truncate((result.stdout || '').toString(), MAX_OUTPUT)
          const stderr = truncate((result.stderr || '').toString(), MAX_OUTPUT)
          const exitCode = result.status ?? (result.error ? 1 : 0)
          const timedOut = result.error?.message?.includes('ETIMEDOUT') || result.signal === 'SIGTERM'

          // Scan for created files (exclude the script itself)
          const artifacts: { name: string; url: string }[] = []
          try {
            const files = fs.readdirSync(sandboxDir)
            for (const file of files) {
              if (file === scriptFile) continue
              const src = path.join(sandboxDir, file)
              const stat = fs.statSync(src)
              if (!stat.isFile()) continue
              // Copy to upload dir
              fs.mkdirSync(UPLOAD_DIR, { recursive: true })
              const destName = `sandbox-${Date.now()}-${file}`
              const dest = path.join(UPLOAD_DIR, destName)
              fs.copyFileSync(src, dest)
              artifacts.push({
                name: file,
                url: `/api/uploads/${encodeURIComponent(destName)}`,
              })
            }
          } catch {
            // ignore scan errors
          }

          return JSON.stringify({
            exitCode,
            timedOut,
            stdout,
            stderr,
            artifacts,
          })
        } catch (err: unknown) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        } finally {
          try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      },
      {
        name: 'sandbox_exec',
        description:
          'Execute code in an isolated sandbox. JS/TS runs via Deno with network access but no env vars. Python runs with a stripped environment. ' +
          'Files created in the sandbox directory are returned as downloadable artifact URLs. Use this for data processing, API calls, calculations, and file generation.',
        schema: z.object({
          language: z.enum(['javascript', 'typescript', 'python']).describe('Programming language to execute'),
          code: z.string().describe('Source code to run'),
          timeoutSec: z.number().optional().describe('Execution timeout in seconds (default 60, max 300)'),
        }),
      },
    ),
  )

  tools.push(
    tool(
      async () => {
        const denoPath = getDenoPath()
        const pythonPath = getPythonPath()

        const runtimes: Record<string, { available: boolean; path: string | null; version: string | null }> = {}

        for (const [name, bin] of [['deno', denoPath], ['python', pythonPath]] as const) {
          if (bin) {
            const ver = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 3000 })
            const version = (ver.stdout || '').split('\n')[0]?.trim() || null
            runtimes[name] = { available: true, path: bin, version }
          } else {
            runtimes[name] = { available: false, path: null, version: null }
          }
        }

        return JSON.stringify(runtimes)
      },
      {
        name: 'sandbox_list_runtimes',
        description: 'List available sandbox runtimes (Deno for JS/TS, Python) and their versions. Use this to check what languages are available before running code.',
        schema: z.object({}),
      },
    ),
  )

  // ---- openclaw_sandbox (CLI passthrough) -----------------------------------

  const openclawSandboxPath = findBinaryOnPath('openclaw') || findBinaryOnPath('clawdbot')
  if (openclawSandboxPath) {
    tools.push(
      tool(
        async ({ code, explain }) => {
          try {
            const args = explain ? ['sandbox', 'explain', code] : ['sandbox', 'run', code]
            const result = spawnSync(openclawSandboxPath, args, {
              encoding: 'utf-8',
              timeout: 60_000,
              maxBuffer: MAX_OUTPUT,
            })
            const stdout = truncate((result.stdout || '').trim(), MAX_OUTPUT)
            const stderr = truncate((result.stderr || '').trim(), MAX_OUTPUT)
            return JSON.stringify({ exitCode: result.status ?? 0, stdout, stderr })
          } catch (err: unknown) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
          }
        },
        {
          name: 'openclaw_sandbox',
          description: 'Execute or explain code through the OpenClaw CLI sandbox. CLI passthrough to `openclaw sandbox run|explain <code>`. Requires openclaw/clawdbot CLI on PATH.',
          schema: z.object({
            code: z.string().describe('Code to run or explain'),
            explain: z.boolean().optional().describe('If true, explain the code instead of running it'),
          }),
        },
      ),
    )
  }

  return tools
}
