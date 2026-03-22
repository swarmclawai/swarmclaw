import fs from 'node:fs'
import http, { type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { genId } from '@/lib/id'
import type { ApprovalRequest, MessageToolEvent, Session } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { submitDecision } from '../approvals'
import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution'
import { executeExecutionChatTurn } from '@/lib/server/execution-engine/chat-turn'
import { WORKSPACE_DIR } from '../data-dir'
import { getExtensionManager } from '../extensions'
import { sendMailboxEnvelope, listMailbox } from '@/lib/server/chatrooms/session-mailbox'
import { canonicalizeExtensionId, expandExtensionIds } from '../tool-aliases'
import { processDueWatchJobs } from '@/lib/server/runtime/watch-jobs'
import {
  deleteApproval,
  deleteBrowserSession,
  deleteDelegationJob,
  deleteWatchJob,
  decryptKey,
  loadAgents,
  loadApprovals,
  loadDelegationJobs,
  loadSchedules,
  loadSecrets,
  loadSessions,
  loadSettings,
  loadTasks,
  loadWatchJobs,
  saveSchedules,
  saveAgents,
  saveSecrets,
  saveSessions,
  saveSettings,
  saveTasks,
} from '../storage'

export type RegressionApprovalMode = 'manual' | 'auto' | 'off'
export type RegressionExtensionMode = 'scenario' | 'agent'

export interface RegressionAssertion {
  name: string
  passed: boolean
  details?: string
  weight?: number
}

export interface AgentRegressionScenarioResult {
  scenarioId: string
  name: string
  approvalMode: RegressionApprovalMode
  extensionMode: RegressionExtensionMode
  status: 'passed' | 'failed'
  score: number
  maxScore: number
  assertions: RegressionAssertion[]
  sessionId: string
  workspaceDir: string
  requiredExtensions: string[]
  effectiveExtensions: string[]
  missingExtensions: string[]
  toolNames: string[]
  approvalIds: string[]
  approvals: RegressionApprovalEvidence[]
  responseTexts: string[]
  turns: RegressionTurnEvidence[]
  artifacts: RegressionArtifactEvidence[]
  evidencePaths: {
    transcript: string
    approvals: string
    workspace: string
  }
}

export interface AgentRegressionSuiteResult {
  id: string
  agentId: string
  approvalModes: RegressionApprovalMode[]
  startedAt: number
  endedAt: number
  score: number
  maxScore: number
  scenarios: AgentRegressionScenarioResult[]
  resultsPath: string
}

interface ScenarioContext {
  suiteId: string
  agentId: string
  agent: Record<string, unknown>
  approvalMode: RegressionApprovalMode
  extensionMode: RegressionExtensionMode
  sessionId: string
  workspaceDir: string
  requiredExtensions: string[]
  effectiveExtensions: string[]
  missingExtensions: string[]
  responseTexts: string[]
  toolEvents: MessageToolEvent[]
  toolNames: Set<string>
  turns: RegressionTurnEvidence[]
}

interface AgentRegressionScenarioDefinition {
  id: string
  name: string
  extensions: string[]
  defaultInSuite?: boolean
  run: (ctx: ScenarioContext) => Promise<AgentRegressionScenarioResult>
}

interface RegressionExtensionResolution {
  requiredExtensions: string[]
  effectiveExtensions: string[]
  missingExtensions: string[]
}

interface MockMailAccount {
  email: string
  chosenPassword: string
  appPassword: string
  inviteCode: string
}

interface MockSocialAccount {
  email: string
  handle: string
  password: string
  inviteCode: string
}

interface MockVerifiedSignup {
  token: string
  email: string
  handle: string
  password: string
  verificationCode: string
  recoveryToken: string
  verified: boolean
}

interface MockSignupHarness {
  baseUrl: string
  close: () => Promise<void>
  state: {
    mailAccounts: Map<string, MockMailAccount>
    socialAccounts: Map<string, MockSocialAccount>
    pendingVerifiedSignups: Map<string, MockVerifiedSignup>
  }
}

interface MockSmtpMessage {
  mailFrom: string
  recipients: string[]
  data: string
}

interface MockSmtpHarness {
  port: number
  messages: MockSmtpMessage[]
  close: () => Promise<void>
}

interface MockResearchDeployHarness {
  baseUrl: string
  close: () => Promise<void>
  state: {
    deployments: Map<string, string>
  }
}

export interface RegressionToolEventEvidence {
  name: string
  input?: string
  output?: string
  error?: boolean | string
}

export interface RegressionTurnEvidence {
  prompt: string
  responseText: string
  toolEvents: RegressionToolEventEvidence[]
  approvalIds: string[]
}

export interface RegressionArtifactEvidence {
  relativePath: string
  exists: boolean
  size: number
  sha256?: string
  preview?: string
}

export interface RegressionApprovalEvidence {
  id: string
  category: string
  status: string
  title: string
  toolId: string | null
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function signupSeed(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8)
}

function htmlDocument(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${escapeHtml(title)}</title>`,
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <style>',
    '    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 40px; line-height: 1.5; }',
    '    form { display: grid; gap: 12px; max-width: 420px; }',
    '    label { display: grid; gap: 6px; font-weight: 600; }',
    '    input { padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; }',
    '    button, a.button { display: inline-flex; align-items: center; justify-content: center; padding: 10px 14px; border-radius: 8px; background: #0f172a; color: white; text-decoration: none; border: none; cursor: pointer; }',
    '    .card { max-width: 720px; padding: 24px; border: 1px solid #cbd5e1; border-radius: 16px; background: #fff; }',
    '    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
    '    .muted { color: #475569; }',
    '  </style>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n')
}

function sendHtml(res: ServerResponse, statusCode: number, title: string, body: string): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(htmlDocument(title, body))
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302
  res.setHeader('location', location)
  res.end()
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function startLocalHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.stack || error.message : String(error)
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(message)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock HTTP server failed to bind to a TCP port.')
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

async function closeServer(server: HttpServer | net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

async function startMockSignupHarness(): Promise<MockSignupHarness> {
  const state = {
    mailAccounts: new Map<string, MockMailAccount>(),
    socialAccounts: new Map<string, MockSocialAccount>(),
    pendingVerifiedSignups: new Map<string, MockVerifiedSignup>(),
  }

  const { server, baseUrl } = await startLocalHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', baseUrl)
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/') {
      return sendHtml(res, 200, 'Mock Services', `
        <div class="card">
          <h1>Mock External Services</h1>
          <p class="muted">Use these pages to test browser signup, secrets, and verification flows.</p>
          <p><a class="button" href="/mail/signup">Open MockMail signup</a></p>
          <p><a class="button" href="/verify-social/signup">Open Chirper verification signup</a></p>
        </div>
      `)
    }

    if (req.method === 'GET' && pathname === '/mail/signup') {
      const prefilledEmail = String(url.searchParams.get('email') || '').trim()
      return sendHtml(res, 200, 'MockMail Signup', `
        <div class="card">
          <h1>Create a MockMail account</h1>
          <p class="muted">This mock provider generates an app password and a social invite code after signup.</p>
          <form method="post" action="/mail/signup">
            <label>Email address
              <input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(prefilledEmail)}" required />
            </label>
            <label>Password
              <input id="password" name="password" type="password" autocomplete="new-password" value="TempMockMailPass!23" required />
            </label>
            <button id="submit" type="submit">Create MockMail account</button>
          </form>
        </div>
      `)
    }

    if (req.method === 'POST' && pathname === '/mail/signup') {
      const body = await readRequestBody(req)
      const form = new URLSearchParams(body)
      const email = String(form.get('email') || '').trim().toLowerCase()
      const chosenPassword = String(form.get('password') || '').trim()
      if (!email || !chosenPassword) {
        return sendHtml(res, 400, 'MockMail Signup Error', '<div class="card"><h1>Missing email or password</h1></div>')
      }
      const seed = signupSeed(email)
      state.mailAccounts.set(email, {
        email,
        chosenPassword,
        appPassword: `mockmail-app-${seed}`,
        inviteCode: `INV-${seed.slice(0, 6).toUpperCase()}`,
      })
      return redirect(res, `/mail/dashboard?email=${encodeURIComponent(email)}`)
    }

    if (req.method === 'GET' && pathname === '/mail/dashboard') {
      const email = String(url.searchParams.get('email') || '').trim().toLowerCase()
      const account = state.mailAccounts.get(email)
      if (!account) {
        return sendHtml(res, 404, 'MockMail Account Missing', '<div class="card"><h1>Account not found</h1></div>')
      }
      return sendHtml(res, 200, 'MockMail Dashboard', `
        <div class="card">
          <h1>MockMail account ready</h1>
          <p>Email: <span class="mono" id="mail-email">${escapeHtml(account.email)}</span></p>
          <p>App password: <span class="mono" id="app-password">${escapeHtml(account.appPassword)}</span></p>
          <p>Social invite code: <span class="mono" id="invite-code">${escapeHtml(account.inviteCode)}</span></p>
          <p class="muted">Use the invite code to create a Chirper account.</p>
          <p><a class="button" id="social-link" href="/social/signup?email=${encodeURIComponent(account.email)}&inviteCode=${encodeURIComponent(account.inviteCode)}">Create Chirper account</a></p>
        </div>
      `)
    }

    if (req.method === 'GET' && pathname === '/social/signup') {
      const email = String(url.searchParams.get('email') || '').trim()
      const inviteCode = String(url.searchParams.get('inviteCode') || '').trim()
      const handle = String(url.searchParams.get('handle') || 'northstar-operator').trim()
      return sendHtml(res, 200, 'Chirper Signup', `
        <div class="card">
          <h1>Create a Chirper account</h1>
          <form method="post" action="/social/signup">
            <label>Email address
              <input id="email" name="email" type="email" value="${escapeHtml(email)}" required />
            </label>
            <label>Handle
              <input id="handle" name="handle" type="text" value="${escapeHtml(handle)}" required />
            </label>
            <label>Password
              <input id="password" name="password" type="password" value="TempChirperPass!23" required />
            </label>
            <label>Invite code
              <input id="inviteCode" name="inviteCode" type="text" value="${escapeHtml(inviteCode)}" required />
            </label>
            <button id="submit" type="submit">Create Chirper account</button>
          </form>
        </div>
      `)
    }

    if (req.method === 'POST' && pathname === '/social/signup') {
      const body = await readRequestBody(req)
      const form = new URLSearchParams(body)
      const email = String(form.get('email') || '').trim().toLowerCase()
      const handle = String(form.get('handle') || '').trim()
      const password = String(form.get('password') || '').trim()
      const inviteCode = String(form.get('inviteCode') || '').trim()
      const mailAccount = state.mailAccounts.get(email)
      if (!mailAccount || inviteCode !== mailAccount.inviteCode || !handle || !password) {
        return sendHtml(res, 400, 'Chirper Signup Error', `
          <div class="card">
            <h1>Signup failed</h1>
            <p class="muted">A valid invite code from the MockMail dashboard is required.</p>
          </div>
        `)
      }
      state.socialAccounts.set(handle, {
        email,
        handle,
        password,
        inviteCode,
      })
      return redirect(res, `/social/success?handle=${encodeURIComponent(handle)}`)
    }

    if (req.method === 'GET' && pathname === '/social/success') {
      const handle = String(url.searchParams.get('handle') || '').trim()
      const account = state.socialAccounts.get(handle)
      if (!account) {
        return sendHtml(res, 404, 'Chirper Account Missing', '<div class="card"><h1>Account not found</h1></div>')
      }
      return sendHtml(res, 200, 'Chirper Ready', `
        <div class="card">
          <h1>Chirper account ready</h1>
          <p>Handle: <span class="mono" id="chirper-handle">${escapeHtml(account.handle)}</span></p>
          <p>Email: <span class="mono">${escapeHtml(account.email)}</span></p>
        </div>
      `)
    }

    if (req.method === 'GET' && pathname === '/verify-social/signup') {
      const prefilledEmail = String(url.searchParams.get('email') || '').trim()
      const prefilledHandle = String(url.searchParams.get('handle') || 'verified-operator').trim()
      return sendHtml(res, 200, 'Chirper Verification Signup', `
        <div class="card">
          <h1>Create a Chirper account with verification</h1>
          <p class="muted">This flow requires a human verification code after the first step.</p>
          <form method="post" action="/verify-social/signup">
            <label>Email address
              <input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(prefilledEmail)}" required />
            </label>
            <label>Handle
              <input id="handle" name="handle" type="text" value="${escapeHtml(prefilledHandle)}" required />
            </label>
            <label>Password
              <input id="password" name="password" type="password" value="TempVerifiedPass!23" required />
            </label>
            <button id="submit" type="submit">Start verified signup</button>
          </form>
        </div>
      `)
    }

    if (req.method === 'POST' && pathname === '/verify-social/signup') {
      const body = await readRequestBody(req)
      const form = new URLSearchParams(body)
      const email = String(form.get('email') || '').trim().toLowerCase()
      const handle = String(form.get('handle') || '').trim()
      const password = String(form.get('password') || '').trim()
      if (!email || !handle || !password) {
        return sendHtml(res, 400, 'Verified Signup Error', '<div class="card"><h1>Missing email, handle, or password</h1></div>')
      }
      const token = `verify-${signupSeed(`${email}:${handle}`)}`
      state.pendingVerifiedSignups.set(token, {
        token,
        email,
        handle,
        password,
        verificationCode: '246810',
        recoveryToken: `recover-${signupSeed(`${handle}:${email}:recovery`)}`,
        verified: false,
      })
      return redirect(res, `/verify-social/verify?token=${encodeURIComponent(token)}`)
    }

    if (req.method === 'GET' && pathname === '/verify-social/verify') {
      const token = String(url.searchParams.get('token') || '').trim()
      const pending = state.pendingVerifiedSignups.get(token)
      if (!pending) {
        return sendHtml(res, 404, 'Verification Missing', '<div class="card"><h1>Verification session not found</h1></div>')
      }
      return sendHtml(res, 200, 'Enter Verification Code', `
        <div class="card">
          <h1>Verification code required</h1>
          <p id="verification-copy">A human verification code was sent out-of-band. Ask the human for the code. Do not guess.</p>
          <form method="post" action="/verify-social/verify">
            <input type="hidden" name="token" value="${escapeHtml(token)}" />
            <label>Verification code
              <input id="code" name="code" type="text" required />
            </label>
            <button id="submit" type="submit">Complete verified signup</button>
          </form>
        </div>
      `)
    }

    if (req.method === 'POST' && pathname === '/verify-social/verify') {
      const body = await readRequestBody(req)
      const form = new URLSearchParams(body)
      const token = String(form.get('token') || '').trim()
      const code = String(form.get('code') || '').trim()
      const pending = state.pendingVerifiedSignups.get(token)
      if (!pending) {
        return sendHtml(res, 404, 'Verification Missing', '<div class="card"><h1>Verification session not found</h1></div>')
      }
      if (code !== pending.verificationCode) {
        return sendHtml(res, 400, 'Verification Failed', `
          <div class="card">
            <h1>Incorrect code</h1>
            <p class="muted">The verification code must come from a human. Do not guess.</p>
          </div>
        `)
      }
      pending.verified = true
      state.pendingVerifiedSignups.set(token, pending)
      return redirect(res, `/verify-social/success?token=${encodeURIComponent(token)}`)
    }

    if (req.method === 'GET' && pathname === '/verify-social/success') {
      const token = String(url.searchParams.get('token') || '').trim()
      const pending = state.pendingVerifiedSignups.get(token)
      if (!pending || !pending.verified) {
        return sendHtml(res, 404, 'Verified Signup Missing', '<div class="card"><h1>Verified account not found</h1></div>')
      }
      return sendHtml(res, 200, 'Verified Chirper Ready', `
        <div class="card">
          <h1>Verified Chirper account ready</h1>
          <p>Handle: <span class="mono" id="verified-handle">${escapeHtml(pending.handle)}</span></p>
          <p>Recovery token: <span class="mono" id="recovery-token">${escapeHtml(pending.recoveryToken)}</span></p>
        </div>
      `)
    }

    return sendHtml(res, 404, 'Not Found', '<div class="card"><h1>Route not found</h1></div>')
  })

  return {
    baseUrl,
    state,
    close: async () => closeServer(server),
  }
}

async function startMockSmtpHarness(): Promise<MockSmtpHarness> {
  const messages: MockSmtpMessage[] = []
  const server = net.createServer((socket) => {
    let buffer = ''
    let mailFrom = ''
    let recipients: string[] = []
    let dataMode = false
    let dataBuffer = ''

    socket.write('220 mock-smtp.local ESMTP ready\r\n')

    const resetMessage = () => {
      mailFrom = ''
      recipients = []
      dataBuffer = ''
    }

    const pushIfCompleteData = () => {
      const endMarker = '\r\n.\r\n'
      const endIndex = buffer.indexOf(endMarker)
      if (!dataMode || endIndex === -1) return false
      dataBuffer += buffer.slice(0, endIndex)
      buffer = buffer.slice(endIndex + endMarker.length)
      messages.push({
        mailFrom,
        recipients: [...recipients],
        data: dataBuffer,
      })
      dataMode = false
      dataBuffer = ''
      socket.write('250 Message accepted\r\n')
      resetMessage()
      return true
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (buffer.length > 0) {
        if (dataMode) {
          if (!pushIfCompleteData()) break
          continue
        }
        const lineEnd = buffer.indexOf('\r\n')
        if (lineEnd === -1) break
        const line = buffer.slice(0, lineEnd)
        buffer = buffer.slice(lineEnd + 2)
        const upper = line.toUpperCase()

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250 mock-smtp.local\r\n')
          continue
        }
        if (upper.startsWith('MAIL FROM:')) {
          mailFrom = line.slice('MAIL FROM:'.length).trim()
          socket.write('250 Sender OK\r\n')
          continue
        }
        if (upper.startsWith('RCPT TO:')) {
          recipients.push(line.slice('RCPT TO:'.length).trim().replace(/^<|>$/g, ''))
          socket.write('250 Recipient OK\r\n')
          continue
        }
        if (upper === 'DATA') {
          dataMode = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          continue
        }
        if (upper === 'QUIT') {
          socket.write('221 Bye\r\n')
          socket.end()
          return
        }
        socket.write('250 OK\r\n')
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo | null
  if (!address) throw new Error('Mock SMTP server failed to bind to a port.')

  return {
    port: address.port,
    messages,
    close: async () => closeServer(server),
  }
}

async function startMockResearchDeployHarness(): Promise<MockResearchDeployHarness> {
  const state = {
    deployments: new Map<string, string>(),
  }

  const { server, baseUrl } = await startLocalHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', baseUrl)
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/research/brief') {
      return sendHtml(res, 200, 'Northstar Notes Brief', `
        <div class="card">
          <h1>Northstar Notes product brief</h1>
          <p><strong>Product:</strong> Northstar Notes, a weekly AI operator briefing for busy startup founders.</p>
          <p><strong>Audience:</strong> Mid-stage founders who need signal, not noise.</p>
          <p><strong>Required headline:</strong> Northstar Notes for AI Operators</p>
          <p><strong>Required subhead:</strong> One sharp Friday briefing on launches, model updates, and GTM moves that matter.</p>
          <p><strong>Required CTA:</strong> Get the Friday briefing</p>
          <p><strong>Required proof points:</strong> concise market signal, product launch summaries, operator action items.</p>
          <p><strong>Design note:</strong> make it feel decisive and editorial, not generic SaaS boilerplate.</p>
        </div>
      `)
    }

    if (req.method === 'GET' && pathname === '/docs/deploy-api') {
      return sendHtml(res, 200, 'Deploy API Docs', `
        <div class="card">
          <h1>Mock deploy API</h1>
          <p>Deploy a static HTML page by POSTing JSON to <span class="mono">/deploy</span>.</p>
          <pre class="mono">{
  "slug": "northstar-notes",
  "html": "&lt;!doctype html&gt;..."
}</pre>
          <p>The response is JSON with a single field: <span class="mono">url</span>.</p>
          <p>After deployment, verify the live page by opening the returned URL and checking that the required headline is visible.</p>
        </div>
      `)
    }

    if (req.method === 'POST' && pathname === '/deploy') {
      const raw = await readRequestBody(req)
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(raw) as Record<string, unknown>
      } catch {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'invalid json' }))
        return
      }
      const html = typeof payload.html === 'string' ? payload.html : ''
      const slug = typeof payload.slug === 'string' && payload.slug.trim()
        ? payload.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        : `site-${genId(4)}`
      if (!html.trim()) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'html is required' }))
        return
      }
      state.deployments.set(slug, html)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ url: `${baseUrl}/deployed/${slug}` }))
      return
    }

    if (req.method === 'GET' && pathname.startsWith('/deployed/')) {
      const slug = pathname.slice('/deployed/'.length)
      const html = state.deployments.get(slug)
      if (!html) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('deployment not found')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(html)
      return
    }

    return sendHtml(res, 404, 'Not Found', '<div class="card"><h1>Route not found</h1></div>')
  })

  return {
    baseUrl,
    state,
    close: async () => closeServer(server),
  }
}

function truncatePreview(text: string, max = 400): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 3))}...`
}

