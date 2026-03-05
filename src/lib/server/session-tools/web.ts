import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import * as cheerio from 'cheerio'
import { UPLOAD_DIR } from '../storage'
import type { ToolBuildContext } from './context'
import { spawnSync } from 'child_process'
import { safePath, truncate, MAX_OUTPUT, findBinaryOnPath } from './context'
import { getSearchProvider } from './search-providers'
import { dedupeScreenshotMarkdownLines } from './web-output'
import { withRetry } from '../tool-retry'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

// --- Search result compression logic ---
async function compressSearchResults(results: any[], query: string, bctx: any): Promise<string | null> {
  const session = bctx.resolveCurrentSession?.()
  if (!session?.provider || !session?.model) return null
  const { getProvider } = await import('@/lib/providers')
  const { loadCredentials, decryptKey } = await import('../storage')
  const providerEntry = getProvider(session.provider)
  if (!providerEntry?.handler?.streamChat) return null
  let apiKey: string | undefined
  if (session.credentialId) {
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (cred) apiKey = decryptKey(cred.encryptedKey)
  }
  const systemPrompt = 'You are a search result summarizer. Condense search results into a concise reference. Keep key facts, URLs, and data points. Remove filler and redundancy. Output plain text, not JSON.'
  const message = `Query: "${query}"\n\nResults:\n${JSON.stringify(results, null, 1)}\n\nSummarize these results concisely.`
  let compressed = ''
  await providerEntry.handler.streamChat({
    session: { ...session, messages: [] }, message, apiKey, systemPrompt,
    write: (raw: string) => {
      const lines = raw.split('\n').filter(Boolean)
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const ev = JSON.parse(line.slice(6))
          if (ev.t === 'd' && ev.text) compressed += ev.text
        } catch { /* ignore */ }
      }
    },
    active: new Map(), loadHistory: () => [],
  })
  return compressed.trim() || null
}

export const activeBrowsers = new Map<string, { client: any; server: any; createdAt: number }>()
export function sweepOrphanedBrowsers(maxAgeMs = 30 * 60 * 1000): number {
  const now = Date.now(); let cleaned = 0
  for (const [key, entry] of activeBrowsers) {
    if (now - entry.createdAt > maxAgeMs) {
      try { entry.client?.close?.() } catch { /* ignore */ }
      try { entry.server?.close?.() } catch { /* ignore */ }
      activeBrowsers.delete(key); cleaned++
    }
  }
  return cleaned
}
export function cleanupSessionBrowser(sessionId: string): void {
  const entry = activeBrowsers.get(sessionId)
  if (entry) {
    try { entry.client?.close?.() } catch { /* ignore */ }
    try { entry.server?.close?.() } catch { /* ignore */ }
    activeBrowsers.delete(sessionId)
  }
}
export function getActiveBrowserCount(): number { return activeBrowsers.size }
export function hasActiveBrowser(sessionId: string): boolean { return activeBrowsers.has(sessionId) }

