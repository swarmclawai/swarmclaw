import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import * as cheerio from 'cheerio'
import { getMemoryDb } from './memory-db'
import { loadRuntimeSettings } from './runtime-settings'
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
} from './process-manager'
import {
  loadAgents, saveAgents,
  loadTasks, saveTasks,
  loadSchedules, saveSchedules,
  loadSkills, saveSkills,
  loadConnectors, saveConnectors,
  loadDocuments, saveDocuments,
  loadWebhooks, saveWebhooks,
  loadSecrets, saveSecrets,
  loadSessions, saveSessions,
  UPLOAD_DIR,
  encryptKey,
  decryptKey,
} from './storage'
import { log } from './logger'

const MAX_OUTPUT = 50 * 1024 // 50KB
const MAX_FILE = 100 * 1024 // 100KB

function safePath(cwd: string, filePath: string): string {
  const resolved = path.resolve(cwd, filePath)
  if (!resolved.startsWith(path.resolve(cwd))) {
    throw new Error('Path traversal not allowed')
  }
  return resolved
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n... [truncated at ${max} bytes]`
}

function tail(text: string, max = 4000): string {
  if (!text) return ''
  return text.length <= max ? text : text.slice(text.length - max)
}

function extractResumeIdentifier(text: string): string | null {
  if (!text) return null
  const patterns = [
    /session[_\s-]?id["'\s]*[:=]\s*["']?([A-Za-z0-9._:-]{6,})/i,
    /thread[_\s-]?id["'\s]*[:=]\s*["']?([A-Za-z0-9._:-]{6,})/i,
    /resume(?:\s+with)?\s+([A-Za-z0-9._:-]{6,})/i,
  ]
  for (const pattern of patterns) {
    const m = text.match(pattern)
    if (m?.[1]) return m[1]
  }
  return null
}

const binaryLookupCache = new Map<string, { checkedAt: number; path: string | null }>()
const BINARY_LOOKUP_TTL_MS = 30_000

function findBinaryOnPath(binaryName: string): string | null {
  const now = Date.now()
  const cached = binaryLookupCache.get(binaryName)
  if (cached && now - cached.checkedAt < BINARY_LOOKUP_TTL_MS) return cached.path

  const probe = spawnSync('/bin/zsh', ['-lc', `command -v ${binaryName} 2>/dev/null`], {
    encoding: 'utf-8',
    timeout: 2000,
  })
  const resolved = (probe.stdout || '').trim() || null
  binaryLookupCache.set(binaryName, { checkedAt: now, path: resolved })
  return resolved
}

function coerceEnvMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  try {
    const url = rawUrl.startsWith('http')
      ? new URL(rawUrl)
      : new URL(rawUrl, 'https://duckduckgo.com')
    const uddg = url.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return url.toString()
  } catch {
    const fromQuery = rawUrl.match(/[?&]uddg=([^&]+)/)?.[1]
    if (fromQuery) {
      try { return decodeURIComponent(fromQuery) } catch { /* noop */ }
    }
    return rawUrl
  }
}

function listDirRecursive(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return []
  const entries: string[] = []
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue
      const rel = depth === 0 ? item.name : item.name
      if (item.isDirectory()) {
        entries.push(rel + '/')
        const sub = listDirRecursive(path.join(dir, item.name), depth + 1, maxDepth)
        entries.push(...sub.map((s) => `  ${rel}/${s}`))
      } else {
        entries.push(rel)
      }
    }
  } catch {
    // permission error etc
  }
  return entries
}

const MAX_DOCUMENT_TEXT_CHARS = 500_000

function extractDocumentText(filePath: string): { text: string; method: string } {
  const ext = path.extname(filePath).toLowerCase()

  const readUtf8Text = (): string => {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const cleaned = raw.replace(/\u0000/g, '')
    return cleaned
  }

  if (ext === '.pdf') {
    const pdftotextBinary = findBinaryOnPath('pdftotext')
    if (!pdftotextBinary) throw new Error('pdftotext is not installed. Install poppler to index PDF files.')
    const out = spawnSync(pdftotextBinary, ['-layout', '-nopgbrk', '-q', filePath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024,
      timeout: 20_000,
    })
    if ((out.status ?? 1) !== 0) {
      throw new Error(`pdftotext failed: ${(out.stderr || out.stdout || '').trim() || 'unknown error'}`)
    }
    return { text: out.stdout || '', method: 'pdftotext' }
  }

  if (['.txt', '.md', '.markdown', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.yaml', '.yml'].includes(ext)) {
    return { text: readUtf8Text(), method: 'utf8' }
  }

  if (ext === '.html' || ext === '.htm') {
    const html = fs.readFileSync(filePath, 'utf-8')
    const $ = cheerio.load(html)
    const text = $('body').text() || $.text()
    return { text, method: 'html-strip' }
  }

  if (['.doc', '.docx', '.rtf'].includes(ext)) {
    const out = spawnSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], {
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024,
      timeout: 20_000,
    })
    if ((out.status ?? 1) === 0 && out.stdout?.trim()) {
      return { text: out.stdout, method: 'textutil' }
    }
  }

  const fallback = readUtf8Text()
  if (fallback.trim()) return { text: fallback, method: 'utf8-fallback' }
  throw new Error(`Unsupported document type: ${ext || '(no extension)'}`)
}

function trimDocumentContent(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
  if (normalized.length <= MAX_DOCUMENT_TEXT_CHARS) return normalized
  return normalized.slice(0, MAX_DOCUMENT_TEXT_CHARS)
}

interface ToolContext {
  agentId?: string | null
  sessionId?: string | null
  platformAssignScope?: 'self' | 'all'
}

export interface SessionToolsResult {
  tools: StructuredToolInterface[]
  cleanup: () => Promise<void>
}

// Global registry of active browser instances for cleanup sweeps
const activeBrowsers = new Map<string, { client: any; server: any; createdAt: number }>()

/** Kill all browser instances that have been alive longer than maxAge (default 30 min) */
export function sweepOrphanedBrowsers(maxAgeMs = 30 * 60 * 1000): number {
  const now = Date.now()
  let cleaned = 0
  for (const [key, entry] of activeBrowsers) {
    if (now - entry.createdAt > maxAgeMs) {
      try { entry.client?.close?.() } catch { /* ignore */ }
      try { entry.server?.close?.() } catch { /* ignore */ }
      activeBrowsers.delete(key)
      cleaned++
    }
  }
  return cleaned
}

/** Kill a specific session's browser instance */
export function cleanupSessionBrowser(sessionId: string): void {
  const entry = activeBrowsers.get(sessionId)
  if (entry) {
    try { entry.client?.close?.() } catch { /* ignore */ }
    try { entry.server?.close?.() } catch { /* ignore */ }
    activeBrowsers.delete(sessionId)
  }
}

/** Get count of active browser instances */
export function getActiveBrowserCount(): number {
  return activeBrowsers.size
}

/** Check if a specific session has an active browser */
export function hasActiveBrowser(sessionId: string): boolean {
  return activeBrowsers.has(sessionId)
}

export function buildSessionTools(cwd: string, enabledTools: string[], ctx?: ToolContext): SessionToolsResult {
  const tools: StructuredToolInterface[] = []
  const cleanupFns: (() => Promise<void>)[] = []
  const runtime = loadRuntimeSettings()
  const commandTimeoutMs = runtime.shellCommandTimeoutMs
  const claudeTimeoutMs = runtime.claudeCodeTimeoutMs
  const cliProcessTimeoutMs = runtime.cliProcessTimeoutMs

  const resolveCurrentSession = (): any | null => {
    if (!ctx?.sessionId) return null
    const sessions = loadSessions()
    return sessions[ctx.sessionId] || null
  }

  const readStoredDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode'): string | null => {
    const session = resolveCurrentSession()
    if (!session?.delegateResumeIds || typeof session.delegateResumeIds !== 'object') return null
    const raw = session.delegateResumeIds[key]
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null
  }

  const persistDelegateResumeId = (key: 'claudeCode' | 'codex' | 'opencode', resumeId: string | null | undefined): void => {
    const normalized = typeof resumeId === 'string' ? resumeId.trim() : ''
    if (!normalized || !ctx?.sessionId) return
    const sessions = loadSessions()
    const target = sessions[ctx.sessionId]
    if (!target) return
    const current = (target.delegateResumeIds && typeof target.delegateResumeIds === 'object')
      ? target.delegateResumeIds
      : {}
    target.delegateResumeIds = {
      ...current,
      [key]: normalized,
    }
    target.updatedAt = Date.now()
    sessions[ctx.sessionId] = target
    saveSessions(sessions)
  }

  if (enabledTools.includes('shell')) {
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

  if (enabledTools.includes('process')) {
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

  const filesEnabled = enabledTools.includes('files')
  const canReadFiles = filesEnabled || enabledTools.includes('read_file')
  const canWriteFiles = filesEnabled || enabledTools.includes('write_file')
  const canListFiles = filesEnabled || enabledTools.includes('list_files')
  const canSendFiles = filesEnabled || enabledTools.includes('send_file')
  const canCopyFiles = filesEnabled || enabledTools.includes('copy_file')
  const canMoveFiles = filesEnabled || enabledTools.includes('move_file')
  // Destructive by default: only enabled when explicitly toggled.
  const canDeleteFiles = enabledTools.includes('delete_file')

  if (canReadFiles) {
    tools.push(
      tool(
        async ({ filePath }) => {
          try {
            const resolved = safePath(cwd, filePath)
            const content = fs.readFileSync(resolved, 'utf-8')
            return truncate(content, MAX_FILE)
          } catch (err: any) {
            return `Error reading file: ${err.message}`
          }
        },
        {
          name: 'read_file',
          description: 'Read a file from the session working directory.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
          }),
        },
      ),
    )
  }

  if (canWriteFiles) {
    tools.push(
      tool(
        async ({ filePath, content }) => {
          try {
            const resolved = safePath(cwd, filePath)
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            fs.writeFileSync(resolved, content, 'utf-8')
            return `File written: ${filePath} (${content.length} bytes)`
          } catch (err: any) {
            return `Error writing file: ${err.message}`
          }
        },
        {
          name: 'write_file',
          description: 'Write content to a file in the session working directory. Creates directories if needed.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
            content: z.string().describe('The content to write'),
          }),
        },
      ),
    )
  }

  if (canListFiles) {
    tools.push(
      tool(
        async ({ dirPath }) => {
          try {
            const resolved = safePath(cwd, dirPath || '.')
            const tree = listDirRecursive(resolved, 0, 3)
            return tree.length ? tree.join('\n') : '(empty directory)'
          } catch (err: any) {
            return `Error listing files: ${err.message}`
          }
        },
        {
          name: 'list_files',
          description: 'List files in the session working directory recursively (max depth 3).',
          schema: z.object({
            dirPath: z.string().optional().describe('Relative path to list (defaults to working directory)'),
          }),
        },
      ),
    )
  }

  if (canCopyFiles) {
    tools.push(
      tool(
        async ({ sourcePath, destinationPath, overwrite }) => {
          try {
            const source = safePath(cwd, sourcePath)
            const destination = safePath(cwd, destinationPath)
            if (!fs.existsSync(source)) return `Error: source file not found: ${sourcePath}`
            const sourceStat = fs.statSync(source)
            if (sourceStat.isDirectory()) return `Error: source must be a file (directories are not supported by copy_file).`
            if (fs.existsSync(destination) && !overwrite) return `Error: destination already exists: ${destinationPath} (set overwrite=true to replace).`
            fs.mkdirSync(path.dirname(destination), { recursive: true })
            fs.copyFileSync(source, destination)
            return `File copied: ${sourcePath} -> ${destinationPath}`
          } catch (err: any) {
            return `Error copying file: ${err.message}`
          }
        },
        {
          name: 'copy_file',
          description: 'Copy a file to a new location in the working directory.',
          schema: z.object({
            sourcePath: z.string().describe('Source file path (relative to working directory)'),
            destinationPath: z.string().describe('Destination file path (relative to working directory)'),
            overwrite: z.boolean().optional().describe('Overwrite destination if it exists (default false)'),
          }),
        },
      ),
    )
  }

  if (canMoveFiles) {
    tools.push(
      tool(
        async ({ sourcePath, destinationPath, overwrite }) => {
          try {
            const source = safePath(cwd, sourcePath)
            const destination = safePath(cwd, destinationPath)
            if (!fs.existsSync(source)) return `Error: source file not found: ${sourcePath}`
            const sourceStat = fs.statSync(source)
            if (sourceStat.isDirectory()) return `Error: source must be a file (directories are not supported by move_file).`
            if (fs.existsSync(destination) && !overwrite) return `Error: destination already exists: ${destinationPath} (set overwrite=true to replace).`
            fs.mkdirSync(path.dirname(destination), { recursive: true })
            if (fs.existsSync(destination) && overwrite) fs.unlinkSync(destination)
            fs.renameSync(source, destination)
            return `File moved: ${sourcePath} -> ${destinationPath}`
          } catch (err: any) {
            return `Error moving file: ${err.message}`
          }
        },
        {
          name: 'move_file',
          description: 'Move (rename) a file to a new location in the working directory.',
          schema: z.object({
            sourcePath: z.string().describe('Source file path (relative to working directory)'),
            destinationPath: z.string().describe('Destination file path (relative to working directory)'),
            overwrite: z.boolean().optional().describe('Overwrite destination if it exists (default false)'),
          }),
        },
      ),
    )
  }

  if (canDeleteFiles) {
    tools.push(
      tool(
        async ({ filePath, recursive, force }) => {
          try {
            const resolved = safePath(cwd, filePath)
            const root = path.resolve(cwd)
            if (resolved === root) return 'Error: refusing to delete the session working directory root.'
            if (!fs.existsSync(resolved)) {
              return force ? `Path already absent: ${filePath}` : `Error: path not found: ${filePath}`
            }
            const stat = fs.statSync(resolved)
            if (stat.isDirectory() && !recursive) {
              return 'Error: target is a directory. Set recursive=true to delete directories.'
            }
            fs.rmSync(resolved, { recursive: !!recursive, force: !!force })
            return `Deleted: ${filePath}`
          } catch (err: any) {
            return `Error deleting file: ${err.message}`
          }
        },
        {
          name: 'delete_file',
          description: 'Delete a file or directory from the working directory. Disabled by default and must be explicitly enabled.',
          schema: z.object({
            filePath: z.string().describe('Path to delete (relative to working directory)'),
            recursive: z.boolean().optional().describe('Required for deleting directories'),
            force: z.boolean().optional().describe('Ignore missing paths and force deletion where possible'),
          }),
        },
      ),
    )
  }

  if (canSendFiles) {
    tools.push(
      tool(
        async ({ filePath: rawPath }) => {
          try {
            // Resolve relative to cwd, but also allow absolute paths
            const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath)
            if (!fs.existsSync(resolved)) return `Error: file not found: ${rawPath}`
            const stat = fs.statSync(resolved)
            if (stat.isDirectory()) return `Error: cannot send a directory. Send individual files instead.`
            if (stat.size > 100 * 1024 * 1024) return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 100MB.`

            const ext = path.extname(resolved).slice(1).toLowerCase()
            const basename = path.basename(resolved)
            const filename = `${Date.now()}-${basename}`
            const dest = path.join(UPLOAD_DIR, filename)
            fs.copyFileSync(resolved, dest)

            const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
            const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'avi', 'mkv']

            if (IMAGE_EXTS.includes(ext)) {
              return `![${basename}](/api/uploads/${filename})`
            } else if (VIDEO_EXTS.includes(ext)) {
              return `![${basename}](/api/uploads/${filename})`
            } else {
              return `[Download ${basename}](/api/uploads/${filename})`
            }
          } catch (err: any) {
            return `Error sending file: ${err.message}`
          }
        },
        {
          name: 'send_file',
          description: 'Send a file to the user so they can view or download it in the chat. Works with images, videos, PDFs, documents, and any other file type. The file will appear inline for images/videos, or as a download link for other types.',
          schema: z.object({
            filePath: z.string().describe('Path to the file (relative to working directory, or absolute)'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('claude_code')) {
    const claudeBinary = findBinaryOnPath('claude')
    const codexBinary = findBinaryOnPath('codex')
    const opencodeBinary = findBinaryOnPath('opencode')

    if (!claudeBinary && !codexBinary && !opencodeBinary) {
      log.warn('session-tools', 'Delegation tool enabled but no CLI binaries found', {
        sessionId: ctx?.sessionId || null,
        agentId: ctx?.agentId || null,
      })
    }

    if (claudeBinary) {
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

    if (codexBinary) {
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

    if (opencodeBinary) {
    tools.push(
      tool(
        async ({ task, resume, resumeId }) => {
          try {
            const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
            const removedOpenCodeEnvKeys: string[] = []
            for (const key of Object.keys(env)) {
              if (key.toUpperCase().startsWith('OPENCODE')) {
                removedOpenCodeEnvKeys.push(key)
                delete env[key]
              }
            }
            const hasApiCredentialEnv = [
              'OPENAI_API_KEY',
              'ANTHROPIC_API_KEY',
              'GROQ_API_KEY',
              'GOOGLE_API_KEY',
              'XAI_API_KEY',
              'MISTRAL_API_KEY',
              'DEEPSEEK_API_KEY',
              'TOGETHER_API_KEY',
            ].some((key) => typeof env[key] === 'string' && (env[key] || '').trim().length > 0)
            if (!hasApiCredentialEnv) {
              const authProbe = spawnSync(opencodeBinary, ['auth', 'list'], {
                cwd,
                env,
                encoding: 'utf-8',
                timeout: 8000,
              })
              const probeText = `${authProbe.stdout || ''}\n${authProbe.stderr || ''}`.toLowerCase()
              const noCreds = probeText.includes('0 credentials')
              if ((authProbe.status ?? 1) !== 0 || noCreds) {
                return 'Error: OpenCode CLI is not authenticated. Run `opencode auth login` (or set provider API key env vars), then retry.'
              }
            }
            const storedResumeId = readStoredDelegateResumeId('opencode')
            const resumeIdToUse = typeof resumeId === 'string' && resumeId.trim()
              ? resumeId.trim()
              : (resume ? storedResumeId : null)

            log.info('session-tools', 'delegate_to_opencode_cli start', {
              sessionId: ctx?.sessionId || null,
              agentId: ctx?.agentId || null,
              cwd,
              timeoutMs: cliProcessTimeoutMs,
              removedOpenCodeEnvKeys,
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

  if (enabledTools.includes('edit_file')) {
    tools.push(
      tool(
        async ({ filePath, oldText, newText }) => {
          try {
            const resolved = safePath(cwd, filePath)
            if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`
            const content = fs.readFileSync(resolved, 'utf-8')
            const count = content.split(oldText).length - 1
            if (count === 0) return `Error: oldText not found in ${filePath}`
            if (count > 1) return `Error: oldText found ${count} times in ${filePath}. Make it more specific.`
            const updated = content.replace(oldText, newText)
            fs.writeFileSync(resolved, updated, 'utf-8')
            return `Successfully edited ${filePath}`
          } catch (err: any) {
            return `Error editing file: ${err.message}`
          }
        },
        {
          name: 'edit_file',
          description: 'Search and replace text in a file. The oldText must match exactly once in the file.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
            oldText: z.string().describe('Exact text to find (must be unique in the file)'),
            newText: z.string().describe('Text to replace it with'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('web_search')) {
    tools.push(
      tool(
        async ({ query, maxResults }) => {
          try {
            const limit = Math.min(maxResults || 5, 10)
            const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
              signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) {
              return `Error searching web: HTTP ${res.status} ${res.statusText}`
            }
            const html = await res.text()
            const $ = cheerio.load(html)
            const results: { title: string; url: string; snippet: string }[] = []

            // Primary parser: DuckDuckGo result cards
            $('.result').each((_i, el) => {
              if (results.length >= limit) return false
              const link = $(el).find('a.result__a').first()
              const rawHref = link.attr('href') || ''
              const title = link.text().replace(/\s+/g, ' ').trim()
              if (!rawHref || !title) return
              const snippet = $(el).find('.result__snippet').first().text().replace(/\s+/g, ' ').trim()
              results.push({
                title,
                url: decodeDuckDuckGoUrl(rawHref),
                snippet,
              })
            })

            // Fallback parser: any result__a anchors
            if (results.length === 0) {
              $('a.result__a').each((_i, el) => {
                if (results.length >= limit) return false
                const rawHref = $(el).attr('href') || ''
                const title = $(el).text().replace(/\s+/g, ' ').trim()
                if (!rawHref || !title) return
                results.push({
                  title,
                  url: decodeDuckDuckGoUrl(rawHref),
                  snippet: '',
                })
              })
            }

            return results.length > 0
              ? JSON.stringify(results, null, 2)
              : 'No results found.'
          } catch (err: any) {
            return `Error searching web: ${err.message}`
          }
        },
        {
          name: 'web_search',
          description: 'Search the web using DuckDuckGo. Returns an array of results with title, url, and snippet.',
          schema: z.object({
            query: z.string().describe('Search query'),
            maxResults: z.number().optional().describe('Maximum results to return (default 5, max 10)'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('web_fetch')) {
    tools.push(
      tool(
        async ({ url }) => {
          try {
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
              signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`
            const html = await res.text()
            // Use cheerio for robust HTML text extraction
            const $ = cheerio.load(html)
            $('script, style, noscript, nav, footer, header').remove()
            // Prefer article/main content if available
            const main = $('article, main, [role="main"]').first()
            let text = (main.length ? main.text() : $('body').text())
              .replace(/\s+/g, ' ')
              .trim()
            return truncate(text, MAX_OUTPUT)
          } catch (err: any) {
            return `Error fetching URL: ${err.message}`
          }
        },
        {
          name: 'web_fetch',
          description: 'Fetch a URL and return its text content (HTML stripped). Useful for reading web pages.',
          schema: z.object({
            url: z.string().describe('The URL to fetch'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('browser')) {
    // In-process Playwright MCP client via @playwright/mcp programmatic API
    const sessionKey = ctx?.sessionId || `anon-${Date.now()}`
    let mcpClient: any = null
    let mcpServer: any = null
    let mcpInitializing: Promise<void> | null = null

    const ensureMcp = (): Promise<void> => {
      if (mcpClient) return Promise.resolve()
      if (mcpInitializing) return mcpInitializing
      mcpInitializing = (async () => {
        const { createConnection } = await import('@playwright/mcp')
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
        const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

        const server = await createConnection({
          browser: {
            launchOptions: { headless: true },
            isolated: true,
          },
          imageResponses: 'allow',
          capabilities: ['core', 'pdf', 'vision', 'network'],
        })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const client = new Client({ name: 'swarmclaw', version: '1.0' })
        await Promise.all([
          client.connect(clientTransport),
          server.connect(serverTransport),
        ])
        mcpClient = client
        mcpServer = server
        // Register in global tracker
        activeBrowsers.set(sessionKey, { client, server, createdAt: Date.now() })
      })()
      return mcpInitializing
    }

    // Register cleanup for this session's browser
    cleanupFns.push(async () => {
      try { mcpClient?.close?.() } catch { /* ignore */ }
      try { mcpServer?.close?.() } catch { /* ignore */ }
      activeBrowsers.delete(sessionKey)
      mcpClient = null
      mcpServer = null
    })

    /** Strip Playwright debug noise — keep page context for the LLM */
    const cleanPlaywrightOutput = (text: string): string => {
      // Remove "### Ran Playwright code" blocks (internal debug)
      text = text.replace(/### Ran Playwright code[\s\S]*?(?=###|$)/g, '')
      // Truncate snapshot to first 40 lines so LLM has page context without flooding
      text = text.replace(/### Snapshot\n([\s\S]*?)(?=###|$)/g, (_match, snapshot) => {
        const lines = (snapshot as string).split('\n')
        if (lines.length > 40) {
          return 'Page elements:\n' + lines.slice(0, 40).join('\n') + '\n... (truncated)\n'
        }
        return 'Page elements:\n' + snapshot
      })
      // Clean headers
      text = text.replace(/^### Result\n/gm, '')
      text = text.replace(/^### Page\n/gm, '')
      return text.replace(/\n{3,}/g, '\n').trim()
    }

    const callMcpTool = async (
      toolName: string,
      args: Record<string, any>,
      options?: { saveTo?: string },
    ): Promise<string> => {
      await ensureMcp()
      const result = await mcpClient.callTool({ name: toolName, arguments: args })
      const isError = result?.isError === true
      const content = result?.content
      const savedPaths: string[] = []

      const saveArtifact = (buffer: Buffer, suggestedExt: string): void => {
        const rawSaveTo = options?.saveTo?.trim()
        if (!rawSaveTo) return
        let resolved = safePath(cwd, rawSaveTo)
        if (!path.extname(resolved) && suggestedExt) {
          resolved = `${resolved}.${suggestedExt}`
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true })
        fs.writeFileSync(resolved, buffer)
        savedPaths.push(resolved)
      }

      if (Array.isArray(content)) {
        const parts: string[] = []
        let hasBinaryImage = false
        for (const c of content) {
          if (c.type === 'image' && c.data) {
            hasBinaryImage = true
            const imageBuffer = Buffer.from(c.data, 'base64')
            const filename = `screenshot-${Date.now()}.png`
            const filepath = path.join(UPLOAD_DIR, filename)
            fs.writeFileSync(filepath, imageBuffer)
            saveArtifact(imageBuffer, 'png')
            parts.push(`![Screenshot](/api/uploads/${filename})`)
          } else if (c.type === 'resource' && c.resource?.blob) {
            const ext = c.resource.mimeType?.includes('pdf') ? 'pdf' : 'bin'
            const resourceBuffer = Buffer.from(c.resource.blob, 'base64')
            const filename = `browser-${Date.now()}.${ext}`
            const filepath = path.join(UPLOAD_DIR, filename)
            fs.writeFileSync(filepath, resourceBuffer)
            saveArtifact(resourceBuffer, ext)
            parts.push(`[Download ${filename}](/api/uploads/${filename})`)
          } else {
            let text = c.text || ''
            // Detect file paths in output (e.g. PDF save returns a local path)
            const fileMatch = text.match(/\]\((\.\.\/[^\s)]+|\/[^\s)]+\.(pdf|png|jpg|jpeg|gif|webp|html|mp4|webm))\)/)
            if (fileMatch) {
              const rawPath = fileMatch[1]
              const srcPath = rawPath.startsWith('/') ? rawPath : path.resolve(process.cwd(), rawPath)
              if (fs.existsSync(srcPath)) {
                const ext = path.extname(srcPath).slice(1).toLowerCase()
                const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
                // Skip file-path images if we already have a binary image (avoids duplicates)
                if (IMAGE_EXTS.includes(ext) && hasBinaryImage) {
                  parts.push(isError ? text : cleanPlaywrightOutput(text))
                } else {
                  const filename = `browser-${Date.now()}.${ext}`
                  const destPath = path.join(UPLOAD_DIR, filename)
                  fs.copyFileSync(srcPath, destPath)
                  if (options?.saveTo?.trim()) {
                    const raw = options.saveTo.trim()
                    let targetPath = safePath(cwd, raw)
                    if (!path.extname(targetPath)) targetPath = `${targetPath}.${ext}`
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
                    fs.copyFileSync(srcPath, targetPath)
                    savedPaths.push(targetPath)
                  }
                  if (IMAGE_EXTS.includes(ext)) {
                    parts.push(`![Screenshot](/api/uploads/${filename})`)
                  } else {
                    parts.push(`[Download ${filename}](/api/uploads/${filename})`)
                  }
                }
              } else {
                parts.push(isError ? text : cleanPlaywrightOutput(text))
              }
            } else {
              parts.push(isError ? text : cleanPlaywrightOutput(text))
            }
          }
        }
        if (savedPaths.length > 0) {
          const unique = Array.from(new Set(savedPaths))
          const rendered = unique.map((p) => path.relative(cwd, p) || '.').join(', ')
          parts.push(`Saved to: ${rendered}`)
        }
        return parts.join('\n')
      }
      return JSON.stringify(result)
    }

    // Action-to-MCP tool mapping
    const MCP_TOOL_MAP: Record<string, string> = {
      navigate: 'browser_navigate',
      screenshot: 'browser_take_screenshot',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      type: 'browser_type',
      press_key: 'browser_press_key',
      select: 'browser_select_option',
      evaluate: 'browser_evaluate',
      pdf: 'browser_pdf_save',
      upload: 'browser_file_upload',
      wait: 'browser_wait_for',
    }

    tools.push(
      tool(
        async (params) => {
          try {
            const { action, ...rest } = params
            // Build MCP args based on action
            const mcpTool = MCP_TOOL_MAP[action]
            if (!mcpTool) return `Unknown browser action: "${action}". Valid: ${Object.keys(MCP_TOOL_MAP).join(', ')}`
            // Pass only defined (non-undefined) params to MCP
            const args: Record<string, any> = {}
            for (const [k, v] of Object.entries(rest)) {
              if (v !== undefined && v !== null && v !== '') args[k] = v
            }
            const saveTo = typeof params.saveTo === 'string' && params.saveTo.trim()
              ? params.saveTo.trim()
              : undefined
            return await callMcpTool(mcpTool, args, { saveTo })
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'browser',
          description: [
            'Control the browser. Use action to specify what to do.',
            'Actions: navigate (url), screenshot, snapshot (get page elements), click (element/ref), type (element/ref, text), press_key (key), select (element/ref, option), evaluate (expression), pdf, upload (paths, ref), wait (text/timeout).',
            'Workflow: use snapshot to see the page and get element refs, then use click/type/select with those refs.',
            'Screenshots are returned as images visible to the user. Use saveTo to persist screenshot/PDF artifacts to disk.',
          ].join(' '),
          schema: z.object({
            action: z.enum(['navigate', 'screenshot', 'snapshot', 'click', 'type', 'press_key', 'select', 'evaluate', 'pdf', 'upload', 'wait']).describe('The browser action to perform'),
            url: z.string().optional().describe('URL to navigate to (for navigate action)'),
            element: z.string().optional().describe('CSS selector or description of an element (for click/type/select)'),
            ref: z.string().optional().describe('Element reference from a previous snapshot (for click/type/select/upload)'),
            text: z.string().optional().describe('Text to type (for type action) or text to wait for (for wait action)'),
            key: z.string().optional().describe('Key to press, e.g. Enter, Tab, Escape (for press_key action)'),
            option: z.string().optional().describe('Option value or label to select (for select action)'),
            expression: z.string().optional().describe('JavaScript expression to evaluate (for evaluate action)'),
            paths: z.array(z.string()).optional().describe('File paths to upload (for upload action)'),
            timeout: z.number().optional().describe('Timeout in milliseconds (for wait action, default 30000)'),
            saveTo: z.string().optional().describe('Optional output path for screenshot/pdf artifacts (relative to working directory).'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('memory')) {
    const memDb = getMemoryDb()

    tools.push(
      tool(
        async ({ action, key, value, category, query, scope }) => {
          try {
            const scopeMode = scope || 'auto'
            const currentAgentId = ctx?.agentId || null
            const canAccessMemory = (m: any) => !m?.agentId || m.agentId === currentAgentId
            const filterScope = (rows: any[]) => {
              if (scopeMode === 'shared') return rows.filter((m) => !m.agentId)
              if (scopeMode === 'agent') return rows.filter((m) => currentAgentId && m.agentId === currentAgentId)
              // auto: shared + this agent's memories
              return rows.filter(canAccessMemory)
            }

            if (action === 'store') {
              const entry = memDb.add({
                agentId: scopeMode === 'shared' ? null : currentAgentId,
                sessionId: ctx?.sessionId || null,
                category: category || 'note',
                title: key,
                content: value || '',
              })
              const memoryScope = entry.agentId ? 'agent' : 'shared'
              return `Stored ${memoryScope} memory "${key}" (id: ${entry.id})`
            }
            if (action === 'get') {
              const found = memDb.get(key)
              if (!found) return `Memory not found: ${key}`
              if (!canAccessMemory(found)) return 'Error: you do not have access to that memory.'
              const owner = found.agentId ? `agent:${found.agentId}` : 'shared'
              return `[${found.id}] (${owner}) ${found.category}/${found.title}: ${found.content}`
            }
            if (action === 'search') {
              const results = filterScope(memDb.search(query || key))
              if (!results.length) return 'No memories found.'
              return results.map((m) => `[${m.id}] (${m.agentId ? `agent:${m.agentId}` : 'shared'}) ${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'list') {
              const results = filterScope(memDb.list())
              if (!results.length) return 'No memories stored yet.'
              return results.map((m) => `[${m.id}] (${m.agentId ? `agent:${m.agentId}` : 'shared'}) ${m.category}/${m.title}: ${m.content}`).join('\n')
            }
            if (action === 'delete') {
              const found = memDb.get(key)
              if (!found) return `Memory not found: ${key}`
              if (!canAccessMemory(found)) return 'Error: you do not have access to that memory.'
              memDb.delete(key)
              return `Deleted memory "${key}"`
            }
            return `Unknown action "${action}". Use: store, get, search, list, or delete.`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'memory_tool',
          description: 'Store and retrieve long-term memories that persist across sessions. Memories can be shared or agent-scoped. Use "store", "get", "search", "list", and "delete".',
          schema: z.object({
            action: z.enum(['store', 'get', 'search', 'list', 'delete']).describe('The action to perform'),
            key: z.string().describe('For store: memory title. For get/delete: memory ID. For search: optional query fallback.'),
            value: z.string().optional().describe('The memory content (for store action)'),
            category: z.string().optional().describe('Category like "note", "fact", "preference" (for store action, defaults to "note")'),
            query: z.string().optional().describe('Search query (alternative to key for search action)'),
            scope: z.enum(['auto', 'shared', 'agent']).optional().describe('Scope hint: auto (shared + own), shared, or agent'),
          }),
        },
      ),
    )
  }

  // Platform management tools — each resource type is a separate toggleable tool
  const RESOURCE_DEFAULTS: Record<string, (parsed: any) => any> = {
    manage_agents: (p) => ({
      name: p.name || 'Unnamed Agent',
      description: p.description || '',
      systemPrompt: p.systemPrompt || '',
      soul: p.soul || '',
      provider: p.provider || 'claude-cli',
      model: p.model || '',
      isOrchestrator: p.isOrchestrator || false,
      tools: p.tools || [],
      skills: p.skills || [],
      skillIds: p.skillIds || [],
      subAgentIds: p.subAgentIds || [],
      ...p,
    }),
    manage_tasks: (p) => ({
      title: p.title || 'Untitled Task',
      description: p.description || '',
      status: p.status || 'backlog',
      agentId: p.agentId || null,
      sessionId: p.sessionId || null,
      result: null,
      error: null,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      ...p,
    }),
    manage_schedules: (p) => {
      const now = Date.now()
      const base = {
        name: p.name || 'Unnamed Schedule',
        agentId: p.agentId || null,
        taskPrompt: p.taskPrompt || '',
        scheduleType: p.scheduleType || 'interval',
        status: p.status || 'active',
        ...p,
      }
      if (!base.nextRunAt) {
        if (base.scheduleType === 'once' && base.runAt) base.nextRunAt = base.runAt
        else if (base.scheduleType === 'interval' && base.intervalMs) base.nextRunAt = now + base.intervalMs
      }
      return base
    },
    manage_skills: (p) => ({
      name: p.name || 'Unnamed Skill',
      description: p.description || '',
      content: p.content || '',
      filename: p.filename || '',
      ...p,
    }),
    manage_connectors: (p) => ({
      name: p.name || 'Unnamed Connector',
      platform: p.platform || 'discord',
      agentId: p.agentId || null,
      enabled: p.enabled ?? false,
      ...p,
    }),
    manage_webhooks: (p) => ({
      name: p.name || 'Unnamed Webhook',
      source: p.source || 'custom',
      events: Array.isArray(p.events) ? p.events : [],
      agentId: p.agentId || null,
      secret: p.secret || '',
      isEnabled: p.isEnabled ?? true,
      ...p,
    }),
    manage_secrets: (p) => ({
      name: p.name || 'Unnamed Secret',
      service: p.service || 'custom',
      scope: p.scope || 'global',
      agentIds: Array.isArray(p.agentIds) ? p.agentIds : [],
      ...p,
    }),
  }

  const PLATFORM_RESOURCES: Record<string, {
    toolId: string
    label: string
    load: () => Record<string, any>
    save: (d: Record<string, any>) => void
    readOnly?: boolean
  }> = {
    manage_agents: { toolId: 'manage_agents', label: 'agents', load: loadAgents, save: saveAgents },
    manage_tasks: { toolId: 'manage_tasks', label: 'tasks', load: loadTasks, save: saveTasks },
    manage_schedules: { toolId: 'manage_schedules', label: 'schedules', load: loadSchedules, save: saveSchedules },
    manage_skills: { toolId: 'manage_skills', label: 'skills', load: loadSkills, save: saveSkills },
    manage_connectors: { toolId: 'manage_connectors', label: 'connectors', load: loadConnectors, save: saveConnectors },
    manage_webhooks: { toolId: 'manage_webhooks', label: 'webhooks', load: loadWebhooks, save: saveWebhooks },
    manage_sessions: { toolId: 'manage_sessions', label: 'sessions', load: loadSessions, save: saveSessions, readOnly: true },
    manage_secrets: { toolId: 'manage_secrets', label: 'secrets', load: loadSecrets, save: saveSecrets },
  }

  // Build dynamic agent summary for tools that need agent awareness
  const assignScope = ctx?.platformAssignScope || 'self'
  let agentSummary = ''
  if (enabledTools.includes('manage_tasks') || enabledTools.includes('manage_schedules')) {
    if (assignScope === 'all') {
      try {
        const agents = loadAgents()
        const agentList = Object.values(agents)
          .map((a: any) => `  - "${a.id}": ${a.name}${a.description ? ` — ${a.description}` : ''}`)
          .join('\n')
        if (agentList) agentSummary = `\n\nAvailable agents:\n${agentList}`
      } catch { /* ignore */ }
    }
  }

  for (const [toolKey, res] of Object.entries(PLATFORM_RESOURCES)) {
    if (!enabledTools.includes(toolKey)) continue

    let description = `Manage SwarmClaw ${res.label}. ${res.readOnly ? 'List and get only.' : 'List, get, create, update, or delete.'} Returns JSON.`
    if (toolKey === 'manage_tasks') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a task to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign tasks to yourself. Valid statuses: backlog, queued, running, completed, failed.`
      } else {
        description += `\n\nSet "agentId" to assign a task to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Valid statuses: backlog, queued, running, completed, failed.` + agentSummary
      }
    } else if (toolKey === 'manage_agents') {
      description += `\n\nAgents may self-edit their own soul. To update your soul, use action="update", id="${ctx?.agentId || 'your-agent-id'}", and include data with the "soul" field.`
    } else if (toolKey === 'manage_schedules') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign schedules to yourself. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do.`
      } else {
        description += `\n\nSet "agentId" to assign a schedule to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do.` + agentSummary
      }
    } else if (toolKey === 'manage_webhooks') {
      description += '\n\nUse `source`, `events`, `agentId`, and `secret` when creating webhooks. Inbound calls should POST to `/api/webhooks/{id}` with header `x-webhook-secret` when a secret is configured.'
    }

    tools.push(
      tool(
        async ({ action, id, data }) => {
          const canAccessSecret = (secret: any): boolean => {
            if (!secret) return false
            if (secret.scope !== 'agent') return true
            if (!ctx?.agentId) return false
            return Array.isArray(secret.agentIds) && secret.agentIds.includes(ctx.agentId)
          }
          try {
            if (action === 'list') {
              if (toolKey === 'manage_secrets') {
                const values = Object.values(res.load())
                  .filter((s: any) => canAccessSecret(s))
                  .map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    service: s.service,
                    scope: s.scope || 'global',
                    agentIds: s.agentIds || [],
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                  }))
                return JSON.stringify(values)
              }
              return JSON.stringify(Object.values(res.load()))
            }
            if (action === 'get') {
              if (!id) return 'Error: "id" is required for get action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[id])) return 'Error: you do not have access to this secret.'
                let value = ''
                try {
                  value = all[id].encryptedValue ? decryptKey(all[id].encryptedValue) : ''
                } catch {
                  value = ''
                }
                return JSON.stringify({
                  id: all[id].id,
                  name: all[id].name,
                  service: all[id].service,
                  scope: all[id].scope || 'global',
                  agentIds: all[id].agentIds || [],
                  value,
                  createdAt: all[id].createdAt,
                  updatedAt: all[id].updatedAt,
                })
              }
              return JSON.stringify(all[id])
            }
            if (res.readOnly) return `Cannot ${action} ${res.label} via this tool (read-only).`
            if (action === 'create') {
              const all = res.load()
              const newId = crypto.randomBytes(4).toString('hex')
              const raw = data ? JSON.parse(data) : {}
              const defaults = RESOURCE_DEFAULTS[toolKey]
              const parsed = defaults ? defaults(raw) : raw
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                delete (parsed as Record<string, unknown>).id
              }
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              const now = Date.now()
              const entry = {
                id: newId,
                ...parsed,
                createdByAgentId: ctx?.agentId || null,
                createdInSessionId: ctx?.sessionId || null,
                createdAt: now,
                updatedAt: now,
              }
              let responseEntry: any = entry
              if (toolKey === 'manage_secrets') {
                const secretValue = typeof parsed.value === 'string' ? parsed.value : null
                if (!secretValue) return 'Error: data.value is required to create a secret.'
                const normalizedScope = parsed.scope === 'agent' ? 'agent' : 'global'
                const normalizedAgentIds = normalizedScope === 'agent'
                  ? Array.from(new Set([
                      ...(Array.isArray(parsed.agentIds) ? parsed.agentIds.filter((x: any) => typeof x === 'string') : []),
                      ...(ctx?.agentId ? [ctx.agentId] : []),
                    ]))
                  : []
                const stored = {
                  ...entry,
                  scope: normalizedScope,
                  agentIds: normalizedAgentIds,
                  encryptedValue: encryptKey(secretValue),
                }
                delete (stored as any).value
                all[newId] = stored
                const { encryptedValue, ...safe } = stored
                responseEntry = safe
              } else {
                all[newId] = entry
              }
              res.save(all)
              if (toolKey === 'manage_tasks' && entry.status === 'queued') {
                const { enqueueTask } = await import('./queue')
                enqueueTask(newId)
              }
              return JSON.stringify(responseEntry)
            }
            if (action === 'update') {
              if (!id) return 'Error: "id" is required for update action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              const parsed = data ? JSON.parse(data) : {}
              const prevStatus = all[id]?.status
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              all[id] = { ...all[id], ...parsed, updatedAt: Date.now() }
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[id])) return 'Error: you do not have access to this secret.'
                const nextScope = parsed.scope === 'agent'
                  ? 'agent'
                  : parsed.scope === 'global'
                    ? 'global'
                    : (all[id].scope === 'agent' ? 'agent' : 'global')
                if (nextScope === 'agent') {
                  const incomingIds = Array.isArray(parsed.agentIds)
                    ? parsed.agentIds.filter((x: any) => typeof x === 'string')
                    : Array.isArray(all[id].agentIds)
                      ? all[id].agentIds
                      : []
                  all[id].agentIds = Array.from(new Set([
                    ...incomingIds,
                    ...(ctx?.agentId ? [ctx.agentId] : []),
                  ]))
                } else {
                  all[id].agentIds = []
                }
                all[id].scope = nextScope
                if (typeof parsed.value === 'string' && parsed.value.trim()) {
                  all[id].encryptedValue = encryptKey(parsed.value)
                }
                delete all[id].value
              }
              res.save(all)
              if (toolKey === 'manage_tasks' && prevStatus !== 'queued' && all[id].status === 'queued') {
                const { enqueueTask } = await import('./queue')
                enqueueTask(id)
              }
              if (toolKey === 'manage_secrets') {
                const { encryptedValue, ...safe } = all[id]
                return JSON.stringify(safe)
              }
              return JSON.stringify(all[id])
            }
            if (action === 'delete') {
              if (!id) return 'Error: "id" is required for delete action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              if (toolKey === 'manage_secrets' && !canAccessSecret(all[id])) {
                return 'Error: you do not have access to this secret.'
              }
              delete all[id]
              res.save(all)
              return JSON.stringify({ deleted: id })
            }
            return `Unknown action "${action}". Valid: list, get, create, update, delete`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: toolKey,
          description,
          schema: z.object({
            action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('The CRUD action to perform'),
            id: z.string().optional().describe('Resource ID (required for get, update, delete)'),
            data: z.string().optional().describe('JSON string of fields for create/update'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('manage_documents')) {
    tools.push(
      tool(
        async ({ action, id, filePath, query, limit, metadata, title }) => {
          try {
            const documents = loadDocuments()

            if (action === 'list') {
              const rows = Object.values(documents)
                .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0))
                .slice(0, Math.max(1, Math.min(limit || 100, 500)))
                .map((doc: any) => ({
                  id: doc.id,
                  title: doc.title,
                  fileName: doc.fileName,
                  sourcePath: doc.sourcePath,
                  textLength: doc.textLength,
                  method: doc.method,
                  metadata: doc.metadata || {},
                  createdAt: doc.createdAt,
                  updatedAt: doc.updatedAt,
                }))
              return JSON.stringify(rows)
            }

            if (action === 'get') {
              if (!id) return 'Error: id is required for get.'
              const doc = documents[id]
              if (!doc) return `Not found: document "${id}"`
              const maxContentChars = 60_000
              return JSON.stringify({
                ...doc,
                content: typeof doc.content === 'string' && doc.content.length > maxContentChars
                  ? `${doc.content.slice(0, maxContentChars)}\n... [truncated]`
                  : (doc.content || ''),
              })
            }

            if (action === 'delete') {
              if (!id) return 'Error: id is required for delete.'
              if (!documents[id]) return `Not found: document "${id}"`
              delete documents[id]
              saveDocuments(documents)
              return JSON.stringify({ ok: true, id })
            }

            if (action === 'upload') {
              if (!filePath?.trim()) return 'Error: filePath is required for upload.'
              const sourcePath = path.isAbsolute(filePath) ? filePath : safePath(cwd, filePath)
              if (!fs.existsSync(sourcePath)) return `Error: file not found: ${filePath}`
              const stat = fs.statSync(sourcePath)
              if (!stat.isFile()) return 'Error: upload expects a file path.'

              const extracted = extractDocumentText(sourcePath)
              const content = trimDocumentContent(extracted.text)
              if (!content) return 'Error: extracted document text is empty.'

              const docId = crypto.randomBytes(6).toString('hex')
              const now = Date.now()
              const parsedMetadata = metadata && typeof metadata === 'string'
                ? (() => {
                    try {
                      const m = JSON.parse(metadata)
                      return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}
                    } catch {
                      return {}
                    }
                  })()
                : {}

              const entry = {
                id: docId,
                title: title?.trim() || path.basename(sourcePath),
                fileName: path.basename(sourcePath),
                sourcePath,
                method: extracted.method,
                textLength: content.length,
                content,
                metadata: parsedMetadata,
                uploadedByAgentId: ctx?.agentId || null,
                uploadedInSessionId: ctx?.sessionId || null,
                createdAt: now,
                updatedAt: now,
              }
              documents[docId] = entry
              saveDocuments(documents)
              return JSON.stringify({
                id: entry.id,
                title: entry.title,
                fileName: entry.fileName,
                textLength: entry.textLength,
                method: entry.method,
              })
            }

            if (action === 'search') {
              const q = (query || '').trim().toLowerCase()
              if (!q) return 'Error: query is required for search.'
              const terms = q.split(/\s+/).filter(Boolean)
              const max = Math.max(1, Math.min(limit || 5, 50))

              const matches = Object.values(documents)
                .map((doc: any) => {
                  const hay = (doc.content || '').toLowerCase()
                  if (!hay) return null
                  if (!terms.every((term) => hay.includes(term))) return null
                  let score = hay.includes(q) ? 10 : 0
                  for (const term of terms) {
                    let pos = hay.indexOf(term)
                    while (pos !== -1) {
                      score += 1
                      pos = hay.indexOf(term, pos + term.length)
                    }
                  }
                  const firstTerm = terms[0] || q
                  const at = firstTerm ? hay.indexOf(firstTerm) : -1
                  const start = at >= 0 ? Math.max(0, at - 120) : 0
                  const end = Math.min((doc.content || '').length, start + 320)
                  const snippet = ((doc.content || '').slice(start, end) || '').replace(/\s+/g, ' ').trim()
                  return {
                    id: doc.id,
                    title: doc.title,
                    score,
                    snippet,
                    textLength: doc.textLength,
                    updatedAt: doc.updatedAt,
                  }
                })
                .filter(Boolean)
                .sort((a: any, b: any) => b.score - a.score)
                .slice(0, max)

              return JSON.stringify({
                query,
                total: matches.length,
                matches,
              })
            }

            return 'Unknown action. Use list, upload, search, get, or delete.'
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'manage_documents',
          description: 'Upload and index documents, then search/get/delete them for long-term retrieval. Supports PDFs (via pdftotext) and common text/doc formats.',
          schema: z.object({
            action: z.enum(['list', 'upload', 'search', 'get', 'delete']).describe('Document action'),
            id: z.string().optional().describe('Document id (for get/delete)'),
            filePath: z.string().optional().describe('Path to document file for upload (relative to working directory or absolute)'),
            title: z.string().optional().describe('Optional title override for upload'),
            query: z.string().optional().describe('Search query text (for search)'),
            limit: z.number().optional().describe('Max results (default 5 for search, 100 for list)'),
            metadata: z.string().optional().describe('Optional JSON string metadata for upload'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('manage_sessions')) {
    tools.push(
      tool(
        async () => {
          try {
            const sessions = loadSessions()
            const current = ctx?.sessionId ? sessions[ctx.sessionId] : null
            return JSON.stringify({
              sessionId: ctx?.sessionId || null,
              sessionName: current?.name || null,
              sessionType: current?.sessionType || null,
              user: current?.user || null,
              agentId: ctx?.agentId || current?.agentId || null,
              parentSessionId: current?.parentSessionId || null,
              heartbeatEnabled: typeof current?.heartbeatEnabled === 'boolean'
                ? current.heartbeatEnabled
                : null,
            })
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'whoami_tool',
          description: 'Return identity/runtime context for this agent execution (current session id, agent id, session owner, and parent session).',
          schema: z.object({}),
        },
      ),
    )

    tools.push(
      tool(
        async ({ action, sessionId, message, limit, agentId, name, waitForReply, timeoutSec, queueMode, heartbeatEnabled, heartbeatIntervalSec, heartbeatIntervalMs, finalStatus }) => {
          try {
            const sessions = loadSessions()
            if (action === 'list') {
              const { getSessionRunState } = await import('./session-run-manager')
              const items = Object.values(sessions)
                .sort((a: any, b: any) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
                .slice(0, Math.max(1, Math.min(limit || 50, 200)))
                .map((s: any) => {
                  const runState = getSessionRunState(s.id)
                  return {
                    id: s.id,
                    name: s.name,
                    sessionType: s.sessionType || 'human',
                    agentId: s.agentId || null,
                    provider: s.provider,
                    model: s.model,
                    parentSessionId: s.parentSessionId || null,
                    active: !!runState.runningRunId,
                    queuedCount: runState.queueLength,
                    heartbeatEnabled: s.heartbeatEnabled !== false,
                    lastActiveAt: s.lastActiveAt,
                    createdAt: s.createdAt,
                  }
                })
              return JSON.stringify(items)
            }

            if (action === 'history') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required for history when no current session context exists.'
              const target = sessions[targetSessionId]
              if (!target) return `Not found: session "${targetSessionId}"`
              const max = Math.max(1, Math.min(limit || 20, 100))
              const history = (target.messages || []).slice(-max).map((m: any) => ({
                role: m.role,
                text: m.text,
                time: m.time,
                kind: m.kind || 'chat',
              }))
              return JSON.stringify({ sessionId: target.id, name: target.name, history, currentSessionDefaulted: !sessionId })
            }

            if (action === 'status') {
              if (!sessionId) return 'Error: sessionId is required for status.'
              const target = sessions[sessionId]
              if (!target) return `Not found: session "${sessionId}"`
              const { getSessionRunState } = await import('./session-run-manager')
              const run = getSessionRunState(sessionId)
              return JSON.stringify({
                id: target.id,
                name: target.name,
                runningRunId: run.runningRunId || null,
                queuedCount: run.queueLength,
                heartbeatEnabled: target.heartbeatEnabled !== false,
                lastActiveAt: target.lastActiveAt,
                messageCount: (target.messages || []).length,
              })
            }

            if (action === 'stop') {
              if (!sessionId) return 'Error: sessionId is required for stop.'
              if (!sessions[sessionId]) return `Not found: session "${sessionId}"`
              const { cancelSessionRuns } = await import('./session-run-manager')
              const out = cancelSessionRuns(sessionId, 'Stopped by manage_sessions')
              return JSON.stringify({ sessionId, ...out })
            }

            if (action === 'send') {
              if (!sessionId) return 'Error: sessionId is required for send.'
              if (!message?.trim()) return 'Error: message is required for send.'
              if (!sessions[sessionId]) return `Not found: session "${sessionId}"`
              if (ctx?.sessionId && sessionId === ctx.sessionId) return 'Error: cannot send to the current session itself.'

              const sourceSession = ctx?.sessionId ? sessions[ctx.sessionId] : null
              const sourceLabel = sourceSession
                ? `${sourceSession.name} (${sourceSession.id})`
                : (ctx?.agentId ? `agent:${ctx.agentId}` : 'platform')
              const bridgedMessage = `[Session message from ${sourceLabel}]\n${message.trim()}`

              const { enqueueSessionRun } = await import('./session-run-manager')
              const mode = queueMode === 'steer' || queueMode === 'collect' || queueMode === 'followup'
                ? queueMode
                : 'followup'
              const run = enqueueSessionRun({
                sessionId,
                message: bridgedMessage,
                source: 'session-send',
                internal: false,
                mode,
              })

              if (waitForReply === false) {
                return JSON.stringify({
                  sessionId,
                  runId: run.runId,
                  status: 'queued',
                  mode,
                })
              }

              const timeoutMs = Math.max(5, Math.min(timeoutSec || 120, 900)) * 1000
              const result = await Promise.race([
                run.promise,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Timed out waiting for session reply after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
                ),
              ])
              return JSON.stringify({
                sessionId,
                runId: run.runId,
                status: result.error ? 'failed' : 'completed',
                reply: result.text || '',
                error: result.error || null,
              })
            }

            if (action === 'spawn') {
              if (!agentId) return 'Error: agentId is required for spawn.'
              const agents = loadAgents()
              const agent = agents[agentId]
              if (!agent) return `Not found: agent "${agentId}"`
              const sourceSession = ctx?.sessionId ? sessions[ctx.sessionId] : null
              const ownerUser = sourceSession?.user || 'system'

              const id = crypto.randomBytes(4).toString('hex')
              const now = Date.now()
              const entry = {
                id,
                name: (name || `${agent.name} Session`).trim(),
                cwd,
                user: ownerUser,
                provider: agent.provider || 'claude-cli',
                model: agent.model || '',
                credentialId: agent.credentialId || null,
                apiEndpoint: agent.apiEndpoint || null,
                claudeSessionId: null,
                codexThreadId: null,
                opencodeSessionId: null,
                delegateResumeIds: {
                  claudeCode: null,
                  codex: null,
                  opencode: null,
                },
                messages: [],
                createdAt: now,
                lastActiveAt: now,
                sessionType: 'orchestrated',
                agentId: agent.id,
                parentSessionId: ctx?.sessionId || null,
                tools: agent.tools || [],
                heartbeatEnabled: agent.heartbeatEnabled ?? true,
                heartbeatIntervalSec: agent.heartbeatIntervalSec ?? null,
              }
              sessions[id] = entry as any
              saveSessions(sessions)

              let runId: string | null = null
              if (message?.trim()) {
                const { enqueueSessionRun } = await import('./session-run-manager')
                const run = enqueueSessionRun({
                  sessionId: id,
                  message: message.trim(),
                  source: 'session-spawn',
                  internal: false,
                  mode: 'followup',
                })
                runId = run.runId
              }

              return JSON.stringify({
                sessionId: id,
                name: entry.name,
                agentId: agent.id,
                queuedRunId: runId,
              })
            }

            if (action === 'set_heartbeat') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required when no current session context exists.'
              const target = sessions[targetSessionId]
              if (!target) return `Not found: session "${targetSessionId}"`
              const intervalFromMs = typeof heartbeatIntervalMs === 'number'
                ? Math.max(0, Math.round(heartbeatIntervalMs / 1000))
                : undefined
              const nextIntervalSecRaw = typeof heartbeatIntervalSec === 'number'
                ? heartbeatIntervalSec
                : intervalFromMs
              const nextIntervalSec = typeof nextIntervalSecRaw === 'number'
                ? Math.max(0, Math.min(3600, Math.round(nextIntervalSecRaw)))
                : undefined

              if (typeof heartbeatEnabled !== 'boolean' && typeof nextIntervalSec !== 'number') {
                return 'Error: set_heartbeat requires heartbeatEnabled and/or heartbeatIntervalSec/heartbeatIntervalMs.'
              }

              if (typeof heartbeatEnabled === 'boolean') target.heartbeatEnabled = heartbeatEnabled
              if (typeof nextIntervalSec === 'number') target.heartbeatIntervalSec = nextIntervalSec
              target.lastActiveAt = Date.now()

              let statusMessageAdded = false
              if (target.heartbeatEnabled === false && finalStatus?.trim()) {
                if (!Array.isArray(target.messages)) target.messages = []
                target.messages.push({
                  role: 'assistant',
                  text: finalStatus.trim(),
                  time: Date.now(),
                  kind: 'heartbeat',
                })
                statusMessageAdded = true
              }

              saveSessions(sessions)
              return JSON.stringify({
                sessionId: targetSessionId,
                heartbeatEnabled: target.heartbeatEnabled !== false,
                heartbeatIntervalSec: target.heartbeatIntervalSec ?? null,
                heartbeatIntervalMs: typeof target.heartbeatIntervalSec === 'number' ? target.heartbeatIntervalSec * 1000 : null,
                statusMessageAdded,
              })
            }

            return 'Unknown action. Use list, history, status, send, spawn, stop, or set_heartbeat.'
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'sessions_tool',
          description: 'Session-to-session operations: list/status/history sessions, send messages to other sessions, spawn new agent sessions, stop active runs, and control per-session heartbeat.',
          schema: z.object({
            action: z.enum(['list', 'history', 'status', 'send', 'spawn', 'stop', 'set_heartbeat']).describe('Session action'),
            sessionId: z.string().optional().describe('Target session id (history defaults to current session when omitted; status/send/stop still require explicit sessionId)'),
            message: z.string().optional().describe('Message body (required for send, optional initial task for spawn)'),
            limit: z.number().optional().describe('Max items/messages for list/history'),
            agentId: z.string().optional().describe('Agent id to spawn (required for spawn)'),
            name: z.string().optional().describe('Optional session name for spawn'),
            waitForReply: z.boolean().optional().describe('For send: if false, queue and return immediately'),
            timeoutSec: z.number().optional().describe('For send with waitForReply=true, max wait time in seconds (default 120)'),
            queueMode: z.enum(['followup', 'steer', 'collect']).optional().describe('Queue mode for send'),
            heartbeatEnabled: z.boolean().optional().describe('For set_heartbeat: true to enable heartbeat, false to disable'),
            heartbeatIntervalSec: z.number().optional().describe('For set_heartbeat: optional heartbeat interval in seconds (0-3600).'),
            heartbeatIntervalMs: z.number().optional().describe('For set_heartbeat: optional heartbeat interval in milliseconds (alias of heartbeatIntervalSec).'),
            finalStatus: z.string().optional().describe('For set_heartbeat when disabling: optional final status update to append in the session'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async ({ query, sessionId, limit, dateRange }) => {
          try {
            const sessions = loadSessions()
            const targetSessionId = sessionId || ctx?.sessionId || null
            if (!targetSessionId) return 'Error: sessionId is required when no current session context exists.'
            const target = sessions[targetSessionId]
            if (!target) return `Not found: session "${targetSessionId}"`

            const from = typeof dateRange?.from === 'number' ? dateRange.from : Number.NEGATIVE_INFINITY
            const to = typeof dateRange?.to === 'number' ? dateRange.to : Number.POSITIVE_INFINITY
            const max = Math.max(1, Math.min(limit || 20, 200))
            const q = (query || '').trim().toLowerCase()
            const terms = q ? q.split(/\s+/).filter(Boolean) : []

            const scoredAll = (target.messages || [])
              .map((m: any, idx: number) => ({ ...m, _idx: idx }))
              .filter((m: any) => {
                const t = typeof m.time === 'number' ? m.time : 0
                if (t < from || t > to) return false
                if (!terms.length) return true
                const hay = `${m.role || ''}\n${m.kind || ''}\n${m.text || ''}`.toLowerCase()
                return terms.every((term) => hay.includes(term))
              })
              .map((m: any) => {
                const hay = `${m.text || ''}`.toLowerCase()
                let score = 0
                if (q && hay.includes(q)) score += 5
                for (const term of terms) {
                  if (hay.includes(term)) score += 1
                }
                const ageBoost = Math.max(0, (m.time || 0) / 1e13)
                score += ageBoost
                return { ...m, _score: score }
              })
              .sort((a: any, b: any) => b._score - a._score)
            const scored = scoredAll
              .slice(0, max)
              .map((m: any) => ({
                index: m._idx,
                role: m.role,
                kind: m.kind || 'chat',
                time: m.time,
                text: typeof m.text === 'string' && m.text.length > 1200 ? `${m.text.slice(0, 1200)}...` : (m.text || ''),
              }))

            return JSON.stringify({
              sessionId: target.id,
              name: target.name,
              query: query || '',
              limit: max,
              matches: scored,
              totalMatches: scoredAll.length,
              currentSessionDefaulted: !sessionId,
            })
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'search_history_tool',
          description: 'Search message history for the current session by default, or another session if sessionId is provided. Useful for recalling prior commitments, decisions, and details.',
          schema: z.object({
            query: z.string().describe('Search query text (keywords, phrase, or topic).'),
            sessionId: z.string().optional().describe('Optional target session id; defaults to current session.'),
            limit: z.number().optional().describe('Maximum number of matches to return (default 20, max 200).'),
            dateRange: z.object({
              from: z.number().optional().describe('Unix epoch ms lower bound (inclusive).'),
              to: z.number().optional().describe('Unix epoch ms upper bound (inclusive).'),
            }).optional().describe('Optional time filter for message timestamps.'),
          }),
        },
      ),
    )
  }

  if (enabledTools.includes('manage_connectors')) {
    tools.push(
      tool(
        async ({ action, connectorId, platform, to, message, imageUrl, fileUrl, mimeType, fileName, caption }) => {
          try {
            const normalizeWhatsAppTarget = (input: string): string => {
              const raw = input.trim()
              if (!raw) return raw
              if (raw.includes('@')) return raw
              let cleaned = raw.replace(/[^\d+]/g, '')
              if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
              if (cleaned.startsWith('0') && cleaned.length >= 10) {
                // Match inbound connector normalization (e.g. UK local 07... -> 447...)
                cleaned = '44' + cleaned.slice(1)
              }
              cleaned = cleaned.replace(/[^\d]/g, '')
              return cleaned ? `${cleaned}@s.whatsapp.net` : raw
            }

            const { listRunningConnectors, sendConnectorMessage, getConnectorRecentChannelId } = await import('./connectors/manager')
            const running = listRunningConnectors(platform || undefined)

            if (action === 'list_running' || action === 'list_targets') {
              return JSON.stringify(running)
            }

            if (action === 'send') {
              const hasText = !!message?.trim()
              const hasMedia = !!imageUrl?.trim() || !!fileUrl?.trim()
              if (!hasText && !hasMedia) return 'Error: message or media URL is required for send action.'
              if (!running.length) {
                return `Error: no running connectors${platform ? ` for platform "${platform}"` : ''}.`
              }

              const selected = connectorId
                ? running.find((c) => c.id === connectorId)
                : running[0]
              if (!selected) return `Error: running connector not found: ${connectorId}`

              const connectors = loadConnectors()
              const connector = connectors[selected.id]
              if (!connector) return `Error: connector not found: ${selected.id}`

              let channelId = to?.trim() || ''
              if (!channelId) {
                const outbound = connector.config?.outboundJid?.trim()
                if (outbound) channelId = outbound
              }
              if (!channelId) {
                const recentChannelId = getConnectorRecentChannelId(selected.id)
                if (recentChannelId) channelId = recentChannelId
              }
              if (!channelId) {
                const allowed = connector.config?.allowedJids?.split(',').map((s: string) => s.trim()).filter(Boolean) || []
                if (allowed.length) channelId = allowed[0]
              }
              if (!channelId) {
                return `Error: no target recipient configured. Provide "to", or set connector config "outboundJid"/"allowedJids".`
              }
              if (connector.platform === 'whatsapp') {
                channelId = normalizeWhatsAppTarget(channelId)
              }

              const sent = await sendConnectorMessage({
                connectorId: selected.id,
                channelId,
                text: message?.trim() || '',
                imageUrl: imageUrl?.trim() || undefined,
                fileUrl: fileUrl?.trim() || undefined,
                mimeType: mimeType?.trim() || undefined,
                fileName: fileName?.trim() || undefined,
                caption: caption?.trim() || undefined,
              })
              return JSON.stringify({
                status: 'sent',
                connectorId: sent.connectorId,
                platform: sent.platform,
                to: sent.channelId,
                messageId: sent.messageId || null,
              })
            }

            return 'Unknown action. Use list_running, list_targets, or send.'
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'connector_message_tool',
          description: 'Send proactive outbound messages through running connectors (for example WhatsApp status updates). Supports listing running connectors/targets and sending text plus optional media links.',
          schema: z.object({
            action: z.enum(['list_running', 'list_targets', 'send']).describe('connector messaging action'),
            connectorId: z.string().optional().describe('Optional connector id. Defaults to the first running connector (or first for selected platform).'),
            platform: z.string().optional().describe('Optional platform filter (whatsapp, telegram, slack, discord).'),
            to: z.string().optional().describe('Target channel id / recipient. For WhatsApp, phone number or full JID.'),
            message: z.string().optional().describe('Message text to send (required for send action).'),
            imageUrl: z.string().optional().describe('Optional public image URL to attach/send where platform supports media.'),
            fileUrl: z.string().optional().describe('Optional public file URL to attach/send where platform supports documents.'),
            mimeType: z.string().optional().describe('Optional MIME type when sending fileUrl.'),
            fileName: z.string().optional().describe('Optional display file name when sending fileUrl.'),
            caption: z.string().optional().describe('Optional caption used with image/file sends.'),
          }),
        },
      ),
    )
  }

  return {
    tools,
    cleanup: async () => {
      for (const fn of cleanupFns) {
        try { await fn() } catch { /* ignore */ }
      }
    },
  }
}
