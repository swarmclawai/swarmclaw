import { genId } from '@/lib/id'
import { z } from 'zod'
import type { GoalContract, MessageToolEvent } from '@/types'
import { loadSessions, saveSessions, loadAgents, saveAgents, loadTasks, saveTasks } from './storage'
import { log } from './logger'
import { getMemoryDb } from './memory-db'
import {
  mergeGoalContracts,
  parseGoalContractFromText,
  parseMainLoopPlan,
  parseMainLoopReview,
} from './autonomy-contract'

const MAIN_SESSION_NAME = '__main__'
const MAX_PENDING_EVENTS = 40
const MAX_TIMELINE_EVENTS = 80
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MEMORY_NOTE_MIN_INTERVAL_MS = 90 * 60 * 1000
const DEFAULT_FOLLOWUP_DELAY_SEC = 45
const MAX_FOLLOWUP_CHAIN = 6
const META_LINE_RE = /\[MAIN_LOOP_META\]\s*(\{[^\n]*\})/i
const AGENT_HEARTBEAT_META_RE = /\[AGENT_HEARTBEAT_META\]\s*(\{[^\n]*\})/i
const SCREENSHOT_GOAL_HINT = /\b(screenshot|screen shot|snapshot|capture)\b/i
const DELIVERY_GOAL_HINT = /\b(send|deliver|return|share|upload|post|message)\b/i
const SCHEDULE_GOAL_HINT = /\b(schedule|scheduled|every\s+\w+|interval|cron|recurr)\b/i
const UPLOAD_ARTIFACT_HINT = /(?:sandbox:)?\/api\/uploads\/[^\s)\]]+|https?:\/\/[^\s)\]]+\.(?:png|jpe?g|webp|gif|pdf)\b/i
const SENT_ARTIFACT_HINT = /\b(sent|shared|uploaded|returned)\b[^.]*\b(screenshot|snapshot|image|file)\b/i

interface MainLoopSessionMessageLike {
  text?: string
}

interface MainLoopSessionEvidenceLike {
  messages?: MainLoopSessionMessageLike[]
}

export interface MainLoopEvent {
  id: string
  type: string
  text: string
  createdAt: number
}

export interface MainLoopTimelineEntry {
  id: string
  at: number
  source: string
  note: string
  status?: 'idle' | 'progress' | 'blocked' | 'ok'
}

export interface MainLoopState {
  goal: string | null
  goalContract: GoalContract | null
  status: 'idle' | 'progress' | 'blocked' | 'ok'
  summary: string | null
  nextAction: string | null
  planSteps: string[]
  currentPlanStep: string | null
  reviewNote: string | null
  reviewConfidence: number | null
  missionTaskId: string | null
  momentumScore: number
  paused: boolean
  autonomyMode: 'assist' | 'autonomous'
  pendingEvents: MainLoopEvent[]
  timeline: MainLoopTimelineEntry[]
  followupChainCount: number
  metaMissCount: number
  workingMemoryNotes: string[]
  lastMemoryNoteAt: number | null
  lastPlannedAt: number | null
  lastReviewedAt: number | null
  lastTickAt: number | null
  updatedAt: number
}

interface MainLoopMeta {
  status?: 'idle' | 'progress' | 'blocked' | 'ok'
  summary?: string
  next_action?: string
  follow_up?: boolean
  delay_sec?: number
  goal?: string
  consume_event_ids?: string[]
}

export interface MainLoopFollowupRequest {
  message: string
  delayMs: number
  dedupeKey: string
}

export interface PushMainLoopEventInput {
  type: string
  text: string
  user?: string | null
}

export interface HandleMainLoopRunResultInput {
  sessionId: string
  message: string
  internal: boolean
  source: string
  resultText: string
  error?: string
  toolEvents?: MessageToolEvent[]
}

function toOneLine(value: string, max = 240): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeMemoryText(value: string): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function pruneEvents(events: MainLoopEvent[], now = Date.now()): MainLoopEvent[] {
  const minTs = now - EVENT_TTL_MS
  const fresh = events.filter((e) => e && typeof e.createdAt === 'number' && e.createdAt >= minTs)
  if (fresh.length <= MAX_PENDING_EVENTS) return fresh
  return fresh.slice(fresh.length - MAX_PENDING_EVENTS)
}

function pruneTimeline(entries: MainLoopTimelineEntry[], now = Date.now()): MainLoopTimelineEntry[] {
  const minTs = now - EVENT_TTL_MS
  const fresh = entries.filter((e) => e && typeof e.at === 'number' && e.at >= minTs && typeof e.note === 'string' && e.note.trim())
  if (fresh.length <= MAX_TIMELINE_EVENTS) return fresh
  return fresh.slice(fresh.length - MAX_TIMELINE_EVENTS)
}

function appendTimeline(
  state: MainLoopState,
  source: string,
  note: string,
  now = Date.now(),
  status?: 'idle' | 'progress' | 'blocked' | 'ok',
) {
  const normalizedNote = toOneLine(note, 400)
  if (!normalizedNote) return
  const recent = state.timeline.at(-1)
  if (recent && recent.source === source && recent.note === normalizedNote && now - recent.at < 45_000) return
  state.timeline.push({
    id: `tl_${genId()}`,
    at: now,
    source,
    note: normalizedNote,
    status,
  })
  state.timeline = pruneTimeline(state.timeline, now)
}

function computeMomentumScore(state: MainLoopState): number {
  const baseByStatus = {
    idle: 40,
    progress: 72,
    blocked: 20,
    ok: 94,
  } as const
  let score: number = baseByStatus[state.status]
  score -= Math.min(20, state.metaMissCount * 3)
  score -= Math.min(12, Math.max(0, state.pendingEvents.length - 4) * 2)
  if (state.paused) score = Math.min(score, 35)
  return clampInt(score, 0, 0, 100)
}

