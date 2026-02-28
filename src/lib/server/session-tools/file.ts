import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from '../storage'
import type { ToolBuildContext } from './context'
import { safePath, truncate, listDirRecursive, MAX_OUTPUT, MAX_FILE } from './context'

export function buildFileTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []

  const filesEnabled = bctx.hasTool('files')
  const canReadFiles = filesEnabled || bctx.hasTool('read_file')
  const canWriteFiles = filesEnabled || bctx.hasTool('write_file')
  const canListFiles = filesEnabled || bctx.hasTool('list_files')
  const canSendFiles = filesEnabled || bctx.hasTool('send_file')
  const canCopyFiles = filesEnabled || bctx.hasTool('copy_file')
  const canMoveFiles = filesEnabled || bctx.hasTool('move_file')
  const canDeleteFiles = bctx.hasTool('delete_file')

  if (canReadFiles) {
    tools.push(
      tool(
        async ({ filePath }) => {
          try {
            const resolved = safePath(bctx.cwd, filePath)
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
            const resolved = safePath(bctx.cwd, filePath)
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
            const resolved = safePath(bctx.cwd, dirPath || '.')
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
            const source = safePath(bctx.cwd, sourcePath)
            const destination = safePath(bctx.cwd, destinationPath)
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
            const source = safePath(bctx.cwd, sourcePath)
            const destination = safePath(bctx.cwd, destinationPath)
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
            const resolved = safePath(bctx.cwd, filePath)
            const root = path.resolve(bctx.cwd)
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
            const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(bctx.cwd, rawPath)
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

  if (bctx.hasTool('edit_file')) {
    tools.push(
      tool(
        async ({ filePath, oldText, newText }) => {
          try {
            const resolved = safePath(bctx.cwd, filePath)
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

  return tools
}
