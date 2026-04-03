import fs from 'fs'
import path from 'path'
import * as cheerio from 'cheerio'

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.rb', '.php', '.sh', '.bash', '.zsh', '.sql', '.r', '.swift', '.kt',
  '.env', '.log', '.conf', '.properties', '.gitignore', '.dockerignore',
])

export const MAX_KNOWLEDGE_IMPORT_BYTES = 10 * 1024 * 1024
export const MAX_KNOWLEDGE_CONTENT_CHARS = 500_000

export function isKnowledgeTextFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return TEXT_EXTS.has(ext) || ext === ''
}

export function deriveKnowledgeTitle(filename: string): string {
  const name = path.basename(filename, path.extname(filename))
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || 'Knowledge Source'
}

function normalizeKnowledgeContent(content: string): string {
  const normalized = String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim()

  if (normalized.length <= MAX_KNOWLEDGE_CONTENT_CHARS) return normalized
  return `${normalized.slice(0, MAX_KNOWLEDGE_CONTENT_CHARS)}\n\n[... truncated at 500k characters]`
}

async function extractPdfText(buffer: Buffer, filePathHint?: string): Promise<string> {
  try {
    const pdfParseModule = await import('pdf-parse') as unknown as {
      default?: (input: Buffer) => Promise<{ text?: string }>
    }
    const pdfParse = pdfParseModule.default
    if (typeof pdfParse !== 'function') throw new Error('pdf-parse loader unavailable')
    const result = await pdfParse(buffer)
    return normalizeKnowledgeContent(result.text || '')
  } catch {
    return normalizeKnowledgeContent(
      `[PDF document]\n\nUnable to extract text automatically.${filePathHint ? `\n\nSaved at: ${filePathHint}` : ''}`,
    )
  }
}

function htmlToReadableText(html: string): { title: string | null; content: string } {
  const $ = cheerio.load(html)
  $('script, style, noscript, svg, nav, footer, header').remove()

  const title = $('title').first().text().trim() || null
  const root = $('main').first().length
    ? $('main').first()
    : $('article').first().length
      ? $('article').first()
      : $('body').first().length
        ? $('body').first()
        : $('html').first()

  const text = root
    .text()
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n')

  return {
    title,
    content: normalizeKnowledgeContent(text),
  }
}

export async function extractKnowledgeTextFromBuffer(
  buffer: Buffer,
  filename: string,
  filePathHint?: string,
): Promise<string> {
  if (buffer.length === 0) return ''
  if (buffer.length > MAX_KNOWLEDGE_IMPORT_BYTES) {
    throw new Error('File too large. Maximum 10MB.')
  }

  const ext = path.extname(filename).toLowerCase()
  if (ext === '.pdf') {
    return extractPdfText(buffer, filePathHint)
  }

  if (isKnowledgeTextFile(filename)) {
    return normalizeKnowledgeContent(buffer.toString('utf-8'))
  }

  return normalizeKnowledgeContent(
    `[Binary file: ${filename}]${filePathHint ? `\n\nSaved at: ${filePathHint}` : ''}`,
  )
}

export async function extractKnowledgeTextFromFile(filePath: string, filename?: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath)
  return extractKnowledgeTextFromBuffer(buffer, filename || path.basename(filePath), filePath)
}

export async function extractKnowledgeTextFromUrl(sourceUrl: string): Promise<{
  title: string | null
  content: string
  contentType: string | null
}> {
  const response = await fetch(sourceUrl, {
    headers: {
      'user-agent': 'SwarmClaw/knowledge-import',
      accept: 'text/html, text/plain, application/json, application/pdf, */*',
    },
  })

  if (!response.ok) {
    throw new Error(`URL fetch failed (${response.status})`)
  }

  const contentType = response.headers.get('content-type')
  const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_KNOWLEDGE_IMPORT_BYTES) {
    throw new Error('Remote document is too large. Maximum 10MB.')
  }

  if ((contentType || '').includes('application/pdf') || sourceUrl.toLowerCase().endsWith('.pdf')) {
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      title: null,
      content: await extractPdfText(buffer, sourceUrl),
      contentType,
    }
  }

  const text = await response.text()
  const looksLikeHtml = (contentType || '').includes('text/html') || /<html[\s>]|<body[\s>]/i.test(text)
  if (looksLikeHtml) {
    const parsed = htmlToReadableText(text)
    return {
      title: parsed.title,
      content: parsed.content,
      contentType,
    }
  }

  return {
    title: null,
    content: normalizeKnowledgeContent(text),
    contentType,
  }
}
