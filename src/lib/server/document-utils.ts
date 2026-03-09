import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as cheerio from 'cheerio'
import { findBinaryOnPath } from './session-tools/context'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv',
  '', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.java', '.yaml', '.yml', '.sql', '.xml', '.css', '.scss', '.html', '.htm',
])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])

export interface StructuredTable {
  name: string
  headers: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
}

export interface DocumentArtifact {
  filePath: string
  fileName: string
  ext: string
  method: string
  text: string
  metadata: Record<string, unknown>
  tables: StructuredTable[]
}

function trimText(text: string, maxChars = 200_000): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}\n... [truncated]`
}

function normalizeScalar(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function parseDelimitedText(input: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"'
        index += 1
        continue
      }
      if (char === '"') {
        inQuotes = false
        continue
      }
      field += char
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (char === '\r') continue
    field += char
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0))
}

function matrixToTable(name: string, matrix: string[][]): StructuredTable {
  if (matrix.length === 0) return { name, headers: [], rows: [], rowCount: 0 }
  const headerRow = matrix[0].map((cell, index) => cell.trim() || `column_${index + 1}`)
  const rows = matrix.slice(1).map((cells) => {
    const row: Record<string, unknown> = {}
    for (let index = 0; index < headerRow.length; index += 1) {
      row[headerRow[index]] = cells[index] ?? ''
    }
    return row
  })
  return {
    name,
    headers: headerRow,
    rows,
    rowCount: rows.length,
  }
}

function objectsToTable(name: string, rows: Array<Record<string, unknown>>): StructuredTable {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const normalizedRows = rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const header of headers) out[header] = normalizeScalar(row[header])
    return out
  })
  return {
    name,
    headers,
    rows: normalizedRows,
    rowCount: normalizedRows.length,
  }
}

function tablesToText(tables: StructuredTable[]): string {
  return tables
    .map((table) => {
      const header = table.headers.join('\t')
      const body = table.rows.slice(0, 100).map((row) => table.headers.map((key) => String(row[key] ?? '')).join('\t')).join('\n')
      return `${table.name}\n${header}${body ? `\n${body}` : ''}`
    })
    .join('\n\n')
}

function worksheetRowToArray(values: unknown): unknown[] {
  if (Array.isArray(values)) return values.slice(1)
  if (values && typeof values === 'object') {
    return Object.entries(values as Record<string, unknown>)
      .filter(([key]) => Number.isFinite(Number(key)) && Number(key) >= 1)
      .sort((left, right) => Number(left[0]) - Number(right[0]))
      .map(([, value]) => value)
  }
  return []
}

function listZipEntries(filePath: string): { entries: string[]; method: string } {
  const unzip = findBinaryOnPath('unzip') || findBinaryOnPath('zipinfo')
  if (!unzip) throw new Error('ZIP listing requires `unzip` or `zipinfo` on PATH.')
  const args = path.basename(unzip).includes('zipinfo') ? ['-1', filePath] : ['-Z1', filePath]
  const out = spawnSync(unzip, args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
  })
  if ((out.status ?? 1) !== 0) {
    throw new Error(`Failed to inspect ZIP: ${(out.stderr || out.stdout || '').trim() || 'unknown error'}`)
  }
  const entries = (out.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return { entries, method: path.basename(unzip) }
}

async function extractPdfText(filePath: string): Promise<{ text: string; method: string }> {
  try {
    const pdfMod = await import(/* webpackIgnore: true */ 'pdf-parse')
    const pdfParse = ((pdfMod as Record<string, unknown>).default ?? pdfMod) as (buf: Buffer) => Promise<{ text: string }>
    const result = await pdfParse(fs.readFileSync(filePath))
    if ((result.text || '').trim()) {
      return { text: result.text, method: 'pdf-parse' }
    }
  } catch {
    // fall through to pdftotext
  }

  const pdftotext = findBinaryOnPath('pdftotext')
  if (!pdftotext) throw new Error('PDF extraction requires `pdf-parse` or `pdftotext`.')
  const out = spawnSync(pdftotext, ['-layout', '-nopgbrk', '-q', filePath, '-'], {
    encoding: 'utf-8',
    maxBuffer: 25 * 1024 * 1024,
    timeout: 20_000,
  })
  if ((out.status ?? 1) !== 0) {
    throw new Error(`pdftotext failed: ${(out.stderr || out.stdout || '').trim() || 'unknown error'}`)
  }
  return { text: out.stdout || '', method: 'pdftotext' }
}

function extractImageText(filePath: string): { text: string; method: string } {
  const tesseract = findBinaryOnPath('tesseract')
  if (!tesseract) {
    throw new Error('Image OCR requires `tesseract` on PATH.')
  }
  const out = spawnSync(tesseract, [filePath, 'stdout', '--psm', '6'], {
    encoding: 'utf-8',
    maxBuffer: 25 * 1024 * 1024,
    timeout: 30_000,
  })
  if ((out.status ?? 1) !== 0) {
    throw new Error(`tesseract failed: ${(out.stderr || out.stdout || '').trim() || 'unknown error'}`)
  }
  return { text: out.stdout || '', method: 'tesseract' }
}

function extractRichText(filePath: string): { text: string; method: string } {
  const textutil = findBinaryOnPath('textutil')
  if (!textutil) throw new Error('DOC/DOCX/RTF extraction requires `textutil` on PATH.')
  const out = spawnSync(textutil, ['-convert', 'txt', '-stdout', filePath], {
    encoding: 'utf-8',
    maxBuffer: 25 * 1024 * 1024,
    timeout: 20_000,
  })
  if ((out.status ?? 1) !== 0 || !(out.stdout || '').trim()) {
    throw new Error(`textutil failed: ${(out.stderr || out.stdout || '').trim() || 'unknown error'}`)
  }
  return { text: out.stdout || '', method: 'textutil' }
}

export async function extractDocumentArtifact(filePath: string, options?: { maxChars?: number; preferOcr?: boolean }): Promise<DocumentArtifact> {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${filePath}`)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`Expected a file: ${filePath}`)

  const ext = path.extname(resolved).toLowerCase()
  const metadata: Record<string, unknown> = {
    sizeBytes: stat.size,
    modifiedAt: stat.mtimeMs,
  }
  const maxChars = options?.maxChars || 200_000
  let text = ''
  let method = 'utf8'
  let tables: StructuredTable[] = []

  if (ext === '.pdf') {
    const pdf = await extractPdfText(resolved)
    text = pdf.text
    method = pdf.method
  } else if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? '\t' : ','
    const raw = fs.readFileSync(resolved, 'utf-8')
    const table = matrixToTable(path.basename(resolved), parseDelimitedText(raw, delimiter))
    tables = [table]
    text = tablesToText(tables)
    method = ext === '.tsv' ? 'tsv' : 'csv'
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(resolved)
    tables = workbook.worksheets.map((worksheet) => {
      const matrix: string[][] = []
      worksheet.eachRow((row) => {
        matrix.push(worksheetRowToArray(row.values).map((cell) => String(normalizeScalar(cell) ?? '')))
      })
      return matrixToTable(worksheet.name, matrix)
    }).filter((table) => table.headers.length > 0 || table.rowCount > 0)
    text = tablesToText(tables)
    method = 'exceljs'
    metadata.sheetNames = workbook.worksheets.map((sheet) => sheet.name)
  } else if (ext === '.json') {
    const raw = fs.readFileSync(resolved, 'utf-8')
    text = raw
    method = 'json'
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
        tables = [objectsToTable(path.basename(resolved), parsed as Array<Record<string, unknown>>)]
      }
    } catch {
      // keep raw json text only
    }
  } else if (ext === '.html' || ext === '.htm') {
    const html = fs.readFileSync(resolved, 'utf-8')
    const $ = cheerio.load(html)
    $('script, style, noscript').remove()
    text = $('body').text() || $.text()
    method = 'html-strip'
  } else if (ext === '.zip') {
    const zip = listZipEntries(resolved)
    text = zip.entries.join('\n')
    method = zip.method
    metadata.entries = zip.entries
  } else if (ext === '.doc' || ext === '.docx' || ext === '.rtf') {
    const rich = extractRichText(resolved)
    text = rich.text
    method = rich.method
  } else if (IMAGE_EXTENSIONS.has(ext) || options?.preferOcr === true) {
    const image = extractImageText(resolved)
    text = image.text
    method = image.method
  } else if (TEXT_EXTENSIONS.has(ext) || !ext) {
    text = fs.readFileSync(resolved, 'utf-8')
    method = 'utf8'
  } else {
    text = fs.readFileSync(resolved, 'utf-8')
    method = 'utf8-fallback'
  }

  return {
    filePath: resolved,
    fileName: path.basename(resolved),
    ext,
    method,
    text: trimText(text, maxChars),
    metadata,
    tables,
  }
}

