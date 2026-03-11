import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { UPLOAD_DIR } from '../storage'
import { safePath, truncate, MAX_OUTPUT } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { SearchResult } from './search-providers'
import type { SandboxFsBridge } from '@/lib/server/sandbox/fs-bridge'

function readBrowserTimeoutMs(envKey: string, fallbackMs: number, bounds: { min: number; max: number }): number {
  const raw = Number.parseInt(process.env[envKey] || '', 10)
  if (!Number.isFinite(raw)) return fallbackMs
  return Math.max(bounds.min, Math.min(bounds.max, raw))
}

export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = readBrowserTimeoutMs(
  'SWARMCLAW_BROWSER_ACTION_TIMEOUT_MS',
  60_000,
  { min: 15_000, max: 5 * 60_000 },
)

export const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = readBrowserTimeoutMs(
  'SWARMCLAW_BROWSER_NAVIGATION_TIMEOUT_MS',
  90_000,
  { min: 30_000, max: 10 * 60_000 },
)

export const DEFAULT_BROWSER_MCP_CALL_TIMEOUT_MS = readBrowserTimeoutMs(
  'SWARMCLAW_BROWSER_MCP_CALL_TIMEOUT_MS',
  Math.max(DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS + 15_000, DEFAULT_BROWSER_ACTION_TIMEOUT_MS + 15_000),
  { min: 30_000, max: 12 * 60_000 },
)

function cleanSearchField(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

export function formatWebSearchResults(query: string, results: SearchResult[], maxChars = MAX_OUTPUT): string {
  const cleanedQuery = cleanSearchField(query)
  const header = cleanedQuery ? `Search results for: ${cleanedQuery}` : 'Search results'
  const sections: string[] = [header]
  const joinSections = (items: string[]) => items.filter(Boolean).join('\n\n')

  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    const title = cleanSearchField(result?.title) || cleanSearchField(result?.url) || `Result ${index + 1}`
    const url = cleanSearchField(result?.url)
    const snippet = cleanSearchField(result?.snippet)
    const lines = [`${index + 1}. ${title}`]
    if (url) lines.push(`URL: ${url}`)
    if (snippet) lines.push(`Snippet: ${snippet}`)
    const candidate = joinSections([...sections, lines.join('\n')])
    if (candidate.length <= maxChars) {
      sections.push(lines.join('\n'))
      continue
    }

    if (url) {
      const minimalLines = [`${index + 1}. ${title}`, `URL: ${url}`]
      const minimalCandidate = joinSections([...sections, minimalLines.join('\n')])
      if (minimalCandidate.length <= maxChars) {
        sections.push(minimalLines.join('\n'))
      }
    }

    const omitted = results.length - index
    if (omitted > 0) {
      const remainingNotice = `(${omitted} additional result${omitted === 1 ? '' : 's'} omitted for brevity)`
      const withNotice = joinSections([...sections, remainingNotice])
      if (withNotice.length <= maxChars) sections.push(remainingNotice)
    }
    return truncate(joinSections(sections), maxChars)
  }

  return truncate(joinSections(sections), maxChars)
}

export function buildBrowserConnectionOptions(profileDir: string) {
  return {
    browser: {
      userDataDir: profileDir,
      launchOptions: { headless: true },
      contextOptions: {
        viewport: { width: 1440, height: 900 },
      },
    },
    imageResponses: 'allow' as const,
    capabilities: ['core', 'pdf', 'vision', 'network', 'storage'],
    sharedBrowserContext: false,
    timeouts: {
      action: DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
      navigation: DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS,
    },
  }
}

