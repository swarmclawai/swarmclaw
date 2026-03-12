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
import type { BrowserObservation, Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { dedup, errorMessage, hmrSingleton, sleep } from '@/lib/shared-utils'
import { resolvePathWithinBaseDir } from '../path-utils'
import {
  ensureSessionBrowserProfileId,
  getBrowserProfileDir,
  loadBrowserSessionRecord,
  markBrowserSessionClosed,
  markBrowserSessionIdle,
  recordBrowserObservation,
  removeBrowserSessionRecord,
  upsertBrowserSessionRecord,
} from '../browser-state'
import { ensureSessionSandbox } from '@/lib/server/sandbox/session-runtime'
import {
  destroySandboxBrowser,
  ensureSandboxBrowser,
  type SandboxBrowserContext,
} from '@/lib/server/sandbox/browser-runtime'
import {
  DEFAULT_BROWSER_MCP_CALL_TIMEOUT_MS,
  buildBrowserConnectionOptions,
  buildBrowserStdioServerParams,
  formatWebSearchResults,
  inferWebActionFromArgs,
  normalizeBrowserActionParams,
  parseJsonArrayValue,
  pickBrowserTargetFromParams,
  pickNonEmptyBrowserString,
  resolveBrowserNavigationTarget,
  sanitizePlaywrightMcpEnv,
} from './web-utils'

export {
  buildBrowserConnectionOptions,
  buildBrowserStdioServerParams,
  formatWebSearchResults,
  inferWebActionFromArgs,
  normalizeBrowserActionParams,
  resolveBrowserNavigationTarget,
  sanitizePlaywrightMcpEnv,
}

type BrowserRuntimeEntry = {
  client: BrowserMcpClient
  server: BrowserMcpTransport
  createdAt: number
  profileId: string
  profileDir: string
  refCount: number
  runtime: 'host' | 'sandbox-browser'
  sandbox: SandboxBrowserContext | null
}

type BrowserMcpTransport = {
  close?: () => void | Promise<void>
}

type BrowserMcpToolResultContent = {
  type: string
  text?: string
  data?: string
  resource?: { blob?: string; mimeType?: string }
}

type BrowserMcpToolResult = {
  isError?: boolean
  content?: BrowserMcpToolResultContent[]
}

type BrowserMcpClient = {
  callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<BrowserMcpToolResult>
  close?: () => void | Promise<void>
}

// Stored on globalThis to survive HMR reloads in dev mode —
// prevents orphaned Chromium processes when web.ts is edited.
export const activeBrowsers: Map<string, BrowserRuntimeEntry> =
  hmrSingleton('__swarmclaw_active_browsers__', () => new Map<string, BrowserRuntimeEntry>())
const pendingBrowserInitializations: Map<string, Promise<BrowserRuntimeEntry>> =
  hmrSingleton('__swarmclaw_pending_browser_inits__', () => new Map<string, Promise<BrowserRuntimeEntry>>())

// Kill all browsers on process exit to prevent orphaned Chromium processes
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _shutdownRegistered = hmrSingleton('__swarmclaw_browser_shutdown_registered__', () => {
  process.on('exit', () => {
    for (const [, entry] of activeBrowsers) {
      try { entry.client?.close?.() } catch { /* ignore */ }
      try { entry.server?.close?.() } catch { /* ignore */ }
    }
  })
  return true
})

export function sweepOrphanedBrowsers(maxAgeMs = 30 * 60 * 1000): number {
  const now = Date.now(); let cleaned = 0
  for (const [key, entry] of activeBrowsers) {
    if (now - entry.createdAt > maxAgeMs) {
      try { entry.client?.close?.() } catch { /* ignore */ }
      try { entry.server?.close?.() } catch { /* ignore */ }
      pendingBrowserInitializations.delete(key)
      markBrowserSessionClosed(key, 'Browser was swept after inactivity.')
      if (entry.sandbox?.scopeKey === `session:${key}`) {
        void destroySandboxBrowser(entry.sandbox)
      }
      activeBrowsers.delete(key); cleaned++
    }
  }
  return cleaned
}

function releaseSessionBrowser(sessionId: string): void {
  const entry = activeBrowsers.get(sessionId)
  if (!entry) return
  try { entry.client?.close?.() } catch { /* ignore */ }
  try { entry.server?.close?.() } catch { /* ignore */ }
  activeBrowsers.delete(sessionId)
  pendingBrowserInitializations.delete(sessionId)
  markBrowserSessionIdle(sessionId)
}

export function cleanupSessionBrowser(sessionId: string): void {
  const entry = activeBrowsers.get(sessionId)
  if (entry) {
    try { entry.client?.close?.() } catch { /* ignore */ }
    try { entry.server?.close?.() } catch { /* ignore */ }
  }
  activeBrowsers.delete(sessionId)
  pendingBrowserInitializations.delete(sessionId)
  const current = loadBrowserSessionRecord(sessionId)
  markBrowserSessionClosed(sessionId)
  if (current?.sandbox?.scopeKey === `session:${sessionId}`) {
    void destroySandboxBrowser(current.sandbox)
  }
}
export function getActiveBrowserCount(): number { return activeBrowsers.size }
export function hasActiveBrowser(sessionId: string): boolean { return activeBrowsers.has(sessionId) }

/**
 * Unified Web Execution Logic
 */
 
async function executeWebAction(args: Record<string, unknown>) {
  const normalized = normalizeToolInputArgs(args)
  const { query, url, maxResults } = normalized as { query?: string; url?: string; maxResults?: number }
  const action = inferWebActionFromArgs({
    action: (normalized as { action?: string }).action,
    query,
    url,
  })
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
      return formatWebSearchResults(searchQuery, results)
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
          return `Error parsing PDF: ${errorMessage(err)}`
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
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const WebPlugin: Plugin = {
  name: 'Core Web',
  description: 'Search the web and fetch content from URLs.',
  hooks: {
    getCapabilityDescription: () => 'I can use the unified `web` tool with action `search` for research and action `fetch` for reading a URL.',
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
      execute: async (args) => executeWebAction(args)
    }
  ]
}

getPluginManager().registerBuiltin('web', WebPlugin)

/**
 * Legacy Bridge
 */
export function buildWebTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx, cleanupFns, filesystemScope } = bctx

  if (bctx.hasPlugin('web')) {
    tools.push(
      tool(
        async (args) => executeWebAction(args),
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
    const currentSession = bctx.resolveCurrentSession?.()
    const profileInfo = currentSession?.id
      ? ensureSessionBrowserProfileId(sessionKey)
      : { profileId: sessionKey, inheritedFromSessionId: null as string | null }
    const profileDir = getBrowserProfileDir(profileInfo.profileId)
    let mcpClient: BrowserMcpClient | null = null
    let mcpServer: BrowserMcpTransport | null = null
    let mcpInitializing: Promise<void> | null = null
    let browserLeaseHeld = false
    let sandboxRuntimePromise: Promise<SandboxBrowserContext | null> | null = null

    const ensureSandboxRuntime = async (): Promise<SandboxBrowserContext | null> => {
      if (!currentSession?.id) return null
      if (sandboxRuntimePromise) return sandboxRuntimePromise
      sandboxRuntimePromise = (async () => {
        try {
          const sandbox = await ensureSessionSandbox({
            config: bctx.sandboxConfig,
            session: currentSession,
            agentId: currentSession.agentId ?? ctx?.agentId ?? null,
            sessionId: currentSession.id,
            workspaceDir: cwd,
          })
          return await ensureSandboxBrowser({
            config: bctx.sandboxConfig,
            sandbox,
          })
        } catch {
          return null
        }
      })()
      return await sandboxRuntimePromise
    }

    const resolveNavigationTarget = async (target: string): Promise<string> => {
      const sandboxRuntime = await ensureSandboxRuntime()
      return resolveBrowserNavigationTarget(cwd, target, sandboxRuntime?.fsBridge, filesystemScope)
    }

    upsertBrowserSessionRecord({
      sessionId: sessionKey,
      profileId: profileInfo.profileId,
      profileDir,
      inheritedFromSessionId: profileInfo.inheritedFromSessionId,
      status: 'idle',
    })

    const ensureMcp = (): Promise<void> => {
      if (mcpClient) return Promise.resolve()
      if (mcpInitializing) return mcpInitializing
      const acquireExistingEntry = (entry: BrowserRuntimeEntry) => {
        mcpClient = entry.client
        mcpServer = entry.server
        if (!browserLeaseHeld) {
          entry.refCount = Math.max(0, entry.refCount || 0) + 1
          activeBrowsers.set(sessionKey, entry)
          browserLeaseHeld = true
        }
      }
      const existing = activeBrowsers.get(sessionKey)
      if (existing) {
        acquireExistingEntry(existing)
        return Promise.resolve()
      }
      mcpInitializing = (async () => {
        try {
          const pending = pendingBrowserInitializations.get(sessionKey)
          if (pending) {
            acquireExistingEntry(await pending)
            return
          }

          const connectPromise = (async () => {
            const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
            const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
            const sandboxRuntime = await ensureSandboxRuntime()
            const transport = new StdioClientTransport(buildBrowserStdioServerParams(profileDir, sandboxRuntime
              ? {
                  cdpEndpoint: sandboxRuntime.cdpEndpoint,
                  cdpHeaders: [`Authorization: Bearer ${sandboxRuntime.bridgeAuthToken}`],
                  allowUnrestrictedFileAccess: true,
                }
              : undefined))
            const sdkClient = new Client({ name: 'swarmclaw', version: '1.0' })
            await sdkClient.connect(transport)
            const client: BrowserMcpClient = {
              callTool: (params) => sdkClient.callTool(params) as Promise<BrowserMcpToolResult>,
              close: () => sdkClient.close?.(),
            }
            return {
              client,
              server: transport,
              createdAt: Date.now(),
              profileId: profileInfo.profileId,
              profileDir,
              refCount: 0,
              runtime: sandboxRuntime ? 'sandbox-browser' as const : 'host' as const,
              sandbox: sandboxRuntime,
            }
          })()
          pendingBrowserInitializations.set(sessionKey, connectPromise)
          const entry = await connectPromise
          acquireExistingEntry(entry)
          const lastState = loadBrowserSessionRecord(sessionKey)
          const restoreUrl = typeof lastState?.currentUrl === 'string' ? lastState.currentUrl.trim() : ''
          if (restoreUrl && restoreUrl !== 'about:blank') {
            try {
              await entry.client.callTool({ name: 'browser_navigate', arguments: { url: restoreUrl } })
            } catch (err: unknown) {
              upsertBrowserSessionRecord({
                sessionId: sessionKey,
                profileId: profileInfo.profileId,
                profileDir,
                inheritedFromSessionId: profileInfo.inheritedFromSessionId,
                status: 'error',
                runtime: entry.runtime,
                sandbox: entry.sandbox ? {
                  scopeKey: entry.sandbox.scopeKey,
                  containerName: entry.sandbox.containerName,
                  cdpEndpoint: entry.sandbox.cdpEndpoint,
                  cdpPort: entry.sandbox.cdpPort,
                  noVncPort: entry.sandbox.noVncPort,
                  bridgeUrl: entry.sandbox.bridgeUrl,
                } : null,
                lastAction: 'browser_restore',
                lastError: errorMessage(err),
              })
            }
          }
          upsertBrowserSessionRecord({
            sessionId: sessionKey,
            profileId: profileInfo.profileId,
            profileDir,
            inheritedFromSessionId: profileInfo.inheritedFromSessionId,
            status: 'active',
            runtime: entry.runtime,
            sandbox: entry.sandbox ? {
              scopeKey: entry.sandbox.scopeKey,
              containerName: entry.sandbox.containerName,
              cdpEndpoint: entry.sandbox.cdpEndpoint,
              cdpPort: entry.sandbox.cdpPort,
              noVncPort: entry.sandbox.noVncPort,
              bridgeUrl: entry.sandbox.bridgeUrl,
            } : null,
            lastAction: restoreUrl && restoreUrl !== 'about:blank' ? 'browser_restore' : 'browser_open',
          })
        } finally {
          if (pendingBrowserInitializations.get(sessionKey)) {
            pendingBrowserInitializations.delete(sessionKey)
          }
          mcpInitializing = null
        }
      })()
      return mcpInitializing
    }

    cleanupFns.push(async () => {
      pendingBrowserInitializations.delete(sessionKey)
      const entry = activeBrowsers.get(sessionKey)
      const ownsActiveEntry = !!entry && entry.client === mcpClient && entry.server === mcpServer
      if (ownsActiveEntry && browserLeaseHeld) {
        entry.refCount = Math.max(0, (entry.refCount || 1) - 1)
        if (entry.refCount === 0) {
          releaseSessionBrowser(sessionKey)
        } else {
          activeBrowsers.set(sessionKey, entry)
        }
      } else {
        try { mcpClient?.close?.() } catch { /* ignore */ }
        try { mcpServer?.close?.() } catch { /* ignore */ }
        if (browserLeaseHeld) markBrowserSessionIdle(sessionKey)
      }
      mcpClient = null
      mcpServer = null
      mcpInitializing = null
      sandboxRuntimePromise = null
      browserLeaseHeld = false
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

    const extractJsonPayload = (text: string): Record<string, unknown> | unknown[] | null => {
      const candidates = [
        [text.indexOf('{'), text.lastIndexOf('}')],
        [text.indexOf('['), text.lastIndexOf(']')],
      ]
      for (const [start, end] of candidates) {
        if (start === -1 || end === -1 || end <= start) continue
        try {
          return JSON.parse(text.slice(start, end + 1))
        } catch {
          // try next candidate
        }
      }
      return null
    }

    const stringifyStructured = (value: unknown): string => truncate(JSON.stringify(value, null, 2), MAX_OUTPUT)
    const callBrowserEvaluate = (fn: string) => callMcpTool('browser_evaluate', {
      function: fn,
    })

    const performSelectorDomAction = async (
      action: 'click' | 'type' | 'select' | 'hover',
      params: Record<string, unknown>,
    ): Promise<{ ok: true; output: string } | { ok: false; error: string } | null> => {
      const selector = pickNonEmptyBrowserString(params.element, params.selector)
      if (!selector) return null
      if (typeof params.ref === 'string' && params.ref.trim()) return null

      const payload =
        action === 'click'
          ? `() => {
              const selector = ${JSON.stringify(selector)};
              try {
                const element = document.querySelector(selector);
                if (!element) return { ok: false, error: 'No element matched selector.' };
                element.click?.();
                return { ok: true, action: 'click', selector };
              } catch (error) {
                return { ok: false, error: String(error) };
              }
            }`
          : action === 'hover'
            ? `() => {
                const selector = ${JSON.stringify(selector)};
                try {
                  const element = document.querySelector(selector);
                  if (!element) return { ok: false, error: 'No element matched selector.' };
                  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                  element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                  return { ok: true, action: 'hover', selector };
                } catch (error) {
                  return { ok: false, error: String(error) };
                }
              }`
            : action === 'type'
              ? `() => {
                  const selector = ${JSON.stringify(selector)};
                  const value = ${JSON.stringify(String(params.text ?? params.value ?? ''))};
                  const submit = ${params.submit === true ? 'true' : 'false'};
                  try {
                    const element = document.querySelector(selector);
                    if (!element) return { ok: false, error: 'No element matched selector.' };
                    element.focus?.();
                    if ('value' in element) element.value = value;
                    else if (element.isContentEditable) element.textContent = value;
                    else return { ok: false, error: 'Matched element is not editable.' };
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    if (submit) {
                      if (element.form?.requestSubmit) element.form.requestSubmit();
                      else {
                        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
                      }
                    }
                    return { ok: true, action: 'type', selector, valueLength: value.length };
                  } catch (error) {
                    return { ok: false, error: String(error) };
                  }
                }`
              : `() => {
                  const selector = ${JSON.stringify(selector)};
                  const desired = ${JSON.stringify(
                    Array.isArray(params.values)
                      ? params.values.map((value) => String(value ?? ''))
                      : [String(params.value ?? params.option ?? '')],
                  )};
                  try {
                    const element = document.querySelector(selector);
                    if (!element) return { ok: false, error: 'No element matched selector.' };
                    if (!(element instanceof HTMLSelectElement)) return { ok: false, error: 'Matched element is not a <select>.' };
                    const selected = [];
                    for (const option of Array.from(element.options)) {
                      const match = desired.includes(option.value) || desired.includes(option.text);
                      option.selected = match;
                      if (match) selected.push(option.value || option.text || '');
                    }
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return { ok: true, action: 'select', selector, selected };
                  } catch (error) {
                    return { ok: false, error: String(error) };
                  }
                }`

      const raw = await callBrowserEvaluate(payload)
      const parsed = extractJsonPayload(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: cleanPlaywrightOutput(raw) || `DOM ${action} fallback failed.` }
      }
      if ((parsed as Record<string, unknown>).ok !== true) {
        return {
          ok: false,
          error: String((parsed as Record<string, unknown>).error || `DOM ${action} fallback failed.`),
        }
      }
      return { ok: true, output: stringifyStructured(parsed) }
    }

    const captureStructuredObservation = async () => {
      const expression = `() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const links = Array.from(document.querySelectorAll('a[href]'))
          .filter(visible)
          .slice(0, 25)
          .map((a) => ({
            text: normalize(a.innerText || a.textContent || a.getAttribute('aria-label')),
            href: a.href || a.getAttribute('href') || '',
          }))
          .filter((entry) => entry.href);
        const forms = Array.from(document.forms).slice(0, 5).map((form, index) => ({
          index,
          action: form.getAttribute('action') || form.action || null,
          method: normalize(form.getAttribute('method') || form.method || 'get') || 'get',
          fields: Array.from(form.elements).slice(0, 20).map((el) => ({
            name: el.getAttribute?.('name') || null,
            label: normalize(el.labels?.[0]?.innerText || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder')) || null,
            type: normalize(el.getAttribute?.('type') || el.tagName || 'field').toLowerCase(),
            required: !!el.required,
          })),
        }));
        const tables = Array.from(document.querySelectorAll('table')).slice(0, 3).map((table, index) => {
          const headerCells = Array.from(table.querySelectorAll('thead th')).map((th) => normalize(th.innerText || th.textContent));
          const bodyRows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 5).map((tr) =>
            Array.from(tr.querySelectorAll('th, td')).map((cell) => normalize(cell.innerText || cell.textContent))
          );
          return {
            index,
            headers: headerCells,
            rowCount: table.querySelectorAll('tbody tr').length,
            rows: bodyRows,
          };
        });
        const errors = Array.from(document.querySelectorAll('[aria-invalid="true"], .error, .field-error, .invalid, [role="alert"]'))
          .filter(visible)
          .slice(0, 10)
          .map((el) => normalize(el.innerText || el.textContent))
          .filter(Boolean);
        const textPreview = normalize(document.body?.innerText || document.body?.textContent || '').slice(0, 1200);
        const lowerPreview = textPreview.toLowerCase();
        const notices = [];
        if (/ask the human|out-of-band|do not guess|verification code required/.test(lowerPreview)) {
          notices.push({
            type: 'human_input_required',
            message: 'This page requires human-provided input. Ask the human instead of guessing or repeatedly submitting blank values.',
          });
        }
        return {
          url: window.location.href,
          title: document.title || null,
          textPreview,
          links,
          forms,
          tables,
          errors,
          notices,
        };
      }`
      const raw = await callBrowserEvaluate(expression)
      const parsed = extractJsonPayload(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const observation = {
          capturedAt: Date.now(),
          ...parsed,
        } as BrowserObservation
        recordBrowserObservation(sessionKey, observation)
        return observation
      }
      const fallback = {
        capturedAt: Date.now(),
        url: null,
        title: null,
        textPreview: cleanPlaywrightOutput(raw).slice(0, 1200),
      }
      recordBrowserObservation(sessionKey, fallback)
      return fallback
    }

    const MCP_CALL_TIMEOUT_MS = DEFAULT_BROWSER_MCP_CALL_TIMEOUT_MS
    const callMcpTool = async (toolName: string, args: Record<string, unknown>, options?: { saveTo?: string }): Promise<string> => {
      const rawCall = async (): Promise<string> => {
        try {
          await ensureMcp()
          const client = mcpClient
          if (!client) throw new Error('Browser MCP client failed to initialize.')
          const result = await Promise.race([
            client.callTool({ name: toolName, arguments: args }),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error(`Browser action "${toolName}" timed out after ${MCP_CALL_TIMEOUT_MS / 1000}s`)), MCP_CALL_TIMEOUT_MS),
            ),
          ])
          const isError = result?.isError === true
          const content = result?.content
          const savedPaths: string[] = []
          const artifacts: Array<{ kind: 'snapshot' | 'screenshot' | 'download' | 'pdf'; path: string; url?: string | null; filename?: string | null; createdAt: number }> = []
          const saveArtifact = (buffer: Buffer, suggestedExt: string): void => {
            const rawSaveTo = options?.saveTo?.trim()
            if (!rawSaveTo) return
            let resolved = safePath(cwd, rawSaveTo, filesystemScope)
            if (!path.extname(resolved) && suggestedExt) resolved = `${resolved}.${suggestedExt}`
            fs.mkdirSync(path.dirname(resolved), { recursive: true })
            fs.writeFileSync(resolved, buffer)
            savedPaths.push(resolved)
          }
          if (Array.isArray(content)) {
            let parts: string[] = []
            const isScreenshotTool = toolName === 'browser_take_screenshot'
            const contentHasBinaryImage = content.some((c) => c.type === 'image' && !!c.data)
            for (const c of content) {
              if (c.type === 'image' && c.data) {
                const imageBuffer = Buffer.from(c.data, 'base64')
                const filename = `screenshot-${Date.now()}.png`
                const filepath = path.join(UPLOAD_DIR, filename)
                fs.writeFileSync(filepath, imageBuffer)
                saveArtifact(imageBuffer, 'png')
                artifacts.push({ kind: 'screenshot', path: filepath, url: `/api/uploads/${filename}`, filename, createdAt: Date.now() })
                parts.push(`Screenshot saved to /api/uploads/${filename}`)
                parts.push(`![Screenshot](/api/uploads/${filename})`)
              } else if (c.type === 'resource' && c.resource?.blob) {
                const ext = c.resource.mimeType?.includes('pdf') ? 'pdf' : 'bin'
                const resourceBuffer = Buffer.from(c.resource.blob, 'base64')
                const filename = `browser-${Date.now()}.${ext}`
                const filepath = path.join(UPLOAD_DIR, filename)
                fs.writeFileSync(filepath, resourceBuffer)
                saveArtifact(resourceBuffer, ext)
                artifacts.push({
                  kind: ext === 'pdf' ? 'pdf' : 'download',
                  path: filepath,
                  url: `/api/uploads/${filename}`,
                  filename,
                  createdAt: Date.now(),
                })
                parts.push(`[Download ${filename}](/api/uploads/${filename})`)
              } else {
                const text = c.text || ''
                const fileMatch = text.match(/\]\((\.\.\/[^\s)]+|\/[^\s)]+\.(pdf|png|jpg|jpeg|gif|webp|html|mp4|webm))\)/)
                if (fileMatch) {
                  const rawPath = fileMatch[1]
                  let srcPath = rawPath
                  if (!rawPath.startsWith('/')) {
                    try {
                      srcPath = resolvePathWithinBaseDir(cwd, rawPath)
                    } catch {
                      continue
                    }
                  }
                  if (fs.existsSync(srcPath)) {
                    const ext = path.extname(srcPath).slice(1).toLowerCase()
                    const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
                    if (IMAGE_EXTS.includes(ext) && contentHasBinaryImage) {
                      continue
                    } else {
                      const filename = `browser-${Date.now()}.${ext}`
                      const destPath = path.join(UPLOAD_DIR, filename)
                      fs.copyFileSync(srcPath, destPath)
                      if (options?.saveTo?.trim()) {
                        let targetPath = safePath(cwd, options.saveTo.trim(), filesystemScope)
                        if (!path.extname(targetPath)) targetPath = `${targetPath}.${ext}`
                        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
                        fs.copyFileSync(srcPath, targetPath)
                        savedPaths.push(targetPath)
                      }
                      artifacts.push({
                        kind: ext === 'pdf' ? 'pdf' : 'download',
                        path: destPath,
                        url: `/api/uploads/${filename}`,
                        filename,
                        createdAt: Date.now(),
                      })
                      parts.push(IMAGE_EXTS.includes(ext) ? `![Screenshot](/api/uploads/${filename})` : `[Download ${filename}](/api/uploads/${filename})`)
                    }
                  } else {
                    parts.push(isError ? text : cleanPlaywrightOutput(text))
                  }
                } else {
                  parts.push(isError ? text : cleanPlaywrightOutput(text))
                }
              }
            }
            if (isScreenshotTool) parts = dedupeScreenshotMarkdownLines(parts)
            if (savedPaths.length > 0) {
              const unique = dedup(savedPaths)
              parts.push(`Saved to: ${unique.map((p) => path.relative(cwd, p) || '.').join(', ')}`)
            }
            upsertBrowserSessionRecord({
              sessionId: sessionKey,
              profileId: profileInfo.profileId,
              profileDir,
              status: 'active',
              lastAction: toolName,
              lastError: isError ? parts.join('\n').slice(0, 1000) : null,
              artifacts,
            })
            return parts.join('\n')
          }
          const fallback = JSON.stringify(result)
          upsertBrowserSessionRecord({
            sessionId: sessionKey,
            profileId: profileInfo.profileId,
            profileDir,
            status: 'active',
            lastAction: toolName,
            lastError: isError ? fallback.slice(0, 1000) : null,
          })
          return fallback
        } catch (err: unknown) {
          const message = errorMessage(err)
          upsertBrowserSessionRecord({
            sessionId: sessionKey,
            profileId: profileInfo.profileId,
            profileDir,
            status: 'error',
            lastAction: toolName,
            lastError: message,
          })
          return `Error: ${message}`
        }
      }

      return withRetry(rawCall, undefined, {
        maxAttempts: 3,
        backoffMs: 1000,
        retryable: [
          /timed out/i,
          /ERR_ABORTED/i,
          /Target closed/i,
          /Execution context was destroyed/i,
          /SharedContextFactory already exists/i,
          /ECONNRESET/i,
          /temporarily unavailable/i,
        ],
        onRetry: async (_attempt, result) => {
          if (/SharedContextFactory already exists/i.test(result)) {
            cleanupSessionBrowser(sessionKey)
            upsertBrowserSessionRecord({
              sessionId: sessionKey,
              profileId: profileInfo.profileId,
              profileDir,
              inheritedFromSessionId: profileInfo.inheritedFromSessionId,
              status: 'idle',
              lastAction: 'browser_recover',
              lastError: 'Recovered browser transport after Playwright shared-context startup conflict.',
            })
          }
        },
      })
    }

    const dismissCookieBanners = async (mcpCall: (toolName: string, args: Record<string, unknown>) => Promise<string>) => {
      await sleep(1200)
      const js = `() => {
        const docs = [document];
        const roots = [document];
        const seenRoots = new Set([document]);
        const pushRoot = (root) => {
          if (!root || seenRoots.has(root)) return;
          seenRoots.add(root);
          roots.push(root);
        };
        const collectFrames = (doc) => {
          try {
            const frames = doc.querySelectorAll('iframe');
            for (const frame of frames) {
              try {
                const child = frame.contentDocument || frame.contentWindow?.document;
                if (child && !docs.includes(child)) {
                  docs.push(child);
                  pushRoot(child);
                }
              } catch {}
            }
          } catch {}
        };
        const collectShadowRoots = () => {
          for (const root of [...roots]) {
            try {
              const all = root.querySelectorAll('*');
              for (const el of all) {
                if (el.shadowRoot) pushRoot(el.shadowRoot);
              }
            } catch {}
          }
        };
        collectFrames(document);
        collectShadowRoots();
        const allRoots = [...new Set([...docs, ...roots])];
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const normalizedText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const candidateSelectors = [
          '#onetrust-reject-all-handler',
          '#CybotCookiebotDialogBodyButtonDecline',
          '#didomi-notice-disagree-button',
          '.qc-cmp2-summary-buttons button:first-child',
          'button.sp_choice_type_12',
          'button[id*="reject" i]',
          'button[class*="reject" i]',
          'button[id*="decline" i]',
          'button[class*="decline" i]',
          'button[id*="consent" i]',
          'button[class*="consent" i]',
          'a[id*="reject" i]',
          'a[class*="reject" i]',
          'a[id*="decline" i]',
          'a[class*="decline" i]'
        ];
        for (const root of allRoots) {
          for (const selector of candidateSelectors) {
            try {
              const el = root.querySelector(selector);
              if (el && visible(el)) {
                el.click();
                return 'clicked:' + selector;
              }
            } catch {}
          }
        }
        const buttonSelector = 'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]';
        const rejectRe = /^(reject|reject all|decline|decline all|deny|deny all|refuse|no,? thanks|only necessary|necessary only|use necessary cookies only)$/i;
        const acceptRe = /^(accept|accept all|allow all|agree|i agree|okay|ok|got it|continue|consent)$/i;
        const closeRe = /^(close|dismiss|skip|not now|x|×)$/i;
        const clickMatching = (matcher, label) => {
          for (const root of allRoots) {
            let buttons = [];
            try { buttons = [...root.querySelectorAll(buttonSelector)]; } catch {}
            for (const button of buttons) {
              const txt = normalizedText(button.textContent || button.getAttribute?.('aria-label') || button.getAttribute?.('value'));
              if (!txt || !matcher.test(txt) || !visible(button)) continue;
              try {
                button.click();
                return label + ':' + txt.slice(0, 80);
              } catch {}
            }
          }
          return null;
        };
        const clicked = clickMatching(rejectRe, 'reject') || clickMatching(acceptRe, 'accept') || clickMatching(closeRe, 'close');
        if (clicked) return clicked;
        const overlaySelectors = [
          '#onetrust-banner-sdk',
          '#onetrust-consent-sdk',
          '#CybotCookiebotDialog',
          '.didomi-popup-container',
          '.fc-consent-root',
          '[id*="cookie" i]',
          '[class*="cookie" i]',
          '[id*="consent" i]',
          '[class*="consent" i]',
          '[id*="privacy" i]',
          '[class*="privacy" i]',
          '[id*="sp_message" i]',
          '[class*="sp_message" i]'
        ];
        const hidden = [];
        for (const root of allRoots) {
          for (const selector of overlaySelectors) {
            let nodes = [];
            try { nodes = [...root.querySelectorAll(selector)]; } catch {}
            for (const node of nodes) {
              if (!visible(node)) continue;
              const text = normalizedText(node.textContent).toLowerCase();
              const attrs = normalizedText(node.id + ' ' + node.className).toLowerCase();
              if (!text.includes('cookie') && !text.includes('consent') && !text.includes('privacy') && !attrs.includes('cookie') && !attrs.includes('consent') && !attrs.includes('privacy') && !attrs.includes('onetrust') && !attrs.includes('didomi') && !attrs.includes('sp_message')) continue;
              try {
                node.style.setProperty('display', 'none', 'important');
                node.style.setProperty('visibility', 'hidden', 'important');
                node.style.setProperty('pointer-events', 'none', 'important');
                hidden.push(selector);
              } catch {}
            }
          }
        }
        if (hidden.length) {
          try {
            document.documentElement.style.removeProperty('overflow');
            document.body.style.removeProperty('overflow');
          } catch {}
          return 'hidden:' + hidden[0];
        }
        return 'none';
      }`
      await mcpCall('browser_evaluate', { function: js })
    }

    const performFillForm = async (params: Record<string, unknown>) => {
      const fields = Array.isArray(params.fields)
        ? params.fields
        : (() => {
          const form = params.form
          if (!form || typeof form !== 'object' || Array.isArray(form)) return []
          return Object.entries(form as Record<string, unknown>).map(([key, value]) => {
              const escapedId = String(key).replace(/[^a-zA-Z0-9_-]/g, '')
              const escapedAttr = String(key).replace(/["\\]/g, '\\$&')
              const inferredType = typeof value === 'boolean'
                ? 'checkbox'
                : /password/i.test(key)
                  ? 'password'
                  : 'text'
              return {
                element: escapedId
                  ? `#${escapedId}, [name="${escapedAttr}"]`
                  : `[name="${escapedAttr}"]`,
                type: inferredType,
                value,
              }
            })
          })()
      if (fields.length === 0) return { ok: false, error: 'fields is required for fill_form.' }
      const filled: Array<Record<string, unknown>> = []
      for (const field of fields) {
        if (!field || typeof field !== 'object') continue
        const entry = field as Record<string, unknown>
        const ref = typeof entry.ref === 'string' ? entry.ref : undefined
        const element = typeof entry.element === 'string' ? entry.element : undefined
        const fieldType = String(entry.type || 'text').toLowerCase()
        const value = entry.value ?? entry.text
        if (!ref && !element) continue
        const selectValues = Array.isArray(entry.values)
          ? entry.values.map((item) => String(item ?? ''))
          : Array.isArray(parseJsonArrayValue(entry.values ?? entry.option ?? value))
            ? (parseJsonArrayValue(entry.values ?? entry.option ?? value) as unknown[]).map((item) => String(item ?? ''))
            : [String(entry.option ?? value ?? '')]
        if (!ref && element) {
          if (fieldType === 'select') {
            const result = await performSelectorDomAction('select', { element, values: selectValues })
            if (!result) return { ok: false, error: 'Selector fallback failed for select field.' }
            if (!result.ok) return result
          } else if (fieldType === 'checkbox' || fieldType === 'radio') {
            if (value === true || value === 'true' || value === 'on' || value === 'checked') {
              const result = await performSelectorDomAction('click', { element })
              if (!result) return { ok: false, error: 'Selector fallback failed for checkbox field.' }
              if (!result.ok) return result
            }
          } else {
            const result = await performSelectorDomAction('type', {
              element,
              text: String(value ?? ''),
              submit: params.submit === true,
            })
            if (!result) return { ok: false, error: 'Selector fallback failed for input field.' }
            if (!result.ok) return result
          }
          filled.push({
            ref: null,
            element,
            type: fieldType,
            value: value ?? null,
          })
          continue
        }
        if (fieldType === 'select') {
          await callMcpTool('browser_select_option', { ref, element, values: selectValues })
        } else if (fieldType === 'checkbox' || fieldType === 'radio') {
          if (value === true || value === 'true' || value === 'on' || value === 'checked') {
            await callMcpTool('browser_click', { ref, element })
          }
        } else {
          await callMcpTool('browser_type', {
            ref,
            element,
            text: String(value ?? ''),
            slowly: fieldType === 'password' ? false : params.slowly === true,
          })
        }
        filled.push({
          ref: ref || null,
          element: element || null,
          type: fieldType,
          value: value ?? null,
        })
      }
      return { ok: true, filled }
    }

    const submitForm = async (params: Record<string, unknown>) => {
      const submitRef = pickNonEmptyBrowserString(params.submitRef)
      const submitElement = pickNonEmptyBrowserString(params.submitElement, params.selector, params.element)
      if (submitRef || submitElement) {
        if (submitRef) {
          await callMcpTool('browser_click', {
            ref: submitRef,
            element: submitElement,
          })
        } else if (submitElement) {
          const result = await performSelectorDomAction('click', { element: submitElement })
          if (!result) return { ok: false, error: 'submitElement is required for selector-based submit.' }
          if (!result.ok) return result
        }
      } else {
        await callBrowserEvaluate(`() => {
          const form = document.forms[0];
          if (!form) return { submitted: false, reason: 'no-form' };
          const submitButton = form.querySelector('button[type="submit"], input[type="submit"], button');
          if (submitButton && typeof submitButton.click === 'function') {
            submitButton.click();
            return { submitted: true, method: 'click' };
          }
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return { submitted: true, method: 'requestSubmit' };
          }
          if (typeof form.submit === 'function') {
            form.submit();
            return { submitted: true, method: 'submit' };
          }
          return { submitted: false, reason: 'no-submit-method' };
        }`)
      }

      const waitMs = typeof params.waitMs === 'number' ? Math.max(250, params.waitMs) : 1000
      try {
        await callBrowserEvaluate(`async () => { await new Promise(resolve => setTimeout(resolve, ${Math.min(waitMs, 5000)})); }`)
      } catch {
        await sleep(waitMs)
      }

      return {
        ok: true,
        submitted: true,
        page: await captureStructuredObservation(),
      }
    }

    const scrollUntil = async (params: Record<string, unknown>) => {
      const containsText = typeof params.containsText === 'string'
        ? params.containsText
        : typeof params.text === 'string'
          ? params.text
          : ''
      const selector = typeof params.selector === 'string' ? params.selector : ''
      if (!containsText && !selector) return { ok: false, error: 'containsText or selector is required for scroll_until.' }

      const maxScrolls = typeof params.maxScrolls === 'number' ? Math.max(1, Math.min(20, params.maxScrolls)) : 8
      let matchedAtStep = -1
      for (let index = 0; index < maxScrolls; index += 1) {
        const result = await callBrowserEvaluate(`() => {
            const bodyText = String(document.body?.innerText || document.body?.textContent || '');
            const selector = ${JSON.stringify(selector)};
            const containsText = ${JSON.stringify(containsText)};
            const match = (selector && !!document.querySelector(selector))
              || (containsText && bodyText.includes(containsText));
            if (match) return { found: true, scrollY: window.scrollY, step: ${index} };
            window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 600), behavior: 'instant' });
            return { found: false, scrollY: window.scrollY, step: ${index} };
          }`)
        const payload = extractJsonPayload(result)
        if (payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>).found === true) {
          matchedAtStep = index
          break
        }
      }

      const page = await captureStructuredObservation()
      return {
        ok: matchedAtStep >= 0,
        found: matchedAtStep >= 0,
        matchedAtStep: matchedAtStep >= 0 ? matchedAtStep : null,
        page,
      }
    }

    const resolveDownloadUrl = async (params: Record<string, unknown>) => {
      if (typeof params.url === 'string' && params.url.trim()) return params.url.trim()
      const linkText = typeof params.linkText === 'string' ? params.linkText.trim() : ''
      const hrefContains = typeof params.hrefContains === 'string' ? params.hrefContains.trim() : ''
      if (!linkText && !hrefContains) return null
      const result = await callBrowserEvaluate(`() => {
          const linkText = ${JSON.stringify(linkText)};
          const hrefContains = ${JSON.stringify(hrefContains)};
          const links = Array.from(document.querySelectorAll('a[href]'));
          const match = links.find((link) => {
            const text = String(link.innerText || link.textContent || '').trim();
            const href = String(link.href || link.getAttribute('href') || '').trim();
            if (!href) return false;
            if (linkText && text.toLowerCase().includes(linkText.toLowerCase())) return true;
            if (hrefContains && href.toLowerCase().includes(hrefContains.toLowerCase())) return true;
            return false;
          });
          return { href: match ? (match.href || match.getAttribute('href') || '') : null };
        }`)
      const payload = extractJsonPayload(result)
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const href = (payload as Record<string, unknown>).href
        return typeof href === 'string' && href.trim() ? href.trim() : null
      }
      return null
    }

    const downloadFile = async (params: Record<string, unknown>) => {
      const downloadUrl = await resolveDownloadUrl(params)
      if (!downloadUrl) return { ok: false, error: 'url, linkText, or hrefContains is required for download_file.' }

      const current = await captureStructuredObservation()
      let resolvedUrl = downloadUrl
      if (!/^https?:\/\//i.test(resolvedUrl)) {
        const base = typeof current.url === 'string' && current.url ? current.url : undefined
        if (!base) return { ok: false, error: 'Relative download URL requires an active page URL.' }
        resolvedUrl = new URL(resolvedUrl, base).toString()
      }

      const res = await fetch(resolvedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwarmClaw/1.0)' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.statusText}`, url: resolvedUrl }

      const arrayBuffer = await res.arrayBuffer()
      const data = Buffer.from(arrayBuffer)
      const inferredName = (() => {
        try {
          const pathname = new URL(resolvedUrl).pathname
          const base = path.basename(pathname)
          return base && base !== '/' ? base : `download-${Date.now()}`
        } catch {
          return `download-${Date.now()}`
        }
      })()
      const targetPath = typeof params.saveTo === 'string' && params.saveTo.trim()
        ? safePath(cwd, params.saveTo.trim(), filesystemScope)
        : path.join(UPLOAD_DIR, inferredName)
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.writeFileSync(targetPath, data)

      const artifactPath = targetPath.startsWith(UPLOAD_DIR)
        ? targetPath
        : path.join(UPLOAD_DIR, `${Date.now()}-${path.basename(targetPath)}`)
      if (artifactPath !== targetPath) fs.copyFileSync(targetPath, artifactPath)
      const filename = path.basename(artifactPath)
      upsertBrowserSessionRecord({
        sessionId: sessionKey,
        profileId: profileInfo.profileId,
        profileDir,
        status: 'active',
        lastAction: 'download_file',
        artifacts: [{
          kind: 'download',
          path: artifactPath,
          url: `/api/uploads/${filename}`,
          filename,
          createdAt: Date.now(),
        }],
      })

      return {
        ok: true,
        url: resolvedUrl,
        path: targetPath,
        artifactUrl: `/api/uploads/${filename}`,
        filename: path.basename(targetPath),
        sizeBytes: data.byteLength,
        contentType: res.headers.get('content-type') || null,
      }
    }

    const verifyOutcome = async (params: Record<string, unknown>) => {
      const verification: Record<string, unknown> = {}
      if (typeof params.expectText === 'string' && params.expectText.trim()) {
        verification.expectText = await callMcpTool('browser_verify_text_visible', { text: params.expectText.trim() })
      }
      if (typeof params.expectElement === 'string' && params.expectElement.trim()) {
        verification.expectElement = await callMcpTool('browser_verify_element_visible', { element: params.expectElement.trim() })
      }
      if (typeof params.expectValue === 'string' && params.expectValue.trim()) {
        verification.expectValue = await callMcpTool('browser_verify_value', {
          element: typeof params.expectValueElement === 'string' ? params.expectValueElement : undefined,
          value: params.expectValue.trim(),
        })
      }
      return verification
    }

    const completeWebTask = async (params: Record<string, unknown>) => {
      const steps: string[] = []
      if (typeof params.url === 'string' && params.url.trim()) {
        const navigationTarget = await resolveNavigationTarget(params.url.trim())
        await callMcpTool('browser_navigate', { url: navigationTarget })
        steps.push(`navigate:${navigationTarget}`)
        try { await dismissCookieBanners(callMcpTool) } catch { /* ignore */ }
      }

      let initialPage = await captureStructuredObservation()
      if (typeof params.scrollUntilText === 'string' || typeof params.scrollUntilSelector === 'string') {
        const scroll = await scrollUntil({
          containsText: typeof params.scrollUntilText === 'string' ? params.scrollUntilText : undefined,
          selector: typeof params.scrollUntilSelector === 'string' ? params.scrollUntilSelector : undefined,
          maxScrolls: typeof params.maxScrolls === 'number' ? params.maxScrolls : undefined,
        })
        steps.push('scroll_until')
        if (scroll.ok && scroll.page) initialPage = scroll.page
      }

      if ((Array.isArray(params.fields) && params.fields.length > 0) || (params.form && typeof params.form === 'object' && !Array.isArray(params.form))) {
        const filled = await performFillForm(params)
        if (!filled.ok) return filled
        steps.push('fill_form')
      }

      if (params.submit === true) {
        await submitForm(params)
        steps.push('submit_form')
      }

      let download: Record<string, unknown> | null = null
      if (params.download === true || typeof params.downloadUrl === 'string' || typeof params.linkText === 'string' || typeof params.hrefContains === 'string') {
        download = await downloadFile({
          url: typeof params.downloadUrl === 'string' ? params.downloadUrl : params.url,
          linkText: params.linkText,
          hrefContains: params.hrefContains,
          saveTo: params.saveTo,
        })
        steps.push('download_file')
      }

      const verification = await verifyOutcome(params)
      const page = await captureStructuredObservation()
      return {
        ok: true,
        goal: typeof params.goal === 'string' ? params.goal : null,
        steps,
        verification,
        initialPage,
        page,
        download,
      }
    }

    const MCP_TOOL_MAP: Record<string, string> = {
      navigate: 'browser_navigate',
      back: 'browser_navigate_back',
      close: 'browser_close',
      screenshot: 'browser_take_screenshot',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      hover: 'browser_hover',
      type: 'browser_type',
      press_key: 'browser_press_key',
      select: 'browser_select_option',
      fill_form: 'browser_fill_form',
      dialog: 'browser_handle_dialog',
      evaluate: 'browser_evaluate',
      run_code: 'browser_run_code',
      pdf: 'browser_pdf_save',
      upload: 'browser_file_upload',
      wait: 'browser_wait_for',
      tabs: 'browser_tabs',
      network: 'browser_network_requests',
      verify_text: 'browser_verify_text_visible',
      verify_element: 'browser_verify_element_visible',
      verify_list: 'browser_verify_list_visible',
      verify_value: 'browser_verify_value',
    }

    tools.push(
      tool(
        async (rawParams) => {
          const params = normalizeBrowserActionParams((rawParams ?? {}) as Record<string, unknown>)
          try {
            const action = String(params.action || '').trim()

            if (action === 'profile') {
              const state = upsertBrowserSessionRecord({
                sessionId: sessionKey,
                profileId: profileInfo.profileId,
                profileDir,
                inheritedFromSessionId: profileInfo.inheritedFromSessionId,
                status: activeBrowsers.has(sessionKey) ? 'active' : 'idle',
              })
              return stringifyStructured({
                sessionId: sessionKey,
                active: activeBrowsers.has(sessionKey),
                profileId: state.profileId,
                profileDir: state.profileDir,
                runtime: state.runtime,
                sandbox: state.sandbox,
                inheritedFromSessionId: state.inheritedFromSessionId,
                currentUrl: state.currentUrl,
                pageTitle: state.pageTitle,
                lastObservation: state.lastObservation,
              })
            }

            if (action === 'reset_profile') {
              cleanupSessionBrowser(sessionKey)
              fs.rmSync(profileDir, { recursive: true, force: true })
              removeBrowserSessionRecord(sessionKey)
              return stringifyStructured({
                ok: true,
                sessionId: sessionKey,
                profileId: profileInfo.profileId,
                profileDir,
                reset: true,
              })
            }

            if (action === 'read_page') {
              const target = pickBrowserTargetFromParams(params)
              if (target) {
                await callMcpTool('browser_navigate', { url: await resolveNavigationTarget(target) })
                try { await dismissCookieBanners(callMcpTool) } catch { /* ignore */ }
              }
              return stringifyStructured(await captureStructuredObservation())
            }

            if (action === 'extract_links') {
              const observation = await captureStructuredObservation() as Record<string, unknown>
              return stringifyStructured({
                url: observation.url || null,
                title: observation.title || null,
                links: Array.isArray(observation.links) ? observation.links : [],
              })
            }

            if (action === 'extract_form_fields') {
              const observation = await captureStructuredObservation() as Record<string, unknown>
              return stringifyStructured({
                url: observation.url || null,
                title: observation.title || null,
                forms: Array.isArray(observation.forms) ? observation.forms : [],
              })
            }

            if (action === 'extract_table') {
              const observation = await captureStructuredObservation() as Record<string, unknown>
              const tables = Array.isArray(observation.tables) ? observation.tables : []
              const tableIndex = typeof params.tableIndex === 'number' ? params.tableIndex : 0
              return stringifyStructured({
                url: observation.url || null,
                title: observation.title || null,
                table: tables[tableIndex] || null,
                tables,
              })
            }

            if (action === 'fill_form') {
              const filled = await performFillForm(params)
              if (!filled.ok) return `Error: ${filled.error}`
              if (params.submit === true) {
                await submitForm(params)
              }
              return stringifyStructured({
                ok: true,
                filled: filled.filled,
                submitted: params.submit === true,
                page: await captureStructuredObservation(),
              })
            }

            if (action === 'submit_form') {
              return stringifyStructured(await submitForm(params))
            }

            if (action === 'scroll_until') {
              return stringifyStructured(await scrollUntil(params))
            }

            if (action === 'download_file') {
              return stringifyStructured(await downloadFile(params))
            }

            if (action === 'complete_web_task') {
              return stringifyStructured(await completeWebTask(params))
            }

            const mcpTool = MCP_TOOL_MAP[action]
            if (!mcpTool) return `Unknown browser action: "${action}"`
            const rest = { ...params }
            delete rest.action
            const args: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(rest)) {
              if (v !== undefined && v !== null && v !== '') args[k] = v
            }

            if (action === 'navigate') {
              const target = pickBrowserTargetFromParams(params)
              if (!target) return 'Error: url or filePath is required for navigate.'
              args.url = await resolveNavigationTarget(target)
              delete args.filePath
              delete args.path
              delete args.href
              delete args.link
              delete args.target
              delete args.page
            }

            if (action === 'tabs') {
              args.action = typeof params.tabAction === 'string' ? params.tabAction : 'list'
              delete args.tabAction
            }
            if (action === 'network') {
              args.includeStatic = params.includeStatic === true
              if (typeof params.filename !== 'string') delete args.filename
            }
            if (action === 'select' && args.option !== undefined) {
              args.values = Array.isArray(args.option) ? args.option : [String(args.option)]
              delete args.option
            }
            if (action === 'select' && args.values === undefined && args.value !== undefined) {
              args.values = Array.isArray(args.value) ? args.value : [String(args.value)]
              delete args.value
            }

            if ((action === 'screenshot' || action === 'snapshot') && args.url) {
              const navUrl = await resolveNavigationTarget(String(args.url))
              delete args.url
              await callMcpTool('browser_navigate', { url: navUrl })
              try { await dismissCookieBanners(callMcpTool) } catch { /* ignore */ }
            }

            if (action === 'screenshot' || action === 'snapshot') {
              try {
                await callBrowserEvaluate(`async () => { await new Promise(resolve => {
                    if (document.readyState === 'complete') {
                      setTimeout(resolve, 1200);
                    } else {
                      window.addEventListener('load', () => setTimeout(resolve, 1200), { once: true });
                      setTimeout(resolve, 5000);
                    }
                  }); }`)
              } catch {
                await sleep(1200)
              }
              try { await dismissCookieBanners(callMcpTool) } catch { /* ignore */ }
            }

            if (['click', 'hover', 'type', 'select'].includes(action) && !args.ref && typeof args.element === 'string') {
              const selectorResult = await performSelectorDomAction(action as 'click' | 'hover' | 'type' | 'select', args)
              if (!selectorResult) return `Error: ${action} requires a target element.`
              if (!selectorResult.ok) return `Error: ${selectorResult.error}`
              try { await captureStructuredObservation() } catch { /* ignore */ }
              return selectorResult.output
            }

            let result = await callMcpTool(mcpTool, args, { saveTo: typeof params.saveTo === 'string' ? params.saveTo : undefined })
            if (action === 'navigate' && result.includes('ERR_ABORTED')) {
              await sleep(1000)
              result = await callMcpTool('browser_snapshot', {})
            }
            if (action === 'navigate') {
              try { await dismissCookieBanners(callMcpTool) } catch { /* ignore */ }
            }

            if (['navigate', 'back', 'click', 'type', 'select', 'fill_form', 'submit_form', 'press_key', 'scroll_until', 'complete_web_task'].includes(action)) {
              try { await captureStructuredObservation() } catch { /* ignore */ }
            }

            if (action === 'close') {
              cleanupSessionBrowser(sessionKey)
            }

            return result
          } catch (err: unknown) {
            return `Error: ${errorMessage(err)}`
          }
        },
        {
          name: 'browser',
          description: 'Control a persistent browser profile. Supports low-level actions plus higher-level workflows like read_page, extract_links, extract_form_fields, extract_table, fill_form, submit_form, scroll_until, download_file, complete_web_task, profile, and reset_profile.',
          schema: z.object({
            action: z.enum([
              'navigate',
              'back',
              'close',
              'screenshot',
              'snapshot',
              'click',
              'hover',
              'type',
              'fill_form',
              'submit_form',
              'scroll_until',
              'press_key',
              'select',
              'dialog',
              'evaluate',
              'run_code',
              'pdf',
              'upload',
              'wait',
              'tabs',
              'network',
              'read_page',
              'extract_links',
              'extract_form_fields',
              'extract_table',
              'download_file',
              'complete_web_task',
              'verify_text',
              'verify_element',
              'verify_list',
              'verify_value',
              'profile',
              'reset_profile',
            ]),
          }).passthrough(),
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
            const parsedArgs = cmdArgs ? cmdArgs.split(/\s+/).filter(Boolean) : []
            const runBrowserCommand = (browserCommand: string, browserArgs: string[]) => {
              const spawnArgs = ['browser', '--json', browserCommand, ...browserArgs]
              return spawnSync(openclawPath, spawnArgs, {
                encoding: 'utf-8',
                timeout: 60_000,
                maxBuffer: MAX_OUTPUT,
              })
            }

            if (command === 'capture') {
              const outputs: string[] = []
              if (parsedArgs.length > 0) {
                const openResult = runBrowserCommand('open', parsedArgs)
                if (openResult.status !== 0) {
                  return `Error (exit ${openResult.status}): ${openResult.stderr || openResult.stdout || 'unknown'}`
                }
                if (openResult.stdout?.trim()) outputs.push(openResult.stdout.trim())
              }
              const screenshotResult = runBrowserCommand('screenshot', [])
              if (screenshotResult.status !== 0) {
                return `Error (exit ${screenshotResult.status}): ${screenshotResult.stderr || screenshotResult.stdout || 'unknown'}`
              }
              if (screenshotResult.stdout?.trim()) outputs.push(screenshotResult.stdout.trim())
              return truncate(outputs.join('\n').trim() || '(no output)', MAX_OUTPUT)
            }

            const result = runBrowserCommand(command, parsedArgs)
            if (result.status !== 0) return `Error (exit ${result.status}): ${result.stderr || result.stdout || 'unknown'}`
            return truncate(result.stdout || '(no output)', MAX_OUTPUT)
          } catch (err: unknown) { return `Error: ${errorMessage(err)}` }
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
