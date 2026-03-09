#!/usr/bin/env node

import { chromium } from 'playwright'
import {
  attachPageDiagnostics,
  captureFailure,
  createArtifactDir,
  createBrowserContext,
  maybeAuthenticate,
  readAccessKey,
  resolveBaseUrl,
} from './browser-smoke-lib.mjs'

const BASE_URL = resolveBaseUrl()
const OUTPUT_DIR = createArtifactDir('browser-route-smoke')
const ROUTE_TIMEOUT_MS = Number.parseInt(process.env.SWARMCLAW_BROWSER_SMOKE_TIMEOUT_MS || '45000', 10)
const ROUTES = (
  process.env.SWARMCLAW_BROWSER_SMOKE_ROUTES
    ? process.env.SWARMCLAW_BROWSER_SMOKE_ROUTES.split(',').map((entry) => entry.trim()).filter(Boolean)
    : ['/', '/agents', '/plugins', '/connectors', '/tasks', '/skills', '/mcp-servers', '/webhooks']
)

const accessKey = readAccessKey()
const browser = await chromium.launch({ headless: true })
const context = await createBrowserContext(browser, accessKey)
const page = await context.newPage()
const routes = []

const summary = {
  ok: false,
  baseUrl: BASE_URL,
  routes,
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  badResponses: [],
}
attachPageDiagnostics(page, summary, BASE_URL)

async function gotoRoute(url) {
  const target = new URL(url)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ROUTE_TIMEOUT_MS })
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/ERR_ABORTED/i.test(message)) throw error
    await page.waitForURL((currentUrl) => currentUrl.pathname === target.pathname, { timeout: Math.min(10_000, ROUTE_TIMEOUT_MS) }).catch(() => {})
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(10_000, ROUTE_TIMEOUT_MS) }).catch(() => {})
    const landedOnRoute = await page.evaluate((expectedPathname) => {
      return window.location.pathname === expectedPathname && document.readyState !== 'loading'
    }, target.pathname).catch(() => false)
    if (!landedOnRoute) throw error
  }
}

try {
  for (const route of ROUTES) {
    const url = new URL(route, BASE_URL).toString()
    await gotoRoute(url)
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
    summary.consoleErrors.length === 0
    && summary.pageErrors.length === 0
    && summary.requestFailures.length === 0
    && summary.badResponses.length === 0
    && routes.every((route) => route.failed === false)
} catch (error) {
  summary.ok = false
  summary.error = error instanceof Error ? error.message : String(error)
  summary.failureUrl = page.url()
  summary.failureText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000)
  await captureFailure(page, OUTPUT_DIR)
  throw error
} finally {
  const fs = await import('node:fs')
  const path = await import('node:path')
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}

console.log(JSON.stringify(summary, null, 2))
