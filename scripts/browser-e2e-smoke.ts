import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const ROOT = process.cwd()
const DEFAULT_ACCESS_KEY = 'swarmclaw-e2e-access-key'
const DEFAULT_CREDENTIAL_SECRET = 'swarmclaw-e2e-credential-secret'
const HEALTH_TIMEOUT_MS = 90_000
const DEFAULT_PAGE_TIMEOUT_MS = 240_000
const PAGE_TIMEOUT_MS = readPositiveInt(process.env.SWARMCLAW_E2E_PAGE_TIMEOUT_MS) ?? DEFAULT_PAGE_TIMEOUT_MS

interface StartedServer {
  baseUrl: string
  child: ChildProcessWithoutNullStreams
  tempDir: string
  logs: string[]
}

interface AuthSession {
  accessKey: string
  cookieHeader: string
}

interface WorkflowPlanSmokeResponse {
  bundle?: Record<string, unknown>
}

interface WorkflowBundleSmokeResponse {
  run?: {
    id?: unknown
  }
  taskIds?: unknown[]
}

function authHeaders(auth: AuthSession, contentType = true): Record<string, string> {
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    'X-Access-Key': auth.accessKey,
    ...(auth.cookieHeader ? { Cookie: auth.cookieHeader } : {}),
  }
}

function printHelp(): void {
  console.log(`SwarmClaw browser smoke runner

Usage:
  npm run test:e2e

Environment:
  SWARMCLAW_E2E_BASE_URL    Test an already-running SwarmClaw instance.
  PLAYWRIGHT_BASE_URL       Alias for SWARMCLAW_E2E_BASE_URL.
  SWARMCLAW_E2E_ACCESS_KEY  Access key for the tested instance.
  SWARMCLAW_E2E_PORT        Port to use when starting a local dev server.

Without a base URL the runner starts a local Next.js dev server with isolated
DATA_DIR, WORKSPACE_DIR, and browser profile directories.`)
}

function readEnvFileKey(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const equalsIndex = line.indexOf('=')
    if (equalsIndex <= 0) continue
    const name = line.slice(0, equalsIndex).trim()
    if (name !== key) continue
    const rawValue = line.slice(equalsIndex + 1).trim()
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      return rawValue.slice(1, -1)
    }
    return rawValue
  }
  return null
}

function readPositiveInt(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function resolveAccessKey(): string {
  return process.env.SWARMCLAW_E2E_ACCESS_KEY
    || process.env.ACCESS_KEY
    || readEnvFileKey(path.join(ROOT, '.env.local'), 'ACCESS_KEY')
    || DEFAULT_ACCESS_KEY
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findFreePort(): Promise<number> {
  const requested = Number.parseInt(process.env.SWARMCLAW_E2E_PORT || '', 10)
  if (Number.isFinite(requested) && requested > 0) return requested

  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port)
        else reject(new Error('Could not allocate a free port'))
      })
    })
  })
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHealth(baseUrl: string, logs?: string[]): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(new URL('/api/healthz', baseUrl).toString(), {}, 5_000)
      if (res.ok) {
        const payload = await res.json().catch(() => null) as { ok?: unknown } | null
        if (payload?.ok === true) return
      }
    } catch (err) {
      lastError = err
    }
    await wait(1_000)
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'timed out')
  const tail = logs?.slice(-40).join('\n')
  throw new Error(`Timed out waiting for ${baseUrl}/api/healthz: ${detail}${tail ? `\n\nServer log tail:\n${tail}` : ''}`)
}