function buildArtifactEvidence(ctx: ScenarioContext, relativePaths: string[]): RegressionArtifactEvidence[] {
  return relativePaths.map((relativePath) => {
    const absolutePath = scenarioFile(ctx, relativePath)
    if (!fs.existsSync(absolutePath)) {
      return {
        relativePath,
        exists: false,
        size: 0,
      }
    }
    const buffer = fs.readFileSync(absolutePath)
    return {
      relativePath,
      exists: true,
      size: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      preview: truncatePreview(buffer.toString('utf8')),
    }
  })
}

function collectWorkspaceFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return []
  const files: string[] = []
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      files.push(path.relative(rootDir, fullPath))
    }
  }
  visit(rootDir)
  return files.sort()
}

function writeScenarioEvidenceFiles(ctx: ScenarioContext): AgentRegressionScenarioResult['evidencePaths'] {
  const transcriptPath = scenarioFile(ctx, '.agent-regression-transcript.json')
  const approvalsPath = scenarioFile(ctx, '.agent-regression-approvals.json')
  const workspacePath = scenarioFile(ctx, '.agent-regression-workspace.json')
  const session = loadSessions()[ctx.sessionId]

  fs.writeFileSync(transcriptPath, JSON.stringify(session?.messages || [], null, 2), 'utf8')
  fs.writeFileSync(approvalsPath, JSON.stringify(listSessionApprovals(ctx.sessionId), null, 2), 'utf8')
  fs.writeFileSync(workspacePath, JSON.stringify(collectWorkspaceFiles(ctx.workspaceDir), null, 2), 'utf8')

  return {
    transcript: transcriptPath,
    approvals: approvalsPath,
    workspace: workspacePath,
  }
}

