/**
 * On-demand heartbeat wake — triggers an immediate heartbeat for an agent/session.
 * Requests are debounced with a short coalesce window, retain distinct trigger
 * events per target, and retry when the session lane is already busy.
 */

import { ensureAgentThreadSession } from '@/lib/server/agents/agent-thread-session'
import {
  buildAgentHeartbeatPrompt,
  heartbeatConfigForSession,
  isHeartbeatContentEffectivelyEmpty,
  readHeartbeatFile,
} from '@/lib/server/runtime/heartbeat-service'
import { buildMainLoopHeartbeatPrompt, isMainSession } from '@/lib/server/agents/main-agent-loop'
import { loadSessions, loadAgents, loadSettings } from '@/lib/server/storage'
import {
  enqueueSessionRun,
  getSessionExecutionState,
  hasActiveNonHeartbeatSessionLease,
  repairSessionRunQueue,
} from '@/lib/server/runtime/session-run-manager'
import { log } from '@/lib/server/logger'
import { isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'

export interface WakeRequestInput {
  eventId?: string
  agentId?: string
  sessionId?: string
  reason?: string
  source?: string
  resumeMessage?: string
  detail?: string
  requestedAt?: number
  occurredAt?: number
  priority?: number
  retryCount?: number
}

export interface WakeEvent {
  eventId?: string
  reason: string
  source?: string
  resumeMessage?: string
  detail?: string
  occurredAt: number
  priority: number
}

export interface WakeRequest {
  agentId?: string
  sessionId?: string
  requestedAt: number
  retryCount: number
  events: WakeEvent[]
}

const COALESCE_MS = 250
const RETRY_MS = 1_000
const MAX_WAKE_EVENTS = 6
const MAX_RESUME_CHARS = 280
const MAX_DETAIL_CHARS = 800
type WakeTimerKind = 'normal' | 'retry'

const state = hmrSingleton('__swarmclaw_heartbeat_wake__', () => ({
  pending: new Map<string, WakeRequest>(),
  timer: null as ReturnType<typeof setTimeout> | null,
  timerDueAt: null as number | null,
  timerKind: null as WakeTimerKind | null,
}))

function trimText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxChars) : undefined
}

function normalizeWakeReason(reason?: string): string {
  return trimText(reason, 80) || 'on-demand'
}

function normalizeWakeTarget(value?: string): string | undefined {
  return trimText(value, 160)
}

function normalizeOccurredAt(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Date.now()
}

function reasonPriority(reason: string): number {
  const normalized = reason.toLowerCase()
  if (/(approval|connector-message|webhook|watch_job|scheduled_wake|task-completed)/.test(normalized)) return 90
  if (/(schedule)/.test(normalized)) return 70
  if (/(comparison|manual|on-demand)/.test(normalized)) return 50
  return 40
}

function normalizeWakeEvent(input: WakeRequestInput): WakeEvent {
  const reason = normalizeWakeReason(input.reason)
  const explicitPriority = typeof input.priority === 'number' && Number.isFinite(input.priority)
    ? Math.trunc(input.priority)
    : reasonPriority(reason)
  return {
    ...(trimText(input.eventId, 160) ? { eventId: trimText(input.eventId, 160) } : {}),
    reason,
    ...(trimText(input.source, 120) ? { source: trimText(input.source, 120) } : {}),
    ...(trimText(input.resumeMessage, MAX_RESUME_CHARS) ? { resumeMessage: trimText(input.resumeMessage, MAX_RESUME_CHARS) } : {}),
    ...(trimText(input.detail, MAX_DETAIL_CHARS) ? { detail: trimText(input.detail, MAX_DETAIL_CHARS) } : {}),
    occurredAt: normalizeOccurredAt(input.occurredAt ?? input.requestedAt),
    priority: Math.max(0, Math.min(100, explicitPriority)),
  }
}

