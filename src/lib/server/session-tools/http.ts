import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import { truncate, MAX_OUTPUT } from './context'
import { withRetry } from '../tool-retry'

interface HttpRequestArgs {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  timeoutSec?: number
  followRedirects?: boolean
}

export function buildHttpTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasTool('http_request')) return []

  return [
    tool(
      (args: HttpRequestArgs) => withRetry(async (_a: HttpRequestArgs) => {
        try {
          const timeout = Math.max(1, Math.min(_a.timeoutSec ?? 30, 120)) * 1000
          const init: RequestInit = {
            method: _a.method,
            headers: (_a.headers ?? undefined) as Record<string, string> | undefined,
            signal: AbortSignal.timeout(timeout),
          }
          if (_a.body && _a.method !== 'GET' && _a.method !== 'HEAD') {
            init.body = _a.body
          }
          if (_a.followRedirects === false) {
            init.redirect = 'manual'
          }
          const res = await fetch(_a.url, init)
          const resHeaders: Record<string, string> = {}
          for (const key of ['content-type', 'location', 'x-request-id', 'retry-after', 'content-length']) {
            const val = res.headers.get(key)
            if (val) resHeaders[key] = val
          }
          let resBody: string
          const ct = res.headers.get('content-type') ?? ''
          if (ct.includes('image/') || ct.includes('audio/') || ct.includes('video/') || ct.includes('application/octet-stream')) {
            resBody = `[binary content, ${res.headers.get('content-length') ?? 'unknown'} bytes]`
          } else {
            resBody = truncate(await res.text(), MAX_OUTPUT)
          }
          return JSON.stringify({ status: res.status, statusText: res.statusText, headers: resHeaders, body: resBody })
        } catch (err: unknown) {
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        }
      }, args),
      {
        name: 'http_request',
        description: 'Make an HTTP API request. Supports all methods, custom headers, and request bodies. Returns status, headers, and body.',
        schema: z.object({
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).describe('HTTP method'),
          url: z.string().describe('Full URL to request'),
          headers: z.record(z.string(), z.string()).optional().describe('Request headers as key-value pairs'),
          body: z.string().optional().describe('Request body (JSON string, form data, or plain text). Ignored for GET/HEAD.'),
          timeoutSec: z.number().optional().describe('Timeout in seconds (default 30, max 120)'),
          followRedirects: z.boolean().optional().describe('Follow redirects (default true). Set false to inspect redirect responses.'),
        }),
      },
    ),
  ]
}