function normalizeStringList(input: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const value = raw.replace(/\s+/g, ' ').trim().slice(0, maxChars)
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= maxItems) break
  }
  return out
}

function normalizeGoalContract(raw: any): GoalContract | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const objective = typeof raw.objective === 'string' ? raw.objective.trim().slice(0, 300) : ''
  if (!objective) return null
  const constraints = normalizeStringList(raw.constraints, 10, 220)
  const budgetUsd = typeof raw.budgetUsd === 'number'
    ? Math.max(0, Math.min(1_000_000, raw.budgetUsd))
    : null
  const deadlineAt = typeof raw.deadlineAt === 'number' && Number.isFinite(raw.deadlineAt)
    ? Math.trunc(raw.deadlineAt)
    : null
  const successMetric = typeof raw.successMetric === 'string'
    ? raw.successMetric.trim().slice(0, 220) || null
    : null
  return {
    objective,
    constraints: constraints.length ? constraints : undefined,
    budgetUsd,
    deadlineAt,
    successMetric,
  }
}

function normalizeState(raw: any, now = Date.now()): MainLoopState {
  const status = raw?.status === 'blocked' || raw?.status === 'ok' || raw?.status === 'progress' || raw?.status === 'idle'
    ? raw.status
    : 'idle'

  const pendingRaw = Array.isArray(raw?.pendingEvents) ? raw.pendingEvents : []
  const pendingEvents = pruneEvents(
    pendingRaw
      .map((e: any) => {
        const text = toOneLine(typeof e?.text === 'string' ? e.text : '')
        if (!text) return null
        return {
          id: typeof e?.id === 'string' && e.id.trim() ? e.id.trim() : `evt_${genId(3)}`,
          type: typeof e?.type === 'string' && e.type.trim() ? e.type.trim() : 'event',
          text,
          createdAt: typeof e?.createdAt === 'number' ? e.createdAt : now,
        } as MainLoopEvent
      })
      .filter(Boolean) as MainLoopEvent[],
    now,
  )

  const timelineRaw = Array.isArray(raw?.timeline) ? raw.timeline : []
  const timeline = pruneTimeline(
    timelineRaw
      .map((entry: any) => {
        const note = toOneLine(typeof entry?.note === 'string' ? entry.note : '', 400)
        if (!note) return null
        const status = entry?.status === 'blocked' || entry?.status === 'ok' || entry?.status === 'progress' || entry?.status === 'idle'
          ? entry.status
          : undefined
        return {
          id: typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : `tl_${genId(3)}`,
          at: typeof entry?.at === 'number' ? entry.at : now,
          source: typeof entry?.source === 'string' && entry.source.trim() ? entry.source.trim() : 'event',
          note,
          status,
        } as MainLoopTimelineEntry
      })
      .filter(Boolean) as MainLoopTimelineEntry[],
    now,
  )

  const normalized: MainLoopState = {
    goal: typeof raw?.goal === 'string' && raw.goal.trim() ? raw.goal.trim().slice(0, 600) : null,
    goalContract: normalizeGoalContract(raw?.goalContract),
    status,
    summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 800) : null,
    nextAction: typeof raw?.nextAction === 'string' && raw.nextAction.trim() ? raw.nextAction.trim().slice(0, 600) : null,
    planSteps: normalizeStringList(raw?.planSteps, 10, 220),
    currentPlanStep: typeof raw?.currentPlanStep === 'string' && raw.currentPlanStep.trim()
      ? raw.currentPlanStep.trim().slice(0, 220)
      : null,
    reviewNote: typeof raw?.reviewNote === 'string' && raw.reviewNote.trim()
      ? raw.reviewNote.trim().slice(0, 320)
      : null,
    reviewConfidence: typeof raw?.reviewConfidence === 'number' && Number.isFinite(raw.reviewConfidence)
      ? Math.max(0, Math.min(1, raw.reviewConfidence))
      : null,
    missionTaskId: typeof raw?.missionTaskId === 'string' && raw.missionTaskId.trim() ? raw.missionTaskId.trim() : null,
    momentumScore: clampInt(raw?.momentumScore, 40, 0, 100),
    paused: raw?.paused === true,
    autonomyMode: raw?.autonomyMode === 'assist' ? 'assist' : 'autonomous',
    pendingEvents,
    timeline,
    followupChainCount: clampInt(raw?.followupChainCount, 0, 0, 100),
    metaMissCount: clampInt(raw?.metaMissCount, 0, 0, 100),
    workingMemoryNotes: normalizeStringList(raw?.workingMemoryNotes, 24, 260),
    lastMemoryNoteAt: typeof raw?.lastMemoryNoteAt === 'number' ? raw.lastMemoryNoteAt : null,
    lastPlannedAt: typeof raw?.lastPlannedAt === 'number' ? raw.lastPlannedAt : null,
    lastReviewedAt: typeof raw?.lastReviewedAt === 'number' ? raw.lastReviewedAt : null,
    lastTickAt: typeof raw?.lastTickAt === 'number' ? raw.lastTickAt : null,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : now,
  }
  if (!normalized.goal && normalized.goalContract?.objective) {
    normalized.goal = normalized.goalContract.objective
  }
  normalized.momentumScore = computeMomentumScore(normalized)
  return normalized
}

function appendEvent(state: MainLoopState, type: string, text: string, now = Date.now()): boolean {
  const normalizedText = toOneLine(text)
  if (!normalizedText) return false
  const recent = state.pendingEvents.at(-1)
  if (recent && recent.type === type && recent.text === normalizedText && now - recent.createdAt < 60_000) {
    return false
  }
  state.pendingEvents.push({
    id: `evt_${genId()}`,
    type,
    text: normalizedText,
    createdAt: now,
  })
  state.pendingEvents = pruneEvents(state.pendingEvents, now)
  return true
}

