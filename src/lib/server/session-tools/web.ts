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

// ---------------------------------------------------------------------------
// Global registry of active browser instances for cleanup sweeps
// ---------------------------------------------------------------------------

export const activeBrowsers = new Map<string, { client: any; server: any; createdAt: number }>()

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

// ---------------------------------------------------------------------------
// buildWebTools
// ---------------------------------------------------------------------------

export function buildWebTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx, cleanupFns } = bctx

  // ---- web_search --------------------------------------------------------

  if (bctx.hasTool('web_search')) {
    tools.push(
      tool(
        async ({ query, maxResults }) => {
          try {
            const limit = Math.min(maxResults || 5, 10)
            const { loadSettings } = await import('../storage')
            const settings = loadSettings()
            const provider = await getSearchProvider(settings)
            const results = await provider.search(query, limit)
            return results.length > 0
              ? JSON.stringify(results, null, 2)
              : 'No results found.'
          } catch (err: unknown) {
            return `Error searching web: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'web_search',
          description: 'Search the web. Returns an array of results with title, url, and snippet.',
          schema: z.object({
            query: z.string().describe('Search query'),
            maxResults: z.number().optional().describe('Maximum results to return (default 5, max 10)'),
          }),
        },
      ),
    )
  }

  // ---- web_fetch ---------------------------------------------------------

  if (bctx.hasTool('web_fetch')) {
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
          } catch (err: unknown) {
            return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`
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

  // ---- browser -----------------------------------------------------------

  if (bctx.hasTool('browser')) {
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
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
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

  // ---- openclaw_browser (CLI passthrough) -----------------------------------

  if (bctx.hasTool('browser') || bctx.hasTool('openclaw_browser')) {
    const openclawPath = findBinaryOnPath('openclaw') || findBinaryOnPath('clawdbot')
    if (openclawPath) {
      tools.push(
        tool(
          async ({ command, args: cmdArgs }) => {
            try {
              const spawnArgs = ['browser', command, '--json']
              if (cmdArgs) spawnArgs.push(...cmdArgs.split(/\s+/).filter(Boolean))
              const result = spawnSync(openclawPath, spawnArgs, {
                encoding: 'utf-8',
                timeout: 60_000,
                maxBuffer: MAX_OUTPUT,
              })
              const stdout = (result.stdout || '').trim()
              const stderr = (result.stderr || '').trim()
              if (result.status !== 0) {
                return `Error (exit ${result.status}): ${stderr || stdout || 'unknown error'}`
              }
              return truncate(stdout || '(no output)', MAX_OUTPUT)
            } catch (err: unknown) {
              return `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          },
          {
            name: 'openclaw_browser',
            description: 'Control a browser through the OpenClaw CLI. Requires openclaw/clawdbot CLI on PATH. Passes through to `openclaw browser <command> --json`.',
            schema: z.object({
              command: z.string().describe('Browser command (navigate, screenshot, click, type, evaluate, etc.)'),
              args: z.string().optional().describe('Additional arguments as a space-separated string'),
            }),
          },
        ),
      )
    }
  }

  return tools
}
