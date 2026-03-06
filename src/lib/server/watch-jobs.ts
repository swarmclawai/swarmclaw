import crypto from 'crypto'
import fs from 'fs'
import * as cheerio from 'cheerio'
import { genId } from '@/lib/id'
import type { MailboxEnvelope, WatchJob } from '@/types'
import { requestHeartbeatNow } from './heartbeat-wake'
import { enqueueSystemEvent } from './system-events'
import { loadApprovals, loadTasks, loadWatchJobs, upsertWatchJob, upsertWatchJobs } from './storage'
import { notify } from './ws-hub'
import { fetchMailboxMessages, getMailboxHighwaterUid } from './mailbox-utils'

export interface CreateWatchJobInput {
  type: WatchJob['type']
  sessionId?: string | null
  agentId?: string | null
  createdByAgentId?: string | null
  browserProfileId?: string | null
  description?: string | null
  resumeMessage: string
  target: Record<string, unknown>
  condition: Record<string, unknown>
  runAt?: number | null
  intervalMs?: number | null
  timeoutAt?: number | null
}

function now() {
  return Date.now()
}

function hashContent(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex')
}

function cleanHtmlToText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript').remove()
  return $('body').text().replace(/\s+/g, ' ').trim()
}

function matchesRegex(body: string, pattern: unknown): boolean {
  if (typeof pattern !== 'string' || !pattern.trim()) return false
  try {
    return new RegExp(pattern, 'i').test(body)
  } catch {
    return false
  }
}

function scheduleNextCheck(job: WatchJob, at = now()): WatchJob {
  const intervalMs = typeof job.intervalMs === 'number' && job.intervalMs > 0 ? job.intervalMs : 60_000
  return {
    ...job,
    nextCheckAt: at + intervalMs,
    updatedAt: at,
  }
}

function notifyWatchJobsChanged() {
  notify('watch_jobs')
}

function finalizeWatchJob(job: WatchJob, status: WatchJob['status'], result?: Record<string, unknown> | null, error?: string | null): WatchJob {
  const updated: WatchJob = {
    ...job,
    status,
    result: result ?? job.result ?? null,
    lastError: error ?? null,
    lastTriggeredAt: status === 'triggered' ? now() : job.lastTriggeredAt ?? null,
    updatedAt: now(),
  }
  upsertWatchJob(updated.id, updated)
  notifyWatchJobsChanged()
  return updated
}

function wakeFromWatch(job: WatchJob, result?: Record<string, unknown> | null) {
  const summary = job.description || `Watch ${job.id}`
  const detail = result ? JSON.stringify(result).slice(0, 1200) : ''
  if (job.sessionId) {
    enqueueSystemEvent(
      job.sessionId,
      `[Watch Triggered] ${summary}\n${job.resumeMessage}${detail ? `\n\nObserved:\n${detail}` : ''}`,
    )
    requestHeartbeatNow({ sessionId: job.sessionId, reason: 'watch_job' })
  } else if (job.agentId) {
    requestHeartbeatNow({ agentId: job.agentId, reason: 'watch_job' })
  }
}

