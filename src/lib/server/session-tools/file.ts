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
        async ({ filePath, content, encoding }) => {
          try {
            const resolved = safePath(bctx.cwd, filePath)
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            if (encoding === 'base64') {
              const buf = Buffer.from(content, 'base64')
              fs.writeFileSync(resolved, buf)
              return `File written: ${filePath} (${buf.length} bytes, binary)`
            }
            fs.writeFileSync(resolved, content, 'utf-8')
            return `File written: ${filePath} (${content.length} bytes)`
          } catch (err: any) {
            return `Error writing file: ${err.message}`
          }
        },
        {
          name: 'write_file',
          description: 'Write content to a file in the session working directory. Creates directories if needed. For PDFs and styled reports, use the create_document tool instead. For other binary files (Excel, images, zip, etc.), set encoding to "base64" and pass base64-encoded content.',
          schema: z.object({
            filePath: z.string().describe('Relative path to the file'),
            content: z.string().describe('The content to write. For binary files, this must be a base64-encoded string.'),
            encoding: z.enum(['utf-8', 'base64']).optional().describe('Encoding of the content. Use "base64" for binary files like PDF, Excel, images, zip archives. Defaults to "utf-8" for plain text.'),
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

  if (canSendFiles || canWriteFiles) {
    // create_document: markdown → pdf / html / png / jpg
    tools.push(
      tool(
        async ({ content, title, filename, format }) => {
          try {
            const fmt = format || 'pdf'
            const { marked } = await import('marked')
            const html = await marked.parse(content)
            const safeTitle = (title || 'Document').replace(/</g, '&lt;')
            const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.6}
h1{font-size:28px;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
h2{font-size:22px;margin-top:32px}
h3{font-size:18px;margin-top:24px}
pre{background:#f3f4f6;padding:16px;border-radius:8px;overflow-x:auto;font-size:13px}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #d1d5db;padding:8px 12px;text-align:left}
th{background:#f9fafb;font-weight:600}
blockquote{border-left:4px solid #d1d5db;margin:16px 0;padding:8px 16px;color:#4b5563}
img{max-width:100%}
</style></head><body>${html}</body></html>`

            const defaultBase = (title || 'document').replace(/[^a-zA-Z0-9_-]/g, '_')

            if (fmt === 'html') {
              const outName = filename || `${defaultBase}.html`
              const resolved = safePath(bctx.cwd, outName)
              fs.mkdirSync(path.dirname(resolved), { recursive: true })
              fs.writeFileSync(resolved, fullHtml, 'utf-8')
              return `HTML document created: ${outName} (${fullHtml.length} bytes)`
            }

            const { chromium } = await import('playwright')
            const browser = await chromium.launch({ headless: true })
            try {
              const page = await browser.newPage()
              await page.setContent(fullHtml, { waitUntil: 'networkidle' })

              if (fmt === 'pdf') {
                const outName = filename || `${defaultBase}.pdf`
                const resolved = safePath(bctx.cwd, outName)
                fs.mkdirSync(path.dirname(resolved), { recursive: true })
                await page.pdf({ path: resolved, format: 'A4', margin: { top: '40px', bottom: '40px', left: '40px', right: '40px' }, printBackground: true })
                return `PDF created: ${outName}`
              }

              // png or jpg screenshot
              const ext = fmt === 'jpg' ? 'jpeg' : 'png'
              const outName = filename || `${defaultBase}.${fmt}`
              const resolved = safePath(bctx.cwd, outName)
              fs.mkdirSync(path.dirname(resolved), { recursive: true })
              await page.screenshot({ path: resolved, type: ext, fullPage: true })
              const size = fs.statSync(resolved).size
              return `Image created: ${outName} (${(size / 1024).toFixed(1)} KB)`
            } finally {
              await browser.close()
            }
          } catch (err: any) {
            return `Error creating document: ${err.message}`
          }
        },
        {
          name: 'create_document',
          description: 'Create a document from markdown content. Renders markdown with professional styling and outputs as PDF, HTML, or image. Use this instead of write_file for PDFs, reports, styled pages, or document screenshots. After creating, use send_file to deliver it to the user.',
          schema: z.object({
            content: z.string().describe('Markdown content for the document'),
            title: z.string().optional().describe('Document title (shown in header and used for default filename)'),
            filename: z.string().optional().describe('Output filename (defaults to title-based name with appropriate extension)'),
            format: z.enum(['pdf', 'html', 'png', 'jpg']).optional().describe('Output format. "pdf" (default) for print-ready documents, "html" for web pages, "png"/"jpg" for images.'),
          }),
        },
      ),
    )

    // create_spreadsheet: JSON data → xlsx or csv
    tools.push(
      tool(
        async ({ data, headers, sheetName, filename, format }) => {
          try {
            const fmt = format || 'xlsx'
            let rows: Record<string, unknown>[]
            try {
              rows = JSON.parse(data)
              if (!Array.isArray(rows)) return 'Error: data must be a JSON array of objects'
            } catch {
              return 'Error: data is not valid JSON. Pass a JSON array of objects, e.g. [{"name":"Alice","age":30}]'
            }

            if (!rows.length) return 'Error: data array is empty'

            // Resolve column headers: explicit headers, or keys from first row
            const cols = headers?.length
              ? headers
              : Object.keys(rows[0] && typeof rows[0] === 'object' ? rows[0] : {})
            if (!cols.length) return 'Error: could not determine column headers. Pass headers or use objects with keys.'

            const defaultBase = (sheetName || 'spreadsheet').replace(/[^a-zA-Z0-9_-]/g, '_')

            if (fmt === 'csv') {
              const escapeCsv = (val: unknown): string => {
                const s = val == null ? '' : String(val)
                return s.includes(',') || s.includes('"') || s.includes('\n')
                  ? `"${s.replace(/"/g, '""')}"`
                  : s
              }
              const lines = [cols.map(escapeCsv).join(',')]
              for (const row of rows) {
                const r = Array.isArray(row) ? row : cols.map((c) => (row as Record<string, unknown>)[c])
                lines.push(r.map(escapeCsv).join(','))
              }
              const outName = filename || `${defaultBase}.csv`
              const resolved = safePath(bctx.cwd, outName)
              fs.mkdirSync(path.dirname(resolved), { recursive: true })
              fs.writeFileSync(resolved, lines.join('\n'), 'utf-8')
              return `CSV created: ${outName} (${rows.length} rows, ${cols.length} columns)`
            }

            // xlsx via exceljs
            const ExcelJS = await import('exceljs')
            const workbook = new ExcelJS.default.Workbook()
            const sheet = workbook.addWorksheet(sheetName || 'Sheet1')

            sheet.columns = cols.map((c) => ({ header: c, key: c, width: Math.max(12, c.length + 4) }))
            // Style header row
            sheet.getRow(1).font = { bold: true }
            sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }

            for (const row of rows) {
              if (Array.isArray(row)) {
                const obj: Record<string, unknown> = {}
                cols.forEach((c, i) => { obj[c] = row[i] })
                sheet.addRow(obj)
              } else {
                sheet.addRow(row)
              }
            }

            const outName = filename || `${defaultBase}.xlsx`
            const resolved = safePath(bctx.cwd, outName)
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            await workbook.xlsx.writeFile(resolved)
            const size = fs.statSync(resolved).size
            return `Excel spreadsheet created: ${outName} (${rows.length} rows, ${cols.length} columns, ${(size / 1024).toFixed(1)} KB)`
          } catch (err: any) {
            return `Error creating spreadsheet: ${err.message}`
          }
        },
        {
          name: 'create_spreadsheet',
          description: 'Create an Excel (.xlsx) or CSV file from structured data. Pass data as a JSON array of objects. Use this for tables, reports, data exports, and any tabular data the user requests. After creating, use send_file to deliver it to the user.',
          schema: z.object({
            data: z.string().describe('JSON array of objects, e.g. [{"name":"Alice","score":95},{"name":"Bob","score":87}]'),
            headers: z.array(z.string()).optional().describe('Column headers in display order. If omitted, keys from the first object are used.'),
            sheetName: z.string().optional().describe('Worksheet name (default "Sheet1")'),
            filename: z.string().optional().describe('Output filename (defaults to sheetName-based name with extension)'),
            format: z.enum(['xlsx', 'csv']).optional().describe('Output format: "xlsx" (default) for Excel, "csv" for plain CSV.'),
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