export async function loadTabularFile(filePath: string, options?: { sheetName?: string }): Promise<StructuredTable> {
  const resolved = path.resolve(filePath)
  const ext = path.extname(resolved).toLowerCase()
  if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? '\t' : ','
    return matrixToTable(path.basename(resolved), parseDelimitedText(fs.readFileSync(resolved, 'utf-8'), delimiter))
  }
  if (ext === '.json') {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
    if (!Array.isArray(parsed) || !parsed.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      throw new Error('JSON table inputs must be an array of objects.')
    }
    return objectsToTable(path.basename(resolved), parsed as Array<Record<string, unknown>>)
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(resolved)
    const target = options?.sheetName
      ? workbook.getWorksheet(options.sheetName)
      : workbook.worksheets[0]
    if (!target) throw new Error(`Worksheet not found: ${options?.sheetName || '(first worksheet)'}`)
    const matrix: string[][] = []
    target.eachRow((row) => {
      matrix.push(worksheetRowToArray(row.values).map((cell) => String(normalizeScalar(cell) ?? '')))
    })
    return matrixToTable(target.name, matrix)
  }
  throw new Error(`Unsupported tabular file: ${ext || '(no extension)'}`)
}

export function normalizeInlineRows(value: unknown): StructuredTable {
  if (!Array.isArray(value)) throw new Error('rows must be an array.')
  if (value.length === 0) return { name: 'rows', headers: [], rows: [], rowCount: 0 }
  if (value.every((row) => Array.isArray(row))) {
    return matrixToTable('rows', value.map((row) => (row as unknown[]).map((cell) => String(normalizeScalar(cell) ?? ''))))
  }
  if (value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return objectsToTable('rows', value as Array<Record<string, unknown>>)
  }
  throw new Error('rows must be an array of objects or arrays.')
}