function uniqueWakeEvents(existing: WakeEvent[], incoming: WakeEvent): WakeEvent[] {
  const merged = [...existing]
  const matchIndex = merged.findIndex((candidate) => {
    if (candidate.eventId && incoming.eventId) return candidate.eventId === incoming.eventId
    return candidate.reason === incoming.reason
      && candidate.source === incoming.source
      && candidate.resumeMessage === incoming.resumeMessage
      && candidate.detail === incoming.detail
  })

  if (matchIndex >= 0) {
    const previous = merged[matchIndex]
    merged[matchIndex] = {
      ...previous,
      ...incoming,
      priority: Math.max(previous.priority, incoming.priority),
      occurredAt: Math.max(previous.occurredAt, incoming.occurredAt),
      resumeMessage: incoming.resumeMessage || previous.resumeMessage,
      detail: incoming.detail || previous.detail,
    }
  } else {
    merged.push(incoming)
  }

  merged.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority
    return right.occurredAt - left.occurredAt
  })
  return merged.slice(0, MAX_WAKE_EVENTS)
}

function wakeTargetKey(input: { agentId?: string; sessionId?: string }): string {
  return `${normalizeWakeTarget(input.agentId) || ''}::${normalizeWakeTarget(input.sessionId) || ''}`
}

export function mergeHeartbeatWakeRequest(
  existing: WakeRequest | undefined,
  next: WakeRequestInput,
): WakeRequest {
  const agentId = normalizeWakeTarget(next.agentId) || existing?.agentId
  const sessionId = normalizeWakeTarget(next.sessionId) || existing?.sessionId
  const requestedAt = Math.max(existing?.requestedAt || 0, normalizeOccurredAt(next.requestedAt))
  const retryCount = Math.max(existing?.retryCount || 0, typeof next.retryCount === 'number' ? Math.trunc(next.retryCount) : 0)
  const events = uniqueWakeEvents(existing?.events || [], normalizeWakeEvent(next))
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    requestedAt,
    retryCount,
    events,
  }
}

function queuePendingWake(next: WakeRequestInput): void {
  const key = wakeTargetKey(next)
  const existing = state.pending.get(key)
  state.pending.set(key, mergeHeartbeatWakeRequest(existing, next))
}

function queuePendingWakeRequest(next: WakeRequest): void {
  const key = wakeTargetKey(next)
  let merged = state.pending.get(key)
  for (const event of next.events) {
    merged = mergeHeartbeatWakeRequest(merged, {
      agentId: next.agentId,
      sessionId: next.sessionId,
      requestedAt: next.requestedAt,
      retryCount: next.retryCount,
      eventId: event.eventId,
      reason: event.reason,
      source: event.source,
      resumeMessage: event.resumeMessage,
      detail: event.detail,
      occurredAt: event.occurredAt,
      priority: event.priority,
    })
  }
  if (merged) state.pending.set(key, merged)
}

function scheduleFlush(delayMs: number, kind: WakeTimerKind = 'normal'): void {
  const delay = Math.max(0, Number.isFinite(delayMs) ? Math.trunc(delayMs) : COALESCE_MS)
  const dueAt = Date.now() + delay
  if (state.timer) {
    if (state.timerKind === 'retry' && kind !== 'normal') return
    if (typeof state.timerDueAt === 'number' && state.timerDueAt <= dueAt) return
    clearTimeout(state.timer)
    state.timer = null
    state.timerDueAt = null
    state.timerKind = null
  }

  state.timerDueAt = dueAt
  state.timerKind = kind
  state.timer = setTimeout(() => {
    flushWakes()
  }, delay)
}

function isScheduleLikeWake(wake: WakeRequest): boolean {
  return wake.events.some((event) => {
    const reason = event.reason.toLowerCase()
    return reason.includes('schedule')
  })
}

