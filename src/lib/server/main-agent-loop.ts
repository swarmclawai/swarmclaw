import crypto from 'crypto'
import type { MessageToolEvent } from '@/types'
import { loadSessions, saveSessions, loadTasks, saveTasks } from './storage'
import { log } from './logger'
import { getMemoryDb } from './memory-db'

const MAIN_SESSION_NAME = '__main__'
const MAX_PENDING_EVENTS = 40
const MAX_TIMELINE_EVENTS = 80
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MEMORY_NOTE_MIN_INTERVAL_MS = 15 * 60 * 1000
const DEFAULT_FOLLOWUP_DELAY_SEC = 45
const MAX_FOLLOWUP_CHAIN = 6
const META_LINE_RE = /\[MAIN_LOOP_META\]\s*(\{[^\n]*\})/i

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
  status: 'idle' | 'progress' | 'blocked' | 'ok'
  summary: string | null
  nextAction: string | null
  missionTaskId: string | null
  momentumScore: number
  paused: boolean
  autonomyMode: 'assist' | 'autonomous'
  pendingEvents: MainLoopEvent[]
  timeline: MainLoopTimelineEntry[]
  followupChainCount: number
  metaMissCount: number
  lastMemoryNoteAt: number | null
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
    id: `tl_${crypto.randomBytes(4).toString('hex')}`,
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
          id: typeof e?.id === 'string' && e.id.trim() ? e.id.trim() : `evt_${crypto.randomBytes(3).toString('hex')}`,
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
          id: typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : `tl_${crypto.randomBytes(3).toString('hex')}`,
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
    status,
    summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 800) : null,
    nextAction: typeof raw?.nextAction === 'string' && raw.nextAction.trim() ? raw.nextAction.trim().slice(0, 600) : null,
    missionTaskId: typeof raw?.missionTaskId === 'string' && raw.missionTaskId.trim() ? raw.missionTaskId.trim() : null,
    momentumScore: clampInt(raw?.momentumScore, 40, 0, 100),
    paused: raw?.paused === true,
    autonomyMode: raw?.autonomyMode === 'assist' ? 'assist' : 'autonomous',
    pendingEvents,
    timeline,
    followupChainCount: clampInt(raw?.followupChainCount, 0, 0, 100),
    metaMissCount: clampInt(raw?.metaMissCount, 0, 0, 100),
    lastMemoryNoteAt: typeof raw?.lastMemoryNoteAt === 'number' ? raw.lastMemoryNoteAt : null,
    lastTickAt: typeof raw?.lastTickAt === 'number' ? raw.lastTickAt : null,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : now,
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
    id: `evt_${crypto.randomBytes(4).toString('hex')}`,
    type,
    text: normalizedText,
    createdAt: now,
  })
  state.pendingEvents = pruneEvents(state.pendingEvents, now)
  return true
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
  const mappedStatus = statusMap[state.status]

  let changed = false
  if (!task) {
    const id = crypto.randomBytes(4).toString('hex')
    task = {
      id,
      title,
      description: `Autonomous mission goal tracked from main loop.\nGoal: ${state.goal}`,
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
    const nextDescription = `Autonomous mission goal tracked from main loop.\nGoal: ${state.goal}${state.nextAction ? `\nNext action: ${state.nextAction}` : ''}`
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
    `summary: ${summary}`,
    `next_action: ${next}`,
    state.missionTaskId ? `mission_task_id: ${state.missionTaskId}` : '',
  ].filter(Boolean).join('\n')

  try {
    const memDb = getMemoryDb()
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
  return [
    'SWARM_MAIN_AUTO_FOLLOWUP',
    `Mission goal: ${goal}`,
    `Next action to execute now: ${nextAction}`,
    `Current status: ${state.status}`,
    `Mission task id: ${state.missionTaskId || 'none'}`,
    `Momentum score: ${state.momentumScore}/100`,
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
    'If no meaningful action remains right now, reply exactly HEARTBEAT_OK.',
    'Otherwise include a concise human update, then append exactly one line:',
    '[MAIN_LOOP_META] {"status":"progress|ok|blocked|idle","summary":"...","next_action":"...","follow_up":true|false,"delay_sec":45,"goal":"optional","consume_event_ids":["evt_..."]}',
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

  return [
    'SWARM_MAIN_MISSION_TICK',
    `Time: ${new Date(now).toISOString()}`,
    `Mission goal: ${promptGoal}`,
    `Current status: ${state.status}`,
    `Mission paused: ${state.paused ? 'yes' : 'no'}`,
    `Autonomy mode: ${state.autonomyMode}`,
    `Mission task id: ${state.missionTaskId || 'none'}`,
    `Momentum score: ${state.momentumScore}/100`,
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
    'If nothing important changed and no action is needed now, reply exactly HEARTBEAT_OK.',
    'Otherwise: provide a concise human-readable update, then append exactly one line:',
    '[MAIN_LOOP_META] {"status":"progress|ok|blocked|idle","summary":"...","next_action":"...","follow_up":true|false,"delay_sec":45,"goal":"optional","consume_event_ids":["evt_..."]}',
    'The [MAIN_LOOP_META] JSON must be valid, on one line, and only appear once.',
    `Fallback prompt context: ${fallbackPrompt || 'SWARM_HEARTBEAT_CHECK'}`,
  ].join('\n')
}

export function stripMainLoopMetaForPersistence(text: string, internal: boolean): string {
  if (!internal) return text
  if (!text) return ''
  return text
    .split('\n')
    .filter((line) => !line.includes('[MAIN_LOOP_META]'))
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
  if (patch.status === 'idle' || patch.status === 'progress' || patch.status === 'blocked' || patch.status === 'ok') state.status = patch.status
  if (typeof patch.summary === 'string') state.summary = patch.summary.trim().slice(0, 800) || null
  if (patch.summary === null) state.summary = null
  if (typeof patch.nextAction === 'string') state.nextAction = patch.nextAction.trim().slice(0, 600) || null
  if (patch.nextAction === null) state.nextAction = null
  if (typeof patch.missionTaskId === 'string') state.missionTaskId = patch.missionTaskId.trim() || null
  if (patch.missionTaskId === null) state.missionTaskId = null
  if (typeof patch.momentumScore === 'number') state.momentumScore = clampInt(patch.momentumScore, state.momentumScore, 0, 100)
  if (typeof patch.paused === 'boolean') state.paused = patch.paused
  if (patch.autonomyMode === 'assist' || patch.autonomyMode === 'autonomous') state.autonomyMode = patch.autonomyMode
  if (Array.isArray(patch.pendingEvents)) state.pendingEvents = pruneEvents(patch.pendingEvents, now)
  if (Array.isArray(patch.timeline)) state.timeline = pruneTimeline(patch.timeline, now)
  if (typeof patch.followupChainCount === 'number') state.followupChainCount = clampInt(patch.followupChainCount, state.followupChainCount, 0, 100)
  if (typeof patch.metaMissCount === 'number') state.metaMissCount = clampInt(patch.metaMissCount, state.metaMissCount, 0, 100)
  if (typeof patch.lastMemoryNoteAt === 'number') state.lastMemoryNoteAt = patch.lastMemoryNoteAt
  if (patch.lastMemoryNoteAt === null) state.lastMemoryNoteAt = null

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

export function handleMainLoopRunResult(input: HandleMainLoopRunResultInput): MainLoopFollowupRequest | null {
  const sessions = loadSessions()
  const session = sessions[input.sessionId]
  if (!session || !isMainSession(session)) return null

  const now = Date.now()
  const state = normalizeState(session.mainLoopState, now)
  const hasMemoryTool = Array.isArray(session.tools) && session.tools.includes('memory')
  state.pendingEvents = pruneEvents(state.pendingEvents, now)
  let forceMemoryNote = false

  const userGoal = inferGoalFromUserMessage(input.message)
  if (!input.internal) {
    if (userGoal) {
      state.goal = userGoal
      state.status = 'progress'
      appendEvent(state, 'user_instruction', `User goal updated: ${userGoal}`, now)
      appendTimeline(state, 'user_goal', `Goal updated: ${userGoal}`, now, state.status)
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
    && !!userGoal
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

    if (meta) {
      state.metaMissCount = 0
      if (meta.goal) state.goal = meta.goal
      if (meta.status) state.status = meta.status
      if (meta.summary) state.summary = meta.summary
      if (meta.next_action) state.nextAction = meta.next_action
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
      if (state.status === 'idle') state.status = 'progress'
      appendEvent(state, 'meta_missing', 'Main-loop reply missing [MAIN_LOOP_META] contract; state inferred from text.', now)
      appendTimeline(state, 'meta_missing', 'Missing [MAIN_LOOP_META]; inferred state from plain text.', now, state.status)
    } else if (isHeartbeatOk) {
      state.metaMissCount = 0
      appendTimeline(state, 'heartbeat_ok', 'Heartbeat returned HEARTBEAT_OK.', now, state.status)
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
