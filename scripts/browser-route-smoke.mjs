#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.env.SWARMCLAW_URL || process.env.SWARMCLAW_BASE_URL || 'http://127.0.0.1:3456'
const OUTPUT_DIR = path.join(process.cwd(), '.tmp-smoke-artifacts', 'browser-route-smoke')
const ROUTES = (
  process.env.SWARMCLAW_BROWSER_SMOKE_ROUTES
    ? process.env.SWARMCLAW_BROWSER_SMOKE_ROUTES.split(',').map((entry) => entry.trim()).filter(Boolean)
    : ['/', '/agents', '/plugins', '/connectors', '/tasks', '/skills', '/mcp-servers', '/webhooks']
)

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readAccessKey() {
  if (process.env.SWARMCLAW_ACCESS_KEY?.trim()) return process.env.SWARMCLAW_ACCESS_KEY.trim()
  const envPath = path.join(process.cwd(), '.env.local')
  const envText = fs.readFileSync(envPath, 'utf8')
  const match = envText.match(/^ACCESS_KEY=(.+)$/m)
  if (!match) throw new Error('Access key missing. Set SWARMCLAW_ACCESS_KEY or add ACCESS_KEY to .env.local.')
  const key = match[1].trim()
  if (!key) throw new Error('ACCESS_KEY is empty in .env.local.')
  return key
}

async function maybeAuthenticate(page, accessKey) {
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

ensureDir(OUTPUT_DIR)

const accessKey = readAccessKey()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
await context.addInitScript((key) => {
  window.localStorage.setItem('sc_access_key', key)
}, accessKey)

const page = await context.newPage()
const consoleErrors = []
const pageErrors = []
const requestFailures = []
const badResponses = []
const routes = []

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push({ url: page.url(), text: msg.text() })
})
page.on('pageerror', (error) => {
  pageErrors.push({ url: page.url(), message: error.message })
})
page.on('requestfailed', (req) => {
  const url = req.url()
  if (!isInterestingSameOriginFailure(BASE_URL, url)) return
  requestFailures.push({
    url,
    method: req.method(),
    error: req.failure()?.errorText || 'request failed',
  })
})
page.on('response', (res) => {
  const url = res.url()
  if (!isInterestingSameOriginError(BASE_URL, url, res.status())) return
  badResponses.push({ url, status: res.status() })
})

const summary = {
  ok: false,
  baseUrl: BASE_URL,
  routes,
  consoleErrors,
  pageErrors,
  requestFailures,
  badResponses,
}

try {
  for (const route of ROUTES) {
    const url = new URL(route, BASE_URL).toString()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await maybeAuthenticate(page, accessKey)
    await page.waitForTimeout(1200)

    const bodyText = await page.locator('body').innerText().catch(() => '')
    const failed =
      /Something went wrong/i.test(bodyText)
      || /Application error/i.test(bodyText)
      || /Unhandled Runtime Error/i.test(bodyText)

    routes.push({
      route,
      url: page.url(),
      title: await page.title(),
      failed,
    })

    if (failed) {
      throw new Error(`Route ${route} rendered an error boundary or application error.`)
    }
  }

  summary.ok =
    consoleErrors.length === 0
    && pageErrors.length === 0
    && requestFailures.length === 0
    && badResponses.length === 0
    && routes.every((route) => route.failed === false)
} catch (error) {
  summary.ok = false
  summary.error = error instanceof Error ? error.message : String(error)
  summary.failureUrl = page.url()
  summary.failureText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000)
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}

console.log(JSON.stringify(summary, null, 2))
