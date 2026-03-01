import { genId } from '@/lib/id'
import type { SSEEvent } from '@/types'
import { active, loadSessions } from './storage'
import { executeSessionChatTurn, type ExecuteChatTurnResult } from './chat-execution'
import { loadRuntimeSettings } from './runtime-settings'
import { log } from './logger'
import { handleMainLoopRunResult, type MainLoopFollowupRequest } from './main-agent-loop'

export type SessionRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type SessionQueueMode = 'followup' | 'steer' | 'collect'

export interface SessionRunRecord {
  id: string
  sessionId: string
  source: string
  internal: boolean
  mode: SessionQueueMode
  status: SessionRunStatus
  messagePreview: string
  dedupeKey?: string
  queuedAt: number
  startedAt?: number
  endedAt?: number
  error?: string
  resultPreview?: string
}

interface QueueEntry {
  executionKey: string
  run: SessionRunRecord
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  onEvents: Array<(event: SSEEvent) => void>
  signalController: AbortController
  maxRuntimeMs?: number
  modelOverride?: string
  heartbeatConfig?: { ackMaxChars: number; showOk: boolean; showAlerts: boolean; target: string | null }
  resolve: (value: ExecuteChatTurnResult) => void
  reject: (error: Error) => void
  promise: Promise<ExecuteChatTurnResult>
}

interface RuntimeState {
  runningByExecution: Map<string, QueueEntry>
  queueByExecution: Map<string, QueueEntry[]>
  runs: Map<string, SessionRunRecord>
  recentRunIds: string[]
  promises: Map<string, Promise<ExecuteChatTurnResult>>
}

const MAX_RECENT_RUNS = 500
const COLLECT_COALESCE_WINDOW_MS = 1500
const globalKey = '__swarmclaw_session_run_manager__' as const
const state: RuntimeState = (globalThis as any)[globalKey] ?? ((globalThis as any)[globalKey] = {
  runningByExecution: new Map<string, QueueEntry>(),
  queueByExecution: new Map<string, QueueEntry[]>(),
  runs: new Map<string, SessionRunRecord>(),
  recentRunIds: [],
  promises: new Map<string, Promise<ExecuteChatTurnResult>>(),
})

function now() {
  return Date.now()
}

function messagePreview(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 140)
}

function trimRecentRuns() {
  while (state.recentRunIds.length > MAX_RECENT_RUNS) {
    const id = state.recentRunIds.shift()
    if (!id) continue
    state.runs.delete(id)
    state.promises.delete(id)
  }
}

function registerRun(run: SessionRunRecord) {
  state.runs.set(run.id, run)
  state.recentRunIds.push(run.id)
  trimRecentRuns()
}

function emitToSubscribers(entry: QueueEntry, event: SSEEvent) {
  for (const send of entry.onEvents) {
    try {
      send(event)
    } catch {
      // Subscriber stream can be closed by the client.
    }
  }
}

function emitRunMeta(entry: QueueEntry, status: SessionRunStatus, extra?: Record<string, unknown>) {
  emitToSubscribers(entry, {
    t: 'md',
    text: JSON.stringify({
      run: {
        id: entry.run.id,
        sessionId: entry.run.sessionId,
        status,
        source: entry.run.source,
        internal: entry.run.internal,
        ...extra,
      },
    }),
  })
}

function executionKeyForSession(sessionId: string): string {
  return `session:${sessionId}`
}

function queueForExecution(executionKey: string): QueueEntry[] {
  const existing = state.queueByExecution.get(executionKey)
  if (existing) return existing
  const created: QueueEntry[] = []
  state.queueByExecution.set(executionKey, created)
  return created
}

function normalizeMode(mode: string | undefined, internal: boolean): SessionQueueMode {
  if (mode === 'steer' || mode === 'collect' || mode === 'followup') return mode
  return internal ? 'collect' : 'followup'
}

function cancelPendingForSession(sessionId: string, reason: string): number {
  let cancelled = 0
  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: QueueEntry[] = []
    for (const entry of queue) {
      if (entry.run.sessionId !== sessionId) {
        keep.push(entry)
        continue
      }
      entry.run.status = 'cancelled'
      entry.run.endedAt = now()
      entry.run.error = reason
      emitRunMeta(entry, 'cancelled', { reason })
      entry.reject(new Error(reason))
      cancelled++
    }
    if (keep.length > 0) state.queueByExecution.set(key, keep)
    else state.queueByExecution.delete(key)
  }
  return cancelled
}