export function buildBrowserStdioServerParams(
  profileDir: string,
  options?: {
    cdpEndpoint?: string | null
    cdpHeaders?: string[]
    allowUnrestrictedFileAccess?: boolean
  },
) {
  const cliCandidates = [
    path.join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js'),
    path.join(process.cwd(), '[project]', 'node_modules', '@playwright', 'mcp', 'cli.js'),
  ]
  const cliPath = cliCandidates.find((candidate) => fs.existsSync(candidate)) || cliCandidates[0]
  const outputDir = path.join(profileDir, 'mcp-output')
  const env = sanitizePlaywrightMcpEnv()
  const cdpEndpoint = typeof options?.cdpEndpoint === 'string' && options.cdpEndpoint.trim()
    ? options.cdpEndpoint.trim()
    : null
  const args = [
    cliPath,
    '--output-dir', outputDir,
    '--caps', 'vision,pdf',
    '--image-responses', 'allow',
    '--output-mode', 'file',
    '--timeout-action', String(DEFAULT_BROWSER_ACTION_TIMEOUT_MS),
    '--timeout-navigation', String(DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS),
  ]

  if (cdpEndpoint) {
    args.push('--cdp-endpoint', cdpEndpoint)
    for (const header of options?.cdpHeaders || []) {
      if (typeof header === 'string' && header.trim()) {
        args.push('--cdp-header', header.trim())
      }
    }
    if (options?.allowUnrestrictedFileAccess) {
      args.push('--allow-unrestricted-file-access')
    }
  } else {
    args.push(
      '--headless',
      '--user-data-dir', profileDir,
    )
  }

  return {
    command: process.execPath,
    args,
    env: {
      ...env,
      ...(cdpEndpoint ? { PLAYWRIGHT_MCP_CDP_ENDPOINT: cdpEndpoint } : {
        PLAYWRIGHT_MCP_USER_DATA_DIR: profileDir,
        PLAYWRIGHT_MCP_HEADLESS: '1',
      }),
      ...(options?.allowUnrestrictedFileAccess ? { PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: '1' } : {}),
      PLAYWRIGHT_MCP_IMAGE_RESPONSES: 'allow',
      PLAYWRIGHT_MCP_OUTPUT_DIR: outputDir,
      PLAYWRIGHT_MCP_OUTPUT_MODE: 'file',
      PLAYWRIGHT_MCP_TIMEOUT_ACTION: String(DEFAULT_BROWSER_ACTION_TIMEOUT_MS),
      PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION: String(DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS),
    },
    stderr: 'inherit' as const,
  }
}

export function sanitizePlaywrightMcpEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (!key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')) continue
    delete env[key]
  }
  return env
}

export function inferWebActionFromArgs(params: {
  action?: string
  query?: string
  url?: string
}): 'search' | 'fetch' | undefined {
  if (params.action === 'search' || params.action === 'fetch') return params.action
  if (typeof params.url === 'string' && /^https?:\/\//i.test(params.url.trim())) return 'fetch'
  if (typeof params.query === 'string' && params.query.trim()) return 'search'
  if (typeof params.url === 'string' && params.url.trim()) return 'search'
  return undefined
}

function parseStructuredJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function parseJsonObjectValue(value: unknown): Record<string, unknown> | null {
  const parsed = parseStructuredJsonValue(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}

export function parseJsonArrayValue(value: unknown): unknown[] | null {
  const parsed = parseStructuredJsonValue(value)
  return Array.isArray(parsed) ? parsed : null
}

export function pickNonEmptyBrowserString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function wrapBrowserEvaluateFunction(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) return trimmed
  if (/^(?:async\s+)?function\b/.test(trimmed)) return trimmed
  if (/^(?:async\s*)?\([^)]*\)\s*=>/.test(trimmed)) return trimmed
  return /[;{}]/.test(trimmed)
    ? `() => { ${trimmed} }`
    : `() => (${trimmed})`
}

function wrapBrowserRunCodeFunction(code: string): string {
  const trimmed = code.trim()
  if (!trimmed) return trimmed
  if (/^(?:async\s+)?function\b/.test(trimmed)) return trimmed
  if (/^(?:async\s*)?\([^)]*\)\s*=>/.test(trimmed)) return trimmed
  return /[;{}]/.test(trimmed)
    ? `async (page) => { ${trimmed} }`
    : `async (page) => (${trimmed})`
}

export function normalizeBrowserActionParams(rawParams: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolInputArgs(rawParams)
  const action = String(normalized.action || '').trim().toLowerCase()
  const params: Record<string, unknown> = { ...normalized }

  const parsedFields = parseJsonArrayValue(params.fields)
  if (parsedFields) params.fields = parsedFields

  const parsedForm = parseJsonObjectValue(params.form)
  if (parsedForm) params.form = parsedForm

  if (typeof params.selector === 'string' && !pickNonEmptyBrowserString(params.element)) {
    params.element = params.selector
  }

  if (action === 'submit_form' && typeof params.selector === 'string' && !pickNonEmptyBrowserString(params.submitElement)) {
    params.submitElement = params.selector
  }

  if (action === 'select') {
    const parsedValues = parseJsonArrayValue(params.values ?? params.option ?? params.value)
    if (parsedValues) params.values = parsedValues
    else if (params.values === undefined) {
      const scalar = pickNonEmptyBrowserString(params.option, params.value, params.text)
      if (scalar) params.values = [scalar]
    }
  }

  if (action === 'evaluate' && !pickNonEmptyBrowserString(params.function)) {
    const code = pickNonEmptyBrowserString(params.code, params.script, params.javascript, params.js)
    if (code) params.function = wrapBrowserEvaluateFunction(code)
  }

  if (action === 'run_code') {
    const code = pickNonEmptyBrowserString(params.code, params.function, params.script, params.javascript, params.js)
    if (code) params.code = wrapBrowserRunCodeFunction(code)
  }

  return params
}

