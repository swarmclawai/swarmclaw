import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from '../storage'
import type { ToolBuildContext } from './context'
import { safePath, truncate, listDirRecursive, MAX_FILE } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

function resolveFileToolPath(cwd: string, target: string): string {
  try {
    return safePath(cwd, target)
  } catch (err: unknown) {
    if (!path.isAbsolute(target)) throw err
    return safePath(process.cwd(), target)
  }
}

/**
 * Unified File Execution Logic
 */
async function executeFileAction(args: Record<string, unknown>, bctx: { cwd: string }) {
  const normalized = normalizeToolInputArgs(args)
  // Normalize filePath/content for single-file mode
  const files = normalized.files as Array<Record<string, unknown>> | undefined
  let action = normalized.action as string | undefined
  const encoding = normalized.encoding as string | undefined

  // Resiliency: check if action is buried in the files array
  if (!action && Array.isArray(files) && files.length > 0) {
    action = files[0].action as string
  }

  const filePath = (normalized.filePath || normalized.path) as string | undefined
  const content = normalized.content as string | undefined
  const dirPath = (normalized.dirPath || normalized.directory || normalized.path) as string | undefined
  const sourcePath = (normalized.sourcePath || normalized.source || normalized.from) as string | undefined
  const destinationPath = (normalized.destinationPath || normalized.destination || normalized.to) as string | undefined
  const overwrite = !!normalized.overwrite
  const recursive = !!normalized.recursive
  const force = !!normalized.force

  try {
    switch (action) {
      case 'read': {
        const target = filePath || (files?.[0]?.path as string | undefined)
        if (!target) return 'Error: no filePath or path provided.'
        const resolved = resolveFileToolPath(bctx.cwd, target)
        return truncate(fs.readFileSync(resolved, 'utf-8'), MAX_FILE)
      }
      
      case 'write': {
        // Handle bulk files if provided
        const filesToWrite: Array<Record<string, unknown>> = Array.isArray(files) ? files : [{ path: filePath, content }]
        const results: string[] = []

        for (const file of filesToWrite) {
          const targetPath = (file.path || file.filePath) as string | undefined
          if (!targetPath) continue
          const fileContent = (file.content ?? '') as string

          const resolved = resolveFileToolPath(bctx.cwd, targetPath)
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
        const resolved = resolveFileToolPath(bctx.cwd, dirPath || filePath || '.')
        const tree = listDirRecursive(resolved, 0, 3)
        return tree.length ? tree.join('\n') : '(empty directory)'
      }

      case 'copy': {
        if (!sourcePath) return 'Error: sourcePath is required for copy action.'
        if (!destinationPath) return 'Error: destinationPath is required for copy action.'
        const src = resolveFileToolPath(bctx.cwd, sourcePath)
        const dest = resolveFileToolPath(bctx.cwd, destinationPath)
        if (fs.existsSync(dest) && !overwrite) return `Error: destination exists`
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
        return `Copied ${sourcePath} to ${destinationPath}`
      }

      case 'move': {
        if (!sourcePath) return 'Error: sourcePath is required for move action.'
        if (!destinationPath) return 'Error: destinationPath is required for move action.'
        const src = resolveFileToolPath(bctx.cwd, sourcePath)
        const dest = resolveFileToolPath(bctx.cwd, destinationPath)
        if (fs.existsSync(dest) && !overwrite) return `Error: destination exists`
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        if (fs.existsSync(dest) && overwrite) fs.unlinkSync(dest)
        fs.renameSync(src, dest)
        return `Moved ${sourcePath} to ${destinationPath}`
      }

      case 'delete': {
        const target = filePath || (files?.[0]?.path as string | undefined)
        if (!target) return 'Error: no filePath or path provided.'
        const resolved = resolveFileToolPath(bctx.cwd, target)
        if (resolved === path.resolve(bctx.cwd) || resolved === path.resolve(process.cwd())) return 'Error: cannot delete root'
        fs.rmSync(resolved, { recursive: !!recursive, force: !!force })
        return `Deleted ${target}`
      }

      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

function collectSendFilePaths(payload: unknown, into: string[]): void {
  if (!payload) return
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed) into.push(trimmed)
    return
  }
  if (Array.isArray(payload)) {
    for (const item of payload) collectSendFilePaths(item, into)
    return
  }
  if (typeof payload !== 'object') return
  const record = payload as Record<string, unknown>
  if (typeof record.filePath === 'string') into.push(record.filePath)
  if (typeof record.path === 'string') into.push(record.path)
  if (record.files !== undefined) collectSendFilePaths(record.files, into)
}

export function normalizeSendFilePaths(args: Record<string, unknown>): string[] {
  const candidates: string[] = []
  collectSendFilePaths(args.filePath, candidates)
  collectSendFilePaths(args.path, candidates)
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

async function executeSendFile(args: Record<string, unknown>, bctx: { cwd: string }) {
  try {
    const paths = normalizeSendFilePaths(args)
    if (paths.length === 0) {
      return 'Error: filePath/path is required (or provide files[] / input.files[]).'
    }

    const links: string[] = []
    const errors: string[] = []
    for (const rawPath of paths) {
      const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(bctx.cwd, rawPath)
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
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const FilePlugin: Plugin = {
  name: 'Core Files',
  description: 'Complete file management: read, write, list, move, copy, delete, and send.',
  hooks: {
    getCapabilityDescription: () => 'I can read, write, copy, move, and send files (`read_file`, `write_file`, `list_files`, `copy_file`, `move_file`, `send_file`). Deleting files is destructive, so that may need explicit permission.',
  } as PluginHooks,
  tools: [
    {
      name: 'files',
      description: 'Unified file management tool. Actions: read, write, list, copy, move, delete. Supports bulk writes via "files" array.',
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
      description: 'Send a file to the user in chat.',
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
      async (args) => executeFileAction(args, { cwd: bctx.cwd }),
      {
        name: 'files',
        description: FilePlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    ),
    tool(
      async (args) => executeSendFile(args, { cwd: bctx.cwd }),
      {
        name: 'send_file',
        description: FilePlugin.tools![1].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