async function startLocalServer(): Promise<StartedServer> {
  let port: number
  try {
    port = await findFreePort()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not allocate a local port for the e2e dev server: ${message}. `
      + 'Set SWARMCLAW_E2E_BASE_URL to smoke-test an already-running instance.',
    )
  }
  const baseUrl = `http://127.0.0.1:${port}`
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-e2e-'))
  const logs: string[] = []
  const nextBin = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')

  for (const dir of ['data', 'workspace', 'browser-profiles', 'home']) {
    fs.mkdirSync(path.join(tempDir, dir), { recursive: true })
  }

  const env = {
    ...process.env,
    ACCESS_KEY: resolveAccessKey(),
    BROWSER_PROFILES_DIR: path.join(tempDir, 'browser-profiles'),
    CREDENTIAL_SECRET: process.env.CREDENTIAL_SECRET || DEFAULT_CREDENTIAL_SECRET,
    DATA_DIR: path.join(tempDir, 'data'),
    NEXT_TELEMETRY_DISABLED: '1',
    SWARMCLAW_DAEMON_AUTOSTART: '0',
    SWARMCLAW_HOME: path.join(tempDir, 'home'),
    WORKSPACE_DIR: path.join(tempDir, 'workspace'),
  }

  const child = spawn(process.execPath, [nextBin, 'dev', '--webpack', '--hostname', '127.0.0.1', '-p', String(port)], {
    cwd: ROOT,
    env,
  })

  const record = (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      logs.push(line)
      if (logs.length > 200) logs.shift()
    }
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)

  try {
    await waitForHealth(baseUrl, logs)
    return { baseUrl, child, tempDir, logs }
  } catch (err) {
    child.kill('SIGTERM')
    fs.rmSync(tempDir, { recursive: true, force: true })
    throw err
  }
}