export function cancelAllHeartbeatRuns(reason = 'Heartbeat disabled globally'): { cancelledQueued: number; abortedRunning: number } {
  let cancelledQueued = 0
  let abortedRunning = 0

  for (const [key, queue] of state.queueByExecution.entries()) {
    if (!queue.length) continue
    const keep: QueueEntry[] = []
    for (const entry of queue) {
      const isHeartbeat = entry.run.internal === true && entry.run.source === 'heartbeat'
      if (!isHeartbeat) {
        keep.push(entry)
        continue
      }
      entry.run.status = 'cancelled'
      entry.run.endedAt = now()
      entry.run.error = reason
      emitRunMeta(entry, 'cancelled', { reason })
      entry.reject(new Error(reason))
      cancelledQueued += 1
    }
    if (keep.length > 0) state.queueByExecution.set(key, keep)
    else state.queueByExecution.delete(key)
  }

  for (const entry of state.runningByExecution.values()) {
    const isHeartbeat = entry.run.internal === true && entry.run.source === 'heartbeat'
    if (!isHeartbeat) continue
    abortedRunning += 1
    entry.signalController.abort()
    try { active.get(entry.run.sessionId)?.kill?.() } catch { /* noop */ }
  }

  return { cancelledQueued, abortedRunning }
}

function scheduleMainLoopFollowup(sessionId: string, followup: MainLoopFollowupRequest) {
  const delayMs = Math.max(0, Math.trunc(followup.delayMs || 0))
  setTimeout(() => {
    try {
      const sessions = loadSessions()
      const session = sessions[sessionId]
      if (!session || session.name !== '__main__') return
      enqueueSessionRun({
        sessionId,
        message: followup.message,
        internal: true,
        source: 'main-loop-followup',
        mode: 'collect',
        dedupeKey: followup.dedupeKey,
      })
    } catch (err: any) {
      log.warn('session-run', `Failed to enqueue main-loop followup for ${sessionId}`, err?.message || String(err))
    }
  }, delayMs)
}

async function drainExecution(executionKey: string): Promise<void> {
  if (state.runningByExecution.has(executionKey)) return
  const q = queueForExecution(executionKey)
  const next = q.shift()
  if (!next) return

  state.runningByExecution.set(executionKey, next)
  next.run.status = 'running'
  next.run.startedAt = now()
  emitRunMeta(next, 'running')
  log.info('session-run', `Run started ${next.run.id}`, {
    sessionId: next.run.sessionId,
    source: next.run.source,
    internal: next.run.internal,
    mode: next.run.mode,
    timeoutMs: next.maxRuntimeMs || null,
  })

  let runtimeTimer: ReturnType<typeof setTimeout> | null = null
  if (next.maxRuntimeMs && next.maxRuntimeMs > 0) {
    runtimeTimer = setTimeout(() => {
      next.signalController.abort()
    }, next.maxRuntimeMs)
  }

  try {
    const result = await executeSessionChatTurn({
      sessionId: next.run.sessionId,
      message: next.message,
      imagePath: next.imagePath,
      imageUrl: next.imageUrl,
      attachedFiles: next.attachedFiles,
      internal: next.run.internal,
      source: next.run.source,
      runId: next.run.id,
      signal: next.signalController.signal,
      onEvent: (event) => emitToSubscribers(next, event),
      modelOverride: next.modelOverride,
      heartbeatConfig: next.heartbeatConfig,
    })

    const failed = !!result.error
    let followup: MainLoopFollowupRequest | null = null
    try {
      followup = handleMainLoopRunResult({
        sessionId: next.run.sessionId,
        message: next.message,
        internal: next.run.internal,
        source: next.run.source,
        resultText: result.text,
        error: result.error,
        toolEvents: result.toolEvents,
      })
    } catch (mainLoopErr: any) {
      log.warn('session-run', `Main-loop update failed for ${next.run.id}`, mainLoopErr?.message || String(mainLoopErr))
    }

    next.run.status = failed ? 'failed' : 'completed'
    next.run.endedAt = now()
    next.run.error = result.error
    next.run.resultPreview = result.text?.slice(0, 280)
    emitRunMeta(next, next.run.status, {
      persisted: result.persisted,
      hasText: !!result.text,
      error: result.error || null,
    })
    log.info('session-run', `Run finished ${next.run.id}`, {
      sessionId: next.run.sessionId,
      status: next.run.status,
      persisted: result.persisted,
      hasText: !!result.text,
      error: result.error || null,
      durationMs: (next.run.endedAt || now()) - (next.run.startedAt || now()),
    })
    next.resolve(result)
    if (!failed && followup) {
      scheduleMainLoopFollowup(next.run.sessionId, followup)
      log.info('session-run', `Queued main-loop followup after ${next.run.id}`, {
        sessionId: next.run.sessionId,
        delayMs: followup.delayMs,
      })
    }
  } catch (err: any) {
    const aborted = next.signalController.signal.aborted
    next.run.status = aborted ? 'cancelled' : 'failed'
    next.run.endedAt = now()
    next.run.error = err?.message || String(err)
    emitRunMeta(next, next.run.status, { error: next.run.error })
    log.error('session-run', `Run failed ${next.run.id}`, {
      sessionId: next.run.sessionId,
      status: next.run.status,
      error: next.run.error,
      durationMs: (next.run.endedAt || now()) - (next.run.startedAt || now()),
    })
    try {
      handleMainLoopRunResult({
        sessionId: next.run.sessionId,
        message: next.message,
        internal: next.run.internal,
        source: next.run.source,
        resultText: '',
        error: next.run.error,
        toolEvents: [],
      })
    } catch {
      // Main-loop bookkeeping failures should not affect queue execution.
    }
    next.reject(err instanceof Error ? err : new Error(next.run.error))
  } finally {
    if (runtimeTimer) clearTimeout(runtimeTimer)
    state.runningByExecution.delete(executionKey)
    void drainExecution(executionKey)
  }
}