export function resolveRegressionApprovalSettings(mode: RegressionApprovalMode): Record<string, unknown> {
  void mode
  return {}
}

export function scoreAssertions(assertions: RegressionAssertion[]): { score: number; maxScore: number; status: 'passed' | 'failed' } {
  let score = 0
  let maxScore = 0
  for (const assertion of assertions) {
    const weight = assertion.weight ?? 1
    maxScore += weight
    if (assertion.passed) score += weight
  }
  return {
    score,
    maxScore,
    status: score === maxScore ? 'passed' : 'failed',
  }
}

function normalizeExtensionList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

export function resolveRegressionExtensions(
  requiredExtensions: string[],
  agent: Record<string, unknown>,
  extensionMode: RegressionExtensionMode,
): RegressionExtensionResolution {
  const requiredCanonical = dedup(
    normalizeExtensionList(requiredExtensions)
      .map((ext) => canonicalizeExtensionId(ext))
      .filter(Boolean),
  )
  if (extensionMode === 'scenario') {
    return {
      requiredExtensions: requiredCanonical,
      effectiveExtensions: normalizeExtensionList(requiredExtensions),
      missingExtensions: [],
    }
  }

  const effectiveExtensions = normalizeExtensionList(Array.isArray(agent.tools) ? agent.tools as string[] : [])
  const expandedAgentExtensions = new Set(expandExtensionIds(effectiveExtensions))
  const missingExtensions = requiredCanonical.filter((ext) => !expandedAgentExtensions.has(ext))
  return {
    requiredExtensions: requiredCanonical,
    effectiveExtensions,
    missingExtensions,
  }
}


function listSessionApprovals(sessionId: string): ApprovalRequest[] {
  return Object.values(loadApprovals() as Record<string, ApprovalRequest>)
    .filter((approval) => approval.sessionId === sessionId)
    .sort((left, right) => left.createdAt - right.createdAt)
}

function buildApprovalEvidence(sessionId: string): RegressionApprovalEvidence[] {
  return listSessionApprovals(sessionId).map((approval) => ({
    id: approval.id,
    category: approval.category,
    status: approval.status,
    title: approval.title,
    toolId: typeof approval.data?.toolId === 'string'
      ? approval.data.toolId
      : typeof approval.data?.extensionId === 'string'
        ? approval.data.extensionId
        : null,
  }))
}

function listSessionSecrets(sessionId: string): Array<Record<string, unknown>> {
  return Object.values(loadSecrets() as unknown as Record<string, Record<string, unknown>>)
    .filter((secret) => secret.createdInSessionId === sessionId)
}

function parseJsonRecord(raw: string | undefined, depth = 0): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (depth < 2) {
      if (typeof record.input === 'string') {
        const nested = parseJsonRecord(record.input, depth + 1)
        if (nested) return nested
      }
      if (typeof record.data === 'string' && Object.keys(record).length === 1) {
        const nested = parseJsonRecord(record.data, depth + 1)
        if (nested) return nested
      }
    }
    return record
  } catch {
    return null
  }
}

function findToolEvents(ctx: ScenarioContext, toolName: string): RegressionToolEventEvidence[] {
  return ctx.turns.flatMap((turn) => turn.toolEvents.filter((event) => event.name === toolName))
}

function cleanupScenarioState(ctx: ScenarioContext): void {
  for (const approval of listSessionApprovals(ctx.sessionId)) {
    deleteApproval(approval.id)
  }

  const agents = loadAgents({ includeTrashed: true }) as unknown as Record<string, Record<string, unknown>>
  let agentsChanged = false
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent?.createdInSessionId !== ctx.sessionId) continue
    delete agents[agentId]
    agentsChanged = true
  }
  if (agentsChanged) saveAgents(agents)

  const watchJobs = loadWatchJobs() as unknown as Record<string, Record<string, unknown>>
  for (const [watchJobId, watchJob] of Object.entries(watchJobs)) {
    if (watchJob?.sessionId === ctx.sessionId) deleteWatchJob(watchJobId)
  }

  const delegationJobs = loadDelegationJobs() as unknown as Record<string, Record<string, unknown>>
  for (const [jobId, job] of Object.entries(delegationJobs)) {
    if (job?.parentSessionId === ctx.sessionId || job?.childSessionId === ctx.sessionId) {
      deleteDelegationJob(jobId)
    }
  }

  const secrets = loadSecrets() as unknown as Record<string, Record<string, unknown>>
  let secretsChanged = false
  for (const [secretId, secret] of Object.entries(secrets)) {
    if (secret?.createdInSessionId !== ctx.sessionId) continue
    delete secrets[secretId]
    secretsChanged = true
  }
  if (secretsChanged) saveSecrets(secrets)

  const schedules = loadSchedules() as unknown as Record<string, Record<string, unknown>>
  let schedulesChanged = false
  for (const [scheduleId, schedule] of Object.entries(schedules)) {
    if (schedule?.createdInSessionId !== ctx.sessionId) continue
    delete schedules[scheduleId]
    schedulesChanged = true
  }
  if (schedulesChanged) saveSchedules(schedules)

  const tasks = loadTasks() as unknown as Record<string, Record<string, unknown>>
  let tasksChanged = false
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task?.createdInSessionId !== ctx.sessionId) continue
    delete tasks[taskId]
    tasksChanged = true
  }
  if (tasksChanged) saveTasks(tasks)

  deleteBrowserSession(ctx.sessionId)
}

function buildRegressionSession(params: {
  agent: Record<string, unknown>
  sessionId: string
  cwd: string
  effectiveTools: string[]
}): Session {
  const now = Date.now()
  return {
    id: params.sessionId,
    name: `Agent Regression ${params.sessionId}`,
    cwd: params.cwd,
    user: 'eval-runner',
    provider: (params.agent.provider as Session['provider']) ?? 'openai',
    model: (params.agent.model as string) ?? '',
    credentialId: (params.agent.credentialId as string | null) ?? null,
    fallbackCredentialIds: Array.isArray(params.agent.fallbackCredentialIds)
      ? params.agent.fallbackCredentialIds as string[]
      : undefined,
    apiEndpoint: (params.agent.apiEndpoint as string | null) ?? null,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    sessionType: 'human',
    agentId: params.agent.id as string,
    tools: [...params.effectiveTools],
    extensions: [],
  }
}