function cookieHeaderFromSetCookie(setCookie: string | null): string {
  if (!setCookie) return ''
  return setCookie
    .split(',')
    .map((part) => part.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ')
}

async function authenticate(baseUrl: string): Promise<AuthSession> {
  let accessKey = resolveAccessKey()
  const authUrl = new URL('/api/auth', baseUrl).toString()
  const initial = await fetchWithTimeout(authUrl, {}, 10_000)
  const initialPayload = await initial.json().catch(() => null) as { firstTime?: boolean; generatedKey?: string } | null

  let response = await fetchWithTimeout(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: accessKey }),
  }, 10_000)

  if (!response.ok && initialPayload?.firstTime && initialPayload.generatedKey) {
    accessKey = initialPayload.generatedKey
    response = await fetchWithTimeout(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: accessKey }),
    }, 10_000)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Could not authenticate e2e browser session (${response.status}). `
      + `Set SWARMCLAW_E2E_ACCESS_KEY for live targets. ${body}`.trim(),
    )
  }

  const cookieHeader = cookieHeaderFromSetCookie(response.headers.get('set-cookie'))

  await fetchWithTimeout(new URL('/api/settings', baseUrl).toString(), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': accessKey,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({ setupCompleted: true, userName: 'E2E Operator' }),
  }, 10_000)

  return { accessKey, cookieHeader }
}

async function createContext(browser: Browser, baseUrl: string, auth: AuthSession): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: baseUrl })
  const scAuth = auth.cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('sc_auth='))
  if (scAuth) {
    const value = scAuth.slice('sc_auth='.length)
    await context.addCookies([{
      name: 'sc_auth',
      value,
      domain: new URL(baseUrl).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: new URL(baseUrl).protocol === 'https:',
    }])
  }
  await context.addInitScript((key) => {
    window.localStorage.setItem('sc_access_key', key)
    window.localStorage.setItem('sc_user', 'E2E Operator')
    window.localStorage.setItem('sc_setup_done', '1')
  }, auth.accessKey)
  return context
}

async function expectHealth(baseUrl: string): Promise<void> {
  const res = await fetchWithTimeout(new URL('/api/healthz', baseUrl).toString(), {}, 10_000)
  if (!res.ok) throw new Error(`/api/healthz returned ${res.status}`)
  const payload = await res.json().catch(() => null) as { ok?: unknown; service?: unknown } | null
  if (payload?.ok !== true || payload.service !== 'swarmclaw') {
    throw new Error(`/api/healthz returned an unexpected payload: ${JSON.stringify(payload)}`)
  }
}

async function expectAgentCard(baseUrl: string): Promise<void> {
  const res = await fetchWithTimeout(new URL('/.well-known/agent-card.json', baseUrl).toString(), {}, 10_000)
  if (!res.ok) throw new Error(`/.well-known/agent-card.json returned ${res.status}`)
  const payload = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!payload || payload.protocolVersion !== '0.3.0' || payload.kind !== 'directory') {
    throw new Error(`Agent card discovery returned an unexpected payload: ${JSON.stringify(payload)}`)
  }
}

async function waitForPageText(page: Page, url: string, options: { anyText: string[] }): Promise<void> {
  await page.goto(url, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS })
  await page.waitForSelector('body', { timeout: PAGE_TIMEOUT_MS })
  await page.waitForFunction(
    (needles) => {
      const text = (document.body?.innerText || '').toLowerCase()
      return needles.some((needle) => text.includes(needle.toLowerCase()))
    },
    options.anyText,
    { timeout: PAGE_TIMEOUT_MS },
  )
}

async function smokeStep(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`${label}: ${message}`)
  }
}

async function runBrowserSmoke(baseUrl: string): Promise<void> {
  await expectHealth(baseUrl)
  await expectAgentCard(baseUrl)

  const auth = await authenticate(baseUrl)
  const browser = await chromium.launch({ headless: true })
  const pageErrors: string[] = []

  try {
    const context = await createContext(browser, baseUrl, auth)
    const newSmokePage = async () => {
      const nextPage = await context.newPage()
      nextPage.on('pageerror', (err) => pageErrors.push(err.message))
      return nextPage
    }

    let page = await newSmokePage()
    await smokeStep('home page loads', () => waitForPageText(page, '/home', {
      anyText: ['Launchpad', 'SwarmClaw', 'Pick a path'],
    }))
    await page.close()

    page = await newSmokePage()
    await smokeStep('quality overview loads', () => waitForPageText(page, '/quality', {
      anyText: ['Quality', 'Operator Quality Center', 'Eval Lab', 'Approval Desk'],
    }))
    await smokeStep('quality release readiness panel renders', () => page.waitForFunction(() => {
      const text = (document.body?.innerText || '').toLowerCase()
      return text.includes('release readiness') && text.includes('ship gate report')
    }, { timeout: PAGE_TIMEOUT_MS }))
    await smokeStep('quality architecture health panel renders', () => page.waitForFunction(() => {
      const text = (document.body?.innerText || '').toLowerCase()
      return text.includes('architecture health') && text.includes('runtime ownership map')
    }, { timeout: PAGE_TIMEOUT_MS }))
    await page.close()

    page = await newSmokePage()
    await smokeStep('eval lab tab loads', () => waitForPageText(page, '/quality?tab=evals', {
      anyText: ['Eval Lab'],
    }))
    await smokeStep('eval readiness panels render', () => page.waitForFunction(() => {
      const text = document.body?.innerText || ''
      return text.includes('Validation environment') && text.includes('Regression gate')
    }, { timeout: PAGE_TIMEOUT_MS }))
    await page.close()

    page = await newSmokePage()
    await smokeStep('built-in protocol builder visual flow loads', async () => {
      await waitForPageText(page, '/protocols/builder/facilitated_discussion', {
        anyText: ['Facilitated Discussion', 'Built-in template'],
      })
      await page.waitForFunction(() => {
        const flow = document.querySelector('.react-flow')
        const flowRect = flow?.getBoundingClientRect()
        const visibleNodes = Array.from(document.querySelectorAll('.react-flow__node'))
          .filter((node) => {
            const rect = node.getBoundingClientRect()
            return rect.width > 40 && rect.height > 20
          })
        const text = document.body?.innerText || ''
        return Boolean(
          flowRect
          && flowRect.width > 320
          && flowRect.height > 240
          && visibleNodes.length >= 3
          && !text.includes('No visual steps'),
        )
      }, { timeout: PAGE_TIMEOUT_MS })
    })
    await page.close()

    const workflowPlanRes = await fetchWithTimeout(new URL('/api/workflows/plans', baseUrl).toString(), {
      method: 'POST',
      headers: authHeaders(auth),
      body: JSON.stringify({
        title: 'E2E workflow bundle smoke',
        goal: 'Verify Workflow Bundles renders draft-safe controls and selected ledger without queueing work.',
        allowedScopes: ['docs/operations/'],
        loopSpec: {
          invariant: 'E2E workflow smoke remains read-only and backlog-only.',
          progressSignal: 'Workflow panel and selected ledger render in the browser.',
          stuckSignal: 'Workflow controls or selected ledger fail to render.',
        },
      }),
    }, 10_000)
    if (!workflowPlanRes.ok) {
      throw new Error(`Could not draft workflow smoke plan: ${workflowPlanRes.status} ${await workflowPlanRes.text().catch(() => '')}`)
    }
    const workflowPlan = await workflowPlanRes.json().catch(() => null) as WorkflowPlanSmokeResponse | null
    if (!workflowPlan?.bundle || typeof workflowPlan.bundle !== 'object') {
      throw new Error(`Workflow smoke plan returned an unexpected payload: ${JSON.stringify(workflowPlan)}`)
    }

    const workflowBundleRes = await fetchWithTimeout(new URL('/api/workflows/bundles', baseUrl).toString(), {
      method: 'POST',
      headers: authHeaders(auth),
      body: JSON.stringify(workflowPlan.bundle),
    }, 10_000)
    if (!workflowBundleRes.ok) {
      throw new Error(`Could not create workflow smoke bundle: ${workflowBundleRes.status} ${await workflowBundleRes.text().catch(() => '')}`)
    }
    const workflowBundle = await workflowBundleRes.json().catch(() => null) as WorkflowBundleSmokeResponse | null
    const workflowRunId = typeof workflowBundle?.run?.id === 'string' ? workflowBundle.run.id : ''
    if (!workflowRunId || !Array.isArray(workflowBundle?.taskIds) || workflowBundle.taskIds.length < 1) {
      throw new Error(`Workflow smoke bundle returned an unexpected payload: ${JSON.stringify(workflowBundle)}`)
    }

    page = await newSmokePage()
    await smokeStep('workflow bundles panel renders selected ledger', async () => {
      await waitForPageText(page, `/protocols?runId=${encodeURIComponent(workflowRunId)}`, {
        anyText: ['Workflow Bundles', 'Selected Run Ledger'],
      })
      await page.waitForFunction(() => {
        const text = document.body?.innerText || ''
        const lowerText = text.toLowerCase()
        const draftButton = document.querySelector('[data-testid="workflow-draft-plan"]') as HTMLButtonElement | null
        const createBacklogButton = document.querySelector('[data-testid="workflow-create-backlog"]') as HTMLButtonElement | null
        const continueButton = document.querySelector('[data-testid="workflow-continue-selected-run"]') as HTMLButtonElement | null
        const continueUntilDone = document.querySelector('[data-testid="workflow-continue-until-done"]') as HTMLInputElement | null
        const autoCreateBacklog = document.querySelector('[data-testid="workflow-auto-create-safe-backlog"]') as HTMLInputElement | null
        return Boolean(
          lowerText.includes('workflow bundles')
          && lowerText.includes('selected run ledger')
          && text.includes('E2E workflow smoke remains read-only and backlog-only.')
          && text.includes('3 tasks · 0 done')
          && draftButton?.disabled === true
          && createBacklogButton?.disabled === true
          && continueButton
          && continueUntilDone
          && autoCreateBacklog?.disabled === true,
        )
      }, { timeout: PAGE_TIMEOUT_MS })
    })
    await page.close()

    page = await newSmokePage()
    await smokeStep('schedule history tab is available', async () => {
      await waitForPageText(page, '/schedules', { anyText: ['Schedule Console', 'SCHEDULE CONSOLE'] })
      await page.waitForFunction(() => {
        const text = (document.body?.innerText || '').toLowerCase()
        return text.includes('schedule console') && text.includes('history')
      }, { timeout: PAGE_TIMEOUT_MS })
    })
    await page.close()

    const taskRes = await fetchWithTimeout(new URL('/api/tasks', baseUrl).toString(), {
      method: 'POST',
      headers: authHeaders(auth),
      body: JSON.stringify({
        title: 'E2E task workspace',
        description: 'Verify task-scoped workspace and preview metadata render in the task board.',
        provisionWorkspace: true,
        previewLinks: [{ label: 'Local preview', url: `${baseUrl}/tasks`, kind: 'web' }],
        runtimeServices: [{ name: 'Task board', status: 'running', url: `${baseUrl}/tasks` }],
      }),
    }, 10_000)
    if (!taskRes.ok) {
      throw new Error(`Could not create task workspace smoke record: ${taskRes.status} ${await taskRes.text().catch(() => '')}`)
    }

    const chatRes = await fetchWithTimeout(new URL('/api/chats', baseUrl).toString(), {
      method: 'POST',
      headers: authHeaders(auth),
      body: JSON.stringify({
        name: 'E2E context pack',
        provider: 'claude-cli',
        model: 'sonnet',
        messages: [
          { role: 'user', text: 'Prepare a handoff pack.', time: Date.now(), attachedFiles: ['/tmp/e2e-context.md'] },
          { role: 'assistant', text: 'The handoff pack is ready.', time: Date.now() + 1 },
        ],
      }),
    }, 10_000)
    if (!chatRes.ok) {
      throw new Error(`Could not create context pack smoke chat: ${chatRes.status} ${await chatRes.text().catch(() => '')}`)
    }
    const chatPayload = await chatRes.json().catch(() => null) as { id?: unknown } | null
    if (typeof chatPayload?.id !== 'string' || !chatPayload.id) {
      throw new Error(`Context pack smoke chat returned an unexpected payload: ${JSON.stringify(chatPayload)}`)
    }

    const contextPackRes = await fetchWithTimeout(new URL(`/api/chats/${chatPayload.id}/context-pack`, baseUrl).toString(), {
      headers: authHeaders(auth),
    }, 10_000)
    if (!contextPackRes.ok) {
      throw new Error(`Context pack JSON route returned ${contextPackRes.status}: ${await contextPackRes.text().catch(() => '')}`)
    }
    const contextPack = await contextPackRes.json().catch(() => null) as { schemaVersion?: unknown; session?: { id?: unknown }; recentMessages?: unknown[] } | null
    if (contextPack?.schemaVersion !== 1 || contextPack.session?.id !== chatPayload.id || !Array.isArray(contextPack.recentMessages)) {
      throw new Error(`Context pack JSON returned an unexpected payload: ${JSON.stringify(contextPack)}`)
    }

    const contextPackMarkdownRes = await fetchWithTimeout(new URL(`/api/chats/${chatPayload.id}/context-pack?format=markdown`, baseUrl).toString(), {
      headers: authHeaders(auth),
    }, 10_000)
    if (!contextPackMarkdownRes.ok) {
      throw new Error(`Context pack markdown route returned ${contextPackMarkdownRes.status}: ${await contextPackMarkdownRes.text().catch(() => '')}`)
    }
    const contextPackMarkdown = await contextPackMarkdownRes.text()
    if (!contextPackMarkdown.includes('# Session Context Pack: E2E context pack') || !contextPackMarkdown.includes('Recent Turns')) {
      throw new Error(`Context pack markdown returned an unexpected body: ${contextPackMarkdown.slice(0, 240)}`)
    }

    page = await newSmokePage()
    await smokeStep('task board shows created workspace task', () => waitForPageText(page, '/tasks?taskView=all', {
      anyText: ['E2E task workspace'],
    }))
    await smokeStep('task workspace metadata renders', () => page.waitForFunction(() => {
      const text = document.body?.innerText || ''
      return text.includes('E2E task workspace') && text.includes('workspace') && text.includes('ready')
    }, { timeout: PAGE_TIMEOUT_MS }))
    await page.close()

    if (pageErrors.length > 0) {
      throw new Error(`Browser page errors:\n${pageErrors.join('\n')}`)
    }

    await context.close()
  } finally {
    await browser.close()
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp()
    return
  }

  let localServer: StartedServer | null = null
  const externalBaseUrl = process.env.SWARMCLAW_E2E_BASE_URL || process.env.PLAYWRIGHT_BASE_URL
  let baseUrl = externalBaseUrl ? externalBaseUrl.replace(/\/+$/, '') : ''
  if (!baseUrl) {
    localServer = await startLocalServer()
    baseUrl = localServer.baseUrl
  }

  const stop = () => {
    if (!localServer) return
    localServer.child.kill('SIGTERM')
    fs.rmSync(localServer.tempDir, { recursive: true, force: true })
  }

  process.once('SIGINT', () => {
    stop()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    stop()
    process.exit(143)
  })

  try {
    console.log(`Running browser smoke against ${baseUrl}`)
    await runBrowserSmoke(baseUrl)
    console.log('Browser smoke passed')
  } finally {
    stop()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