function appendWorkingMemoryNote(state: MainLoopState, note: string) {
  const value = toOneLine(note, 260)
  if (!value) return
  const existing = state.workingMemoryNotes || []
  if (existing.length && existing[existing.length - 1] === value) return
  state.workingMemoryNotes = [...existing.slice(-23), value]
}

function inferGoalFromUserMessage(message: string): string | null {
  const text = (message || '').trim()
  if (!text) return null
  if (/^SWARM_MAIN_(MISSION_TICK|AUTO_FOLLOWUP)\b/i.test(text)) return null
  if (/^SWARM_HEARTBEAT_CHECK\b/i.test(text)) return null
  if (/^(ok|okay|cool|thanks|thx|got it|nice|yep|yeah|nope|nah)[.! ]*$/i.test(text)) return null
  return text.slice(0, 600)
}

function inferGoalFromSessionMessages(session: any): string | null {
  const msgs = Array.isArray(session?.messages) ? session.messages : []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i]
    if (msg?.role !== 'user') continue
    const inferred = inferGoalFromUserMessage(typeof msg?.text === 'string' ? msg.text : '')
    if (inferred) return inferred
  }
  return null
}

function parseMainLoopMeta(text: string): MainLoopMeta | null {
  const raw = (text || '').trim()
  if (!raw) return null

  const markerMatch = raw.match(META_LINE_RE)
  const parseCandidate = markerMatch?.[1]
  if (parseCandidate) {
    try {
      const parsed = JSON.parse(parseCandidate)
      return normalizeMeta(parsed)
    } catch {
      // fall through
    }
  }

  // Fallback: parse any one-line JSON that appears to be the meta payload.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    if (!trimmed.includes('follow_up') && !trimmed.includes('next_action') && !trimmed.includes('consume_event_ids')) continue
    try {
      const parsed = JSON.parse(trimmed)
      return normalizeMeta(parsed)
    } catch {
      // skip malformed candidate lines
    }
  }

  return null
}

function normalizeMeta(raw: any): MainLoopMeta {
  const status = raw?.status === 'blocked' || raw?.status === 'ok' || raw?.status === 'progress' || raw?.status === 'idle'
    ? raw.status
    : undefined

  const consumeIds = Array.isArray(raw?.consume_event_ids)
    ? raw.consume_event_ids
      .map((v: unknown) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
    : undefined

  const followUp = typeof raw?.follow_up === 'boolean'
    ? raw.follow_up
    : typeof raw?.follow_up === 'string'
      ? raw.follow_up.trim().toLowerCase() === 'true'
      : undefined

  return {
    status,
    summary: typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 800) : undefined,
    next_action: typeof raw?.next_action === 'string' ? raw.next_action.trim().slice(0, 600) : undefined,
    follow_up: followUp,
    delay_sec: clampInt(raw?.delay_sec, DEFAULT_FOLLOWUP_DELAY_SEC, 5, 900),
    goal: typeof raw?.goal === 'string' ? raw.goal.trim().slice(0, 600) : undefined,
    consume_event_ids: consumeIds,
  }
}

function consumeEvents(state: MainLoopState, ids: string[] | undefined) {
  if (!ids?.length) return
  const remove = new Set(ids)
  state.pendingEvents = state.pendingEvents.filter((event) => !remove.has(event.id))
}

function buildPendingEventLines(state: MainLoopState): string {
  if (!state.pendingEvents.length) return 'Pending events:\n- none'
  const lines = state.pendingEvents
    .slice(-10)
    .map((event) => `- ${event.id} | ${event.type} | ${event.text}`)
    .join('\n')
  return `Pending events (oldest → newest):\n${lines}`
}

function buildTimelineLines(state: MainLoopState): string {
  if (!state.timeline.length) return 'Recent mission timeline:\n- none'
  const lines = state.timeline
    .slice(-5)
    .map((entry) => {
      const ts = new Date(entry.at).toISOString().slice(11, 19)
      const status = entry.status ? ` [${entry.status}]` : ''
      return `- ${ts} ${entry.source}${status}: ${entry.note}`
    })
    .join('\n')
  return `Recent mission timeline:\n${lines}`
}

function buildGoalContractLines(state: MainLoopState): string[] {
  const contract = state.goalContract
  if (!contract?.objective) return []
  const lines = [
    `contract_objective: ${contract.objective}`,
  ]
  if (contract.constraints?.length) lines.push(`contract_constraints: ${contract.constraints.join(' | ')}`)
  if (typeof contract.budgetUsd === 'number') lines.push(`contract_budget_usd: ${contract.budgetUsd}`)
  if (typeof contract.deadlineAt === 'number') lines.push(`contract_deadline_iso: ${new Date(contract.deadlineAt).toISOString()}`)
  if (contract.successMetric) lines.push(`contract_success_metric: ${contract.successMetric}`)
  return lines
}

function missionNeedsScreenshotArtifactEvidence(state: MainLoopState): boolean {
  const haystack = [
    state.goal || '',
    state.goalContract?.objective || '',
    state.goalContract?.successMetric || '',
    state.nextAction || '',
    ...(state.planSteps || []),
    state.currentPlanStep || '',
  ].join(' ')
  if (!SCREENSHOT_GOAL_HINT.test(haystack)) return false
  return DELIVERY_GOAL_HINT.test(haystack) || SCHEDULE_GOAL_HINT.test(haystack)
}