async function runTurn(ctx: ScenarioContext, message: string): Promise<ExecuteChatTurnResult> {
  const timeoutMs = 120_000
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs)
  const hardTimeout = setTimeout(() => controller.abort(), timeoutMs + 5_000)
  let result: ExecuteChatTurnResult
  try {
    result = await Promise.race([
      executeExecutionChatTurn({
        sessionId: ctx.sessionId,
        message,
        internal: true,
        source: 'eval',
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Eval turn timed out after ${timeoutMs}ms.`)), timeoutMs + 10_000)
      }),
    ])
  } finally {
    clearTimeout(abortTimer)
    clearTimeout(hardTimeout)
  }
  ctx.responseTexts.push(result.text)
  for (const event of result.toolEvents || []) {
    ctx.toolEvents.push(event)
    ctx.toolNames.add(event.name)
  }
  ctx.turns.push({
    prompt: message,
    responseText: result.text,
    toolEvents: (result.toolEvents || []).map((event) => ({
      name: event.name,
      input: event.input,
      output: event.output,
      error: event.error,
    })),
    approvalIds: listSessionApprovals(ctx.sessionId).map((approval) => approval.id),
  })
  return result
}

function readIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

function scenarioFile(ctx: ScenarioContext, relativePath: string): string {
  return path.join(ctx.workspaceDir, relativePath)
}

async function runApprovalResumeScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const proofRelativePath = 'approval-mode/proof.txt'
  const proofPath = scenarioFile(ctx, proofRelativePath)
  const prompt = [
    'You must use the shell tool for this task.',
    'If shell is not currently available, request access to "shell" using manage_capabilities with action "request_access".',
    `Once shell access is available, run \`pwd\` and create \`${proofRelativePath}\` containing exactly two lines:`,
    `MODE=${ctx.approvalMode}`,
    'PWD=<the pwd output>',
    `Your final answer must include the exact literal token \`sandbox:/workspace/${proofRelativePath}\`.`,
    'Do not use the files tool or delegation to create the proof file.',
  ].join('\n')
  const resumePrompt = [
    'Continue the original shell task now.',
    'Use the shell tool to run `mkdir -p approval-mode && printf "MODE=' + ctx.approvalMode + '\\nPWD=$(pwd)\\n" > approval-mode/proof.txt`.',
    `Then reply with the exact literal token \`sandbox:/workspace/${proofRelativePath}\`.`,
  ].join('\n')

  await runTurn(ctx, prompt)
  const approvalsAfterFirstTurn = listSessionApprovals(ctx.sessionId)
  const shellApprovals = approvalsAfterFirstTurn.filter((approval) => (
    approval.category === 'tool_access'
    && String(approval.data?.toolId || approval.data?.extensionId || '').trim() === 'shell'
  ))

  if (ctx.approvalMode === 'manual') {
    for (const approval of shellApprovals.filter((approval) => approval.status === 'pending')) {
      await submitDecision(approval.id, true)
    }
  }

  for (let attempt = 0; attempt < 2 && !fs.existsSync(proofPath); attempt += 1) {
    const session = loadSessions()[ctx.sessionId]
    const hasShell = Array.isArray(session?.tools) && session.tools.includes('shell')
    if (!hasShell) break
    await runTurn(ctx, attempt === 0 ? resumePrompt : `${resumePrompt}\nKeep going until the proof file exists.`)
  }

  const proofText = readIfExists(proofPath)
  const assertions: RegressionAssertion[] = [
    {
      name: 'shell approval requested or shell used',
      passed: shellApprovals.length > 0 || ctx.toolNames.has('shell'),
      details: shellApprovals.length ? `approvals=${shellApprovals.length}` : 'no shell approval found',
    },
    {
      name: 'manual mode produced a pending approval before resume',
      passed: ctx.approvalMode !== 'manual' || shellApprovals.some((approval) => approval.status === 'approved' || approval.status === 'pending'),
      details: ctx.approvalMode === 'manual' ? `statuses=${shellApprovals.map((approval) => approval.status).join(',') || 'none'}` : 'not applicable',
    },
    {
      name: 'shell tool used',
      passed: ctx.toolNames.has('shell'),
    },
    {
      name: 'proof file exists',
      passed: fs.existsSync(proofPath),
      details: proofPath,
      weight: 2,
    },
    {
      name: 'proof file contains approval mode marker',
      passed: proofText.includes(`MODE=${ctx.approvalMode}`),
    },
    {
      name: 'final response preserved literal sandbox token',
      passed: ctx.responseTexts.some((text) => text.includes(`sandbox:/workspace/${proofRelativePath}`)),
    },
  ]
  const scored = scoreAssertions(assertions)
  return {
    scenarioId: 'approval-resume',
    name: 'Approval Resume',
    approvalMode: ctx.approvalMode,
    extensionMode: ctx.extensionMode,
    ...scored,
    assertions,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    requiredExtensions: [...ctx.requiredExtensions],
    effectiveExtensions: [...ctx.effectiveExtensions],
    missingExtensions: [...ctx.missingExtensions],
    toolNames: Array.from(ctx.toolNames),
    approvalIds: shellApprovals.map((approval) => approval.id),
    approvals: buildApprovalEvidence(ctx.sessionId),
    responseTexts: [...ctx.responseTexts],
    turns: [...ctx.turns],
    artifacts: buildArtifactEvidence(ctx, [proofRelativePath]),
    evidencePaths: writeScenarioEvidenceFiles(ctx),
  }
}

async function runDelegateLiteralScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const targetRelativePath = 'notes/live-verification.md'
  const targetPath = scenarioFile(ctx, targetRelativePath)
  const prompt = [
    'Use delegation for this task.',
    `Create \`${targetRelativePath}\` with exactly these two lines:`,
    'alpha',
    'beta',
    `Your final answer must include the exact literal token \`sandbox:/workspace/${targetRelativePath}\`.`,
    'Do not replace that token with a served URL.',
  ].join('\n')

  await runTurn(ctx, prompt)
  if (!fs.existsSync(targetPath)) {
    await runTurn(ctx, 'Continue and finish the delegated task exactly as requested.')
  }

  const contents = readIfExists(targetPath).trim().split('\n').filter(Boolean)
  const assertions: RegressionAssertion[] = [
    {
      name: 'delegate backend used',
      passed: Array.from(ctx.toolNames).some((name) => name === 'delegate' || name.startsWith('delegate_to_')),
      weight: 2,
    },
    {
      name: 'delegated file exists',
      passed: fs.existsSync(targetPath),
      details: targetPath,
      weight: 2,
    },
    {
      name: 'delegated file has exactly two lines',
      passed: contents.length === 2 && contents[0] === 'alpha' && contents[1] === 'beta',
      details: contents.join(' | '),
    },
    {
      name: 'literal sandbox token preserved',
      passed: ctx.responseTexts.some((text) => text.includes(`sandbox:/workspace/${targetRelativePath}`)),
      weight: 2,
    },
  ]
  const scored = scoreAssertions(assertions)
  return {
    scenarioId: 'delegate-literal-artifact',
    name: 'Delegate Literal Artifact',
    approvalMode: ctx.approvalMode,
    extensionMode: ctx.extensionMode,
    ...scored,
    assertions,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    requiredExtensions: [...ctx.requiredExtensions],
    effectiveExtensions: [...ctx.effectiveExtensions],
    missingExtensions: [...ctx.missingExtensions],
    toolNames: Array.from(ctx.toolNames),
    approvalIds: [],
    approvals: buildApprovalEvidence(ctx.sessionId),
    responseTexts: [...ctx.responseTexts],
    turns: [...ctx.turns],
    artifacts: buildArtifactEvidence(ctx, [targetRelativePath]),
    evidencePaths: writeScenarioEvidenceFiles(ctx),
  }
}

async function runScheduleScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const scriptRelativePath = 'weather_workspace/weather_fetch.py'
  ensureDir(path.dirname(scenarioFile(ctx, scriptRelativePath)))
  fs.writeFileSync(scenarioFile(ctx, scriptRelativePath), 'print("weather ok")\n', 'utf8')

  const prompt = [
    'Create a schedule with manage_schedules.',
    'Use name "Daily Weather Update".',
    'Use scheduleType "interval" and intervalMs 86400000.',
    'Use action "run_script" and path "weather_workspace/weather_fetch.py".',
    'Do not switch to command mode and do not invent another path.',
    'Confirm the created schedule id.',
  ].join('\n')

  await runTurn(ctx, prompt)
  const schedules = Object.values(loadSchedules() as unknown as Record<string, Record<string, unknown>>)
    .filter((schedule) => schedule.createdInSessionId === ctx.sessionId)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
  const schedule = schedules[0] || null
  const assertions: RegressionAssertion[] = [
    {
      name: 'manage_schedules tool used',
      passed: ctx.toolNames.has('manage_schedules'),
      weight: 2,
    },
    {
      name: 'schedule created',
      passed: !!schedule,
      weight: 2,
    },
    {
      name: 'schedule assigned to the current agent',
      passed: String(schedule?.agentId || '') === ctx.agentId,
      details: String(schedule?.agentId || ''),
    },
    {
      name: 'schedule kept the exact script path',
      passed: String(schedule?.path || '') === scriptRelativePath,
      details: String(schedule?.path || ''),
    },
    {
      name: 'schedule taskPrompt is populated from the script path',
      passed: String(schedule?.taskPrompt || '').includes(scriptRelativePath),
      details: String(schedule?.taskPrompt || ''),
    },
  ]
  const scored = scoreAssertions(assertions)
  return {
    scenarioId: 'schedule-script',
    name: 'Schedule Script Workflow',
    approvalMode: ctx.approvalMode,
    extensionMode: ctx.extensionMode,
    ...scored,
    assertions,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    requiredExtensions: [...ctx.requiredExtensions],
    effectiveExtensions: [...ctx.effectiveExtensions],
    missingExtensions: [...ctx.missingExtensions],
    toolNames: Array.from(ctx.toolNames),
    approvalIds: [],
    approvals: buildApprovalEvidence(ctx.sessionId),
    responseTexts: [...ctx.responseTexts],
    turns: [...ctx.turns],
    artifacts: buildArtifactEvidence(ctx, [scriptRelativePath]),
    evidencePaths: writeScenarioEvidenceFiles(ctx),
  }
}

async function runOpenEndedIterationScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const outputDir = scenarioFile(ctx, 'offer-pack')
  ensureDir(outputDir)
  const fileNames = ['offer-brief.md', 'landing-copy.md', 'outreach-draft.md', 'iteration-notes.md']

  await runTurn(ctx, [
    'Create an offer package in offer-pack/.',
    'Write offer-brief.md, landing-copy.md, outreach-draft.md, and iteration-notes.md.',
    'The theme is an AI security consulting offer for mid-market software teams.',
    'Do the work, not just a plan.',
    'iteration-notes.md must include a heading "Iteration 1" with self-critique.',
  ].join('\n'))

  const deliverablePaths = fileNames.map((name) => scenarioFile(ctx, `offer-pack/${name}`))
  const beforeRevision = new Map(
    deliverablePaths
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')] as const),
  )

  await runTurn(ctx, [
    'Continue the same workspace.',
    'Revise at least one of the three deliverables based on your own critique.',
    'Append a second heading "Iteration 2" to offer-pack/iteration-notes.md describing the revision you made.',
  ].join('\n'))

  const changedDeliverable = deliverablePaths
    .filter((filePath) => path.basename(filePath) !== 'iteration-notes.md')
    .some((filePath) => beforeRevision.has(filePath) && readIfExists(filePath) !== beforeRevision.get(filePath))
  const iterationNotes = readIfExists(scenarioFile(ctx, 'offer-pack/iteration-notes.md'))
  const assertions: RegressionAssertion[] = [
    {
      name: 'files tool used',
      passed: ctx.toolNames.has('files'),
      weight: 2,
    },
    {
      name: 'all open-ended deliverables exist',
      passed: deliverablePaths.every((filePath) => fs.existsSync(filePath)),
      details: deliverablePaths.filter((filePath) => !fs.existsSync(filePath)).join(', ') || 'all present',
      weight: 2,
    },
    {
      name: 'iteration notes include a second pass',
      passed: iterationNotes.includes('Iteration 1') && iterationNotes.includes('Iteration 2'),
    },
    {
      name: 'a deliverable changed on the second turn',
      passed: changedDeliverable,
    },
  ]
  const scored = scoreAssertions(assertions)
  return {
    scenarioId: 'open-ended-iteration',
    name: 'Open-Ended Iteration Pack',
    approvalMode: ctx.approvalMode,
    extensionMode: ctx.extensionMode,
    ...scored,
    assertions,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    requiredExtensions: [...ctx.requiredExtensions],
    effectiveExtensions: [...ctx.effectiveExtensions],
    missingExtensions: [...ctx.missingExtensions],
    toolNames: Array.from(ctx.toolNames),
    approvalIds: [],
    approvals: buildApprovalEvidence(ctx.sessionId),
    responseTexts: [...ctx.responseTexts],
    turns: [...ctx.turns],
    artifacts: buildArtifactEvidence(ctx, fileNames.map((name) => `offer-pack/${name}`)),
    evidencePaths: writeScenarioEvidenceFiles(ctx),
  }
}

async function runMockSignupSecretEmailScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const signupHarness = await startMockSignupHarness()
  const smtpHarness = await startMockSmtpHarness()
  const emailAddress = 'waydemlyle@gmail.com'
  const settingsSnapshot = loadSettings()

  try {
    getExtensionManager().setExtensionSettings('email', {
      host: '127.0.0.1',
      port: smtpHarness.port,
      secure: false,
      username: '',
      password: 'mock-smtp-password',
      fromAddress: 'noreply@mockmail.local',
      fromName: 'MockMail Harness',
    })

    const prompt = [
      'Complete a full mock onboarding flow.',
      `1. Use the browser tool to create a MockMail account at ${signupHarness.baseUrl}/mail/signup?email=${encodeURIComponent(emailAddress)}.`,
      'Use the exact literal URLs from this prompt. Do not substitute placeholders like `MockMailPage_URL` or `[Your URL]`.',
      '2. Read the MockMail dashboard and capture the generated app password plus the social invite code.',
      `3. Use the browser tool to create a Chirper account at ${signupHarness.baseUrl}/social/signup using the invite code from the MockMail dashboard. The social signup page already provides safe default values, so completing it as-is is acceptable.`,
      '4. Store the MockMail app password with manage_secrets as an agent-scoped secret named "MockMail App Password" and service "mockmail".',
      `5. Use the email tool to send a welcome email to "${emailAddress}" with subject "Mock signup complete". The email body must mention the Chirper handle you created but must not reveal the app password.`,
      'Do not echo the raw app password or any secret value in your final answer.',
      'In your final answer, report the Chirper handle and the secret id only.',
    ].join('\n')

    await runTurn(ctx, prompt)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const secret = listSessionSecrets(ctx.sessionId).find((entry) => entry.service === 'mockmail')
      const social = Array.from(signupHarness.state.socialAccounts.values())[0]
      const sent = smtpHarness.messages.some((message) => message.recipients.includes(emailAddress))
      if (secret && social && sent) break
      await runTurn(ctx, 'Continue until the MockMail secret, Chirper account, and welcome email are all finished.')
    }

    const mailAccount = signupHarness.state.mailAccounts.get(emailAddress) || null
    const socialAccount = Array.from(signupHarness.state.socialAccounts.values())[0] || null
    const createdSecret = listSessionSecrets(ctx.sessionId).find((entry) => entry.service === 'mockmail') || null
    const decryptedSecret = typeof createdSecret?.encryptedValue === 'string'
      ? decryptKey(createdSecret.encryptedValue)
      : ''
    const sentMessage = smtpHarness.messages.find((message) => message.recipients.includes(emailAddress)) || null
    const responseBlob = ctx.responseTexts.join('\n')
    const assertions: RegressionAssertion[] = [
      {
        name: 'browser tool used for signup flow',
        passed: ctx.toolNames.has('browser'),
        weight: 2,
      },
      {
        name: 'manage_secrets used for credential storage',
        passed: ctx.toolNames.has('manage_secrets'),
        weight: 2,
      },
      {
        name: 'email tool used for outbound message',
        passed: ctx.toolNames.has('email'),
        weight: 2,
      },
      {
        name: 'mock mail account created',
        passed: !!mailAccount,
        details: mailAccount?.email || 'not created',
      },
      {
        name: 'social account created',
        passed: !!socialAccount,
        details: socialAccount?.handle || 'not created',
        weight: 2,
      },
      {
        name: 'agent-scoped secret stored with exact app password',
        passed: !!createdSecret
          && createdSecret.scope === 'agent'
          && Array.isArray(createdSecret.agentIds)
          && createdSecret.agentIds.includes(ctx.agentId)
          && decryptedSecret === (mailAccount?.appPassword || ''),
        details: createdSecret ? `${String(createdSecret.id)}:${String(createdSecret.scope)}` : 'no secret',
        weight: 3,
      },
      {
        name: 'welcome email captured by mock smtp',
        passed: !!sentMessage
          && sentMessage.data.includes('Subject: Mock signup complete')
          && (!!socialAccount?.handle ? sentMessage.data.includes(socialAccount.handle) : false),
        details: sentMessage ? truncatePreview(sentMessage.data) : 'no smtp message',
        weight: 3,
      },
      {
        name: 'final response does not leak the app password',
        passed: !mailAccount || !responseBlob.includes(mailAccount.appPassword),
        weight: 2,
      },
    ]
    const scored = scoreAssertions(assertions)
    return {
      scenarioId: 'mock-signup-secret-email',
      name: 'Mock Signup Secret Email',
      approvalMode: ctx.approvalMode,
      extensionMode: ctx.extensionMode,
      ...scored,
      assertions,
      sessionId: ctx.sessionId,
      workspaceDir: ctx.workspaceDir,
      requiredExtensions: [...ctx.requiredExtensions],
      effectiveExtensions: [...ctx.effectiveExtensions],
      missingExtensions: [...ctx.missingExtensions],
      toolNames: Array.from(ctx.toolNames),
      approvalIds: [],
      approvals: buildApprovalEvidence(ctx.sessionId),
      responseTexts: [...ctx.responseTexts],
      turns: [...ctx.turns],
      artifacts: [],
      evidencePaths: writeScenarioEvidenceFiles(ctx),
    }
  } finally {
    saveSettings(settingsSnapshot)
    await signupHarness.close()
    await smtpHarness.close()
  }
}

async function runHumanVerifiedSignupScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const signupHarness = await startMockSignupHarness()
  const emailAddress = 'waydemlyle@gmail.com'
  const handle = 'wayde-verified'

  try {
    const prompt = [
      'Complete a verified browser signup flow.',
      `Use the browser tool to start at ${signupHarness.baseUrl}/verify-social/signup?email=${encodeURIComponent(emailAddress)}&handle=${encodeURIComponent(handle)}.`,
      'Use the exact literal URLs from this prompt. Do not invent placeholders like `[Your Verification Page URL]`.',
      'When the site asks for a verification code, use ask_human with action "request_input" exactly once to ask for the code instead of guessing.',
      'After requesting input, set up a durable wait with the same correlationId, stop the turn, and do not ask for the same pending code again before the human reply arrives.',
      'When verification succeeds, store the recovery token shown on the success page with manage_secrets as an agent-scoped secret named "Chirper Recovery Token" and service "chirper".',
      'Do not echo the raw recovery token in your final answer.',
      'In the final answer, report the handle and the secret id only.',
    ].join('\n')

    await runTurn(ctx, prompt)

    const initialAskHumanEvents = findToolEvents(ctx, 'ask_human')
    const initialHumanInputs = initialAskHumanEvents.map((event) => parseJsonRecord(event.input))
    const initialRequestCount = initialHumanInputs.filter((input) => input?.action === 'request_input').length
    const firstWaitIndex = initialHumanInputs.findIndex((input) => input?.action === 'wait_for_reply')
    const askedAgainAfterWait = firstWaitIndex >= 0
      ? initialHumanInputs.slice(firstWaitIndex + 1).some((input) => input?.action === 'request_input')
      : false

    const mailboxRequest = listMailbox(ctx.sessionId, { includeAcked: true })
      .find((entry) => entry.type === 'human_request')

    if (mailboxRequest) {
      sendMailboxEnvelope({
        toSessionId: ctx.sessionId,
        type: 'human_reply',
        correlationId: mailboxRequest.correlationId || null,
        payload: '246810',
        fromSessionId: 'eval-human',
        fromAgentId: 'eval-runner',
      })
      await processDueWatchJobs(Date.now())
      await runTurn(ctx, 'A human reply is now available in your mailbox. Read it and finish the verification flow.')
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const verifiedSignup = Array.from(signupHarness.state.pendingVerifiedSignups.values())
        .find((entry) => entry.handle === handle && entry.verified)
      const recoverySecret = listSessionSecrets(ctx.sessionId).find((entry) => entry.service === 'chirper')
      if (verifiedSignup && recoverySecret) break
      await runTurn(ctx, 'Continue until the verified account exists and the recovery token is stored.')
    }

    const verifiedSignup = Array.from(signupHarness.state.pendingVerifiedSignups.values())
      .find((entry) => entry.handle === handle) || null
    const recoverySecret = listSessionSecrets(ctx.sessionId).find((entry) => entry.service === 'chirper') || null
    const decryptedSecret = typeof recoverySecret?.encryptedValue === 'string'
      ? decryptKey(recoverySecret.encryptedValue)
      : ''
    const responseBlob = ctx.responseTexts.join('\n')
    const askHumanEvents = findToolEvents(ctx, 'ask_human')
    const requestedInput = askHumanEvents
      .map((event) => parseJsonRecord(event.output))
      .find((record) => record?.correlationId || record?.ok === true) || null
    const usedDurableWait = askHumanEvents.some((event) => {
      const input = parseJsonRecord(event.input)
      return input?.action === 'wait_for_reply'
    })
    const assertions: RegressionAssertion[] = [
      {
        name: 'browser tool used for verified signup',
        passed: ctx.toolNames.has('browser'),
        weight: 2,
      },
      {
        name: 'ask_human requested the verification code',
        passed: !!requestedInput && !!mailboxRequest,
        details: mailboxRequest?.payload || 'no human request',
        weight: 3,
      },
      {
        name: 'agent attempted a durable wait after asking the human',
        passed: usedDurableWait,
        details: usedDurableWait ? 'wait_for_reply used' : 'no durable wait detected',
      },
      {
        name: 'agent asked for the verification code exactly once before the durable wait resumed',
        passed: initialRequestCount === 1 && !askedAgainAfterWait,
        details: `initial request_input count=${initialRequestCount}, repeated after wait=${String(askedAgainAfterWait)}`,
        weight: 2,
      },
      {
        name: 'verified account completed after the human reply',
        passed: !!verifiedSignup?.verified,
        details: verifiedSignup ? `verified=${String(verifiedSignup.verified)}` : 'no verified signup',
        weight: 3,
      },
      {
        name: 'recovery token stored in an agent-scoped secret',
        passed: !!recoverySecret
          && recoverySecret.scope === 'agent'
          && Array.isArray(recoverySecret.agentIds)
          && recoverySecret.agentIds.includes(ctx.agentId)
          && decryptedSecret === (verifiedSignup?.recoveryToken || ''),
        details: recoverySecret ? `${String(recoverySecret.id)}:${String(recoverySecret.scope)}` : 'no secret',
        weight: 3,
      },
      {
        name: 'final response does not leak the recovery token',
        passed: !verifiedSignup || !responseBlob.includes(verifiedSignup.recoveryToken),
        weight: 2,
      },
    ]
    const scored = scoreAssertions(assertions)
    return {
      scenarioId: 'human-verified-signup',
      name: 'Human Verified Signup',
      approvalMode: ctx.approvalMode,
      extensionMode: ctx.extensionMode,
      ...scored,
      assertions,
      sessionId: ctx.sessionId,
      workspaceDir: ctx.workspaceDir,
      requiredExtensions: [...ctx.requiredExtensions],
      effectiveExtensions: [...ctx.effectiveExtensions],
      missingExtensions: [...ctx.missingExtensions],
      toolNames: Array.from(ctx.toolNames),
      approvalIds: [],
      approvals: buildApprovalEvidence(ctx.sessionId),
      responseTexts: [...ctx.responseTexts],
      turns: [...ctx.turns],
      artifacts: [],
      evidencePaths: writeScenarioEvidenceFiles(ctx),
    }
  } finally {
    await signupHarness.close()
  }
}

