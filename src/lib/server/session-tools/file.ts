import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { UPLOAD_DIR } from '../storage'
import { WORKSPACE_DIR } from '../data-dir'
import type { ToolBuildContext } from './context'
import { safePath, truncate, listDirRecursive, MAX_FILE } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { dedup, errorMessage } from '@/lib/shared-utils'

function pickNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function pickStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value
  }
  return undefined
}

function getFileEntryPath(entry: Record<string, unknown> | undefined): string | undefined {
  if (!entry) return undefined
  return pickNonEmptyString(
    entry.path,
    entry.filePath,
    entry.filename,
    entry.fileName,
    entry.name,
    entry.targetPath,
    entry.target,
  )
}

function getFileEntryContent(entry: Record<string, unknown> | undefined): string | undefined {
  if (!entry) return undefined
  const raw = entry.content ?? entry.text ?? entry.contents ?? entry.value ?? entry.body
  if (raw === undefined || raw === null) return undefined
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

function parseFileEntries(value: unknown): Array<Record<string, unknown>> | undefined {
  const candidates = [value]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        candidates.unshift(JSON.parse(trimmed))
      } catch {
        // ignore malformed JSON payloads and fall back to the raw string
      }
    }
  }
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    return candidate.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
  }
  return undefined
}

function inferFileAction(
  normalized: Record<string, unknown>,
  files: Array<Record<string, unknown>> | undefined,
  filePath: string | undefined,
  dirPath: string | undefined,
): string | undefined {
  const fileHasContent = Array.isArray(files) && files.some((entry) => getFileEntryContent(entry) !== undefined)
  if (fileHasContent) return 'write'
  if (getFileEntryContent(normalized) !== undefined) return 'write'
  if (dirPath) return 'list'
  if (filePath) return 'read'
  return 'list'
}

export function normalizeFileArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolInputArgs(rawArgs)
  const actionPayload = ['read', 'write', 'list', 'copy', 'move', 'delete']
    .map((candidate) => {
      const value = normalized[candidate]
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { action: candidate, value: value as Record<string, unknown> }
        : null
    })
    .find(Boolean)
  const merged = {
    ...normalized,
    ...(actionPayload?.value || {}),
  }
  const files = parseFileEntries(merged.files)

  let action = pickNonEmptyString(normalized.action, actionPayload?.action)
  if (!action && Array.isArray(files) && files.length > 0) {
    action = pickNonEmptyString(files[0].action)
  }

  const filePath = pickNonEmptyString(
    merged.filePath,
    merged.filepath,
    merged.path,
    merged.name,
    merged.filename,
    merged.fileName,
    merged.file,
    merged.targetPath,
    merged.target,
  )
  const dirPath = pickNonEmptyString(
    merged.dirPath,
    merged.directory,
    merged.directoryPath,
    merged.dir,
    merged.folder,
  )

  if (!action) {
    action = inferFileAction(merged, files, filePath, dirPath)
  }

  return {
    action,
    files,
    encoding: pickNonEmptyString(merged.encoding),
    filePath,
    content: pickStringValue(merged.content, merged.text, merged.contents, merged.value, merged.body),
    dirPath,
    sourcePath: pickNonEmptyString(merged.sourcePath, merged.source, merged.from, merged.src),
    destinationPath: pickNonEmptyString(merged.destinationPath, merged.destination, merged.to, merged.dest),
    overwrite: !!merged.overwrite,
    recursive: !!merged.recursive,
    force: !!merged.force,
  }
}

function resolveFileToolPath(cwd: string, target: string, scope?: 'workspace' | 'machine'): string {
  try {
    return safePath(cwd, target, scope)
  } catch (err: unknown) {
    if (!path.isAbsolute(target)) throw err
    return safePath(process.cwd(), target, scope)
  }
}

const BINARY_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.pdf',
  '.zip', '.gz', '.tar', '.tgz', '.7z', '.rar',
  '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.mov', '.avi', '.webm',
  '.woff', '.woff2', '.ttf', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.bin',
])