function findDedupeMatch(sessionId: string, dedupeKey?: string): QueueEntry | null {
  if (!dedupeKey) return null
  const executionKey = executionKeyForSession(sessionId)
  const running = state.runningByExecution.get(executionKey)
  if (running?.run.sessionId === sessionId && running?.run.dedupeKey === dedupeKey) return running
  const q = queueForExecution(executionKey)
  return q.find((e) => e.run.sessionId === sessionId && e.run.dedupeKey === dedupeKey) || null
}

export interface EnqueueSessionRunInput {
  sessionId: string
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  internal?: boolean
  source?: string
  mode?: SessionQueueMode
  onEvent?: (event: SSEEvent) => void
  dedupeKey?: string
  maxRuntimeMs?: number
  modelOverride?: string
  heartbeatConfig?: { ackMaxChars: number; showOk: boolean; showAlerts: boolean; target: string | null }
}

export interface EnqueueSessionRunResult {
  runId: string
  position: number
  deduped?: boolean
  coalesced?: boolean
  promise: Promise<ExecuteChatTurnResult>
}

export function enqueueSessionRun(input: EnqueueSessionRunInput): EnqueueSessionRunResult {
  const internal = input.internal === true
  const mode = normalizeMode(input.mode, internal)
  const source = input.source || 'chat'
  const executionKey = executionKeyForSession(input.sessionId)
  const runtime = loadRuntimeSettings()
  const defaultMaxRuntimeMs = runtime.ongoingLoopMaxRuntimeMs ?? (10 * 60_000)
  const effectiveMaxRuntimeMs = typeof input.maxRuntimeMs === 'number'
    ? input.maxRuntimeMs
    : defaultMaxRuntimeMs

  const dedupe = findDedupeMatch(input.sessionId, input.dedupeKey)
  if (dedupe) {
    if (input.onEvent) dedupe.onEvents.push(input.onEvent)
    return {
      runId: dedupe.run.id,
      position: 0,
      deduped: true,
      promise: dedupe.promise,
    }
  }

  if (mode === 'steer') {
    const running = state.runningByExecution.get(executionKey)
    if (running && running.run.sessionId === input.sessionId) {
      running.signalController.abort()
      try { active.get(input.sessionId)?.kill?.() } catch { /* noop */ }
    }
    cancelPendingForSession(input.sessionId, 'Cancelled by steer mode')
  }

  const running = state.runningByExecution.get(executionKey)
  const q = queueForExecution(executionKey)
  if (mode === 'collect' && !input.imagePath && !input.imageUrl && !input.attachedFiles?.length) {
    const nowMs = now()
    const candidate = q.at(-1)
    const canCoalesce = !!candidate
      && candidate.run.mode === 'collect'
      && candidate.run.internal === internal
      && candidate.run.source === source
      && !candidate.imagePath
      && !candidate.imageUrl
      && !candidate.attachedFiles?.length
      && (nowMs - candidate.run.queuedAt) <= COLLECT_COALESCE_WINDOW_MS

    if (candidate && canCoalesce) {
      const nextChunk = input.message.trim()
      if (nextChunk) {
        const current = candidate.message.trim()
        candidate.message = current
          ? `${current}\n\n[Collected follow-up]\n${nextChunk}`
          : nextChunk
        candidate.run.messagePreview = messagePreview(candidate.message)
        candidate.run.queuedAt = nowMs
      }
      if (input.onEvent) candidate.onEvents.push(input.onEvent)
      emitRunMeta(candidate, 'queued', { position: 0, coalesced: true, mergedIntoRunId: candidate.run.id })
      return {
        runId: candidate.run.id,
        position: 0,
        coalesced: true,
        promise: candidate.promise,
      }
    }
  }

  const runId = genId(8)
  const run: SessionRunRecord = {
    id: runId,
    sessionId: input.sessionId,
    source,
    internal,
    mode,
    status: 'queued',
    messagePreview: messagePreview(input.message),
    dedupeKey: input.dedupeKey,
    queuedAt: now(),
  }
  registerRun(run)

  let resolve!: (value: ExecuteChatTurnResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ExecuteChatTurnResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  state.promises.set(runId, promise)

  const entry: QueueEntry = {
    executionKey,
    run,
    message: input.message,
    imagePath: input.imagePath,
    imageUrl: input.imageUrl,
    attachedFiles: input.attachedFiles,
    onEvents: input.onEvent ? [input.onEvent] : [],
    signalController: new AbortController(),
    maxRuntimeMs: effectiveMaxRuntimeMs > 0 ? effectiveMaxRuntimeMs : undefined,
    modelOverride: input.modelOverride,
    heartbeatConfig: input.heartbeatConfig,
    resolve,
    reject,
    promise,
  }

  q.push(entry)
  const position = (running ? 1 : 0) + q.length - 1
  emitRunMeta(entry, 'queued', { position })
  void drainExecution(executionKey)

  return { runId, position, promise }
}

export function getSessionRunState(sessionId: string): {
  runningRunId?: string
  queueLength: number
} {
  const executionKey = executionKeyForSession(sessionId)
  const running = state.runningByExecution.get(executionKey)
  const queued = queueForExecution(executionKey).filter((entry) => entry.run.sessionId === sessionId).length
  return {
    runningRunId: running?.run.sessionId === sessionId ? running.run.id : undefined,
    queueLength: queued,
  }
}

export function getRunById(runId: string): SessionRunRecord | null {
  return state.runs.get(runId) || null
}

export function listRuns(params?: {
  sessionId?: string
  status?: SessionRunStatus
  limit?: number
}): SessionRunRecord[] {
  const limit = Math.max(1, Math.min(1000, params?.limit ?? 200))
  const ordered = [...state.recentRunIds].reverse()
  const out: SessionRunRecord[] = []
  for (const id of ordered) {
    const run = state.runs.get(id)
    if (!run) continue
    if (params?.sessionId && run.sessionId !== params.sessionId) continue
    if (params?.status && run.status !== params.status) continue
    out.push(run)
    if (out.length >= limit) break
  }
  return out
}

export function cancelSessionRuns(sessionId: string, reason = 'Cancelled'): { cancelledQueued: number; cancelledRunning: boolean } {
  const executionKey = executionKeyForSession(sessionId)
  const running = state.runningByExecution.get(executionKey)
  let cancelledRunning = false
  if (running && running.run.sessionId === sessionId) {
    cancelledRunning = true
    running.signalController.abort()
    try { active.get(sessionId)?.kill?.() } catch { /* noop */ }
  }
  const cancelledQueued = cancelPendingForSession(sessionId, reason)
  return { cancelledQueued, cancelledRunning }
}