export async function createWatchJob(input: CreateWatchJobInput): Promise<WatchJob> {
  if (input.type === 'time' && typeof input.runAt !== 'number') {
    throw new Error('Time watches require runAt or delayMinutes.')
  }
  if ((input.type === 'http' || input.type === 'page') && typeof input.target?.url !== 'string') {
    throw new Error(`${input.type} watches require a url target.`)
  }
  if (input.type === 'file' && typeof input.target?.path !== 'string') {
    throw new Error('File watches require a path target.')
  }
  if (input.type === 'task' && typeof input.target?.taskId !== 'string') {
    throw new Error('Task watches require a taskId target.')
  }
  if (input.type === 'webhook' && typeof input.target?.webhookId !== 'string') {
    throw new Error('Webhook watches require a webhookId target.')
  }
  if (input.type === 'email' && typeof input.target?.folder !== 'string' && typeof input.target?.folder !== 'undefined') {
    throw new Error('Email watches expect a string folder when provided.')
  }
  if (input.type === 'mailbox' && typeof input.target?.sessionId !== 'string') {
    throw new Error('Mailbox watches require a sessionId target.')
  }
  if (input.type === 'approval' && typeof input.target?.approvalId !== 'string') {
    throw new Error('Approval watches require an approvalId target.')
  }
  const createdAt = now()
  const job: WatchJob = {
    id: genId(10),
    type: input.type,
    status: 'active',
    description: input.description || null,
    sessionId: input.sessionId || null,
    agentId: input.agentId || null,
    createdByAgentId: input.createdByAgentId || null,
    browserProfileId: input.browserProfileId || null,
    resumeMessage: input.resumeMessage,
    target: { ...(input.target || {}) },
    condition: { ...(input.condition || {}) },
    runAt: input.runAt ?? null,
    nextCheckAt: input.runAt ?? createdAt,
    intervalMs: input.intervalMs ?? (input.type === 'time' ? null : 60_000),
    timeoutAt: input.timeoutAt ?? null,
    lastCheckedAt: null,
    lastTriggeredAt: null,
    lastError: null,
    result: null,
    createdAt,
    updatedAt: createdAt,
  }

  // Capture initial baselines for change watches.
  if ((job.type === 'http' || job.type === 'page') && typeof job.target.url === 'string' && job.condition.changed === true) {
    try {
      const res = await fetch(job.target.url, { signal: AbortSignal.timeout(15_000) })
      if (res.ok) {
        const text = job.type === 'page'
          ? cleanHtmlToText(await res.text())
          : await res.text()
        job.target = { ...job.target, baselineHash: hashContent(text) }
      }
    } catch {
      // Baseline creation is best-effort; the watch can still run later.
    }
  }

  if (job.type === 'file' && typeof job.target.path === 'string' && job.condition.changed === true) {
    try {
      if (fs.existsSync(job.target.path)) {
        const text = fs.readFileSync(job.target.path, 'utf8')
        job.target = { ...job.target, baselineHash: hashContent(text) }
      }
    } catch {
      // Best-effort baseline only.
    }
  }

  if (job.type === 'email') {
    try {
      const baselineUid = await getMailboxHighwaterUid(undefined, typeof job.target.folder === 'string' ? job.target.folder : undefined)
      job.target = {
        ...job.target,
        baselineUid,
      }
    } catch {
      // best-effort baseline only
    }
  }

  upsertWatchJob(job.id, job)
  notifyWatchJobsChanged()
  return job
}

export function cancelWatchJob(id: string): WatchJob | null {
  const all = loadWatchJobs()
  const current = all[id]
  if (!current || typeof current !== 'object') return null
  return finalizeWatchJob(current as WatchJob, 'cancelled', null, null)
}

export function getWatchJob(id: string): WatchJob | null {
  const all = loadWatchJobs()
  const current = all[id]
  if (!current || typeof current !== 'object') return null
  return current as WatchJob
}