function isLikelyBinaryFile(resolvedPath: string, data: Buffer): boolean {
  const ext = path.extname(resolvedPath).toLowerCase()
  if (BINARY_FILE_EXTENSIONS.has(ext)) return true
  const sample = data.subarray(0, Math.min(data.length, 512))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

/**
 * Unified File Execution Logic
 */
export async function executeFileAction(args: Record<string, unknown>, bctx: { cwd: string; filesystemScope?: 'workspace' | 'machine' }) {
  const normalized = normalizeFileArgs(args)
  const files = normalized.files as Array<Record<string, unknown>> | undefined
  const action = normalized.action as string | undefined
  const encoding = normalized.encoding as string | undefined
  const filePath = normalized.filePath as string | undefined
  const content = normalized.content as string | undefined
  const dirPath = normalized.dirPath as string | undefined
  const sourcePath = normalized.sourcePath as string | undefined
  const destinationPath = normalized.destinationPath as string | undefined
  const overwrite = !!normalized.overwrite
  const recursive = !!normalized.recursive
  const force = !!normalized.force
  const scope = bctx.filesystemScope

  try {
    switch (action) {
      case 'read': {
        const target = filePath || getFileEntryPath(files?.[0])
        if (!target) return 'Error: no filePath or path provided.'
        const resolved = resolveFileToolPath(bctx.cwd, target, scope)
        const data = fs.readFileSync(resolved)
        if (isLikelyBinaryFile(resolved, data)) {
          return `Binary file: ${target} (${data.byteLength} bytes). I did not inline its contents. Use send_file with this path to share it.`
        }
        return truncate(data.toString('utf-8'), MAX_FILE)
      }
      
      case 'write': {
        // Handle bulk files if provided
        const filesToWrite: Array<Record<string, unknown>> = Array.isArray(files) ? files : [{ path: filePath, content }]
        const results: string[] = []

        for (const file of filesToWrite) {
          const targetPath = getFileEntryPath(file)
          if (!targetPath) continue
          const fileContent = getFileEntryContent(file) ?? ''
          if (/[\\/]$/.test(targetPath)) {
            const resolvedDir = resolveFileToolPath(bctx.cwd, targetPath, scope)
            fs.mkdirSync(resolvedDir, { recursive: true })
            results.push(`Created directory ${targetPath}`)
            continue
          }

          const resolved = resolveFileToolPath(bctx.cwd, targetPath, scope)
          fs.mkdirSync(path.dirname(resolved), { recursive: true })

          if (encoding === 'base64' && typeof fileContent === 'string') {
            const buf = Buffer.from(fileContent, 'base64')
            fs.writeFileSync(resolved, buf)
            results.push(`Written ${targetPath} (${buf.length} bytes, binary)`)
          } else {
            fs.writeFileSync(resolved, fileContent, 'utf-8')
            results.push(`Written ${targetPath} (${fileContent.length} bytes)`)
          }
        }
        return results.join('\n') || 'Error: no files to write.'
      }

      case 'list': {
        const resolved = resolveFileToolPath(bctx.cwd, dirPath || filePath || '.', scope)
        const tree = listDirRecursive(resolved, 0, 3)
        return tree.length ? tree.join('\n') : '(empty directory)'
      }

      case 'copy': {
        if (!sourcePath) return 'Error: sourcePath is required for copy action.'
        if (!destinationPath) return 'Error: destinationPath is required for copy action.'
        const src = resolveFileToolPath(bctx.cwd, sourcePath, scope)
        const dest = resolveFileToolPath(bctx.cwd, destinationPath, scope)
        if (fs.existsSync(dest) && !overwrite) return `Error: destination exists`
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
        return `Copied ${sourcePath} to ${destinationPath}`
      }

      case 'move': {
        if (!sourcePath) return 'Error: sourcePath is required for move action.'
        if (!destinationPath) return 'Error: destinationPath is required for move action.'
        const src = resolveFileToolPath(bctx.cwd, sourcePath, scope)
        const dest = resolveFileToolPath(bctx.cwd, destinationPath, scope)
        if (fs.existsSync(dest) && !overwrite) return `Error: destination exists`
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        if (fs.existsSync(dest) && overwrite) fs.unlinkSync(dest)
        fs.renameSync(src, dest)
        return `Moved ${sourcePath} to ${destinationPath}`
      }

      case 'delete': {
        const target = filePath || getFileEntryPath(files?.[0])
        if (!target) return 'Error: no filePath or path provided.'
        const resolved = resolveFileToolPath(bctx.cwd, target, scope)
        if (resolved === path.resolve(bctx.cwd) || resolved === path.resolve(process.cwd())) return 'Error: cannot delete root'
        fs.rmSync(resolved, { recursive: !!recursive, force: !!force })
        return `Deleted ${target}`
      }

      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

function collectSendFilePaths(payload: unknown, into: string[]): void {
  if (!payload) return
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed) {
      const extracted = new Set<string>()
      const uploadMatches = trimmed.match(/(?:sandbox:)?\/api\/uploads\/[^\s)\]]+/g) || []
      for (const match of uploadMatches) extracted.add(match)
      const markdownMatches = [...trimmed.matchAll(/\]\(((?:sandbox:)?\/api\/uploads\/[^\s)]+|(?:\.{1,2}\/|\/)?[^\s)]+\.(?:png|jpg|jpeg|gif|webp|pdf|md|txt|html|json|csv|yml|yaml))\)/gi)]
      for (const match of markdownMatches) {
        if (typeof match[1] === 'string' && match[1].trim()) extracted.add(match[1].trim())
      }
      if (extracted.size === 0) extracted.add(trimmed)
      for (const candidate of extracted) into.push(candidate)
    }
    return
  }
  if (Array.isArray(payload)) {
    for (const item of payload) collectSendFilePaths(item, into)
    return
  }
  if (typeof payload !== 'object') return
  const record = payload as Record<string, unknown>
  if (record.filePaths !== undefined) collectSendFilePaths(record.filePaths, into)
  if (typeof record.filePath === 'string') into.push(record.filePath)
  if (typeof record.filepath === 'string') into.push(record.filepath)
  if (typeof record.fileId === 'string') into.push(record.fileId)
  if (typeof record.id === 'string') into.push(record.id)
  if (typeof record.path === 'string') into.push(record.path)
  if (typeof record.filename === 'string') into.push(record.filename)
  if (typeof record.fileName === 'string') into.push(record.fileName)
  if (typeof record.name === 'string') into.push(record.name)
  if (typeof record.targetPath === 'string') into.push(record.targetPath)
  if (typeof record.target === 'string') into.push(record.target)
  if (record.files !== undefined) collectSendFilePaths(record.files, into)
}

