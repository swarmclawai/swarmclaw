import fs from 'node:fs'
import path from 'node:path'

export function resolveBaseUrl() {
  return process.env.SWARMCLAW_URL || process.env.SWARMCLAW_BASE_URL || 'http://127.0.0.1:3456'
}

export function createArtifactDir(name) {
  const outputDir = path.join(process.cwd(), '.tmp-smoke-artifacts', name)
  fs.mkdirSync(outputDir, { recursive: true })
  return outputDir
}

export function uniqueId(prefix = 'browser-smoke') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function readAccessKey() {
  if (process.env.SWARMCLAW_ACCESS_KEY?.trim()) return process.env.SWARMCLAW_ACCESS_KEY.trim()
  const envPath = path.join(process.cwd(), '.env.local')
  const envText = fs.readFileSync(envPath, 'utf8')
  const match = envText.match(/^ACCESS_KEY=(.+)$/m)
  if (!match) throw new Error('Access key missing. Set SWARMCLAW_ACCESS_KEY or add ACCESS_KEY to .env.local.')
  const key = match[1].trim()
  if (!key) throw new Error('ACCESS_KEY is empty in .env.local.')
  return key
}

export async function createBrowserContext(browser, accessKey, viewport = { width: 1440, height: 960 }) {
  const context = await browser.newContext({ viewport })
  await context.addInitScript((key) => {
    window.localStorage.setItem('sc_access_key', key)
  }, accessKey)
  return context
}

export async function maybeAuthenticate(page, accessKey) {
  await page.waitForTimeout(800)

  const keyInput = page.locator('input[placeholder="Paste access key"], input[placeholder="Access key"]').first()
  if (await keyInput.count()) {
    await keyInput.fill(accessKey)
    await page.getByRole('button', { name: 'Connect' }).click()
    await page.waitForFunction(
      () => !document.querySelector('input[placeholder="Paste access key"], input[placeholder="Access key"]'),
      null,
      { timeout: 15_000 },
    )
  }

  const nameInput = page.locator('input[placeholder="Your name"]').first()
  if (await nameInput.count()) {
    await nameInput.fill('browser-smoke')
    await page.getByRole('button', { name: 'Get Started' }).click()
    await page.waitForFunction(
      () => !document.querySelector('input[placeholder="Your name"]'),
      null,
      { timeout: 15_000 },
    )
  }
}

function isInterestingSameOriginFailure(baseUrl, url) {
  if (!url.startsWith(baseUrl)) return false
  return !url.includes('/_next/') && !url.includes('hot-update')
}

function isInterestingSameOriginError(baseUrl, url, status) {
  if (status < 400) return false
  if (!url.startsWith(baseUrl)) return false
  if (url.includes('/_next/')) return false
  if (url.includes('/api/openclaw/approvals')) return false
  if (url.includes('/api/notifications')) return false
  return true
}

function isIgnorableRequestFailure(url, errorText) {
  if (!/net::ERR_ABORTED/i.test(errorText || '')) return false
  return url.includes('_rsc=') || url.includes('/api/auth')
}

function isIgnorableConsoleError(baseUrl, text, location) {
  if (!/Failed to load resource: the server responded with a status of 404/i.test(text || '')) return false

  const sourceUrl = location?.url || ''
  if (!sourceUrl) return false

  if (sourceUrl.endsWith('.map')) return true
  if (sourceUrl.includes('/_next/')) return true
  if (!sourceUrl.startsWith(baseUrl)) return false
  return sourceUrl.endsWith('/favicon.ico')
}

export function attachPageDiagnostics(page, summary, baseUrl = resolveBaseUrl()) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const location = typeof msg.location === 'function' ? msg.location() : {}
    if (isIgnorableConsoleError(baseUrl, msg.text(), location)) return
    summary.consoleErrors.push({ url: page.url(), text: msg.text(), sourceUrl: location?.url || null })
  })
  page.on('pageerror', (error) => {
    summary.pageErrors.push({ url: page.url(), message: error.message })
  })
  page.on('requestfailed', (req) => {
    const url = req.url()
    const error = req.failure()?.errorText || 'request failed'
    if (!isInterestingSameOriginFailure(baseUrl, url)) return
    if (isIgnorableRequestFailure(url, error)) return
    summary.requestFailures.push({
      url,
      method: req.method(),
      error,
    })
  })
  page.on('response', (res) => {
    const url = res.url()
    if (!isInterestingSameOriginError(baseUrl, url, res.status())) return
    summary.badResponses.push({ url, status: res.status() })
  })
}

export async function captureFailure(page, outputDir, label = 'failure') {
  await page.screenshot({ path: path.join(outputDir, `${label}.png`), fullPage: true }).catch(() => {})
}

export async function apiJson({ baseUrl = resolveBaseUrl(), accessKey, method = 'GET', pathName, body }) {
  const url = new URL(`/api${pathName}`, baseUrl)
  const headers = {}
  if (accessKey) headers['X-Access-Key'] = accessKey
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const raw = await response.text()
  let parsed = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
  }

  if (!response.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
    throw new Error(`${method} ${pathName} failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`)
  }

  return parsed
}