export function pickBrowserTargetFromParams(params: Record<string, unknown>): string | null {
  for (const value of [
    params.url,
    params.filePath,
    params.path,
    params.href,
    params.link,
    params.target,
    params.page,
  ]) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function resolveUploadFilePath(target: string): string | null {
  const normalized = target.replace(/^sandbox:/, '')
  const match = normalized.match(/^\/api\/uploads\/([^?#]+)/)
  if (!match) return null
  let decoded = match[1]
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // keep raw segment
  }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  const resolved = path.join(UPLOAD_DIR, safeName)
  return fs.existsSync(resolved) ? resolved : null
}

function resolveBrowserFileUrlPath(target: string): string | null {
  if (!/^file:/i.test(target)) return null
  try {
    const resolved = fileURLToPath(target)
    return fs.existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}

function tryResolveBrowserLocalPath(cwd: string, target: string): string | null {
  const uploadPath = resolveUploadFilePath(target)
  if (uploadPath) return uploadPath

  const fileUrlPath = resolveBrowserFileUrlPath(target)
  if (fileUrlPath) return fileUrlPath

  if (/^(?:https?:|about:|data:)/i.test(target)) return null

  const normalized = target.replace(/^sandbox:/, '')
  const looksLikePath = normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.includes('/')
    || /\.(?:html?|xhtml|txt|md|json|ya?ml|csv|ts|tsx|js|jsx|mjs|cjs|css|png|jpe?g|gif|webp|svg|pdf)$/i.test(normalized)
  if (!looksLikePath) return null

  const candidates = new Set<string>()
  if (path.isAbsolute(normalized)) candidates.add(normalized)
  try { candidates.add(safePath(cwd, normalized)) } catch { /* ignore */ }
  try { candidates.add(path.resolve(cwd, normalized)) } catch { /* ignore */ }

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue
    const stat = fs.statSync(candidate)
    if (stat.isDirectory()) {
      const indexPath = path.join(candidate, 'index.html')
      if (fs.existsSync(indexPath)) return indexPath
      return null
    }
    return candidate
  }
  return null
}

function localHtmlFileToDataUrl(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== '.html' && ext !== '.htm') return null
  try {
    const html = fs.readFileSync(filePath, 'utf8')
    const hasRelativeAssetReferences = /<(?:script|img|source|video|audio)\b[^>]+\b(?:src|poster)\s*=\s*["'](?![a-z]+:|\/\/|#|\/)([^"']+)["']|<link\b[^>]+\bhref\s*=\s*["'](?![a-z]+:|\/\/|#|\/)([^"']+)["']/i.test(html)
    if (hasRelativeAssetReferences) return null
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  } catch {
    return null
  }
}

export function resolveBrowserNavigationTarget(cwd: string, target: string, fsBridge?: SandboxFsBridge | null): string {
  const trimmed = target.trim()
  if (!trimmed) return trimmed
  if (/^(?:https?:|about:|data:)/i.test(trimmed)) return trimmed.replace(/^sandbox:/, '')

  const uploadPath = resolveUploadFilePath(trimmed)
  const fileUrlPath = resolveBrowserFileUrlPath(trimmed)
  const localPath = uploadPath || fileUrlPath || tryResolveBrowserLocalPath(cwd, trimmed)

  if (fsBridge && localPath) {
    const resolved = fsBridge.resolvePath({ filePath: localPath, cwd })
    return pathToFileURL(resolved.containerPath).toString()
  }

  if (localPath) return localHtmlFileToDataUrl(localPath) || pathToFileURL(localPath).toString()
  return trimmed.replace(/^sandbox:/, '')
}