function missionHasScreenshotArtifactEvidence(session: MainLoopSessionEvidenceLike | null | undefined, state: MainLoopState, additionalText = ''): boolean {
  const candidates: string[] = [
    state.summary || '',
    additionalText || '',
  ]
  if (Array.isArray(session?.messages)) {
    for (let i = session.messages.length - 1; i >= 0 && candidates.length < 16; i--) {
      const text = typeof session.messages[i]?.text === 'string' ? session.messages[i].text! : ''
      if (text && text.trim()) candidates.push(text)
    }
  }
  return candidates.some((value) => UPLOAD_ARTIFACT_HINT.test(value) || SENT_ARTIFACT_HINT.test(value))
}

function getMissionCompletionGateReason(session: MainLoopSessionEvidenceLike | null | undefined, state: MainLoopState, additionalText = ''): string | null {
  if (!missionNeedsScreenshotArtifactEvidence(state)) return null
  if (missionHasScreenshotArtifactEvidence(session, state, additionalText)) return null
  return 'Mission requires screenshot artifact evidence (upload link or explicit sent screenshot confirmation) before completion.'
}

function upsertMissionTask(session: any, state: MainLoopState, now: number): string | null {
  if (!state.goal) return state.missionTaskId || null

  const tasks = loadTasks()
  let task = state.missionTaskId ? tasks[state.missionTaskId] : null
  if (!task) {
    task = Object.values(tasks).find((t: any) =>
      t?.sessionId === session.id
      && t?.title?.startsWith('Mission:')
      && t?.status !== 'archived'
    ) as any || null
  }

  const title = `Mission: ${state.goal.slice(0, 140)}`
  const statusMap = {
    idle: 'backlog',
    progress: 'running',
    blocked: 'failed',
    ok: 'completed',
  } as const
  let mappedStatus = statusMap[state.status]
  const completionGateReason = mappedStatus === 'completed'
    ? getMissionCompletionGateReason(session, state)
    : null
  if (completionGateReason) mappedStatus = 'running'

  let changed = false
  const contractLines = buildGoalContractLines(state)
  const planLines = state.planSteps.length
    ? [`plan_steps: ${state.planSteps.join(' -> ')}`]
    : []
  if (state.currentPlanStep) planLines.push(`current_plan_step: ${state.currentPlanStep}`)
  if (state.reviewNote) planLines.push(`latest_review: ${state.reviewNote}`)

  const baseDescription = [
    'Autonomous mission goal tracked from main loop.',
    `Goal: ${state.goal}`,
    state.nextAction ? `Next action: ${state.nextAction}` : '',
    completionGateReason ? `Completion gate: ${completionGateReason}` : '',
    ...contractLines,
    ...planLines,
  ].filter(Boolean).join('\n')

  if (!task) {
    const id = genId()
    task = {
      id,
      title,
      description: baseDescription,
      status: mappedStatus,
      agentId: session.agentId || 'default',
      sessionId: session.id,
      result: state.summary || null,
      error: state.status === 'blocked' ? (state.summary || 'Blocked') : null,
      createdAt: now,
      updatedAt: now,
      startedAt: mappedStatus === 'running' ? now : null,
      completedAt: mappedStatus === 'completed' ? now : null,
      queuedAt: null,
      archivedAt: null,
      comments: [],
      images: [],
      validation: null,
    }
    tasks[id] = task
    changed = true
  } else {
    if (task.title !== title) {
      task.title = title
      changed = true
    }
    const nextDescription = baseDescription
    if (task.description !== nextDescription) {
      task.description = nextDescription
      changed = true
    }
    if (task.status !== mappedStatus) {
      task.status = mappedStatus
      changed = true
      if (mappedStatus === 'running' && !task.startedAt) task.startedAt = now
      if (mappedStatus === 'completed') task.completedAt = now
    }
    const nextResult = state.summary || task.result || null
    if (task.result !== nextResult) {
      task.result = nextResult
      changed = true
    }
    const nextError = mappedStatus === 'failed'
      ? (state.summary || state.nextAction || 'Blocked')
      : null
    if (task.error !== nextError) {
      task.error = nextError
      changed = true
    }
    if (changed) task.updatedAt = now
    tasks[task.id] = task
  }

  if (changed) {
    saveTasks(tasks)
  }
  return task?.id || null
}

function maybeStoreMissionMemoryNote(
  session: any,
  state: MainLoopState,
  now: number,
  source: string,
  force = false,
) {
  if (!Array.isArray(session?.tools) || !session.tools.includes('memory')) return
  if (!state.goal) return
  if (!force && state.lastMemoryNoteAt && (now - state.lastMemoryNoteAt) < MEMORY_NOTE_MIN_INTERVAL_MS) return

  const summary = state.summary || 'No summary'
  const next = state.nextAction || 'No next action'
  const title = `Mission ${state.status}: ${state.goal.slice(0, 72)}`
  const content = [
    `source: ${source}`,
    `status: ${state.status}`,
    `momentum: ${state.momentumScore}/100`,
    `goal: ${state.goal}`,
    ...buildGoalContractLines(state),
    state.planSteps.length ? `plan_steps: ${state.planSteps.join(' -> ')}` : '',
    state.currentPlanStep ? `current_plan_step: ${state.currentPlanStep}` : '',
    `summary: ${summary}`,
    `next_action: ${next}`,
    state.reviewNote ? `review: ${state.reviewNote}` : '',
    typeof state.reviewConfidence === 'number' ? `review_confidence: ${state.reviewConfidence}` : '',
    state.missionTaskId ? `mission_task_id: ${state.missionTaskId}` : '',
  ].filter(Boolean).join('\n')

  try {
    const memDb = getMemoryDb()
    const latest = memDb.getLatestBySessionCategory?.(session.id, 'mission')
    if (latest) {
      const sameTitle = normalizeMemoryText(latest.title) === normalizeMemoryText(title)
      const sameContent = normalizeMemoryText(latest.content) === normalizeMemoryText(content)
      if (sameTitle && sameContent) {
        state.lastMemoryNoteAt = now
        return
      }
    }
    memDb.add({
      agentId: session.agentId || null,
      sessionId: session.id,
      category: 'mission',
      title,
      content,
    } as any)
    state.lastMemoryNoteAt = now
  } catch (err: any) {
    appendEvent(state, 'memory_note_error', `Failed to store mission memory note: ${toOneLine(err?.message || String(err), 240)}`, now)
  }
}