export function listWatchJobs(filter?: { sessionId?: string | null; status?: WatchJob['status'] | null }): WatchJob[] {
  return Object.values(loadWatchJobs())
    .filter((job): job is WatchJob => !!job && typeof job === 'object')
    .filter((job) => !filter?.sessionId || job.sessionId === filter.sessionId)
    .filter((job) => !filter?.status || job.status === filter.status)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

async function evaluateHttpLikeJob(job: WatchJob, asPage: boolean): Promise<{ triggered: boolean; result: Record<string, unknown> }> {
  const url = typeof job.target.url === 'string' ? job.target.url : ''
  if (!url) return { triggered: false, result: { error: 'Missing url' } }
  const startedAt = Date.now()
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  const latencyMs = Date.now() - startedAt
  const raw = await res.text()
  const body = asPage ? cleanHtmlToText(raw) : raw
  const bodyHash = hashContent(body)
  const containsText = typeof job.condition.containsText === 'string' ? job.condition.containsText : ''
  const textGone = typeof job.condition.textGone === 'string' ? job.condition.textGone : ''
  const statusEquals = typeof job.condition.status === 'number' ? job.condition.status : null
  const statusIn = Array.isArray(job.condition.statusIn)
    ? job.condition.statusIn.filter((value): value is number => typeof value === 'number')
    : []
  const changed = job.condition.changed === true
  const latencyThreshold = typeof job.condition.threshold === 'number' ? job.condition.threshold : null
  const baselineHash = typeof job.target.baselineHash === 'string' ? job.target.baselineHash : ''
  const regexMatched = matchesRegex(body, job.condition.regex)
  const triggered =
    (statusEquals !== null && res.status === statusEquals)
    || (statusIn.length > 0 && statusIn.includes(res.status))
    || (!!containsText && body.includes(containsText))
    || (!!textGone && !body.includes(textGone))
    || regexMatched
    || (!!changed && !!baselineHash && baselineHash !== bodyHash)
    || (latencyThreshold !== null && latencyMs >= latencyThreshold)
  return {
    triggered,
    result: {
      url,
      status: res.status,
      latencyMs,
      containsText: containsText || undefined,
      regex: typeof job.condition.regex === 'string' ? job.condition.regex : undefined,
      changed: changed || undefined,
      bodyHash,
      preview: body.slice(0, 1200),
    },
  }
}

function evaluateFileJob(job: WatchJob): { triggered: boolean; result: Record<string, unknown> } {
  const targetPath = typeof job.target.path === 'string' ? job.target.path : ''
  if (!targetPath) return { triggered: false, result: { error: 'Missing path' } }
  const exists = fs.existsSync(targetPath)
  const expectExists = job.condition.exists !== false
  const containsText = typeof job.condition.containsText === 'string' ? job.condition.containsText : ''
  const changed = job.condition.changed === true
  let text = ''
  let bodyHash = ''
  try {
    if (exists) {
      text = fs.readFileSync(targetPath, 'utf8')
      bodyHash = hashContent(text)
    }
  } catch {
    text = ''
  }
  const baselineHash = typeof job.target.baselineHash === 'string' ? job.target.baselineHash : ''
  const triggered =
    exists === expectExists
    && (!containsText || text.includes(containsText))
    && (!job.condition.regex || matchesRegex(text, job.condition.regex))
    && (!changed || (!!baselineHash && baselineHash !== bodyHash))
  return {
    triggered,
    result: {
      path: targetPath,
      exists,
      regex: typeof job.condition.regex === 'string' ? job.condition.regex : undefined,
      bodyHash: bodyHash || undefined,
      preview: text.slice(0, 1200),
    },
  }
}

function evaluateTaskJob(job: WatchJob): { triggered: boolean; result: Record<string, unknown> } {
  const taskId = typeof job.target.taskId === 'string' ? job.target.taskId : ''
  if (!taskId) return { triggered: false, result: { error: 'Missing taskId' } }
  const tasks = loadTasks()
  const task = tasks[taskId] as Record<string, unknown> | undefined
  const statuses = Array.isArray(job.condition.statusIn)
    ? job.condition.statusIn.filter((value): value is string => typeof value === 'string')
    : ['completed', 'failed']
  const currentStatus = typeof task?.status === 'string' ? task.status : 'missing'
  return {
    triggered: statuses.includes(currentStatus),
    result: {
      taskId,
      status: currentStatus,
      title: typeof task?.title === 'string' ? task.title : null,
      result: typeof task?.result === 'string' ? task.result.slice(0, 1000) : null,
      error: typeof task?.error === 'string' ? task.error : null,
    },
  }
}

async function evaluateWatchJob(job: WatchJob): Promise<{ triggered: boolean; result: Record<string, unknown> }> {
  if (job.type === 'time') {
    const runAt = typeof job.runAt === 'number' ? job.runAt : 0
    return { triggered: runAt > 0 && runAt <= now(), result: { runAt } }
  }
  if (job.type === 'http') return evaluateHttpLikeJob(job, false)
  if (job.type === 'page') return evaluateHttpLikeJob(job, true)
  if (job.type === 'file') return evaluateFileJob(job)
  if (job.type === 'task') return evaluateTaskJob(job)
  if (job.type === 'email') {
    const folder = typeof job.target.folder === 'string' ? job.target.folder : undefined
    const messages = await fetchMailboxMessages({
      folder,
      from: typeof job.condition.from === 'string' ? job.condition.from : undefined,
      subjectContains: typeof job.condition.subjectContains === 'string' ? job.condition.subjectContains : undefined,
      bodyContains: typeof job.condition.containsText === 'string' ? job.condition.containsText : undefined,
      query: typeof job.condition.query === 'string' ? job.condition.query : undefined,
      unreadOnly: job.condition.unreadOnly === true,
      hasAttachments: job.condition.hasAttachments === true,
      uidGreaterThan: typeof job.target.baselineUid === 'number' ? job.target.baselineUid : undefined,
      limit: 20,
    })
    const match = messages[0]
    return {
      triggered: !!match,
      result: match
        ? {
            uid: match.uid,
            from: match.from,
            subject: match.subject,
            snippet: match.snippet,
            attachmentCount: match.attachments.length,
            messageId: match.messageId,
          }
        : {
            folder: folder || 'INBOX',
            baselineUid: typeof job.target.baselineUid === 'number' ? job.target.baselineUid : null,
          },
    }
  }
  return { triggered: false, result: { note: 'Webhook waits are triggered by inbound webhook delivery.' } }
}

export async function processDueWatchJobs(timestamp = now()): Promise<{ checked: number; triggered: number; failed: number }> {
  const all = listWatchJobs({ status: 'active' })
  let checked = 0
  let triggered = 0
  let failed = 0
  const updates: Array<[string, WatchJob]> = []

  for (const job of all) {
    if (typeof job.timeoutAt === 'number' && job.timeoutAt > 0 && job.timeoutAt <= timestamp) {
      failed += 1
      updates.push([job.id, {
        ...job,
        status: 'failed',
        lastError: 'Watch timed out before condition was met.',
        updatedAt: timestamp,
      }])
      continue
    }
    if (typeof job.nextCheckAt === 'number' && job.nextCheckAt > timestamp) continue
    if (job.type === 'webhook' || job.type === 'mailbox' || job.type === 'approval') continue

    checked += 1
    try {
      const evaluation = await evaluateWatchJob(job)
      if (evaluation.triggered) {
        triggered += 1
        const completed = {
          ...job,
          status: 'triggered' as const,
          result: evaluation.result,
          lastError: null,
          lastCheckedAt: timestamp,
          lastTriggeredAt: timestamp,
          updatedAt: timestamp,
        }
        updates.push([job.id, completed])
        wakeFromWatch(completed, evaluation.result)
      } else {
        updates.push([job.id, scheduleNextCheck({
          ...job,
          lastCheckedAt: timestamp,
          result: evaluation.result,
        }, timestamp)])
      }
    } catch (err: unknown) {
      failed += 1
      updates.push([job.id, scheduleNextCheck({
        ...job,
        lastCheckedAt: timestamp,
        lastError: err instanceof Error ? err.message : String(err),
      }, timestamp)])
    }
  }

  if (updates.length > 0) {
    upsertWatchJobs(updates)
    notifyWatchJobsChanged()
  }

  return { checked, triggered, failed }
}

export function triggerWebhookWatchJobs(params: {
  webhookId: string
  event: string
  payloadPreview?: string
}): WatchJob[] {
  const matches = listWatchJobs({ status: 'active' }).filter((job) => {
    if (job.type !== 'webhook') return false
    const watchWebhookId = typeof job.target.webhookId === 'string' ? job.target.webhookId : ''
    if (watchWebhookId !== params.webhookId) return false
    const expectedEvent = typeof job.condition.event === 'string' ? job.condition.event.trim() : ''
    return !expectedEvent || expectedEvent === params.event
  })

  const updated = matches.map((job) => {
    const next: WatchJob = {
      ...job,
      status: 'triggered',
      result: {
        webhookId: params.webhookId,
        event: params.event,
        payloadPreview: params.payloadPreview?.slice(0, 1200) || '',
      },
      lastTriggeredAt: now(),
      updatedAt: now(),
    }
    wakeFromWatch(next, next.result || null)
    return [next.id, next] as [string, WatchJob]
  })

  if (updated.length > 0) {
    upsertWatchJobs(updated)
    notifyWatchJobsChanged()
  }

  return updated.map(([, job]) => job)
}

export function triggerMailboxWatchJobs(params: {
  sessionId: string
  envelope: MailboxEnvelope
}): WatchJob[] {
  const matches = listWatchJobs({ status: 'active' }).filter((job) => {
    if (job.type !== 'mailbox') return false
    const targetSessionId = typeof job.target.sessionId === 'string' ? job.target.sessionId : ''
    if (targetSessionId !== params.sessionId) return false
    const expectedType = typeof job.condition.type === 'string' ? job.condition.type.trim() : ''
    const correlationId = typeof job.condition.correlationId === 'string' ? job.condition.correlationId.trim() : ''
    const fromSessionId = typeof job.condition.fromSessionId === 'string' ? job.condition.fromSessionId.trim() : ''
    const payloadContains = typeof job.condition.containsText === 'string' ? job.condition.containsText.trim() : ''
    if (expectedType && params.envelope.type !== expectedType) return false
    if (correlationId && params.envelope.correlationId !== correlationId) return false
    if (fromSessionId && params.envelope.fromSessionId !== fromSessionId) return false
    if (payloadContains && !params.envelope.payload.includes(payloadContains)) return false
    return true
  })

  const updated = matches.map((job) => {
    const next: WatchJob = {
      ...job,
      status: 'triggered',
      result: {
        envelopeId: params.envelope.id,
        type: params.envelope.type,
        correlationId: params.envelope.correlationId || null,
        payload: params.envelope.payload.slice(0, 1200),
        fromSessionId: params.envelope.fromSessionId || null,
      },
      lastTriggeredAt: now(),
      updatedAt: now(),
    }
    wakeFromWatch(next, next.result || null)
    return [next.id, next] as [string, WatchJob]
  })

  if (updated.length > 0) {
    upsertWatchJobs(updated)
    notifyWatchJobsChanged()
  }

  return updated.map(([, job]) => job)
}

export function triggerApprovalWatchJobs(params: {
  approvalId: string
  status: 'approved' | 'rejected'
  title?: string
  description?: string
}): WatchJob[] {
  const approvals = loadApprovals()
  const approval = approvals[params.approvalId] as Record<string, unknown> | undefined
  const matches = listWatchJobs({ status: 'active' }).filter((job) => {
    if (job.type !== 'approval') return false
    const targetApprovalId = typeof job.target.approvalId === 'string' ? job.target.approvalId : ''
    if (targetApprovalId !== params.approvalId) return false
    const statuses = Array.isArray(job.condition.statusIn)
      ? job.condition.statusIn.filter((value): value is string => typeof value === 'string')
      : ['approved']
    return statuses.includes(params.status)
  })

  const updated = matches.map((job) => {
    const next: WatchJob = {
      ...job,
      status: 'triggered',
      result: {
        approvalId: params.approvalId,
        status: params.status,
        title: params.title || (typeof approval?.title === 'string' ? approval.title : null),
        description: params.description || (typeof approval?.description === 'string' ? approval.description : null),
      },
      lastTriggeredAt: now(),
      updatedAt: now(),
    }
    wakeFromWatch(next, next.result || null)
    return [next.id, next] as [string, WatchJob]
  })

  if (updated.length > 0) {
    upsertWatchJobs(updated)
    notifyWatchJobsChanged()
  }

  return updated.map(([, job]) => job)
}
