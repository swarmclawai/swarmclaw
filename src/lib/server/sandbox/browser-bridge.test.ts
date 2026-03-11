import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { ensureBrowserBridge, stopBrowserBridgeForScope } from '@/lib/server/sandbox/browser-bridge'
import { issueNoVncObserverToken } from '@/lib/server/sandbox/novnc-auth'

test('browser bridge proxies loopback CDP requests only with auth and serves noVNC token redirects', async (t) => {
  const upstream = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ Browser: 'SwarmClaw Chrome' }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const scopeKey = 'session:test-browser-bridge'

  t.after(async () => {
    await stopBrowserBridgeForScope(scopeKey)
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  const bridge = await ensureBrowserBridge({
    scopeKey,
    containerName: 'sandbox-browser-1',
    targetUrl: `http://127.0.0.1:${upstreamPort}`,
    auth: { token: 'bridge-token' },
    noVncPort: 46080,
    noVncPassword: 'viewerpass',
  })

  const denied = await fetch(`${bridge.baseUrl}/json/version`)
  assert.equal(denied.status, 401)

  const allowed = await fetch(`${bridge.baseUrl}/json/version`, {
    headers: {
      Authorization: 'Bearer bridge-token',
    },
  })
  assert.equal(allowed.status, 200)
  assert.match(await allowed.text(), /SwarmClaw Chrome/)

  const token = issueNoVncObserverToken({
    noVncPort: 46080,
    password: 'viewerpass',
  })
  const novnc = await fetch(`${bridge.baseUrl}/sandbox/novnc?token=${token}`)
  assert.equal(novnc.status, 200)
  const html = await novnc.text()
  assert.match(html, /127\.0\.0\.1:46080\/vnc\.html/)
  assert.match(html, /viewerpass/)
})