function buildFollowupPrompt(state: MainLoopState, opts?: { hasMemoryTool?: boolean }): string {
  const hasMemoryTool = opts?.hasMemoryTool === true
  const goal = state.goal || 'No explicit goal yet. Continue with the strongest actionable objective from recent context.'
  const nextAction = state.nextAction || 'Determine the next highest-impact action and execute it.'
  const contractLines = buildGoalContractLines(state)
  return [
    'SWARM_MAIN_AUTO_FOLLOWUP',
    `Mission goal: ${goal}`,
    `Next action to execute now: ${nextAction}`,
    `Current status: ${state.status}`,
    `Mission task id: ${state.missionTaskId || 'none'}`,
    `Momentum score: ${state.momentumScore}/100`,
    ...contractLines,
    state.planSteps.length ? `Current plan steps: ${state.planSteps.join(' -> ')}` : '',
    state.currentPlanStep ? `Current plan step: ${state.currentPlanStep}` : '',
    state.reviewNote ? `Last review: ${state.reviewNote}` : '',
    buildPendingEventLines(state),
    buildTimelineLines(state),
    'Act autonomously. Use available tools to execute work, verify results, and keep momentum.',
    state.autonomyMode === 'assist'
      ? 'Assist mode: execute safe internal analysis by default, and ask before irreversible external side effects (sending messages, purchases, account mutations).'
      : 'Autonomous mode: execute safe next actions without waiting for confirmation; ask only when blocked by permissions, credentials, or policy.',
    'Do not ask clarifying questions unless blocked by missing credentials, permissions, or safety constraints.',
    hasMemoryTool
      ? 'Use memory_tool actively: recall relevant prior notes before acting, and store a concise note after each meaningful step.'
      : 'memory_tool is unavailable in this session. Keep concise progress summaries in your status/meta output.',
    'If you are blocked by missing credentials, permissions, or policy limits, say exactly what is blocked and the smallest unblock needed.',
    'For screenshot/image delivery goals (including scheduled captures), do not report status "ok" until a real artifact exists (upload link or explicit sent-file confirmation).',
    'If no meaningful action remains right now, reply exactly HEARTBEAT_OK.',
    'Otherwise include a concise human update, then append exactly one [MAIN_LOOP_META] JSON line.',
    'Optionally append one [MAIN_LOOP_PLAN] JSON line when you create/revise a plan.',
    'Optionally append one [MAIN_LOOP_REVIEW] JSON line when you review recent execution results.',
    '[MAIN_LOOP_META] {"status":"progress|ok|blocked|idle","summary":"...","next_action":"...","follow_up":true|false,"delay_sec":45,"goal":"optional","consume_event_ids":["evt_..."]}',
    '[MAIN_LOOP_PLAN] {"steps":["..."],"current_step":"..."}',
    '[MAIN_LOOP_REVIEW] {"note":"...","confidence":0.0,"needs_replan":false}',
  ].join('\n')
}

export function isMainSession(session: any): boolean {
  return session?.name === MAIN_SESSION_NAME
}

export function buildMainLoopHeartbeatPrompt(session: any, fallbackPrompt: string): string {
  const now = Date.now()
  const state = normalizeState(session?.mainLoopState, now)
  const goal = state.goal || inferGoalFromSessionMessages(session) || null
  const hasMemoryTool = Array.isArray(session?.tools) && session.tools.includes('memory')

  const promptGoal = goal || 'No explicit mission captured yet. Infer the mission from recent user instructions and continue proactively.'
  const promptSummary = state.summary || 'No prior mission summary yet.'
  const promptNextAction = state.nextAction || 'No queued action. Determine one.'
  const contractLines = buildGoalContractLines(state)

  return [
    'SWARM_MAIN_MISSION_TICK',
    `Time: ${new Date(now).toISOString()}`,
    `Mission goal: ${promptGoal}`,
    `Current status: ${state.status}`,
    `Mission paused: ${state.paused ? 'yes' : 'no'}`,
    `Autonomy mode: ${state.autonomyMode}`,
    `Mission task id: ${state.missionTaskId || 'none'}`,
    `Momentum score: ${state.momentumScore}/100`,
    ...contractLines,
    state.planSteps.length ? `Current plan steps: ${state.planSteps.join(' -> ')}` : '',
    state.currentPlanStep ? `Current plan step: ${state.currentPlanStep}` : '',
    state.reviewNote ? `Last review: ${state.reviewNote}` : '',
    `Last summary: ${toOneLine(promptSummary, 500)}`,
    `Last next action: ${toOneLine(promptNextAction, 500)}`,
    buildPendingEventLines(state),
    buildTimelineLines(state),
    'You are running the main autonomous mission loop. Continue executing toward the goal with initiative.',
    state.autonomyMode === 'assist'
      ? 'Assist mode is active: execute safe internal work and ask before irreversible external side effects.'
      : 'Autonomous mode is active: execute safe next actions without waiting for confirmation; only ask when blocked.',
    'Use tools where needed, verify outcomes, and avoid vague status-only replies.',
    'Do not ask broad exploratory questions when a safe next action exists. Pick a reasonable assumption, execute, and adapt from evidence.',
    'Do not ask clarifying questions unless blocked by missing credentials, permissions, or safety constraints.',
    hasMemoryTool
      ? 'Use memory_tool actively: recall relevant prior notes before acting, and store concise notes about progress, constraints, and next step after each meaningful action.'
      : 'If memory_tool is unavailable, keep concise state in summary/next_action and continue execution.',
    'Use a planner-executor-review loop: keep a concrete step plan, execute one meaningful step, then self-review and either continue or re-plan.',
    'For screenshot/image delivery goals (including scheduled captures), do not report status "ok" until a real artifact exists (upload link or explicit sent-file confirmation).',
    'If nothing important changed and no action is needed now, reply exactly HEARTBEAT_OK.',
    'Otherwise: provide a concise human-readable update, then append exactly one [MAIN_LOOP_META] JSON line.',
    'Optionally append one [MAIN_LOOP_PLAN] JSON line when creating/updating plan steps.',
    'Optionally append one [MAIN_LOOP_REVIEW] JSON line after execution review.',
    '[MAIN_LOOP_META] {"status":"progress|ok|blocked|idle","summary":"...","next_action":"...","follow_up":true|false,"delay_sec":45,"goal":"optional","consume_event_ids":["evt_..."]}',
    '[MAIN_LOOP_PLAN] {"steps":["..."],"current_step":"..."}',
    '[MAIN_LOOP_REVIEW] {"note":"...","confidence":0.0,"needs_replan":false}',
    'The [MAIN_LOOP_META] JSON must be valid, on one line, and only appear once.',
    `Fallback prompt context: ${fallbackPrompt || 'SWARM_HEARTBEAT_CHECK'}`,
  ].join('\n')
}