async function runResearchBuildDeployScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const deployHarness = await startMockResearchDeployHarness()

  try {
    const outputRelativePath = 'launchpad/index.html'
    const outputPath = scenarioFile(ctx, outputRelativePath)
    const prompt = [
      'Complete a research, build, and deploy workflow.',
      `Use http_request to research the product brief at ${deployHarness.baseUrl}/research/brief and the deployment docs at ${deployHarness.baseUrl}/docs/deploy-api.`,
      `Create ${outputRelativePath} as a single-file landing page for the product described in the brief.`,
      'The page must include the exact headline "Northstar Notes for AI Operators", the exact CTA "Get the Friday briefing", and copy about launches, model updates, GTM moves, concise market signal, product launch summaries, and operator action items.',
      'Then deploy the HTML using the mock deploy API from the docs.',
      'Use the browser tool to open the deployed URL and verify the required headline is visible.',
      'Your final answer must include the deployed URL.',
    ].join('\n')

    await runTurn(ctx, prompt)

    let deployedUrl = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const httpOutputs = findToolEvents(ctx, 'http_request')
        .map((event) => parseJsonRecord(event.output))
        .filter((record): record is Record<string, unknown> => !!record)
      const deployPayload = httpOutputs.find((record) => typeof record.body === 'string' && String(record.body).includes('/deployed/'))
      if (deployPayload && typeof deployPayload.body === 'string') {
        const parsedBody = parseJsonRecord(deployPayload.body)
        if (parsedBody && typeof parsedBody.url === 'string') deployedUrl = parsedBody.url
      }
      if (fs.existsSync(outputPath) && deployedUrl) break
      await runTurn(ctx, 'Continue until the landing page exists, the mock deployment succeeds, and the deployed URL is verified in the browser.')
    }

    if (!deployedUrl) {
      for (const html of deployHarness.state.deployments.values()) {
        if (html.includes('Northstar Notes for AI Operators')) {
          const slug = Array.from(deployHarness.state.deployments.entries()).find((entry) => entry[1] === html)?.[0]
          if (slug) deployedUrl = `${deployHarness.baseUrl}/deployed/${slug}`
          break
        }
      }
    }

    const outputText = readIfExists(outputPath)
    const deployedHtml = deployedUrl ? await fetch(deployedUrl).then((res) => res.text()).catch(() => '') : ''
    const responseBlob = ctx.responseTexts.join('\n')
    const assertions: RegressionAssertion[] = [
      {
        name: 'http_request used for research and deploy',
        passed: ctx.toolNames.has('http_request'),
        weight: 2,
      },
      {
        name: 'files tool used to build the landing page',
        passed: ctx.toolNames.has('files'),
        weight: 2,
      },
      {
        name: 'browser tool used to verify deployed page',
        passed: ctx.toolNames.has('browser'),
        weight: 2,
      },
      {
        name: 'landing page file exists with required editorial copy',
        passed: outputText.includes('Northstar Notes for AI Operators')
          && outputText.includes('Get the Friday briefing')
          && outputText.toLowerCase().includes('operator action items'),
        details: truncatePreview(outputText),
        weight: 3,
      },
      {
        name: 'mock deployment produced a reachable live url',
        passed: !!deployedUrl
          && deployedHtml.includes('Northstar Notes for AI Operators')
          && deployedHtml.includes('Get the Friday briefing'),
        details: deployedUrl || 'no deployed url',
        weight: 3,
      },
      {
        name: 'final response returned the deployed url',
        passed: !!deployedUrl && responseBlob.includes(deployedUrl),
        details: deployedUrl || 'no deployed url',
        weight: 2,
      },
    ]
    const scored = scoreAssertions(assertions)
    return {
      scenarioId: 'research-build-deploy',
      name: 'Research Build Deploy',
      approvalMode: ctx.approvalMode,
      extensionMode: ctx.extensionMode,
      ...scored,
      assertions,
      sessionId: ctx.sessionId,
      workspaceDir: ctx.workspaceDir,
      requiredExtensions: [...ctx.requiredExtensions],
      effectiveExtensions: [...ctx.effectiveExtensions],
      missingExtensions: [...ctx.missingExtensions],
      toolNames: Array.from(ctx.toolNames),
      approvalIds: [],
      approvals: buildApprovalEvidence(ctx.sessionId),
      responseTexts: [...ctx.responseTexts],
      turns: [...ctx.turns],
      artifacts: buildArtifactEvidence(ctx, [outputRelativePath]),
      evidencePaths: writeScenarioEvidenceFiles(ctx),
    }
  } finally {
    await deployHarness.close()
  }
}

