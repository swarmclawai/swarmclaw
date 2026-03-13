#!/usr/bin/env -S npx tsx

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
import {
  deleteSchedule,
  deleteStoredItem,
  deleteTask,
  deleteWatchJob,
  loadAgents,
  loadSchedules,
  loadSessions,
  loadTasks,
  loadWatchJobs,
} from '@/lib/server/storage'
import type { Agent, MailboxEnvelope, Schedule, Session, WatchJob } from '@/types'

const BASE_URL = resolveBaseUrl()
const OUTPUT_DIR = createArtifactDir('browser-agent-live-pass')
const SOURCE_AGENT_ID = process.env.SWARMCLAW_AGENT_ID || 'e6b683f8'
const HUMAN_REPLY_TIMEOUT_MS = Number.parseInt(process.env.SWARMCLAW_LIVE_HUMAN_TIMEOUT_MS || '90000', 10)
const SCHEDULE_FIRE_TIMEOUT_MS = Number.parseInt(process.env.SWARMCLAW_LIVE_SCHEDULE_TIMEOUT_MS || '180000', 10)
const POLL_INTERVAL_MS = 1000

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)))
}

function buildClonePayload(source: Agent, suffix: string) {
  return {
    name: `${source.name} Browser E2E ${suffix}`,
    description: source.description || `Disposable browser E2E clone of ${source.name}`,
    systemPrompt: source.systemPrompt || '',
    soul: source.soul || undefined,
    provider: source.provider,
    model: source.model || '',
    credentialId: source.credentialId ?? null,
    fallbackCredentialIds: source.fallbackCredentialIds || [],
    apiEndpoint: source.apiEndpoint ?? null,
    gatewayProfileId: source.gatewayProfileId ?? null,
    preferredGatewayTags: source.preferredGatewayTags || [],
    preferredGatewayUseCase: source.preferredGatewayUseCase ?? null,
    routingStrategy: source.routingStrategy ?? null,
    routingTargets: source.routingTargets || [],
    platformAssignScope: source.platformAssignScope || 'self',
    subAgentIds: source.subAgentIds || [],
    plugins: dedupeStrings([...(source.plugins || source.tools || []), 'ask_human']),
    skills: source.skills || [],
    skillIds: source.skillIds || [],
    mcpServerIds: source.mcpServerIds || [],
    mcpDisabledTools: source.mcpDisabledTools || [],
    capabilities: source.capabilities || [],
    thinkingLevel: source.thinkingLevel || undefined,
    identityState: source.identityState ?? null,
    heartbeatEnabled: false,
    heartbeatIntervalSec: null,
    heartbeatModel: null,
    heartbeatPrompt: null,
    elevenLabsVoiceId: source.elevenLabsVoiceId ?? null,
    sessionResetMode: source.sessionResetMode ?? null,
    sessionIdleTimeoutSec: source.sessionIdleTimeoutSec ?? null,
    sessionMaxAgeSec: source.sessionMaxAgeSec ?? null,
    sessionDailyResetAt: source.sessionDailyResetAt ?? null,
    sessionResetTimezone: source.sessionResetTimezone ?? null,
    memoryScopeMode: source.memoryScopeMode ?? null,
    memoryTierPreference: source.memoryTierPreference ?? null,
    autoDraftSkillSuggestions: source.autoDraftSkillSuggestions ?? true,
    projectId: source.projectId,
    avatarSeed: source.avatarSeed,
    avatarUrl: source.avatarUrl ?? null,
    sandboxConfig: source.sandboxConfig ?? null,
    autoRecovery: source.autoRecovery ?? false,
    monthlyBudget: source.monthlyBudget ?? null,
    dailyBudget: source.dailyBudget ?? null,
    hourlyBudget: source.hourlyBudget ?? null,
    budgetAction: source.budgetAction || 'warn',
    disabled: false,
  }
}

function getSession(sessionId: string): Session {
  const session = loadSessions()[sessionId] as Session | undefined
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  return session
}

function listPendingHumanRequests(sessionId: string): MailboxEnvelope[] {
  const session = getSession(sessionId)
  return (session.mailbox || [])
    .filter((item) => item.type === 'human_request' && item.status !== 'ack')
}

function listActiveMailboxWatchJobs(sessionId: string): WatchJob[] {
  return Object.values(loadWatchJobs())
    .filter((item): item is WatchJob => Boolean(item) && typeof item === 'object')
    .filter((item) => item.type === 'mailbox' && item.status === 'active' && item.sessionId === sessionId)
}

