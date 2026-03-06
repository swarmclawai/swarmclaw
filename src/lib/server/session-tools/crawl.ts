import crypto from 'crypto'
import { URL } from 'url'
import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import * as cheerio from 'cheerio'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { runStructuredExtraction } from '../structured-extract'
import type { ToolBuildContext } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'

interface CrawledPage {
  url: string
  status: number
  title: string | null
  depth: number
  textPreview: string
  headings: string[]
  links: string[]
  hash: string
}

function cleanText(value: string, max = 1200): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`
}

function normalizeUrl(input: string, base?: string): string {
  const resolved = base ? new URL(input, base) : new URL(input)
  resolved.hash = ''
  if (resolved.pathname.endsWith('/') && resolved.pathname !== '/') {
    resolved.pathname = resolved.pathname.replace(/\/+$/, '')
  }
  return resolved.toString()
}

function shouldIncludeUrl(url: string, params: { includePattern?: string | null; excludePattern?: string | null }) {
  if (params.includePattern) {
    try {
      if (!new RegExp(params.includePattern, 'i').test(url)) return false
    } catch {
      return false
    }
  }
  if (params.excludePattern) {
    try {
      if (new RegExp(params.excludePattern, 'i').test(url)) return false
    } catch {
      return false
    }
  }
  return true
}

function pageHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex')
}

async function fetchCrawlPage(url: string, depth: number): Promise<CrawledPage> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
    signal: AbortSignal.timeout(15_000),
  })
  const html = await res.text()
  const $ = cheerio.load(html)
  $('script, style, noscript').remove()

  const title = cleanText($('title').first().text(), 200) || null
  const headings = $('h1, h2, h3')
    .toArray()
    .map((node) => cleanText($(node).text(), 200))
    .filter(Boolean)
    .slice(0, 12)
  const textPreview = cleanText($('body').text() || $.text(), 1600)
  const links = $('a[href]')
    .toArray()
    .map((node) => $(node).attr('href') || '')
    .filter(Boolean)
    .map((href) => {
      try {
        return normalizeUrl(href, url)
      } catch {
        return null
      }
    })
    .filter((href): href is string => !!href)
    .slice(0, 200)

  return {
    url,
    status: res.status,
    title,
    depth,
    textPreview,
    headings,
    links: Array.from(new Set(links)),
    hash: pageHash(`${title || ''}\n${textPreview}`),
  }
}

async function crawlSite(params: {
  startUrl: string
  limit: number
  maxDepth: number
  sameOrigin: boolean
  includePattern?: string | null
  excludePattern?: string | null
}): Promise<CrawledPage[]> {
  const startUrl = normalizeUrl(params.startUrl)
  const startOrigin = new URL(startUrl).origin
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }]
  const visited = new Set<string>()
  const pages: CrawledPage[] = []

  while (queue.length > 0 && pages.length < params.limit) {
    const current = queue.shift()!
    if (visited.has(current.url)) continue
    visited.add(current.url)
    if (!shouldIncludeUrl(current.url, params)) continue
    if (params.sameOrigin && new URL(current.url).origin !== startOrigin) continue

    try {
      const page = await fetchCrawlPage(current.url, current.depth)
      pages.push(page)
      if (current.depth >= params.maxDepth) continue
      for (const link of page.links) {
        if (visited.has(link)) continue
        if (params.sameOrigin && new URL(link).origin !== startOrigin) continue
        queue.push({ url: link, depth: current.depth + 1 })
      }
    } catch {
      // skip failed pages and continue crawling
    }
  }

  return pages
}

async function followPagination(params: {
  startUrl: string
  limit: number
}): Promise<CrawledPage[]> {
  const pages: CrawledPage[] = []
  const visited = new Set<string>()
  let currentUrl = normalizeUrl(params.startUrl)
  let depth = 0

  while (currentUrl && pages.length < params.limit && !visited.has(currentUrl)) {
    visited.add(currentUrl)
    const page = await fetchCrawlPage(currentUrl, depth)
    pages.push(page)

    const res = await fetch(currentUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
      signal: AbortSignal.timeout(15_000),
    })
    const html = await res.text()
    const $ = cheerio.load(html)
    const nextHref = $('link[rel="next"]').attr('href')
      || $('a[rel="next"]').attr('href')
      || $('a').toArray().map((node) => ({
        href: $(node).attr('href') || '',
        text: cleanText($(node).text(), 80).toLowerCase(),
      })).find((candidate) => /^(next|next page|older|more|continue)/i.test(candidate.text))?.href

    if (!nextHref) break
    try {
      currentUrl = normalizeUrl(nextHref, currentUrl)
    } catch {
      break
    }
    depth += 1
  }

  return pages
}

function dedupePages(input: CrawledPage[]): CrawledPage[] {
  const seen = new Set<string>()
  const out: CrawledPage[] = []
  for (const page of input) {
    const key = `${page.url}|${page.hash}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(page)
  }
  return out
}