export function stripMainLoopMetaForPersistence(text: string, internal: boolean): string {
  if (!internal) return text
  if (!text) return ''
  return text
    .split('\n')
    .filter((line) => !line.includes('[MAIN_LOOP_META]') && !line.includes('[MAIN_LOOP_PLAN]') && !line.includes('[MAIN_LOOP_REVIEW]'))
    .join('\n')
    .trim()
}

export function getMainLoopStateForSession(sessionId: string): MainLoopState | null {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session || !isMainSession(session)) return null
  return normalizeState(session.mainLoopState)
}

export function setMainLoopStateForSession(sessionId: string, patch: Partial<MainLoopState>): MainLoopState | null {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session || !isMainSession(session)) return null
  const now = Date.now()
  const state = normalizeState(session.mainLoopState, now)

  if (typeof patch.goal === 'string') state.goal = patch.goal.trim().slice(0, 600) || null
  if (patch.goal === null) state.goal = null
  if (patch.goalContract !== undefined) state.goalContract = normalizeGoalContract(patch.goalContract)
  if (patch.status === 'idle' || patch.status === 'progress' || patch.status === 'blocked' || patch.status === 'ok') state.status = patch.status
  if (typeof patch.summary === 'string') state.summary = patch.summary.trim().slice(0, 800) || null
  if (patch.summary === null) state.summary = null
  if (typeof patch.nextAction === 'string') state.nextAction = patch.nextAction.trim().slice(0, 600) || null
  if (patch.nextAction === null) state.nextAction = null
  if (Array.isArray(patch.planSteps)) state.planSteps = normalizeStringList(patch.planSteps, 10, 220)
  if (typeof patch.currentPlanStep === 'string') state.currentPlanStep = patch.currentPlanStep.trim().slice(0, 220) || null
  if (patch.currentPlanStep === null) state.currentPlanStep = null
  if (typeof patch.reviewNote === 'string') state.reviewNote = patch.reviewNote.trim().slice(0, 320) || null
  if (patch.reviewNote === null) state.reviewNote = null
  if (typeof patch.reviewConfidence === 'number' && Number.isFinite(patch.reviewConfidence)) {
    state.reviewConfidence = Math.max(0, Math.min(1, patch.reviewConfidence))
  }
  if (patch.reviewConfidence === null) state.reviewConfidence = null
  if (typeof patch.missionTaskId === 'string') state.missionTaskId = patch.missionTaskId.trim() || null
  if (patch.missionTaskId === null) state.missionTaskId = null
  if (typeof patch.momentumScore === 'number') state.momentumScore = clampInt(patch.momentumScore, state.momentumScore, 0, 100)
  if (typeof patch.paused === 'boolean') state.paused = patch.paused
  if (patch.autonomyMode === 'assist' || patch.autonomyMode === 'autonomous') state.autonomyMode = patch.autonomyMode
  if (Array.isArray(patch.pendingEvents)) state.pendingEvents = pruneEvents(patch.pendingEvents, now)
  if (Array.isArray(patch.timeline)) state.timeline = pruneTimeline(patch.timeline, now)
  if (typeof patch.followupChainCount === 'number') state.followupChainCount = clampInt(patch.followupChainCount, state.followupChainCount, 0, 100)
  if (typeof patch.metaMissCount === 'number') state.metaMissCount = clampInt(patch.metaMissCount, state.metaMissCount, 0, 100)
  if (Array.isArray(patch.workingMemoryNotes)) state.workingMemoryNotes = normalizeStringList(patch.workingMemoryNotes, 24, 260)
  if (typeof patch.lastMemoryNoteAt === 'number') state.lastMemoryNoteAt = patch.lastMemoryNoteAt
  if (patch.lastMemoryNoteAt === null) state.lastMemoryNoteAt = null
  if (typeof patch.lastPlannedAt === 'number') state.lastPlannedAt = patch.lastPlannedAt
  if (patch.lastPlannedAt === null) state.lastPlannedAt = null
  if (typeof patch.lastReviewedAt === 'number') state.lastReviewedAt = patch.lastReviewedAt
  if (patch.lastReviewedAt === null) state.lastReviewedAt = null

  state.momentumScore = computeMomentumScore(state)
  state.updatedAt = now
  session.mainLoopState = state
  sessions[sessionId] = session
  saveSessions(sessions)
  return state
}