function escapeDelimitedCell(value: unknown, delimiter: string): string {
  const raw = String(normalizeScalar(value) ?? '')
  if (raw.includes('"') || raw.includes('\n') || raw.includes(delimiter)) {
    return `"${raw.replace(/"/g, '""')}"`
  }
  return raw
}

export function serializeTable(table: StructuredTable, delimiter = ','): string {
  const header = table.headers.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter)
  const rows = table.rows.map((row) => table.headers.map((headerCell) => escapeDelimitedCell(row[headerCell], delimiter)).join(delimiter))
  return [header, ...rows].join('\n')
}

export async function writeStructuredTable(filePath: string, table: StructuredTable): Promise<{ filePath: string; format: string }> {
  const resolved = path.resolve(filePath)
  const ext = path.extname(resolved).toLowerCase()
  fs.mkdirSync(path.dirname(resolved), { recursive: true })

  if (ext === '.json') {
    fs.writeFileSync(resolved, JSON.stringify(table.rows, null, 2), 'utf-8')
    return { filePath: resolved, format: 'json' }
  }
  if (ext === '.tsv') {
    fs.writeFileSync(resolved, serializeTable(table, '\t'), 'utf-8')
    return { filePath: resolved, format: 'tsv' }
  }
  if (ext === '.xlsx') {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet(table.name || 'Sheet1')
    worksheet.addRow(table.headers)
    for (const row of table.rows) {
      worksheet.addRow(table.headers.map((header) => row[header] ?? null))
    }
    await workbook.xlsx.writeFile(resolved)
    return { filePath: resolved, format: 'xlsx' }
  }

  fs.writeFileSync(resolved, serializeTable(table, ','), 'utf-8')
  return { filePath: resolved, format: 'csv' }
}