export function buildWakeTriggerContext(events: WakeEvent[], nowIso?: string): string {
  const lines = [
    '## Wake Trigger Context',
    `Triggered at: ${nowIso || new Date().toISOString()}`,
    'These new events caused this immediate wake. Prioritize them over generic background polling and avoid repeating already-completed work.',
    'If the base heartbeat instructions require an exact file change or exact acknowledgment phrase, follow that exactly and do not add extra commentary.',
  ]
  for (const event of events.slice(0, MAX_WAKE_EVENTS)) {
    const tags = [
      `reason=${event.reason}`,
      event.source ? `source=${event.source}` : '',
      `priority=${event.priority}`,
      `at=${new Date(event.occurredAt).toISOString()}`,
    ].filter(Boolean).join(' | ')
    lines.push(`- ${tags}`)
    if (event.resumeMessage) lines.push(`  Resume: ${event.resumeMessage}`)
    if (event.detail) lines.push(`  Detail: ${event.detail}`)
  }
  lines.push('Reply HEARTBEAT_OK only if every trigger above is already handled or truly needs no action.')
  return lines.join('\n')
}

export function deriveHeartbeatWakeDeliveryMode(
  events: WakeEvent[],
): 'default' | 'tool_only' | 'silent' {
  if (events.some((event) => event.reason.toLowerCase() === 'connector-message')) {
    return 'tool_only'
  }
  if (events.length > 0 && events.every((event) => event.reason.toLowerCase().includes('schedule'))) {
    return 'silent'
  }
  return 'default'
}

export function buildHeartbeatWakePrompt(input: {
  wake: WakeRequest
  basePrompt?: string
  nowIso?: string
}): string {
  const triggerContext = buildWakeTriggerContext(input.wake.events, input.nowIso)
  if (input.basePrompt?.trim()) {
    return [
      input.basePrompt.trim(),
      '',
      triggerContext,
    ].join('\n')
  }
  return [
    'AGENT_HEARTBEAT_WAKE',
    `Time: ${input.nowIso || new Date().toISOString()}`,
    triggerContext,
    'Take the highest-value next step now, or reply HEARTBEAT_OK if nothing needs attention.',
  ].join('\n')
}

function resolveWakeSessionId(
  wake: WakeRequest,
  sessions: Record<string, Record<string, unknown>>,
): string | undefined {
  if (wake.sessionId) return wake.sessionId
  if (!wake.agentId) return undefined
  if (isScheduleLikeWake(wake)) {
    for (const session of Object.values(sessions)) {
      if (session.agentId !== wake.agentId) continue
      if (isMainSession(session)) return String(session.id)
    }
    return ensureAgentThreadSession(wake.agentId)?.id
  }

  let bestSession: { id: string; lastActiveAt: number } | null = null
  for (const session of Object.values(sessions)) {
    if (session.agentId !== wake.agentId) continue
    const lastActive = typeof session.lastActiveAt === 'number' ? session.lastActiveAt : 0
    if (!bestSession || lastActive > bestSession.lastActiveAt) {
      bestSession = { id: String(session.id), lastActiveAt: lastActive }
    }
  }
  if (bestSession?.id) return bestSession.id
  return ensureAgentThreadSession(wake.agentId)?.id
}

export function resolveWakeSessionIdForTests(
  wake: WakeRequest,
  sessions: Record<string, Record<string, unknown>>,
): string | undefined {
  return resolveWakeSessionId(wake, sessions)
}