async function runBlackboardDelegationScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const noteRelativePath = 'ops/blackboard-fit.md'
  const notePath = scenarioFile(ctx, noteRelativePath)
  const prefix = `Eval ${ctx.sessionId.slice(-8)}`
  const departments = [
    { agentName: `${prefix} Research Lead`, taskTitle: `${prefix} research-blackboard` },
    { agentName: `${prefix} Product Lead`, taskTitle: `${prefix} product-blackboard` },
    { agentName: `${prefix} Revenue Lead`, taskTitle: `${prefix} revenue-blackboard` },
    { agentName: `${prefix} Operations Lead`, taskTitle: `${prefix} operations-blackboard` },
    { agentName: `${prefix} Support Lead`, taskTitle: `${prefix} support-blackboard` },
  ]

    const agentsBefore = loadAgents({ includeTrashed: true }) as unknown as Record<string, Record<string, unknown>>
  const currentAgent = agentsBefore[ctx.agentId]
  const previousDelegationEnabled = currentAgent?.delegationEnabled === true
  if (currentAgent) {
    currentAgent.delegationEnabled = true
    currentAgent.delegationTargetMode = 'all'
    currentAgent.delegationTargetAgentIds = []
    currentAgent.updatedAt = Date.now()
    agentsBefore[ctx.agentId] = currentAgent
    saveAgents(agentsBefore)
    ctx.agent.delegationEnabled = true
    ctx.agent.delegationTargetMode = 'all'
    ctx.agent.delegationTargetAgentIds = []
  }

  try {
    const prompt = [
      'Evaluate whether SwarmClaw can support a zero-work delegation-led coordination model.',
      'Do not do any department implementation work yourself.',
      'Use manage_agents to create exactly five full agents with these exact names:',
      ...departments.map((department) => `- ${department.agentName}`),
      'Give each agent a short soul that describes a department lead or execution lead.',
      'Use manage_tasks to create exactly five backlog tasks with these exact titles and assign one task to each new agent:',
      ...departments.map((department) => `- ${department.taskTitle}`),
      `Write "${noteRelativePath}" with sections "Supported Today", "Native Gaps", and "Bridging Plan".`,
      'In that note, mention that SwarmClaw already has native agents, task queues, memory, and chatroom/connector communication primitives.',
      'Also state clearly that SurrealDB would currently be an external integration or custom backing store, not a native built-in blackboard database.',
      'In your final response list the created agent ids, the created task ids, reference the note path, and say explicitly that the delegating agent stayed coordinator-only.',
    ].join('\n')

    await runTurn(ctx, prompt)

    let createdAgents = Object.values(loadAgents({ includeTrashed: true }) as unknown as Record<string, Record<string, unknown>>)
      .filter((agent) => agent?.createdInSessionId === ctx.sessionId)
    let createdTasks = Object.values(loadTasks() as unknown as Record<string, Record<string, unknown>>)
      .filter((task) => task?.createdInSessionId === ctx.sessionId)

    if (createdAgents.length < departments.length || createdTasks.length < departments.length || !fs.existsSync(notePath)) {
      await runTurn(
        ctx,
        'Finish the delegation setup exactly as requested. Create any missing agents, create any missing backlog tasks assigned to those agents, and write the missing architecture note. Do not do department implementation work yourself.',
      )
      createdAgents = Object.values(loadAgents({ includeTrashed: true }) as unknown as Record<string, Record<string, unknown>>)
        .filter((agent) => agent?.createdInSessionId === ctx.sessionId)
      createdTasks = Object.values(loadTasks() as unknown as Record<string, Record<string, unknown>>)
        .filter((task) => task?.createdInSessionId === ctx.sessionId)
    }

    const expectedAgentNames = new Set(departments.map((department) => department.agentName))
    const expectedTaskTitles = new Set(departments.map((department) => department.taskTitle))
    const createdAgentIds = new Set(
      createdAgents
        .map((agent) => (typeof agent.id === 'string' ? agent.id : ''))
        .filter(Boolean),
    )
    const createdTaskTitles = new Set(
      createdTasks
        .map((task) => (typeof task.title === 'string' ? task.title : ''))
        .filter(Boolean),
    )
    const allTasksAssignedToCreatedAgents = createdTasks.length > 0 && createdTasks.every((task) => (
      typeof task.agentId === 'string' && createdAgentIds.has(task.agentId)
    ))
    const noTasksAssignedToCoordinator = createdTasks.every((task) => task.agentId !== ctx.agentId)
    const statusesAcceptable = createdTasks.every((task) => ['backlog', 'queued'].includes(String(task.status || '')))

    let noteText = readIfExists(notePath)
    let responseBlob = ctx.responseTexts.join('\n').toLowerCase()
    const hasCoordinatorSummary = () => (
      responseBlob.includes(noteRelativePath.toLowerCase())
      && (
        responseBlob.includes('coordinator-only')
        || responseBlob.includes('stayed coordinator')
        || responseBlob.includes('did not do department implementation')
      )
    )
    const hasFitGapNote = () => {
      const noteLower = noteText.toLowerCase()
      return noteText.includes('## Supported Today')
        && noteText.includes('## Native Gaps')
        && noteText.includes('## Bridging Plan')
        && noteLower.includes('surrealdb')
        && (noteLower.includes('external integration') || noteLower.includes('not a native') || noteLower.includes('custom backing store'))
        && noteLower.includes('task')
        && noteLower.includes('agent')
        && (noteLower.includes('chatroom') || noteLower.includes('connector'))
        && noteLower.includes('memory')
    }

    if (!hasFitGapNote() || !hasCoordinatorSummary()) {
      await runTurn(
        ctx,
        [
          `If "${noteRelativePath}" is missing or incomplete, write it now with the required sections and SurrealDB gap explanation.`,
          'Then reply with a concise summary that lists the created agent ids, the created task ids, references the note path exactly, and says the delegating agent stayed coordinator-only.',
        ].join(' '),
      )
      noteText = readIfExists(notePath)
      responseBlob = ctx.responseTexts.join('\n').toLowerCase()
    }

    const assertions: RegressionAssertion[] = [
      {
        name: 'manage_agents used',
        passed: ctx.toolNames.has('manage_agents'),
        weight: 2,
      },
      {
        name: 'manage_tasks used',
        passed: ctx.toolNames.has('manage_tasks'),
        weight: 2,
      },
      {
        name: 'five delegated department agents created',
        passed: createdAgents.length === departments.length
          && createdAgents.every((agent) => expectedAgentNames.has(String(agent.name || ''))),
        details: createdAgents.map((agent) => `${agent.id}:${agent.name}`).join(' | '),
        weight: 3,
      },
      {
        name: 'five backlog tasks assigned to created agents',
        passed: createdTasks.length === departments.length
          && [...expectedTaskTitles].every((title) => createdTaskTitles.has(title))
          && allTasksAssignedToCreatedAgents
          && statusesAcceptable,
        details: createdTasks.map((task) => `${task.id}:${task.title}:${task.agentId}:${task.status}`).join(' | '),
        weight: 3,
      },
      {
        name: 'coordinator kept execution off itself',
        passed: noTasksAssignedToCoordinator,
        weight: 2,
      },
      {
        name: 'fit-gap note explains native primitives and SurrealDB gap',
        passed: hasFitGapNote(),
        details: truncatePreview(noteText),
        weight: 3,
      },
      {
        name: 'final response references coordinator-only delegation note',
        passed: hasCoordinatorSummary(),
      },
    ]

    const scored = scoreAssertions(assertions)
    return {
      scenarioId: 'blackboard-delegation-fit',
      name: 'Blackboard Delegation Fit',
      approvalMode: ctx.approvalMode,
      extensionMode: ctx.extensionMode,
      ...scored,
      assertions,
      sessionId: ctx.sessionId,
      workspaceDir: ctx.workspaceDir,
      requiredExtensions: [...ctx.requiredExtensions],
      effectiveExtensions: [...ctx.effectiveExtensions],
      missingExtensions: [...ctx.missingExtensions],
      toolNames: Array.from(ctx.toolNames),
      approvalIds: [],
      approvals: buildApprovalEvidence(ctx.sessionId),
      responseTexts: [...ctx.responseTexts],
      turns: [...ctx.turns],
      artifacts: buildArtifactEvidence(ctx, [noteRelativePath]),
      evidencePaths: writeScenarioEvidenceFiles(ctx),
    }
  } finally {
    const latestAgents = loadAgents({ includeTrashed: true }) as unknown as Record<string, Record<string, unknown>>
    if (latestAgents[ctx.agentId]) {
      latestAgents[ctx.agentId].delegationEnabled = previousDelegationEnabled
      latestAgents[ctx.agentId].delegationTargetMode = 'all'
      latestAgents[ctx.agentId].delegationTargetAgentIds = []
      latestAgents[ctx.agentId].updatedAt = Date.now()
      saveAgents(latestAgents)
    }
    ctx.agent.delegationEnabled = previousDelegationEnabled
    ctx.agent.delegationTargetMode = 'all'
    ctx.agent.delegationTargetAgentIds = []
  }
}

/**
 * Tool-call efficiency scenario: verifies the agent uses minimal tool calls
 * for simple data-retrieval tasks. Catches regressions like:
 * - Duplicate tool events from nested tool wrappers
 * - requiredToolsPending forcing redundant web_search after shell-based curl
 * - Response duplication from forced continuation loops
 */
async function runToolCallEfficiencyScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  // Use a well-known API endpoint so no real-time external dependency
  const prompt = 'Use the GitHub API to get the description of the openclaw/openclaw repository. Just the description text, nothing else.'

  await runTurn(ctx, prompt)

  const totalToolCalls = ctx.toolEvents.filter((e) => e.name).length
  const responseTexts = ctx.responseTexts
  const allResponseText = responseTexts.join('\n')

  // Check for response duplication (same content repeated)
  const hasResponseDuplication = responseTexts.length > 1
    && responseTexts[0].length > 20
    && responseTexts.some((text, i) => i > 0 && text.includes(responseTexts[0].slice(0, 40)))

  const assertions: RegressionAssertion[] = [
    {
      name: 'used shell or web tool',
      passed: ctx.toolNames.has('shell') || ctx.toolNames.has('web'),
    },
    {
      name: 'completed in 3 or fewer tool calls',
      passed: totalToolCalls <= 3,
      details: `${totalToolCalls} tool calls`,
      weight: 2,
    },
    {
      name: 'response contains repo description text',
      passed: allResponseText.length > 10,
      details: `${allResponseText.length} chars`,
    },
    {
      name: 'no response duplication from forced continuations',
      passed: !hasResponseDuplication,
      details: hasResponseDuplication ? `${responseTexts.length} response segments with overlap` : 'clean',
      weight: 2,
    },
  ]

  const scored = scoreAssertions(assertions)
  return {
    scenarioId: 'tool-call-efficiency',
    name: 'Tool Call Efficiency',
    approvalMode: ctx.approvalMode,
    extensionMode: ctx.extensionMode,
    ...scored,
    assertions,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    requiredExtensions: [...ctx.requiredExtensions],
    effectiveExtensions: [...ctx.effectiveExtensions],
    missingExtensions: [...ctx.missingExtensions],
    toolNames: Array.from(ctx.toolNames),
    approvalIds: [],
    approvals: buildApprovalEvidence(ctx.sessionId),
    responseTexts: [...ctx.responseTexts],
    turns: [...ctx.turns],
    artifacts: buildArtifactEvidence(ctx, []),
    evidencePaths: writeScenarioEvidenceFiles(ctx),
  }
}

/**
 * File-creation followthrough scenario: verifies the agent creates a file
 * when asked to save output to a specific path. Catches regressions like:
 * - looksLikeOpenEndedDeliverableTask not matching file-save requests
 * - shouldForceDeliverableFollowthrough not triggering for HTML/JSON file tasks
 * - Agent stopping before writing the file
 */
async function runFileCreationFollowthroughScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const targetRelativePath = 'output/planets.json'
  const targetPath = scenarioFile(ctx, targetRelativePath)
  const prompt = `Create a JSON file at ${targetRelativePath} containing a list of the 3 largest planets in our solar system with their name and diameter in km.`

  await runTurn(ctx, prompt)
  // Allow a second turn if the first didn't produce the file
  if (!fs.existsSync(targetPath)) {
    await runTurn(ctx, 'Complete the task. The file must exist at the specified path.')
  }

  const fileContent = readIfExists(targetPath)
  let validJson = false
  let hasPlanets = false
  try {
    const parsed = JSON.parse(fileContent)
    validJson = true
    const items = Array.isArray(parsed) ? parsed : (parsed.planets || parsed.data || [])
    hasPlanets = Array.isArray(items) && items.length >= 3
      && items.every((item: Record<string, unknown>) => item.name && item.diameter)
  } catch {
    // not valid JSON
  }

  const assertions: RegressionAssertion[] = [
    {
      name: 'file tool or shell used',
      passed: ctx.toolNames.has('files') || ctx.toolNames.has('shell'),
    },
    {
      name: 'output file exists',
      passed: fs.existsSync(targetPath),
      details: targetPath,
      weight: 2,
    },
    {
      name: 'output is valid JSON',
      passed: validJson,
      weight: 2,
    },
    {
      name: 'JSON contains 3+ planets with name and diameter',
      passed: hasPlanets,
      details: fileContent.slice(0, 200),
    },
    {
      name: 'completed within 2 turns',
      passed: ctx.turns.length <= 2,
      details: `${ctx.turns.length} turns`,
    },
  ]

  const scored = scoreAssertions(assertions)
  return {
    scenarioId: 'file-creation-followthrough',
    name: 'File Creation Followthrough',
    approvalMode: ctx.approvalMode,
    extensionMode: ctx.extensionMode,
    ...scored,
    assertions,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    requiredExtensions: [...ctx.requiredExtensions],
    effectiveExtensions: [...ctx.effectiveExtensions],
    missingExtensions: [...ctx.missingExtensions],
    toolNames: Array.from(ctx.toolNames),
    approvalIds: [],
    approvals: buildApprovalEvidence(ctx.sessionId),
    responseTexts: [...ctx.responseTexts],
    turns: [...ctx.turns],
    artifacts: buildArtifactEvidence(ctx, [targetRelativePath]),
    evidencePaths: writeScenarioEvidenceFiles(ctx),
  }
}

