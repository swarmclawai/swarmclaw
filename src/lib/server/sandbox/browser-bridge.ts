import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { hmrSingleton } from '@/lib/shared-utils'
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from './bridge-auth-registry'
import { buildNoVncDirectUrl, consumeNoVncObserverToken, type NoVncObserverTokenPayload } from './novnc-auth'

export interface BrowserBridgeAuth {
  token?: string
  password?: string
}

export interface BrowserBridge {
  server: Server
  port: number
  baseUrl: string
  targetUrl: string
  auth: BrowserBridgeAuth
}

type BrowserBridgeRegistryEntry = {
  bridge: BrowserBridge
  scopeKey: string
  containerName: string
  noVncPort?: number | null
  noVncPassword?: string | null
}

const browserBridges = hmrSingleton('__swarmclaw_browser_bridges__', () => new Map<string, BrowserBridgeRegistryEntry>())

function buildNoVncBootstrapHtml(params: NoVncObserverTokenPayload): string {
  const hash = new URLSearchParams({
    autoconnect: '1',
    resize: 'remote',
  })
  if (params.password?.trim()) hash.set('password', params.password)
  const targetUrl = `${buildNoVncDirectUrl(params.noVncPort)}#${hash.toString()}`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>SwarmClaw noVNC Observer</title>
</head>
<body>
  <p>Opening sandbox observer...</p>
  <script>
    window.location.replace(${JSON.stringify(targetUrl)});
  </script>
</body>
</html>`
}

function unauthorized(res: ServerResponse): void {
  res.statusCode = 401
  res.setHeader('WWW-Authenticate', 'Bearer realm="swarmclaw-sandbox-browser"')
  res.end('Unauthorized')
}

function requestAuthorized(req: IncomingMessage, auth: BrowserBridgeAuth): boolean {
  const expectedToken = auth.token?.trim()
  const expectedPassword = auth.password?.trim()
  if (!expectedToken && !expectedPassword) return false
  const header = String(req.headers.authorization || '').trim()
  if (expectedToken && header === `Bearer ${expectedToken}`) return true
  if (expectedPassword && header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
      const password = decoded.split(':').slice(1).join(':')
      if (password === expectedPassword) return true
    } catch {
      return false
    }
  }
  return false
}

async function proxyCdpRequest(req: IncomingMessage, res: ServerResponse, targetBaseUrl: string): Promise<void> {
  const targetUrl = new URL(req.url || '/', targetBaseUrl)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry)
    } else {
      headers.set(key, value)
    }
  }
  headers.delete('host')
  headers.delete('authorization')

  const body = req.method === 'GET' || req.method === 'HEAD'
    ? undefined
    : await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
      })

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
    duplex: body ? 'half' : undefined,
  })

  res.statusCode = upstream.status
  upstream.headers.forEach((value, key) => res.setHeader(key, value))
  const buffer = Buffer.from(await upstream.arrayBuffer())
  res.end(buffer)
}

export async function ensureBrowserBridge(params: {
  scopeKey: string
  containerName: string
  targetUrl: string
  auth?: BrowserBridgeAuth
  noVncPort?: number | null
  noVncPassword?: string | null
}): Promise<BrowserBridge> {
  const token = params.auth?.token?.trim() || crypto.randomBytes(24).toString('hex')
  const password = params.auth?.password?.trim() || undefined
  const existing = browserBridges.get(params.scopeKey)
  if (existing && existing.containerName === params.containerName && existing.bridge.targetUrl === params.targetUrl) {
    return existing.bridge
  }
  if (existing) {
    await stopBrowserBridge(existing.bridge).catch(() => undefined)
    browserBridges.delete(params.scopeKey)
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/sandbox/novnc') {
        const rawToken = url.searchParams.get('token')?.trim() || ''
        const resolved = consumeNoVncObserverToken(rawToken)
        if (!resolved) {
          res.statusCode = 404
          res.end('Invalid or expired token')
          return
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
        res.setHeader('Referrer-Policy', 'no-referrer')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(buildNoVncBootstrapHtml(resolved))
        return
      }

      if (!requestAuthorized(req, { token, password })) {
        unauthorized(res)
        return
      }

      await proxyCdpRequest(req, res, params.targetUrl)
    } catch (error) {
      res.statusCode = 502
      res.end(error instanceof Error ? error.message : 'Browser bridge error')
    }
  })

  const listeningServer = await new Promise<Server>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
  const address = listeningServer.address() as AddressInfo | null
  const port = address?.port ?? 0
  const bridge: BrowserBridge = {
    server: listeningServer,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    targetUrl: params.targetUrl,
    auth: {
      token,
      password,
    },
  }
  setBridgeAuthForPort(port, bridge.auth)
  browserBridges.set(params.scopeKey, {
    bridge,
    scopeKey: params.scopeKey,
    containerName: params.containerName,
    noVncPort: params.noVncPort ?? null,
    noVncPassword: params.noVncPassword ?? null,
  })
  return bridge
}

export async function stopBrowserBridge(bridge: BrowserBridge): Promise<void> {
  deleteBridgeAuthForPort(bridge.port)
  await new Promise<void>((resolve) => bridge.server.close(() => resolve()))
}

export async function stopBrowserBridgeForScope(scopeKey: string): Promise<void> {
  const existing = browserBridges.get(scopeKey)
  if (!existing) return
  await stopBrowserBridge(existing.bridge)
  browserBridges.delete(scopeKey)
}

export function getBrowserBridgeForScope(scopeKey: string): {
  bridge: BrowserBridge
  noVncPort?: number | null
  noVncPassword?: string | null
} | null {
  const existing = browserBridges.get(scopeKey)
  if (!existing) return null
  return {
    bridge: existing.bridge,
    noVncPort: existing.noVncPort ?? null,
    noVncPassword: existing.noVncPassword ?? null,
  }
}