/**
 * Unified Web Execution Logic
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeWebAction(args: Record<string, unknown>, bctx: any) {
  const normalized = normalizeToolInputArgs(args)
  const { action, query, url, maxResults } = normalized as { action: string; query?: string; url?: string; maxResults?: number }
  try {
    if (action === 'search') {
      const searchQuery = query || url
      if (!searchQuery) return 'Error: "query" is required for search action.'
      const limit = Math.min(maxResults || 5, 10)
      const { loadSettings } = await import('../storage')
      const settings = loadSettings()
      const provider = await getSearchProvider(settings)
      const results = await provider.search(searchQuery, limit)
      if (results.length === 0) return 'No results found.'
      const raw = JSON.stringify(results, null, 2)
      if (raw.length > 2000) {
        const compressed = await compressSearchResults(results, searchQuery, bctx)
        if (compressed) return compressed
      }
      return raw
    } else if (action === 'fetch') {
      const fetchUrl = url || query
      if (!fetchUrl) return 'Error: "url" is required for fetch action.'
      const res = await fetch(fetchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('application/pdf')) {
        try {
          const pdfMod = await import(/* webpackIgnore: true */ 'pdf-parse')
          const pdfParse = ((pdfMod as Record<string, unknown>).default ?? pdfMod) as (buf: Buffer) => Promise<{ text: string }>
          const arrayBuffer = await res.arrayBuffer()
          const result = await pdfParse(Buffer.from(arrayBuffer))
          return truncate(result.text, MAX_OUTPUT)
        } catch (err: unknown) {
          return `Error parsing PDF: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      const html = await res.text()
      const $ = cheerio.load(html)
      $('script, style, noscript, nav, footer, header').remove()
      const main = $('article, main, [role="main"]').first()
      const text = (main.length ? main.text() : $('body').text()).replace(/\s+/g, ' ').trim()
      return truncate(text, MAX_OUTPUT)
    }
    return `Error: Unknown action "${action}"`
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const WebPlugin: Plugin = {
  name: 'Core Web',
  description: 'Search the web and fetch content from URLs.',
  hooks: {
    getCapabilityDescription: () => 'I can search the web (`web_search`) for research, fact-checking, and discovery.',
  } as PluginHooks,
  tools: [
    {
      name: 'web',
      description: 'Unified web access tool. Actions: search, fetch.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'fetch'] },
          query: { type: 'string' },
          url: { type: 'string' },
          maxResults: { type: 'number' }
        },
        required: ['action']
      },
      execute: async (args, context) => executeWebAction(args, { ...context.session, resolveCurrentSession: () => context.session })
    }
  ]
}

getPluginManager().registerBuiltin('web', WebPlugin)

/**
 * Legacy Bridge
 */
export function buildWebTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx, cleanupFns } = bctx

  if (bctx.hasPlugin('web')) {
    tools.push(
      tool(
        async (args) => executeWebAction(args, bctx),
        {
          name: 'web',
          description: WebPlugin.tools![0].description,
          schema: z.object({}).passthrough()
        }
      )
    )
  }

  // Browser tool (kept as direct injection for now due to complexity)
  if (bctx.hasPlugin('browser')) {
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
          browser: { launchOptions: { headless: true }, isolated: true },
          imageResponses: 'allow', capabilities: ['core', 'pdf', 'vision', 'network'],
        })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const client = new Client({ name: 'swarmclaw', version: '1.0' })
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
        mcpClient = client; mcpServer = server
        activeBrowsers.set(sessionKey, { client, server, createdAt: Date.now() })
      })()
      return mcpInitializing
    }

    cleanupFns.push(async () => {
      try { mcpClient?.close?.() } catch { /* ignore */ }
      try { mcpServer?.close?.() } catch { /* ignore */ }
      activeBrowsers.delete(sessionKey)
      mcpClient = null; mcpServer = null
    })

    const cleanPlaywrightOutput = (text: string): string => {
      text = text.replace(/### Ran Playwright code[\s\S]*?(?=###|$)/g, '')
      text = text.replace(/### Snapshot\n([\s\S]*?)(?=###|$)/g, (_match, snapshot) => {
        const lines = (snapshot as string).split('\n')
        if (lines.length > 40) return 'Page elements:\n' + lines.slice(0, 40).join('\n') + '\n... (truncated)\n'
        return 'Page elements:\n' + snapshot
      })
      text = text.replace(/^### Result\n/gm, ''); text = text.replace(/^### Page\n/gm, '')
      return text.replace(/\n{3,}/g, '\n').trim()
    }

    const MCP_CALL_TIMEOUT_MS = 30000 // 30s timeout per browser action
    const callMcpTool = async (toolName: string, args: Record<string, any>, options?: { saveTo?: string }): Promise<string> => {
      await ensureMcp()
      const result = await Promise.race([
        mcpClient.callTool({ name: toolName, arguments: args }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`Browser action "${toolName}" timed out after ${MCP_CALL_TIMEOUT_MS / 1000}s`)), MCP_CALL_TIMEOUT_MS)
        ),
      ])
      const isError = result?.isError === true; const content = result?.content; const savedPaths: string[] = []
      const saveArtifact = (buffer: Buffer, suggestedExt: string): void => {
        const rawSaveTo = options?.saveTo?.trim()
        if (!rawSaveTo) return
        let resolved = safePath(cwd, rawSaveTo)
        if (!path.extname(resolved) && suggestedExt) resolved = `${resolved}.${suggestedExt}`
        fs.mkdirSync(path.dirname(resolved), { recursive: true }); fs.writeFileSync(resolved, buffer)
        savedPaths.push(resolved)
      }
      if (Array.isArray(content)) {
        let parts: string[] = []
        const isScreenshotTool = toolName === 'browser_take_screenshot'
        const contentHasBinaryImage = content.some((c) => c.type === 'image' && !!c.data)
        for (const c of content) {
          if (c.type === 'image' && c.data) {
            const imageBuffer = Buffer.from(c.data, 'base64'); const filename = `screenshot-${Date.now()}.png`
            const filepath = path.join(UPLOAD_DIR, filename); fs.writeFileSync(filepath, imageBuffer)
            saveArtifact(imageBuffer, 'png'); parts.push(`![Screenshot](/api/uploads/${filename})`)
          } else if (c.type === 'resource' && c.resource?.blob) {
            const ext = c.resource.mimeType?.includes('pdf') ? 'pdf' : 'bin'
            const resourceBuffer = Buffer.from(c.resource.blob, 'base64'); const filename = `browser-${Date.now()}.${ext}`
            const filepath = path.join(UPLOAD_DIR, filename); fs.writeFileSync(filepath, resourceBuffer)
            saveArtifact(resourceBuffer, ext); parts.push(`[Download ${filename}](/api/uploads/${filename})`)
          } else {
            let text = c.text || ''
            const fileMatch = text.match(/\]\((\.\.\/[^\s)]+|\/[^\s)]+\.(pdf|png|jpg|jpeg|gif|webp|html|mp4|webm))\)/)
            if (fileMatch) {
              const rawPath = fileMatch[1]; const srcPath = rawPath.startsWith('/') ? rawPath : path.resolve(process.cwd(), rawPath)
              if (fs.existsSync(srcPath)) {
                const ext = path.extname(srcPath).slice(1).toLowerCase(); const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
                if (IMAGE_EXTS.includes(ext) && contentHasBinaryImage) parts.push(isError ? text : cleanPlaywrightOutput(text))
                else {
                  const filename = `browser-${Date.now()}.${ext}`; const destPath = path.join(UPLOAD_DIR, filename); fs.copyFileSync(srcPath, destPath)
                  if (options?.saveTo?.trim()) {
                    let targetPath = safePath(cwd, options.saveTo.trim())
                    if (!path.extname(targetPath)) targetPath = `${targetPath}.${ext}`
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true }); fs.copyFileSync(srcPath, targetPath)
                    savedPaths.push(targetPath)
                  }
                  parts.push(IMAGE_EXTS.includes(ext) ? `![Screenshot](/api/uploads/${filename})` : `[Download ${filename}](/api/uploads/${filename})`)
                }
              } else parts.push(isError ? text : cleanPlaywrightOutput(text))
            } else parts.push(isError ? text : cleanPlaywrightOutput(text))
          }
        }
        if (isScreenshotTool) parts = dedupeScreenshotMarkdownLines(parts)
        if (savedPaths.length > 0) {
          const unique = Array.from(new Set(savedPaths))
          parts.push(`Saved to: ${unique.map((p) => path.relative(cwd, p) || '.').join(', ')}`)
        }
        return parts.join('\n')
      }
      return JSON.stringify(result)
    }

    const dismissCookieBanners = async (mcpCall: (toolName: string, args: Record<string, unknown>) => Promise<string>) => {
      await new Promise((r) => setTimeout(r, 1500))
      const js = `(() => {
        const sel = ['button[id*="reject" i]', 'button[class*="reject" i]', 'a[id*="reject" i]', 'a[class*="reject" i]', '#onetrust-reject-all-handler', '#CybotCookiebotDialogBodyButtonDecline', '#didomi-notice-disagree-button', '.qc-cmp2-summary-buttons button:first-child', 'button.sp_choice_type_12'];
        for (const s of sel) { const el = document.querySelector(s); if (el && el.offsetParent !== null) { el.click(); return 'dismissed:' + s; } }
        const btns = [...document.querySelectorAll('button, a[role="button"]')]; const rejectRe = /^(reject|reject all|decline|deny|refuse|no,? thanks|only necessary|necessary only)$/i;
        for (const b of btns) { const txt = (b.textContent || '').trim(); if (rejectRe.test(txt) && b.offsetParent !== null) { b.click(); return 'dismissed:text=' + txt; } }
        return 'none';
      })()`
      await mcpCall('browser_evaluate', { expression: js })
    }

    const MCP_TOOL_MAP: Record<string, string> = {
      navigate: 'browser_navigate', screenshot: 'browser_take_screenshot', snapshot: 'browser_snapshot', click: 'browser_click',
      type: 'browser_type', press_key: 'browser_press_key', select: 'browser_select_option', evaluate: 'browser_evaluate',
      pdf: 'browser_pdf_save', upload: 'browser_file_upload', wait: 'browser_wait_for',
    }

    tools.push(
      tool(
        async (params) => {
          try {
            const { action, ...rest } = params
            const mcpTool = MCP_TOOL_MAP[action]
            if (!mcpTool) return `Unknown browser action: "${action}"`
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const args: Record<string, any> = {}
            for (const [k, v] of Object.entries(rest)) { if (v !== undefined && v !== null && v !== '') args[k] = v }

            // If screenshot includes a url, navigate first then capture
            if (action === 'screenshot' && args.url) {
              const navUrl = args.url
              delete args.url
              await callMcpTool('browser_navigate', { url: navUrl })
              try { await dismissCookieBanners(callMcpTool) } catch { /* ignore */ }
            }

            // Wait for the page to finish rendering before capturing
            if (action === 'screenshot') {
              try {
                await callMcpTool('browser_evaluate', {
                  expression: `await new Promise(resolve => {
                    if (document.readyState === 'complete') {
                      setTimeout(resolve, 1500);
                    } else {
                      window.addEventListener('load', () => setTimeout(resolve, 1500), { once: true });
                      setTimeout(resolve, 5000);
                    }
                  })`,
                })
              } catch { /* page may not support evaluate — fall back to a flat delay */
                await new Promise((r) => setTimeout(r, 2000))
              }
            }

            let result = await callMcpTool(mcpTool, args, { saveTo: params.saveTo })

            // Playwright throws ERR_ABORTED on server-side redirects (e.g. Wikipedia Special:Random).
            // The browser follows the redirect fine — the original navigation just gets "aborted".
            // Recover by taking a snapshot of the page the browser actually landed on.
            if (action === 'navigate' && result.includes('ERR_ABORTED')) {
              await new Promise((r) => setTimeout(r, 1000))
              result = await callMcpTool('browser_snapshot', {})
            }

            if (action === 'navigate') { try { await dismissCookieBanners(callMcpTool) } catch { /* ignore */ } }
            return result
          } catch (err: unknown) { return `Error: ${err instanceof Error ? err.message : String(err)}` }
        },
        {
          name: 'browser',
          description: 'Control the browser. Actions: navigate, screenshot, snapshot, click, type, press_key, select, evaluate, pdf, upload, wait.',
          schema: z.object({
            action: z.enum(['navigate', 'screenshot', 'snapshot', 'click', 'type', 'press_key', 'select', 'evaluate', 'pdf', 'upload', 'wait']),
            url: z.string().optional(), element: z.string().optional(), ref: z.string().optional(), text: z.string().optional(),
            key: z.string().optional(), option: z.string().optional(), expression: z.string().optional(),
            paths: z.array(z.string()).optional(), timeout: z.number().optional(), saveTo: z.string().optional(),
          }),
        },
      ),
    )
  }

  // openclaw_browser CLI passthrough
  const openclawPath = findBinaryOnPath('openclaw') || findBinaryOnPath('clawdbot')
  if (openclawPath && (bctx.hasPlugin('browser') || bctx.hasPlugin('openclaw_browser'))) {
    tools.push(
      tool(
        async (rawArgs) => {
          const normalized = normalizeToolInputArgs((rawArgs ?? {}) as Record<string, unknown>)
          const command = normalized.command as string | undefined
          const cmdArgs = (normalized.args ?? normalized.arguments) as string | undefined
          try {
            if (!command) return 'Error: command is required.'
            const spawnArgs = ['browser', command, '--json']
            if (cmdArgs) spawnArgs.push(...cmdArgs.split(/\s+/).filter(Boolean))
            const result = spawnSync(openclawPath, spawnArgs, { encoding: 'utf-8', timeout: 60_000, maxBuffer: MAX_OUTPUT })
            if (result.status !== 0) return `Error (exit ${result.status}): ${result.stderr || result.stdout || 'unknown'}`
            return truncate(result.stdout || '(no output)', MAX_OUTPUT)
          } catch (err: unknown) { return `Error: ${err instanceof Error ? err.message : String(err)}` }
        },
        {
          name: 'openclaw_browser',
          description: 'Control a browser through the OpenClaw CLI.',
          schema: z.object({
            command: z.string(), args: z.string().optional(),
          }),
        },
      ),
    )
  }

  return tools
}