function listFixtureSchedules(agentId: string, sessionId: string, since: number): Schedule[] {
  return Object.values(loadSchedules())
    .filter((item): item is Schedule => Boolean(item) && typeof item === 'object')
    .filter((item) => item.agentId === agentId && item.createdInSessionId === sessionId && item.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function countAssistantMessagesContaining(sessionId: string, token: string): number {
  return getSession(sessionId).messages
    .filter((message) => message.role === 'assistant' && typeof message.text === 'string' && message.text.includes(token))
    .length
}

async function waitFor<T>(
  label: string,
  fn: () => T | Promise<T>,
  timeoutMs: number,
  page: import('playwright').Page,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await page.waitForTimeout(POLL_INTERVAL_MS)
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function sendChatMessage(page: import('playwright').Page, text: string) {
  await page.locator('[data-testid="chat-input"]').fill(text)
  await page.locator('[data-testid="chat-send"]').click()
}

async function cleanupFixture(fixture: { agentId?: string | null; sessionId?: string | null } | null) {
  if (!fixture?.agentId && !fixture?.sessionId) return

  const schedules = Object.values(loadSchedules())
    .filter((item): item is Schedule => Boolean(item) && typeof item === 'object')
    .filter((item) => item.agentId === fixture.agentId || item.createdInSessionId === fixture.sessionId)
  const scheduleIds = new Set(schedules.map((item) => item.id))
  for (const scheduleId of scheduleIds) deleteSchedule(scheduleId)

  const tasks = Object.values(loadTasks())
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => item.agentId === fixture.agentId || item.sessionId === fixture.sessionId || (typeof item.sourceScheduleId === 'string' && scheduleIds.has(item.sourceScheduleId)))
  for (const task of tasks) {
    if (typeof task.id === 'string') deleteTask(task.id)
  }

  const watchJobs = Object.values(loadWatchJobs())
    .filter((item): item is WatchJob => Boolean(item) && typeof item === 'object')
    .filter((item) => item.sessionId === fixture.sessionId || item.agentId === fixture.agentId)
  for (const job of watchJobs) deleteWatchJob(job.id)

  if (fixture.sessionId) deleteStoredItem('sessions', fixture.sessionId)
  if (fixture.agentId) deleteStoredItem('agents', fixture.agentId)
}

async function main() {
  const summary: Record<string, unknown> = {
    ok: false,
    baseUrl: BASE_URL,
    sourceAgentId: SOURCE_AGENT_ID,
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    badResponses: [],
    steps: [],
    screenshots: {},
  }

  const accessKey = readAccessKey()
  const browser = await chromium.launch({ headless: true })
  const context = await createBrowserContext(browser, accessKey)
  const page = await context.newPage()
  attachPageDiagnostics(page, summary, BASE_URL)

  let fixture: { agentId?: string | null; sessionId?: string | null } | null = null

  try {
  const sourceAgent = loadAgents()[SOURCE_AGENT_ID]
  if (!sourceAgent) throw new Error(`Source agent not found: ${SOURCE_AGENT_ID}`)

  const suffix = uniqueId('live-pass').slice(-8)
  const clonedAgent = await apiJson({
    baseUrl: BASE_URL,
    accessKey,
    method: 'POST',
    pathName: '/agents',
    body: buildClonePayload(sourceAgent, suffix),
  })
  const thread = await apiJson({
    baseUrl: BASE_URL,
    accessKey,
    method: 'POST',
    pathName: `/agents/${clonedAgent.id}/thread`,
    body: { user: 'browser-live-pass' },
  })
  fixture = { agentId: clonedAgent.id, sessionId: thread.id }
  summary.fixture = fixture
  ;(summary.steps as Array<Record<string, unknown>>).push({ name: 'create-fixture', ok: true, agentId: clonedAgent.id, sessionId: thread.id })

  await page.goto(new URL('/', BASE_URL).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })
  await maybeAuthenticate(page, accessKey)
  await page.evaluate((agentId) => {
    window.localStorage.setItem('sc_agent', agentId)
  }, clonedAgent.id)
  await page.goto(new URL(`/agents/${clonedAgent.id}`, BASE_URL).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })
  await page.waitForSelector('[data-testid="chat-area"]', { timeout: 30_000 })
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 30_000 })
  ;(summary.screenshots as Record<string, unknown>).chatLoaded = path.join(OUTPUT_DIR, 'chat-loaded.png')
  await page.screenshot({ path: summary.screenshots.chatLoaded as string, fullPage: true })
  ;(summary.steps as Array<Record<string, unknown>>).push({ name: 'open-chat', ok: true })

  const askHumanPrompt = [
    'Use the ask_human tool exactly once.',
    'Ask me for the code word and register a durable wait.',
    'Do not ask twice and do not continue after the wait is registered.',
  ].join(' ')
  const beforeAskHumanCount = getSession(thread.id).messages.length
  await sendChatMessage(page, askHumanPrompt)
  const humanLoopState = await waitFor(
    'human-loop registration',
    () => {
      const pendingHumanRequests = listPendingHumanRequests(thread.id)
      const activeMailboxWatchJobs = listActiveMailboxWatchJobs(thread.id)
      if (pendingHumanRequests.length !== 1 || activeMailboxWatchJobs.length !== 1) return null
      const session = getSession(thread.id)
      if (session.messages.length <= beforeAskHumanCount) return null
      return {
        pendingHumanRequests,
        activeMailboxWatchJobs,
        latestAssistantText: session.messages.filter((message) => message.role === 'assistant').slice(-1)[0]?.text || '',
      }
    },
    HUMAN_REPLY_TIMEOUT_MS,
    page,
  )
  ;(summary.steps as Array<Record<string, unknown>>).push({
    name: 'human-loop-request',
    ok: true,
    pendingHumanRequests: humanLoopState.pendingHumanRequests.length,
    activeMailboxWatchJobs: humanLoopState.activeMailboxWatchJobs.length,
  })

  await sendChatMessage(page, 'OAK')
  const afterReplyCount = getSession(thread.id).messages.length
  const replyResolvedState = await waitFor(
    'human-loop reply resolution',
    () => {
      const pendingHumanRequests = listPendingHumanRequests(thread.id)
      const activeMailboxWatchJobs = listActiveMailboxWatchJobs(thread.id)
      const session = getSession(thread.id)
      const assistantMessages = session.messages.filter((message) => message.role === 'assistant')
      const latestAssistant = assistantMessages[assistantMessages.length - 1]
      if (pendingHumanRequests.length !== 0 || activeMailboxWatchJobs.length !== 0) return null
      if (!latestAssistant || session.messages.length <= afterReplyCount) return null
      return {
        latestAssistantText: latestAssistant.text,
      }
    },
    HUMAN_REPLY_TIMEOUT_MS,
    page,
  )
  ;(summary.steps as Array<Record<string, unknown>>).push({
    name: 'human-loop-reply',
    ok: true,
    latestAssistantText: replyResolvedState.latestAssistantText,
  })

  const scheduleToken = `SCHEDULE_SMOKE_FIRED_${Date.now()}`
  const schedulePrompt = [
    'Use manage_schedules to create one once reminder about one minute from now.',
    `When it fires, reply in this chat with exactly this token: ${scheduleToken}.`,
    'Do not create duplicates.',
  ].join(' ')
  const scheduleStart = Date.now()
  await sendChatMessage(page, schedulePrompt)
  const createdSchedule = await waitFor(
    'schedule creation',
    () => {
      const schedules = listFixtureSchedules(clonedAgent.id, thread.id, scheduleStart - 5_000)
      if (schedules.length !== 1) return null
      return schedules[0]
    },
    HUMAN_REPLY_TIMEOUT_MS,
    page,
  )
  ;(summary.steps as Array<Record<string, unknown>>).push({
    name: 'schedule-created',
    ok: true,
    scheduleId: createdSchedule.id,
    scheduleType: createdSchedule.scheduleType,
    nextRunAt: createdSchedule.nextRunAt ?? null,
  })

  const scheduleFireCount = await waitFor(
    'schedule fire',
    () => {
      const count = countAssistantMessagesContaining(thread.id, scheduleToken)
      return count > 0 ? count : null
    },
    SCHEDULE_FIRE_TIMEOUT_MS,
    page,
  )
  if (scheduleFireCount !== 1) {
    throw new Error(`Expected exactly one schedule-fire message, saw ${scheduleFireCount}.`)
  }
  ;(summary.steps as Array<Record<string, unknown>>).push({
    name: 'schedule-fired',
    ok: true,
    token: scheduleToken,
  })

  ;(summary.screenshots as Record<string, unknown>).chatComplete = path.join(OUTPUT_DIR, 'chat-complete.png')
  await page.screenshot({ path: summary.screenshots.chatComplete as string, fullPage: true })

  summary.ok =
    (summary.steps as Array<Record<string, unknown>>).every((step) => step.ok === true)
    && (summary.consoleErrors as unknown[]).length === 0
    && (summary.pageErrors as unknown[]).length === 0
    && (summary.requestFailures as unknown[]).length === 0
    && (summary.badResponses as unknown[]).length === 0
  } catch (error) {
    summary.ok = false
    summary.error = error instanceof Error ? error.message : String(error)
    summary.failureUrl = page.url()
    summary.failureText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000)
    await captureFailure(page, OUTPUT_DIR, 'browser-agent-live-pass-failure')
    throw error
  } finally {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    await cleanupFixture(fixture).catch(() => {})
  }

  console.log(JSON.stringify(summary, null, 2))
}

void main()
