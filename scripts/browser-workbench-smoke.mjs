#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import {
  apiJson,
  attachPageDiagnostics,
  captureFailure,
  createArtifactDir,
  createBrowserContext,
  maybeAuthenticate,
  readAccessKey,
  resolveBaseUrl,
  uniqueId,
} from './browser-smoke-lib.mjs'

const BASE_URL = resolveBaseUrl()
const OUTPUT_DIR = createArtifactDir('browser-workbench-smoke')

function buildSeededMessages(agentName) {
  const now = Date.now()
  return [
    {
      role: 'user',
      text: 'Show me the latest workbench check and capture the tool activity.',
      time: now - 90_000,
    },
    {
      role: 'assistant',
      text: `I reviewed the latest ${agentName} workbench run and kept the tool details below for inspection.`,
      time: now - 80_000,
      kind: 'chat',
      toolEvents: [
        {
          name: 'browser',
          input: JSON.stringify({ action: 'navigate', url: 'https://example.com/workbench' }),
          output: JSON.stringify({ ok: true, title: 'Example Workbench', status: 'ready' }),
        },
        {
          name: 'read_file',
          input: JSON.stringify({ filePath: 'artifacts/workbench-summary.txt' }),
          output: 'stability: good\nrendering: steady\ntool-calls: visible',
        },
      ],
    },
    {
      role: 'assistant',
      text: 'The transcript is ready for screenshot capture and browser assertions.',
      time: now - 70_000,
      kind: 'chat',
    },
  ]
}

async function createWorkbenchFixture(baseUrl, accessKey) {
  const agentName = `Browser Smoke Agent ${Date.now().toString().slice(-6)}`
  const agent = await apiJson({
    baseUrl,
    accessKey,
    method: 'POST',
    pathName: '/agents',
    body: {
      name: agentName,
      description: 'Temporary browser smoke fixture',
      systemPrompt: 'You are a temporary browser smoke fixture.',
      provider: 'claude-cli',
      model: '',
      tools: ['files', 'browser'],
    },
  })

  const session = await apiJson({
    baseUrl,
    accessKey,
    method: 'POST',
    pathName: '/chats',
    body: {
      id: uniqueId(`agent-chat-${agent.id}`),
      name: `agent-thread:${agent.id}`,
      user: 'browser-smoke',
      agentId: agent.id,
      messages: buildSeededMessages(agent.name),
      plugins: ['files', 'browser'],
    },
  })

  return { agent, session }
}

async function cleanupWorkbenchFixture(baseUrl, accessKey, fixture) {
  if (!fixture) return
  if (fixture.session?.id) {
    await apiJson({
      baseUrl,
      accessKey,
      method: 'DELETE',
      pathName: `/chats/${fixture.session.id}`,
    }).catch(() => {})
  }
  if (fixture.agent?.id) {
    await apiJson({
      baseUrl,
      accessKey,
      method: 'DELETE',
      pathName: `/agents/${fixture.agent.id}`,
    }).catch(() => {})
  }
}

async function screenshotLocator(locator, fileName) {
  const outputPath = path.join(OUTPUT_DIR, fileName)
  await locator.screenshot({ path: outputPath })
  return outputPath
}

const summary = {
  ok: false,
  baseUrl: BASE_URL,
  fixture: null,
  flows: [],
  screenshots: {},
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  badResponses: [],
}

const accessKey = readAccessKey()
const browser = await chromium.launch({ headless: true })
const context = await createBrowserContext(browser, accessKey)
const page = await context.newPage()
attachPageDiagnostics(page, summary, BASE_URL)

let fixture = null
let interceptedBodies = 0

try {
  fixture = await createWorkbenchFixture(BASE_URL, accessKey)
  summary.fixture = {
    agentId: fixture.agent.id,
    sessionId: fixture.session.id,
  }

  await page.route(`**/api/chats/${fixture.session.id}/chat`, async (route) => {
    interceptedBodies += 1
    const body = route.request().postDataJSON?.() || {}
    summary.lastInterceptedMessage = body.message || ''

    const sse = [
      { t: 'md', text: JSON.stringify({ run: { id: 'browser-smoke-run', status: 'queued', position: 0 } }) },
      { t: 'tool_call', toolName: 'browser', toolInput: JSON.stringify({ action: 'navigate', url: 'https://example.com/dashboard' }) },
      { t: 'tool_result', toolName: 'browser', toolOutput: JSON.stringify({ ok: true, title: 'Example Dashboard', captured: true }) },
      { t: 'tool_call', toolName: 'read_file', toolInput: JSON.stringify({ filePath: 'artifacts/workbench-run.txt' }) },
      { t: 'tool_result', toolName: 'read_file', toolOutput: 'browser workbench smoke\nresult: deterministic reply\nstatus: passed' },
      { t: 'd', text: 'I replayed the browser workbench flow, verified the tool cards, and captured the transcript for inspection.' },
      { t: 'done' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')

    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
      body: sse,
    })
  })

  await page.goto(new URL('/agents', BASE_URL).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await maybeAuthenticate(page, accessKey)
  await page.waitForSelector(`[data-testid="agent-row"][data-agent-id="${fixture.agent.id}"]`, { timeout: 20_000 })

  summary.flows.push({ name: 'open-agents-view', ok: true })

  await page.locator(`[data-testid="agent-row"][data-agent-id="${fixture.agent.id}"]`).click()
  await page.waitForSelector('[data-testid="chat-area"]', { timeout: 20_000 })
  await page.waitForSelector('[data-testid="chat-thread"] [data-testid="message-bubble"][data-message-role="assistant"]', { timeout: 20_000 })

  summary.screenshots.threadInitial = await screenshotLocator(page.locator('[data-testid="chat-thread"]'), 'thread-initial.png')
  summary.flows.push({ name: 'open-agent-chat', ok: true })

  const assistantMessages = page.locator('[data-testid="message-bubble"][data-message-role="assistant"]')
  const initialAssistantCount = await assistantMessages.count()

  await page.locator('[data-testid="chat-input"]').fill('Run the browser workbench smoke flow and summarize the result.')
  await page.locator('[data-testid="chat-send"]').click()

  await page.waitForFunction(
    (beforeCount) => document.querySelectorAll('[data-testid="message-bubble"][data-message-role="assistant"]').length > beforeCount,
    initialAssistantCount,
    { timeout: 20_000 },
  )
  await page.waitForSelector('[data-testid="tool-call-card"]', { timeout: 20_000 })

  summary.screenshots.threadAfterSend = await screenshotLocator(page.locator('[data-testid="chat-thread"]'), 'thread-after-send.png')
  summary.screenshots.toolCalls = await screenshotLocator(page.locator('[data-testid="message-tool-events"]').last(), 'tool-calls.png')
  summary.flows.push({ name: 'send-message-and-render-tool-calls', ok: interceptedBodies > 0 })

  summary.ok =
    summary.flows.every((flow) => flow.ok)
    && summary.consoleErrors.length === 0
    && summary.pageErrors.length === 0
    && summary.requestFailures.length === 0
    && summary.badResponses.length === 0
} catch (error) {
  summary.ok = false
  summary.error = error instanceof Error ? error.message : String(error)
  summary.failureUrl = page.url()
  summary.failureText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000)
  await captureFailure(page, OUTPUT_DIR, 'workbench-failure')
  throw error
} finally {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  await cleanupWorkbenchFixture(BASE_URL, accessKey, fixture)
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}

console.log(JSON.stringify(summary, null, 2))