export function pushMainLoopEventToMainSessions(input: PushMainLoopEventInput): number {
  const text = toOneLine(input.text)
  if (!text) return 0

  const sessions = loadSessions()
  const now = Date.now()
  let changed = 0

  for (const session of Object.values(sessions) as any[]) {
    if (!isMainSession(session)) continue
    if (input.user && session.user && session.user !== input.user) continue

    const state = normalizeState(session.mainLoopState, now)
    const appended = appendEvent(state, input.type || 'event', text, now)
    if (!appended) continue
    appendTimeline(state, input.type || 'event', text, now, state.status)
    state.momentumScore = computeMomentumScore(state)
    state.updatedAt = now
    session.mainLoopState = state
    changed += 1
  }

  if (changed > 0) {
    saveSessions(sessions)
    log.info('main-loop', `Queued event for ${changed} main session(s)`, {
      type: input.type,
      text,
      user: input.user || null,
    })
  }

  return changed
}

const AgentHeartbeatMetaSchema = z.object({
  goal: z.string().trim().optional(),
  status: z.enum(['progress', 'ok', 'idle', 'blocked']).optional(),
  next_action: z.string().trim().optional(),
}).passthrough()

type AgentHeartbeatMeta = z.infer<typeof AgentHeartbeatMetaSchema>

function parseAgentHeartbeatMeta(text: string): AgentHeartbeatMeta | null {
  const raw = (text || '').trim()
  if (!raw) return null
  const match = raw.match(AGENT_HEARTBEAT_META_RE)
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(match[1])
    return AgentHeartbeatMetaSchema.parse(parsed)
  } catch {
    return null
  }
}

function handleAgentHeartbeatResult(session: any, input: HandleMainLoopRunResultInput): null {
  if (!input.internal || input.source !== 'heartbeat') return null
  if (!session.agentId) return null
  const text = input.resultText || ''
  if (!text.trim()) return null

  const meta = parseAgentHeartbeatMeta(text)
  if (!meta) return null

  const agents = loadAgents()
  const agent = agents[session.agentId]
  if (!agent) return null

  let changed = false
  if (meta.goal && meta.goal !== agent.heartbeatGoal) {
    agent.heartbeatGoal = meta.goal
    changed = true
    log.info('agent-heartbeat', `Goal updated for agent ${agent.name}: ${meta.goal.slice(0, 120)}`)
  }
  if (meta.next_action) {
    agent.heartbeatNextAction = meta.next_action
    changed = true
  }
  if (meta.status) {
    agent.heartbeatStatus = meta.status
    changed = true
  }

  if (changed) {
    agents[session.agentId] = agent
    saveAgents(agents)
  }
  return null
}