export function normalizeSendFilePaths(args: Record<string, unknown>): string[] {
  const candidates: string[] = []
  collectSendFilePaths(args.filePaths, candidates)
  collectSendFilePaths(args.filePath, candidates)
  collectSendFilePaths(args.filepath, candidates)
  collectSendFilePaths(args.path, candidates)
  collectSendFilePaths(args.filename, candidates)
  collectSendFilePaths(args.fileName, candidates)
  collectSendFilePaths(args.name, candidates)
  collectSendFilePaths(args.file, candidates)
  collectSendFilePaths(args.files, candidates)

  const nestedInput = args.input
  if (typeof nestedInput === 'string') {
    try {
      const parsed = JSON.parse(nestedInput)
      collectSendFilePaths(parsed, candidates)
    } catch {
      // ignore non-JSON input strings
    }
  } else if (nestedInput && typeof nestedInput === 'object') {
    collectSendFilePaths(nestedInput, candidates)
  }

  const deduped = new Set<string>()
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed) deduped.add(trimmed)
  }
  return [...deduped]
}

function collectRecentFiles(
  root: string,
  currentDir: string,
  maxAgeMs: number,
  into: string[],
  depth: number,
): void {
  if (depth > 3) return
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      collectRecentFiles(root, path.join(currentDir, entry.name), maxAgeMs, into, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const absolute = path.join(currentDir, entry.name)
    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(absolute)
    } catch {
      stat = null
    }
    if (!stat) continue
    if (Date.now() - stat.mtimeMs > maxAgeMs) continue
    into.push(path.relative(root, absolute))
  }
}

export function findRecentSendFileFallbackPaths(cwd: string, maxAgeMs = 10 * 60 * 1000): string[] {
  const resolvedRoot = path.resolve(cwd)
  const candidates: string[] = []
  collectRecentFiles(resolvedRoot, resolvedRoot, maxAgeMs, candidates, 0)
  return dedup(candidates)
}

export function resolveSendFileSourcePath(cwd: string, rawPath: string, scope?: 'workspace' | 'machine'): string {
  const trimmed = rawPath.trim()
  const uploadMatch = trimmed.match(/^(?:sandbox:)?\/api\/uploads\/(.+)$/)
  if (uploadMatch) {
    return path.join(UPLOAD_DIR, path.basename(uploadMatch[1]))
  }
  const browserProfileIdx = trimmed.lastIndexOf('.swarmclaw/browser-profiles/')
  if (browserProfileIdx !== -1) {
    const relative = trimmed.slice(browserProfileIdx)
    return path.join(os.homedir(), relative)
  }
  if (trimmed.startsWith('browser-profiles/')) {
    const candidate = path.join(os.homedir(), '.swarmclaw', trimmed)
    if (fs.existsSync(candidate)) return candidate
  }
  if (trimmed === '/workspace' || trimmed === 'workspace') return cwd
  if (trimmed.startsWith('/workspace/') || trimmed.startsWith('workspace/')) {
    const relative = trimmed.replace(/^\/?workspace\/?/, '')
    const sessionScoped = path.resolve(cwd, relative)
    if (fs.existsSync(sessionScoped)) return sessionScoped
    return path.resolve(WORKSPACE_DIR, relative)
  }
  try {
    return safePath(cwd, trimmed, scope)
  } catch (err: unknown) {
    if (path.isAbsolute(trimmed)) return trimmed
    throw err
  }
}