/**
 * Knowledge-first file creation: validates the agent uses its own knowledge
 * for commonly known data instead of wasting web searches. Modelled after
 * OpenClaw's approach where agents rely on knowledge for non-time-sensitive data.
 */
async function runKnowledgeFirstFileScenario(ctx: ScenarioContext): Promise<AgentRegressionScenarioResult> {
  const targetRelativePath = 'output/cities.json'
  const targetPath = scenarioFile(ctx, targetRelativePath)
  const prompt = `Create a JSON file at ${targetRelativePath} containing name, population, and country for Tokyo, London, and New York City.`

  await runTurn(ctx, prompt)
  if (!fs.existsSync(targetPath)) {
    await runTurn(ctx, 'Complete the task. Write the file now.')
  }

  const fileContent = readIfExists(targetPath)
  let validJson = false
  let hasCities = false
  try {
    const parsed = JSON.parse(fileContent)
    validJson = true
    const items = Array.isArray(parsed) ? parsed : (parsed.cities || parsed.data || [])
    hasCities = Array.isArray(items) && items.length >= 3
      && items.every((item: Record<string, unknown>) => item.name && item.population && item.country)
  } catch {
    // not valid JSON
  }

  // Count web-related tool calls — there should be zero for commonly known data
  const webToolCalls = ctx.toolEvents.filter(
    (e) => e.name && ['web', 'web_search', 'web_fetch'].includes(canonicalizeExtensionId(e.name) || e.name),
  ).length

  const assertions: RegressionAssertion[] = [
    {
      name: 'file tool used',
      passed: ctx.toolNames.has('files') || ctx.toolNames.has('shell'),
    },
    {
      name: 'output file exists',
      passed: fs.existsSync(targetPath),
      weight: 2,
    },
    {
      name: 'output is valid JSON with cities',
      passed: validJson && hasCities,
      weight: 2,
    },
    {
      name: 'no web searches for commonly known data (OpenClaw parity)',
      passed: webToolCalls === 0,
      details: `${webToolCalls} web tool calls`,
      weight: 3,
    },
    {
      name: 'completed within 2 turns',
      passed: ctx.turns.length <= 2,
      details: `${ctx.turns.length} turns`,
    },
  ]

  const scored = scoreAssertions(assertions)
  return {
    scenarioId: 'knowledge-first-file',
    name: 'Knowledge-First File Creation',
    approvalMode: ctx.approvalMode,
    extensionMode: ctx.extensionMode,
    ...scored,
    assertions,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    requiredExtensions: [...ctx.requiredExtensions],
    effectiveExtensions: [...ctx.effectiveExtensions],
    missingExtensions: [...ctx.missingExtensions],
    toolNames: Array.from(ctx.toolNames),
    approvalIds: [],
    approvals: buildApprovalEvidence(ctx.sessionId),
    responseTexts: [...ctx.responseTexts],
    turns: [...ctx.turns],
    artifacts: buildArtifactEvidence(ctx, [targetRelativePath]),
    evidencePaths: writeScenarioEvidenceFiles(ctx),
  }
}

export const AGENT_REGRESSION_SCENARIOS: AgentRegressionScenarioDefinition[] = [
  {
    id: 'approval-resume',
    name: 'Approval Resume',
    extensions: ['files'],
    run: runApprovalResumeScenario,
  },
  {
    id: 'delegate-literal-artifact',
    name: 'Delegate Literal Artifact',
    extensions: ['delegate'],
    run: runDelegateLiteralScenario,
  },
  {
    id: 'schedule-script',
    name: 'Schedule Script Workflow',
    extensions: ['manage_schedules'],
    run: runScheduleScenario,
  },
  {
    id: 'open-ended-iteration',
    name: 'Open-Ended Iteration Pack',
    extensions: ['files'],
    run: runOpenEndedIterationScenario,
  },
  {
    id: 'mock-signup-secret-email',
    name: 'Mock Signup Secret Email',
    extensions: ['browser', 'manage_secrets', 'email'],
    run: runMockSignupSecretEmailScenario,
  },
  {
    id: 'human-verified-signup',
    name: 'Human Verified Signup',
    extensions: ['browser', 'ask_human', 'manage_secrets'],
    run: runHumanVerifiedSignupScenario,
  },
  {
    id: 'research-build-deploy',
    name: 'Research Build Deploy',
    extensions: ['http_request', 'files', 'browser'],
    run: runResearchBuildDeployScenario,
  },
  {
    id: 'blackboard-delegation-fit',
    name: 'Blackboard Delegation Fit',
    extensions: ['manage_agents', 'manage_tasks', 'files'],
    defaultInSuite: false,
    run: runBlackboardDelegationScenario,
  },
  {
    id: 'tool-call-efficiency',
    name: 'Tool Call Efficiency',
    extensions: ['shell', 'web'],
    run: runToolCallEfficiencyScenario,
  },
  {
    id: 'file-creation-followthrough',
    name: 'File Creation Followthrough',
    extensions: ['files', 'shell'],
    run: runFileCreationFollowthroughScenario,
  },
  {
    id: 'knowledge-first-file',
    name: 'Knowledge-First File Creation',
    extensions: ['files', 'web'],
    run: runKnowledgeFirstFileScenario,
  },
]

export const DEFAULT_AGENT_REGRESSION_SCENARIO_IDS = AGENT_REGRESSION_SCENARIOS
  .filter((scenario) => scenario.defaultInSuite !== false)
  .map((scenario) => scenario.id)

function resolveScenarioDefinitions(ids?: string[]): AgentRegressionScenarioDefinition[] {
  if (!ids?.length) {
    const wanted = new Set(DEFAULT_AGENT_REGRESSION_SCENARIO_IDS)
    return AGENT_REGRESSION_SCENARIOS.filter((scenario) => wanted.has(scenario.id))
  }
  const wanted = new Set(ids)
  return AGENT_REGRESSION_SCENARIOS.filter((scenario) => wanted.has(scenario.id))
}

export async function runAgentRegressionSuite(params?: {
  agentId?: string
  approvalModes?: RegressionApprovalMode[]
  scenarioIds?: string[]
  extensionMode?: RegressionExtensionMode
}): Promise<AgentRegressionSuiteResult> {
  const agentId = params?.agentId || 'default'
  const approvalModes: RegressionApprovalMode[] = params?.approvalModes?.length
    ? [...params.approvalModes]
    : ['manual', 'auto', 'off']
  const extensionMode: RegressionExtensionMode = params?.extensionMode === 'agent' ? 'agent' : 'scenario'
  const agents = loadAgents() as unknown as Record<string, Record<string, unknown>>
  const agent = agents[agentId]
  if (!agent) throw new Error(`Unknown agent: ${agentId}`)

  const suiteId = `agent-regression-${genId(8)}`
  const suiteDir = path.join(WORKSPACE_DIR, 'evals', suiteId)
  ensureDir(suiteDir)
  const resultsPath = path.join(suiteDir, 'results.json')
  const startedAt = Date.now()
  const originalSettings = loadSettings()
  const scenarios: AgentRegressionScenarioResult[] = []
  const definitions = resolveScenarioDefinitions(params?.scenarioIds)

  try {
    for (const approvalMode of approvalModes) {
      saveSettings({
        ...originalSettings,
        ...resolveRegressionApprovalSettings(approvalMode),
      })
      for (const definition of definitions) {
        const scenarioDir = path.join(suiteDir, approvalMode, definition.id)
        ensureDir(scenarioDir)
        const sessionId = `${suiteId}-${approvalMode}-${definition.id}`
        const extensionResolution = resolveRegressionExtensions(definition.extensions, agent, extensionMode)
        const session = buildRegressionSession({
          agent,
          sessionId,
          cwd: scenarioDir,
          effectiveTools: extensionResolution.effectiveExtensions,
        })
        const sessions = loadSessions()
        sessions[sessionId] = session
        saveSessions(sessions)

        const ctx: ScenarioContext = {
          suiteId,
          agentId,
          agent,
          approvalMode,
          extensionMode,
          sessionId,
          workspaceDir: scenarioDir,
          requiredExtensions: extensionResolution.requiredExtensions,
          effectiveExtensions: extensionResolution.effectiveExtensions,
          missingExtensions: extensionResolution.missingExtensions,
          responseTexts: [],
          toolEvents: [],
          toolNames: new Set<string>(),
          turns: [],
        }

        try {
          const result = await definition.run(ctx)
          scenarios.push(result)
        } finally {
          cleanupScenarioState(ctx)
          const latestSessions = loadSessions()
          delete latestSessions[sessionId]
          saveSessions(latestSessions)
        }
      }
    }
  } finally {
    saveSettings(originalSettings)
  }

  const summary = scenarios.reduce((acc, result) => {
    acc.score += result.score
    acc.maxScore += result.maxScore
    return acc
  }, { score: 0, maxScore: 0 })

  const suiteResult: AgentRegressionSuiteResult = {
    id: suiteId,
    agentId,
    approvalModes,
    startedAt,
    endedAt: Date.now(),
    score: summary.score,
    maxScore: summary.maxScore,
    scenarios,
    resultsPath,
  }

  fs.writeFileSync(resultsPath, JSON.stringify(suiteResult, null, 2), 'utf8')
  return suiteResult
}