async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  const res = await fetch(sitemapUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
    signal: AbortSignal.timeout(15_000),
  })
  const xml = await res.text()
  const matches = Array.from(xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi))
  return Array.from(new Set(matches.map((match) => match[1]?.trim()).filter((value): value is string => !!value)))
}

function normalizeSelectorMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries: Array<readonly [string, string]> = []
  for (const [key, selector] of Object.entries(value as Record<string, unknown>)) {
    if (typeof selector !== 'string') continue
    const trimmed = selector.trim()
    if (!trimmed) continue
    entries.push([key, trimmed] as const)
  }
  return Object.fromEntries(entries)
}

async function extractSelectorRows(urls: string[], selectors: Record<string, string>) {
  const rows: Array<Record<string, unknown>> = []
  for (const url of urls) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
      signal: AbortSignal.timeout(15_000),
    })
    const html = await res.text()
    const $ = cheerio.load(html)
    $('script, style, noscript').remove()
    const row: Record<string, unknown> = { url }
    for (const [key, selector] of Object.entries(selectors)) {
      row[key] = cleanText($(selector).first().text(), 800)
    }
    rows.push(row)
  }
  return rows
}

function normalizePagesInput(value: unknown): CrawledPage[] {
  if (typeof value === 'string' && value.trim()) {
    try {
      return JSON.parse(value) as CrawledPage[]
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value as CrawledPage[]
  return []
}

function resolveExtractionSession(bctx: ToolBuildContext) {
  const session = bctx.resolveCurrentSession?.()
  if (!session) throw new Error('crawl batch_extract requires an active session context.')
  return session
}

async function executeCrawlAction(args: Record<string, unknown>, bctx: ToolBuildContext) {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'crawl_site').trim().toLowerCase()

  try {
    if (action === 'status') {
      return JSON.stringify({
        supports: ['crawl_site', 'follow_pagination', 'extract_sitemap', 'dedupe_pages', 'batch_extract'],
      })
    }

    if (action === 'dedupe_pages') {
      const pages = dedupePages(normalizePagesInput(normalized.pages))
      return JSON.stringify({ count: pages.length, pages })
    }

    const startUrl = typeof normalized.url === 'string'
      ? normalized.url
      : typeof normalized.startUrl === 'string'
        ? normalized.startUrl
        : ''

    const limit = typeof normalized.limit === 'number' ? Math.max(1, Math.min(normalized.limit, 100)) : 20
    const maxDepth = typeof normalized.maxDepth === 'number' ? Math.max(0, Math.min(normalized.maxDepth, 5)) : 2
    const sameOrigin = normalized.sameOrigin !== false

    if (action === 'crawl_site' || action === 'extract_sitemap') {
      const sitemapUrl = typeof normalized.sitemapUrl === 'string' && normalized.sitemapUrl.trim()
        ? normalized.sitemapUrl.trim()
        : null
      const pages = action === 'extract_sitemap' && sitemapUrl
        ? dedupePages(await Promise.all(
            (await fetchSitemapUrls(sitemapUrl))
              .slice(0, limit)
              .map((url) => fetchCrawlPage(normalizeUrl(url), 0)),
          ))
        : dedupePages(await crawlSite({
            startUrl,
            limit,
            maxDepth,
            sameOrigin,
            includePattern: typeof normalized.includePattern === 'string' ? normalized.includePattern : null,
            excludePattern: typeof normalized.excludePattern === 'string' ? normalized.excludePattern : null,
          }))
      if (action === 'extract_sitemap') {
        return JSON.stringify({
          startUrl: normalizeUrl(startUrl),
          count: pages.length,
          urlCount: pages.length,
          urls: pages.map((page) => page.url),
        })
      }
      return JSON.stringify({
        startUrl: normalizeUrl(startUrl),
        count: pages.length,
        pageCount: pages.length,
        pages,
      })
    }

    if (action === 'follow_pagination') {
      const pages = dedupePages(await followPagination({ startUrl, limit }))
      return JSON.stringify({
        startUrl: normalizeUrl(startUrl),
        count: pages.length,
        pageCount: pages.length,
        pages,
      })
    }

    if (action === 'batch_extract') {
      const seededPages = normalizePagesInput(normalized.pages)
      if (seededPages.length === 0 && !startUrl) return 'Error: url/startUrl or pages is required.'
      const pages = seededPages.length > 0
        ? dedupePages(seededPages)
        : dedupePages(await crawlSite({
            startUrl,
            limit,
            maxDepth,
            sameOrigin,
            includePattern: typeof normalized.includePattern === 'string' ? normalized.includePattern : null,
            excludePattern: typeof normalized.excludePattern === 'string' ? normalized.excludePattern : null,
          }))
      const selectors = normalizeSelectorMap(normalized.selectors)
      if (Object.keys(selectors).length > 0) {
        const rows = await extractSelectorRows(pages.map((page) => page.url), selectors)
        return JSON.stringify({
          count: pages.length,
          pageCount: pages.length,
          rowCount: rows.length,
          urls: pages.map((page) => page.url),
          rows,
        })
      }
      const session = resolveExtractionSession(bctx)
      const sourceText = pages
        .map((page) => `URL: ${page.url}\nTitle: ${page.title || ''}\nHeadings: ${page.headings.join(' | ')}\nText: ${page.textPreview}`)
        .join('\n\n---\n\n')
      const extracted = await runStructuredExtraction({
        session,
        text: sourceText,
        schema: normalized.schema,
        instruction: typeof normalized.instruction === 'string'
          ? normalized.instruction
          : 'Aggregate the crawled pages and extract the requested structured information.',
        maxChars: typeof normalized.maxChars === 'number' ? Math.max(10_000, normalized.maxChars) : 120_000,
      })
      return JSON.stringify({
        count: pages.length,
        pageCount: pages.length,
        urls: pages.map((page) => page.url),
        object: extracted.object,
        validationErrors: extracted.validationErrors,
        provider: extracted.provider,
        model: extracted.model,
        raw: normalized.includeRaw === true ? extracted.raw : undefined,
      })
    }

    if (!startUrl) return 'Error: url or startUrl is required.'

    return `Error: Unknown action "${action}".`
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

const CrawlPlugin: Plugin = {
  name: 'Crawl',
  enabledByDefault: false,
  description: 'Research whole sites by crawling pages, following pagination, deduping results, and batch-extracting structure.',
  hooks: {
    getCapabilityDescription: () =>
      'I can crawl websites with `crawl`, including sitemap extraction, pagination following, page deduping, and batch structured extraction over many pages.',
  } as PluginHooks,
  tools: [
    {
      name: 'crawl',
      description: 'Site crawler. Actions: crawl_site, follow_pagination, extract_sitemap, dedupe_pages, batch_extract, status.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['crawl_site', 'follow_pagination', 'extract_sitemap', 'dedupe_pages', 'batch_extract', 'status'],
          },
          url: { type: 'string' },
          startUrl: { type: 'string' },
          sitemapUrl: { type: 'string' },
          pages: {},
          limit: { type: 'number' },
          maxDepth: { type: 'number' },
          sameOrigin: { type: 'boolean' },
          includePattern: { type: 'string' },
          excludePattern: { type: 'string' },
          selectors: {},
          schema: {},
          instruction: { type: 'string' },
          maxChars: { type: 'number' },
          includeRaw: { type: 'boolean' },
        },
        required: ['action'],
      },
      execute: async (args, context) => {
        const syntheticBuildContext = {
          cwd: context.session.cwd || process.cwd(),
          ctx: { sessionId: context.session.id, agentId: context.session.agentId || null },
          hasPlugin: () => true,
          hasTool: () => true,
          cleanupFns: [],
          commandTimeoutMs: 0,
          claudeTimeoutMs: 0,
          cliProcessTimeoutMs: 0,
          persistDelegateResumeId: () => undefined,
          readStoredDelegateResumeId: () => null,
          resolveCurrentSession: () => context.session,
          activePlugins: context.session.plugins || [],
        } as ToolBuildContext
        return executeCrawlAction(args, syntheticBuildContext)
      },
    },
  ],
}

getPluginManager().registerBuiltin('crawl', CrawlPlugin)

export function buildCrawlTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('crawl')) return []
  return [
    tool(
      async (args) => executeCrawlAction(args, bctx),
      {
        name: 'crawl',
        description: CrawlPlugin.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