async function executeSendFile(args: Record<string, unknown>, bctx: { cwd: string; filesystemScope?: 'workspace' | 'machine' }) {
  try {
    const explicitPaths = normalizeSendFilePaths(args)
    const paths = explicitPaths.length > 0 ? explicitPaths : findRecentSendFileFallbackPaths(bctx.cwd)
    if (paths.length === 0) {
      return 'Error: filePath/path is required (or provide files[] / input.files[]).'
    }
    if (explicitPaths.length === 0 && paths.length !== 1) {
      return 'Error: filePath/path is required (or provide files[] / input.files[]).'
    }

    const links: string[] = []
    const errors: string[] = []
    for (const rawPath of paths) {
      const resolved = resolveSendFileSourcePath(bctx.cwd, rawPath, bctx.filesystemScope)
      if (!fs.existsSync(resolved)) {
        errors.push(`file not found: ${rawPath}`)
        continue
      }
      const basename = path.basename(resolved)
      const filename = `${Date.now()}-${basename}`
      const dest = path.join(UPLOAD_DIR, filename)
      fs.copyFileSync(resolved, dest)
      links.push(`[Download ${basename}](/api/uploads/${filename})`)
    }

    if (links.length === 0) return `Error: ${errors[0] || 'file not found'}`
    if (errors.length === 0) return links.join('\n')
    return `${links.join('\n')}\n\nSkipped: ${errors.join('; ')}`
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const FilePlugin: Plugin = {
  name: 'Core Files',
  description: 'Complete file management: read, write, list, move, copy, delete, and send.',
  hooks: {
    getCapabilityDescription: () => 'I can manage files with the unified `files` tool (actions: `read`, `write`, `list`, `copy`, `move`, `delete`) and deliver finished artifacts with `send_file`.',
    getOperatingGuidance: () => [
      'The `files` tool always works best with an explicit action. Use `{"action":"list","dirPath":"."}` to inspect the workspace, `{"action":"read","filePath":"path/to/file.md"}` to inspect a file, and `{"action":"write","files":[{"path":"path/to/file.md","content":"..."}]}` to create or overwrite content.',
      'For follow-up revision requests, read the current file first, then overwrite it with the improved version or use `edit_file` for a surgical change.',
      'If a `files` call fails, correct the arguments and retry. Do not conclude that the workspace is inaccessible until an explicit read/list/write attempt with a path fails.',
      'When `send_file` returns a download link, copy that link exactly instead of rewriting it.',
    ],
  } as PluginHooks,
  tools: [
    {
      name: 'files',
      description: 'Unified file management tool. Actions: read, write, list, copy, move, delete. For writes, include a target path (`filePath`, `path`, `filename`, or `name`) plus content (`content`, `text`, or `body`). Supports bulk writes via "files" array.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write', 'list', 'copy', 'move', 'delete'] },
          filePath: { type: 'string' },
          path: { type: 'string', description: 'Alias for filePath' },
          content: { type: 'string' },
          files: { 
            type: 'array', 
            items: { 
              type: 'object', 
              properties: { path: { type: 'string' }, content: { type: 'string' } } 
            } 
          },
          encoding: { type: 'string', enum: ['utf-8', 'base64'] },
          dirPath: { type: 'string' },
          sourcePath: { type: 'string' },
          destinationPath: { type: 'string' },
          overwrite: { type: 'boolean' },
          recursive: { type: 'boolean' },
          force: { type: 'boolean' },
        },
        required: ['action']
      },
      execute: async (args, context) => executeFileAction(args, { cwd: context.session.cwd || process.cwd() })
    },
    {
      name: 'send_file',
      description: 'Send a file to the user in chat. Use the returned /api/uploads/... links exactly as provided.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          path: { type: 'string', description: 'Alias for filePath' },
          files: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                { type: 'object', properties: { filePath: { type: 'string' }, path: { type: 'string' } } },
              ],
            },
          },
          input: { type: 'object', additionalProperties: true },
        },
        required: []
      },
      execute: async (args, context) => executeSendFile(args, { cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('files', FilePlugin)

/**
 * Legacy Bridge
 */
export function buildFileTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('files')) return []

  return [
    tool(
      async (args) => executeFileAction(args, { cwd: bctx.cwd, filesystemScope: bctx.filesystemScope }),
      {
        name: 'files',
        description: FilePlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    ),
    tool(
      async (args) => executeSendFile(args, { cwd: bctx.cwd, filesystemScope: bctx.filesystemScope }),
      {
        name: 'send_file',
        description: FilePlugin.tools![1].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