export function handleMainLoopRunResult(input: HandleMainLoopRunResultInput): MainLoopFollowupRequest | null {
  const sessions = loadSessions()
  const session = sessions[input.sessionId]
  if (!session) return null
  if (!isMainSession(session)) return handleAgentHeartbeatResult(session, input)

  const now = Date.now()
  const state = normalizeState(session.mainLoopState, now)
  const hasMemoryTool = Array.isArray(session.tools) && session.tools.includes('memory')
  state.pendingEvents = pruneEvents(state.pendingEvents, now)
  let forceMemoryNote = false

  const userGoal = inferGoalFromUserMessage(input.message)
  const userGoalContract = parseGoalContractFromText(input.message)
  if (!input.internal) {
    if (userGoal) {
      state.goal = userGoal
      if (userGoalContract) state.goalContract = mergeGoalContracts(state.goalContract, userGoalContract)
      state.status = 'progress'
      appendEvent(state, 'user_instruction', `User goal updated: ${userGoal}`, now)
      appendTimeline(state, 'user_goal', `Goal updated: ${userGoal}`, now, state.status)
      appendWorkingMemoryNote(state, `goal:${userGoal}`)
      forceMemoryNote = true
    } else if (userGoalContract?.objective) {
      state.goal = userGoalContract.objective
      state.goalContract = mergeGoalContracts(state.goalContract, userGoalContract)
      state.status = 'progress'
      appendTimeline(state, 'user_goal_contract', `Goal contract updated: ${userGoalContract.objective}`, now, state.status)
      appendWorkingMemoryNote(state, `contract:${userGoalContract.objective}`)
      forceMemoryNote = true
    }
    state.followupChainCount = 0
  }

  if (state.paused && input.internal) {
    appendTimeline(state, 'paused_skip', `Skipped internal tick from ${input.source} because mission is paused.`, now, state.status)
    state.momentumScore = computeMomentumScore(state)
    state.updatedAt = now
    session.mainLoopState = state
    sessions[input.sessionId] = session
    saveSessions(sessions)
    return null
  }

  if (input.error) {
    appendEvent(state, 'run_error', `Run error (${input.source}): ${toOneLine(input.error, 400)}`, now)
    appendTimeline(state, 'run_error', `Run error (${input.source}): ${toOneLine(input.error, 220)}`, now, 'blocked')
    state.status = 'blocked'
    appendWorkingMemoryNote(state, `blocked:${toOneLine(input.error, 120)}`)
    forceMemoryNote = true
  }

  for (const event of input.toolEvents || []) {
    if (!event?.error) continue
    appendEvent(
      state,
      'tool_error',
      `Tool ${event.name || 'unknown'} error: ${toOneLine(event.output || event.input || 'unknown error', 400)}`,
      now,
    )
    appendTimeline(
      state,
      'tool_error',
      `Tool ${event.name || 'unknown'} error encountered.`,
      now,
      'blocked',
    )
    forceMemoryNote = true
  }

  let followup: MainLoopFollowupRequest | null = null
  const shouldAutoKickFromUserGoal = !input.internal
    && !input.error
    && (!!userGoal || !!userGoalContract?.objective)
    && !state.paused
    && state.autonomyMode === 'autonomous'

  if (shouldAutoKickFromUserGoal) {
    followup = {
      message: buildFollowupPrompt(state, { hasMemoryTool }),
      delayMs: 1500,
      dedupeKey: `main-loop-user-kickoff:${input.sessionId}`,
    }
    appendTimeline(state, 'followup', 'Queued autonomous kickoff follow-up from new user goal.', now, state.status)
  }

  if (input.internal) {
    state.lastTickAt = now
    const trimmedText = (input.resultText || '').trim()
    const isHeartbeatOk = /^HEARTBEAT_OK$/i.test(trimmedText)
    const meta = parseMainLoopMeta(trimmedText)
    const planMeta = parseMainLoopPlan(trimmedText)
    const reviewMeta = parseMainLoopReview(trimmedText)

    if (planMeta) {
      if (planMeta.steps?.length) {
        state.planSteps = planMeta.steps
        state.lastPlannedAt = now
        appendWorkingMemoryNote(state, `plan:${planMeta.steps.join(' -> ')}`)
      }
      if (planMeta.current_step) {
        state.currentPlanStep = planMeta.current_step
        state.lastPlannedAt = now
      }
      appendTimeline(state, 'plan', `Plan updated${planMeta.current_step ? ` at step: ${planMeta.current_step}` : ''}.`, now, state.status)
    }

    if (reviewMeta) {
      if (reviewMeta.note) {
        state.reviewNote = reviewMeta.note
        appendWorkingMemoryNote(state, `review:${reviewMeta.note}`)
      }
      if (typeof reviewMeta.confidence === 'number') state.reviewConfidence = reviewMeta.confidence
      state.lastReviewedAt = now
      if (reviewMeta.needs_replan === true && state.planSteps.length > 0) {
        appendEvent(state, 'review_replan', 'Execution review requested replanning.', now)
      }
      appendTimeline(state, 'review', reviewMeta.note || 'Execution review updated.', now, state.status)
    }

    if (meta) {
      state.metaMissCount = 0
      if (meta.goal) {
        state.goal = meta.goal
        const metaGoalContract = parseGoalContractFromText(meta.goal)
        if (metaGoalContract) state.goalContract = mergeGoalContracts(state.goalContract, metaGoalContract)
      }
      if (meta.status) state.status = meta.status
      if (meta.summary) state.summary = meta.summary
      if (meta.next_action) state.nextAction = meta.next_action
      if (meta.summary) appendWorkingMemoryNote(state, `summary:${toOneLine(meta.summary, 180)}`)
      if (meta.next_action) appendWorkingMemoryNote(state, `next:${toOneLine(meta.next_action, 180)}`)
      appendTimeline(
        state,
        'meta',
        `Meta update: status=${meta.status || state.status}; summary=${toOneLine(meta.summary || state.summary || 'none', 140)}`,
        now,
        meta.status || state.status,
      )
      consumeEvents(state, meta.consume_event_ids)

      if (meta.follow_up === true && !input.error && !isHeartbeatOk && !state.paused && state.followupChainCount < MAX_FOLLOWUP_CHAIN) {
        state.followupChainCount += 1
        const delaySec = clampInt(meta.delay_sec, DEFAULT_FOLLOWUP_DELAY_SEC, 5, 900)
        followup = {
          message: buildFollowupPrompt(state, { hasMemoryTool }),
          delayMs: delaySec * 1000,
          dedupeKey: `main-loop-followup:${input.sessionId}`,
        }
        appendTimeline(state, 'followup', `Queued chained follow-up in ${delaySec}s.`, now, state.status)
      } else if (meta.follow_up === false || isHeartbeatOk) {
        state.followupChainCount = 0
      }
      if (state.status === 'ok' || state.status === 'blocked') {
        forceMemoryNote = true
      }
    } else if (!isHeartbeatOk && trimmedText) {
      state.metaMissCount = Math.min(100, state.metaMissCount + 1)
      state.summary = toOneLine(trimmedText, 700)
      appendWorkingMemoryNote(state, `inferred:${toOneLine(trimmedText, 160)}`)
      if (state.status === 'idle') state.status = 'progress'
      appendEvent(state, 'meta_missing', 'Main-loop reply missing [MAIN_LOOP_META] contract; state inferred from text.', now)
      appendTimeline(state, 'meta_missing', 'Missing [MAIN_LOOP_META]; inferred state from plain text.', now, state.status)
    } else if (isHeartbeatOk) {
      state.metaMissCount = 0
      appendTimeline(state, 'heartbeat_ok', 'Heartbeat returned HEARTBEAT_OK.', now, state.status)
    }
  }

  if (input.internal && state.status === 'ok') {
    const completionGateReason = getMissionCompletionGateReason(session, state, input.resultText || '')
    if (completionGateReason) {
      state.status = 'progress'
      if (!state.nextAction || /^no queued action/i.test(state.nextAction)) {
        state.nextAction = 'Wait for the next schedule run and verify a screenshot artifact link is delivered.'
      }
      appendEvent(state, 'completion_gate', completionGateReason, now)
      appendTimeline(state, 'completion_gate', 'Holding completion until screenshot artifact evidence is observed.', now, state.status)
      appendWorkingMemoryNote(state, `gate:${toOneLine(completionGateReason, 180)}`)
    }
  }

  state.missionTaskId = upsertMissionTask(session, state, now)
  const shouldWritePeriodicMemory = !!state.summary && state.status === 'progress'
  maybeStoreMissionMemoryNote(session, state, now, input.source, forceMemoryNote || shouldWritePeriodicMemory)
  state.momentumScore = computeMomentumScore(state)

  state.updatedAt = now
  session.mainLoopState = state
  sessions[input.sessionId] = session
  saveSessions(sessions)

  return followup
}
