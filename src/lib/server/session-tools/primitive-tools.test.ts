import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Session } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let buildDocumentTools: typeof import('./document').buildDocumentTools
let buildExtractTools: typeof import('./extract').buildExtractTools
let buildTableTools: typeof import('./table').buildTableTools
let buildMailboxTools: typeof import('./mailbox').buildMailboxTools
let buildHumanLoopTools: typeof import('./human-loop').buildHumanLoopTools
let buildCrawlTools: typeof import('./crawl').buildCrawlTools
let coerceSubagentActionArgs: typeof import('./subagent').coerceSubagentActionArgs
let sessionMailbox: typeof import('@/lib/server/chatrooms/session-mailbox')
let watchJobs: typeof import('@/lib/server/runtime/watch-jobs')
let storage: typeof import('../storage')

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session_1',
    name: 'Test Session',
    cwd: workspaceDir,
    user: 'tester',
    provider: 'ollama',
    model: 'qwen3.5',
    apiEndpoint: 'http://localhost:11434',
    claudeSessionId: null,
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    plugins: [],
    ...overrides,
  }
}

function makeBuildContext(overrides?: {
  cwd?: string
  session?: Session
}) {
  const session = overrides?.session || makeSession()
  return {
    cwd: overrides?.cwd || workspaceDir,
    ctx: {
      sessionId: session.id,
      agentId: session.agentId || 'agent_1',
    },
    hasPlugin: () => true,
    hasTool: () => true,
    cleanupFns: [],
    commandTimeoutMs: 5000,
    claudeTimeoutMs: 5000,
    cliProcessTimeoutMs: 5000,
    persistDelegateResumeId: () => {},
    readStoredDelegateResumeId: () => null,
    resolveCurrentSession: () => session,
    activePlugins: [],
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-primitive-tools-'))
  workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })

  ;({ buildDocumentTools } = await import('./document'))
  ;({ buildExtractTools } = await import('./extract'))
  ;({ buildTableTools } = await import('./table'))
  ;({ buildMailboxTools } = await import('./mailbox'))
  ;({ buildHumanLoopTools } = await import('./human-loop'))
  ;({ buildCrawlTools } = await import('./crawl'))
  ;({ coerceSubagentActionArgs } = await import('./subagent'))
  sessionMailbox = await import('@/lib/server/chatrooms/session-mailbox')
  watchJobs = await import('@/lib/server/runtime/watch-jobs')
  storage = await import('../storage')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('primitive tools', () => {
  it('document tool reads, stores, and searches extracted text', async () => {
    const sourcePath = path.join(workspaceDir, 'note.txt')
    fs.writeFileSync(sourcePath, 'Invoice 42 for ACME\nTotal: $120.50\n')

    const [documentTool] = buildDocumentTools(makeBuildContext())
    const read = JSON.parse(String(await documentTool.invoke({ action: 'read', filePath: 'note.txt' })))
    assert.match(read.text, /Invoice 42/)

    const stored = JSON.parse(String(await documentTool.invoke({ action: 'store', filePath: 'note.txt', title: 'Invoice Note' })))
    const search = JSON.parse(String(await documentTool.invoke({ action: 'search', query: 'ACME' })))
    const fetched = JSON.parse(String(await documentTool.invoke({ action: 'get', id: stored.id })))

    assert.equal(search.matches[0].id, stored.id)
    assert.equal(fetched.title, 'Invoice Note')
  })

  it('table tool transforms inline data and writes results', async () => {
    const [tableTool] = buildTableTools(makeBuildContext())
    const rows = [
      { id: '1', name: 'Ada', score: 10 },
      { id: '2', name: 'Grace', score: 25 },
      { id: '2', name: 'Grace', score: 25 },
    ]

    const filtered = JSON.parse(String(await tableTool.invoke({
      action: 'filter',
      rows,
      where: [{ column: 'score', op: 'gt', value: 15 }],
    })))
    assert.equal(filtered.rowCount, 2)

    const deduped = JSON.parse(String(await tableTool.invoke({
      action: 'dedupe',
      rows,
      on: ['id'],
    })))
    assert.equal(deduped.rowCount, 2)

    const joined = JSON.parse(String(await tableTool.invoke({
      action: 'join',
      leftRows: [{ id: '1', team: 'red' }],
      rightRows: [{ id: '1', email: 'ada@example.com' }],
      on: 'id',
    })))
    assert.equal(joined.rows[0].email, 'ada@example.com')

    const writeResult = JSON.parse(String(await tableTool.invoke({
      action: 'write',
      rows,
      outputPath: 'exports/report.csv',
    })))
    assert.equal(fs.existsSync(writeResult.output.filePath), true)
  })

  it('human-loop tool creates durable mailbox waits', async () => {
    const [humanTool] = buildHumanLoopTools(makeBuildContext())
    const sessions = storage.loadSessions()
    sessions.session_1 = makeSession({ id: 'session_1', agentId: 'agent_1' })
    storage.saveSessions(sessions)

    const requestInput = JSON.parse(String(await humanTool.invoke({
      action: 'request_input',
      question: 'Ship it?',
      correlationId: 'corr_123',
    })))
    assert.equal(requestInput.ok, true)

    const replyWatch = JSON.parse(String(await humanTool.invoke({
      action: 'wait_for_reply',
      correlationId: 'corr_123',
    })))
    assert.equal(watchJobs.getWatchJob(replyWatch.id)?.status, 'active')
    const replyEnvelope = {
      id: 'env_reply_1',
      type: 'human_reply',
      payload: 'yes',
      fromSessionId: null,
      fromAgentId: null,
      toSessionId: 'session_1',
      toAgentId: null,
      correlationId: 'corr_123',
      status: 'new' as const,
      createdAt: Date.now(),
      expiresAt: null,
      ackAt: null,
    }
    const sessionsAfterReply = storage.loadSessions()
    sessionsAfterReply.session_1.mailbox = [...(sessionsAfterReply.session_1.mailbox || []), replyEnvelope]
    storage.saveSessions(sessionsAfterReply)
    assert.equal(replyEnvelope.correlationId, 'corr_123')

    const ackedReply = JSON.parse(String(await humanTool.invoke({
      action: 'ack_mailbox',
    })))
    assert.equal(ackedReply.id, replyEnvelope.id)
    assert.equal(ackedReply.status, 'ack')

    const followupWatch = JSON.parse(String(await humanTool.invoke({
      action: 'wait_for_reply',
      correlationId: 'corr_followup',
    })))
    assert.equal(watchJobs.getWatchJob(followupWatch.id)?.status, 'active')
    const followupReply = {
      id: 'env_reply_2',
      type: 'human_reply',
      payload: JSON.stringify({ approved: true }),
      fromSessionId: null,
      fromAgentId: null,
      toSessionId: 'session_1',
      toAgentId: null,
      correlationId: 'corr_followup',
      status: 'new' as const,
      createdAt: Date.now(),
      expiresAt: null,
      ackAt: null,
    }
    const sessionsAfterFollowup = storage.loadSessions()
    sessionsAfterFollowup.session_1.mailbox = [...(sessionsAfterFollowup.session_1.mailbox || []), followupReply]
    storage.saveSessions(sessionsAfterFollowup)
    assert.equal(followupReply.correlationId, 'corr_followup')
  })

  it('mailbox tool reports configuration status without requiring network', async () => {
    const [mailboxTool] = buildMailboxTools(makeBuildContext())
    const status = JSON.parse(String(await mailboxTool.invoke({ action: 'status' })))
    assert.equal(status.configured, false)
    assert.equal(status.folder, 'INBOX')
  })

  it('extract tool reports active model context', async () => {
    const [extractTool] = buildExtractTools(makeBuildContext({
      session: makeSession({
        provider: 'ollama',
        model: 'qwen3.5',
        apiEndpoint: 'http://localhost:11434',
      }),
    }))
    const status = JSON.parse(String(await extractTool.invoke({ action: 'status' })))
    assert.equal(status.provider, 'ollama')
    assert.equal(Array.isArray(status.supports), true)
  })

  it('crawl tool crawls and dedupes fetched pages without a live server', async () => {
    const originalFetch = global.fetch
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/page-2')) {
        return new Response('<html><head><title>Page Two</title></head><body><article><h1>Second</h1><p>Next content</p></article></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      return new Response('<html><head><title>Root</title></head><body><article><h1>Home</h1><p>Welcome</p></article><a href="/page-2" rel="next">Next</a></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch

    try {
      const [crawlTool] = buildCrawlTools(makeBuildContext())
      const baseUrl = 'https://example.test/'

      const crawled = JSON.parse(String(await crawlTool.invoke({
        action: 'crawl_site',
        url: baseUrl,
        limit: 2,
      })))
      assert.equal(crawled.count, 2)
      assert.equal(crawled.pages[0].title, 'Root')

      const extracted = JSON.parse(String(await crawlTool.invoke({
        action: 'extract_sitemap',
        url: baseUrl,
        limit: 2,
      })))
      assert.equal(extracted.count, 2)
      assert.equal(extracted.urls.includes('https://example.test/page-2'), true)

      const deduped = JSON.parse(String(await crawlTool.invoke({
        action: 'dedupe_pages',
        pages: [crawled.pages[0], crawled.pages[0], crawled.pages[1]],
      })))
      assert.equal(deduped.count, 2)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('coerces wrapped subagent swarm arguments into typed arrays and booleans', () => {
    const args = coerceSubagentActionArgs({
      input: JSON.stringify({
        action: 'swarm',
        waitForCompletion: 'false',
        tasks: JSON.stringify([
          { agentId: 'agent_a', message: 'First task' },
          { agentId: 'agent_b', message: 'Second task' },
        ]),
      }),
    })

    assert.equal(args.action, 'swarm')
    assert.equal(args.waitForCompletion, false)
    assert.ok(Array.isArray(args.tasks))
    assert.equal((args.tasks as Array<unknown>).length, 2)
  })
})