function flushWakes(): void {
  state.timer = null
  state.timerDueAt = null
  state.timerKind = null
  const wakes = [...state.pending.values()]
  state.pending.clear()

  if (!wakes.length) return

  const agents = loadAgents()
  const settings = loadSettings()
  const sessions = loadSessions() as unknown as Record<string, Record<string, unknown>>
  let delayedForRetry = false

  for (const wake of wakes) {
    try {
      const sessionId = resolveWakeSessionId(wake, sessions)
      if (!sessionId) continue

      const session = (sessions[sessionId] || loadSessions()[sessionId]) as unknown as Record<string, unknown> | undefined
      if (!session) continue

      let execution = getSessionExecutionState(sessionId)
      const sharedNonHeartbeatBusy = hasActiveNonHeartbeatSessionLease(sessionId)
      if (execution.hasQueued && !execution.hasRunning && !sharedNonHeartbeatBusy) {
        const repair = repairSessionRunQueue(sessionId, {
          reason: 'Recovered stale queued run before heartbeat wake',
        })
        if (repair.recoveredQueuedRuns > 0 || repair.kickedExecutionKeys > 0) {
          execution = getSessionExecutionState(sessionId)
        }
      }
      if (execution.hasRunning || execution.hasQueued || sharedNonHeartbeatBusy) {
        queuePendingWakeRequest({
          ...wake,
          sessionId,
          retryCount: wake.retryCount + 1,
        })
        delayedForRetry = true
        log.info('heartbeat-wake', `Wake delayed for busy session ${sessionId}`, {
          running: execution.hasRunning,
          queued: execution.queueLength,
          sharedNonHeartbeatBusy,
        })
        continue
      }

      const agentId = (session.agentId || wake.agentId) as string | undefined
      const agent = agentId ? agents[agentId] as unknown as Record<string, unknown> | null : null
      // Skip sessions whose agent was deleted or trashed (not in loadAgents())
      if (agentId && !agent) continue
      if (isAgentDisabled(agent)) continue

      const cfg = heartbeatConfigForSession(session, settings, agents)
      if (!cfg.enabled) {
        log.info('heartbeat-wake', `Wake skipped for session ${sessionId}: heartbeat disabled`, {
          agentId,
        })
        continue
      }
      const rawHeartbeatFileContent = readHeartbeatFile(session)
      const heartbeatFileContent = isHeartbeatContentEffectivelyEmpty(rawHeartbeatFileContent) ? '' : rawHeartbeatFileContent
      const baseHeartbeatPrompt = buildAgentHeartbeatPrompt(session, agent, cfg.prompt, heartbeatFileContent)
      const promptCore = isMainSession(session)
        ? buildMainLoopHeartbeatPrompt(session, baseHeartbeatPrompt)
        : baseHeartbeatPrompt
      const prompt = buildHeartbeatWakePrompt({
        wake,
        basePrompt: promptCore,
      })

      enqueueSessionRun({
        sessionId,
        message: prompt,
        internal: true,
        source: 'heartbeat-wake',
        mode: 'collect',
        dedupeKey: `heartbeat-wake:${sessionId}`,
        modelOverride: cfg.model || undefined,
        heartbeatConfig: {
          ackMaxChars: cfg.ackMaxChars,
          showOk: cfg.showOk,
          showAlerts: cfg.showAlerts,
          target: cfg.target,
          deliveryMode: deriveHeartbeatWakeDeliveryMode(wake.events),
        },
      })

      log.info('heartbeat-wake', `Wake fired for session ${sessionId}`, {
        reasons: wake.events.map((event: WakeEvent) => event.reason),
        retryCount: wake.retryCount,
      })
    } catch (err: unknown) {
      queuePendingWakeRequest({
        ...wake,
        retryCount: wake.retryCount + 1,
      })
      delayedForRetry = true
      log.warn('heartbeat-wake', `Wake failed: ${errorMessage(err)}`)
    }
  }

  if (delayedForRetry && state.pending.size > 0) {
    scheduleFlush(RETRY_MS, 'retry')
  }
}

/** Queue a heartbeat wake. Multiple rapid calls are coalesced into a single flush. */
export function requestHeartbeatNow(opts: WakeRequestInput): void {
  queuePendingWake(opts)
  scheduleFlush(COALESCE_MS, 'normal')
}

export function resetHeartbeatWakeStateForTests(): void {
  if (state.timer) clearTimeout(state.timer)
  state.timer = null
  state.timerDueAt = null
  state.timerKind = null
  state.pending.clear()
}

export function hasPendingHeartbeatWake(): boolean {
  return state.pending.size > 0 || Boolean(state.timer)
}

export function snapshotPendingHeartbeatWakesForTests(): WakeRequest[] {
  return [...state.pending.values()].map((wake) => ({
    ...wake,
    events: wake.events.map((event: WakeEvent) => ({ ...event })),
  }))
}
