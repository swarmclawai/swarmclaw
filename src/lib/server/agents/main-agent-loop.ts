import { hmrSingleton } from '@/lib/shared-utils'
import type { GoalContract, Message, MessageToolEvent, Session } from '@/types'
import { mergeGoalContracts, parseGoalContractFromText, parseMainLoopPlan, parseMainLoopReview } from '@/lib/server/agents/autonomy-contract'
import { assessAutonomyRun } from '@/lib/server/autonomy/supervisor-reflection'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { loadSessions, loadSettings } from '@/lib/server/storage'

const LEGACY_META_LINE_RE = /\[(?:MAIN_LOOP_META|MAIN_LOOP_PLAN|MAIN_LOOP_REVIEW|AGENT_HEARTBEAT_META)\]\s*(\{[^\n]*\})?/i
const HEARTBEAT_META_RE = /\[AGENT_HEARTBEAT_META\]\s*(\{[^\n]*\})/i
const MAX_PENDING_EVENTS = 16
const MAX_TIMELINE_ITEMS = 40
const MAX_WORKING_MEMORY_NOTES = 12
const DEFAULT_FOLLOWUP_DELAY_MS = 1500
const DEFAULT_MAX_FOLLOWUP_CHAIN = 3

export interface MainLoopState {
  goal: string | null
  goalContract: GoalContract | null
  summary: string | null
  nextAction: string | null
  planSteps: string[]
  currentPlanStep: string | null
  reviewNote: string | null
  reviewConfidence: number | null
  missionTaskId: string | null
  momentumScore: number
  paused: boolean
  status: 'idle' | 'progress' | 'blocked' | 'ok'
  autonomyMode: 'assist' | 'autonomous'
  pendingEvents: Array<{
    id: string
    type: string
    text: string
    createdAt: number
  }>
  timeline: Array<{
    id: string
    at: number
    source: string
    note: string
    status?: 'idle' | 'progress' | 'blocked' | 'ok' | 'reflection'
  }>
  missionTokens: number
  missionCostUsd: number
  followupChainCount: number
  metaMissCount: number
  workingMemoryNotes: string[]
  skillBlocker: {
    summary: string
    query: string | null
    status: 'new' | 'searched' | 'recommended' | 'approval_requested' | 'installed'
    attempts: number
    candidateSkills: string[]
    approvalId: string | null
    updatedAt: number
  } | null
  lastMemoryNoteAt: number | null
  lastPlannedAt: number | null
  lastReviewedAt: number | null
  lastTickAt: number | null
  updatedAt: number
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
  runId?: string
  sessionId: string
  message: string
  internal: boolean
  source: string
  resultText: string
  error?: string
  toolEvents?: MessageToolEvent[]
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
}

type MainSessionLike = Partial<Session> & Record<string, unknown>

const stateMap = hmrSingleton('__swarmclaw_main_loop_state__', () => new Map<string, MainLoopState>())

function now(): number {
  return Date.now()
}

function asSession(session: unknown): MainSessionLike | null {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  return session as MainSessionLike
}

function cleanText(value: unknown, maxChars = 320): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxChars) : null
}

function cleanMultiline(value: unknown, maxChars = 1400): string | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars)
    .trim()
  return normalized || null
}

function normalizeConfidence(value: unknown): number | null {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN
  if (!Number.isFinite(raw)) return null
  return Math.max(0, Math.min(1, raw))
}

function defaultState(): MainLoopState {
  return {
    goal: null,
    goalContract: null,
    summary: null,
    nextAction: null,
    planSteps: [],
    currentPlanStep: null,
    reviewNote: null,
    reviewConfidence: null,
    missionTaskId: null,
    momentumScore: 0,
    paused: false,
    status: 'idle',
    autonomyMode: 'assist',
    pendingEvents: [],
    timeline: [],
    missionTokens: 0,
    missionCostUsd: 0,
    followupChainCount: 0,
    metaMissCount: 0,
    workingMemoryNotes: [],
    skillBlocker: null,
    lastMemoryNoteAt: null,
    lastPlannedAt: null,
    lastReviewedAt: null,
    lastTickAt: null,
    updatedAt: now(),
  }
}

function normalizeStatus(value: unknown, fallback: MainLoopState['status'] = 'idle'): MainLoopState['status'] {
  return value === 'progress' || value === 'blocked' || value === 'ok' || value === 'idle'
    ? value
    : fallback
}

function normalizeAutonomyMode(value: unknown, fallback: MainLoopState['autonomyMode'] = 'assist'): MainLoopState['autonomyMode'] {
  return value === 'autonomous' || value === 'assist' ? value : fallback
}

function uniqueStrings(values: string[], maxItems: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = cleanText(value, 280)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

function normalizePendingEvents(value: unknown): MainLoopState['pendingEvents'] {
  if (!Array.isArray(value)) return []
  const out: MainLoopState['pendingEvents'] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const text = cleanText(record.text, 320)
    if (!text) continue
    out.push({
      id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `evt-${out.length + 1}`,
      type: typeof record.type === 'string' && record.type.trim() ? record.type.trim() : 'event',
      text,
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? Math.trunc(record.createdAt)
        : now(),
    })
    if (out.length >= MAX_PENDING_EVENTS) break
  }
  return out
}

function normalizeTimeline(value: unknown): MainLoopState['timeline'] {
  if (!Array.isArray(value)) return []
  const out: MainLoopState['timeline'] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const note = cleanText(record.note, 320)
    if (!note) continue
    const status = record.status === 'idle'
      || record.status === 'progress'
      || record.status === 'blocked'
      || record.status === 'ok'
      || record.status === 'reflection'
      ? record.status
      : undefined
    out.push({
      id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `tl-${out.length + 1}`,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? Math.trunc(record.at) : now(),
      source: typeof record.source === 'string' && record.source.trim() ? record.source.trim() : 'state',
      note,
      status,
    })
    if (out.length >= MAX_TIMELINE_ITEMS) break
  }
  return out
}

function normalizeSkillBlocker(value: unknown): MainLoopState['skillBlocker'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const summary = cleanText(record.summary, 240)
  if (!summary) return null
  const status = record.status === 'new'
    || record.status === 'searched'
    || record.status === 'recommended'
    || record.status === 'approval_requested'
    || record.status === 'installed'
    ? record.status
    : 'new'
  const query = cleanText(record.query, 240)
  const candidateSkills = Array.isArray(record.candidateSkills)
    ? uniqueStrings(record.candidateSkills.filter((entry): entry is string => typeof entry === 'string'), 6)
    : []
  const approvalId = typeof record.approvalId === 'string' && record.approvalId.trim()
    ? record.approvalId.trim()
    : null
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    ? Math.trunc(record.updatedAt)
    : now()
  const attempts = typeof record.attempts === 'number' && Number.isFinite(record.attempts)
    ? Math.max(0, Math.min(6, Math.trunc(record.attempts)))
    : 0
  return {
    summary,
    query,
    status,
    attempts,
    candidateSkills,
    approvalId,
    updatedAt,
  }
}

function parseHeartbeatMeta(text: string): { goal?: string; status?: MainLoopState['status']; summary?: string; nextAction?: string } | null {
  const match = (text || '').match(HEARTBEAT_META_RE)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>
    const payload: { goal?: string; status?: MainLoopState['status']; summary?: string; nextAction?: string } = {}
    const goal = cleanText(parsed.goal, 400)
    const summary = cleanText(parsed.summary, 500)
    const nextAction = cleanText(parsed.next_action, 240)
    if (goal) payload.goal = goal
    if (summary) payload.summary = summary
    if (nextAction) payload.nextAction = nextAction
    if (parsed.status === 'idle' || parsed.status === 'progress' || parsed.status === 'blocked' || parsed.status === 'ok') {
      payload.status = normalizeStatus(parsed.status, 'idle')
    }
    return Object.keys(payload).length > 0 ? payload : null
  } catch {
    return null
  }
}

function clampState(state: MainLoopState): MainLoopState {
  state.planSteps = uniqueStrings(state.planSteps || [], 8)
  state.workingMemoryNotes = uniqueStrings(state.workingMemoryNotes || [], MAX_WORKING_MEMORY_NOTES)
  state.pendingEvents = normalizePendingEvents(state.pendingEvents).slice(-MAX_PENDING_EVENTS)
  state.timeline = normalizeTimeline(state.timeline).slice(-MAX_TIMELINE_ITEMS)
  state.goal = cleanText(state.goal, 500)
  state.summary = cleanText(state.summary, 1000)
  state.nextAction = cleanText(state.nextAction, 240)
  state.currentPlanStep = cleanText(state.currentPlanStep, 240)
  state.reviewNote = cleanText(state.reviewNote, 320)
  state.reviewConfidence = normalizeConfidence(state.reviewConfidence)
  state.momentumScore = Math.max(-10, Math.min(10, Math.trunc(state.momentumScore || 0)))
  state.followupChainCount = Math.max(0, Math.min(10, Math.trunc(state.followupChainCount || 0)))
  state.metaMissCount = Math.max(0, Math.min(100, Math.trunc(state.metaMissCount || 0)))
  state.missionTokens = Math.max(0, Math.trunc(state.missionTokens || 0))
  state.missionCostUsd = Math.max(0, Number.isFinite(state.missionCostUsd) ? Number(state.missionCostUsd) : 0)
  state.skillBlocker = normalizeSkillBlocker(state.skillBlocker)
  state.updatedAt = typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt) ? Math.trunc(state.updatedAt) : now()
  return state
}

function normalizeState(input?: Partial<MainLoopState> | null): MainLoopState {
  const next = defaultState()
  if (input) {
    if (input.goalContract) next.goalContract = input.goalContract
    if (typeof input.goal === 'string' || input.goal === null) next.goal = input.goal
    if (typeof input.summary === 'string' || input.summary === null) next.summary = input.summary
    if (typeof input.nextAction === 'string' || input.nextAction === null) next.nextAction = input.nextAction
    if (Array.isArray(input.planSteps)) next.planSteps = [...input.planSteps]
    if (typeof input.currentPlanStep === 'string' || input.currentPlanStep === null) next.currentPlanStep = input.currentPlanStep
    if (typeof input.reviewNote === 'string' || input.reviewNote === null) next.reviewNote = input.reviewNote
    if (typeof input.reviewConfidence === 'number' || typeof input.reviewConfidence === 'string' || input.reviewConfidence === null) {
      next.reviewConfidence = normalizeConfidence(input.reviewConfidence)
    }
    if (typeof input.missionTaskId === 'string' || input.missionTaskId === null) next.missionTaskId = input.missionTaskId
    if (typeof input.momentumScore === 'number') next.momentumScore = input.momentumScore
    if (typeof input.paused === 'boolean') next.paused = input.paused
    if (input.status) next.status = normalizeStatus(input.status, next.status)
    if (input.autonomyMode) next.autonomyMode = normalizeAutonomyMode(input.autonomyMode, next.autonomyMode)
    if (Array.isArray(input.pendingEvents)) next.pendingEvents = [...input.pendingEvents]
    if (Array.isArray(input.timeline)) next.timeline = [...input.timeline]
    if (typeof input.missionTokens === 'number') next.missionTokens = input.missionTokens
    if (typeof input.missionCostUsd === 'number') next.missionCostUsd = input.missionCostUsd
    if (typeof input.followupChainCount === 'number') next.followupChainCount = input.followupChainCount
    if (typeof input.metaMissCount === 'number') next.metaMissCount = input.metaMissCount
    if (Array.isArray(input.workingMemoryNotes)) next.workingMemoryNotes = [...input.workingMemoryNotes]
    if (input.skillBlocker === null || typeof input.skillBlocker === 'object') next.skillBlocker = input.skillBlocker
    if (typeof input.lastMemoryNoteAt === 'number' || input.lastMemoryNoteAt === null) next.lastMemoryNoteAt = input.lastMemoryNoteAt ?? null
    if (typeof input.lastPlannedAt === 'number' || input.lastPlannedAt === null) next.lastPlannedAt = input.lastPlannedAt ?? null
    if (typeof input.lastReviewedAt === 'number' || input.lastReviewedAt === null) next.lastReviewedAt = input.lastReviewedAt ?? null
    if (typeof input.lastTickAt === 'number' || input.lastTickAt === null) next.lastTickAt = input.lastTickAt ?? null
    if (typeof input.updatedAt === 'number') next.updatedAt = input.updatedAt
  }
  return clampState(next)
}

function appendTimeline(state: MainLoopState, source: string, note: string, status?: MainLoopState['timeline'][number]['status']): void {
  const cleaned = cleanText(note, 320)
  if (!cleaned) return
  const previous = state.timeline.at(-1)
  if (previous && previous.source === source && previous.note === cleaned) return
  state.timeline.push({
    id: `tl-${now()}-${state.timeline.length + 1}`,
    at: now(),
    source,
    note: cleaned,
    status,
  })
  state.timeline = state.timeline.slice(-MAX_TIMELINE_ITEMS)
}

function appendWorkingMemory(state: MainLoopState, note: string): void {
  const cleaned = cleanText(note, 240)
  if (!cleaned) return
  state.workingMemoryNotes = uniqueStrings([...(state.workingMemoryNotes || []), cleaned], MAX_WORKING_MEMORY_NOTES)
  state.lastMemoryNoteAt = now()
}

function extractLatestGoal(messages: Message[]): { goal: string | null; goalContract: GoalContract | null } {
  let goal: string | null = null
  let goalContract: GoalContract | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = cleanMultiline(message.text, 900)
    if (!text) continue
    goal = text
    goalContract = mergeGoalContracts(goalContract, parseGoalContractFromText(text))
    break
  }
  return { goal, goalContract }
}

function hydrateStateFromSession(sessionId: string): MainLoopState | null {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session || !isMainSession(session)) return null

  const messages = Array.isArray(session.messages) ? session.messages : []
  const hydrated = defaultState()
  hydrated.autonomyMode = session.heartbeatEnabled === true ? 'autonomous' : 'assist'
  hydrated.updatedAt = typeof session.lastActiveAt === 'number' ? session.lastActiveAt : now()

  const initial = extractLatestGoal(messages)
  hydrated.goal = initial.goal
  hydrated.goalContract = initial.goalContract

  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.text !== 'string') continue
    const heartbeat = parseHeartbeatMeta(message.text)
    if (heartbeat?.goal) hydrated.goal = heartbeat.goal
    if (heartbeat?.summary) hydrated.summary = heartbeat.summary
    if (heartbeat?.nextAction) hydrated.nextAction = heartbeat.nextAction
    if (heartbeat?.status) hydrated.status = heartbeat.status

    const plan = parseMainLoopPlan(message.text)
    if (plan?.steps?.length) hydrated.planSteps = plan.steps
    if (plan?.current_step) hydrated.currentPlanStep = plan.current_step
    if (plan) hydrated.lastPlannedAt = typeof message.time === 'number' ? message.time : hydrated.lastPlannedAt

    const review = parseMainLoopReview(message.text)
    if (review?.note) hydrated.reviewNote = review.note
    if (typeof review?.confidence === 'number') hydrated.reviewConfidence = review.confidence
    if (review) hydrated.lastReviewedAt = typeof message.time === 'number' ? message.time : hydrated.lastReviewedAt

    const stripped = stripMainLoopMetaForPersistence(message.text)
    if (stripped && !/^HEARTBEAT_OK$/i.test(stripped) && !/^NO_MESSAGE$/i.test(stripped)) {
      hydrated.summary = cleanText(stripped, 1000) || hydrated.summary
    }
    if (Array.isArray(message.toolEvents) && message.toolEvents.length > 0) {
      const toolNames = uniqueStrings(message.toolEvents.map((event: MessageToolEvent) => event.name || '').filter(Boolean), 4)
      if (toolNames.length > 0) appendWorkingMemory(hydrated, `Recent tools: ${toolNames.join(', ')}`)
    }
  }

  return normalizeState(hydrated)
}

function getOrCreateState(sessionId: string): MainLoopState | null {
  const existing = stateMap.get(sessionId)
  if (existing) return existing
  const hydrated = hydrateStateFromSession(sessionId)
  if (!hydrated) return null
  stateMap.set(sessionId, hydrated)
  return hydrated
}

function summarizePendingEvents(events: MainLoopState['pendingEvents']): string {
  if (!events.length) return ''
  return events
    .slice(-4)
    .map((event) => `- [${new Date(event.createdAt).toISOString()}] (${event.type}) ${event.text}`)
    .join('\n')
}

function formatGoalContract(goalContract: GoalContract | null): string {
  if (!goalContract) return ''
  const lines = [`Objective: ${goalContract.objective}`]
  if (goalContract.constraints?.length) lines.push(`Constraints: ${goalContract.constraints.join(' | ')}`)
  if (typeof goalContract.budgetUsd === 'number') lines.push(`Budget: $${goalContract.budgetUsd}`)
  if (typeof goalContract.deadlineAt === 'number') lines.push(`Deadline: ${new Date(goalContract.deadlineAt).toISOString()}`)
  if (goalContract.successMetric) lines.push(`Success metric: ${goalContract.successMetric}`)
  return lines.join('\n')
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore non-JSON outputs
  }
  return null
}

function summarizeSelectedSkillRuntime(session: MainSessionLike | null): string {
  const runtimeState = session?.skillRuntimeState
  if (!runtimeState || typeof runtimeState !== 'object') return ''
  const state = runtimeState as Record<string, unknown>
  const selectedSkillName = cleanText(state.selectedSkillName, 160)
  if (!selectedSkillName) return ''
  const lines = [`Selected skill: ${selectedSkillName}`]
  const lastAction = typeof state.lastAction === 'string' ? state.lastAction.trim() : ''
  const lastRunToolName = cleanText(state.lastRunToolName, 120)
  if (lastAction) lines.push(`Last skill action: ${lastAction}`)
  if (lastRunToolName) lines.push(`Last dispatched tool: ${lastRunToolName}`)
  return lines.join('\n')
}

function summarizeUseSkillToolEvent(toolEvents: MessageToolEvent[]): string | null {
  const event = [...toolEvents].reverse().find((entry) => entry.name === 'use_skill')
  if (!event?.output) return null
  const output = parseJsonRecord(event.output)
  if (!output) return null
  const skill = output.skill && typeof output.skill === 'object'
    ? output.skill as Record<string, unknown>
    : null
  const skillName = typeof skill?.name === 'string' && skill.name.trim()
    ? skill.name.trim()
    : typeof output.selectedSkillName === 'string' && output.selectedSkillName.trim()
      ? output.selectedSkillName.trim()
      : ''
  if (!skillName) return null
  if (output.executed === true) {
    const toolName = typeof output.dispatchedTool === 'string' ? output.dispatchedTool.trim() : ''
    return toolName ? `Skill run: ${skillName} via ${toolName}` : `Skill run: ${skillName}`
  }
  if (output.loaded === true) return `Loaded skill guidance: ${skillName}`
  if (output.selected === true) return `Selected skill: ${skillName}`
  return `Skill context: ${skillName}`
}

function firstMatchingLine(text: string, pattern: RegExp): string | null {
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed && pattern.test(trimmed)) return trimmed
  }
  return null
}

function deriveSkillBlockerFromToolEvents(params: {
  toolEvents: MessageToolEvent[]
  current: MainLoopState['skillBlocker']
  query: string | null
}): MainLoopState['skillBlocker'] {
  const event = [...params.toolEvents].reverse().find((entry) => entry.name === 'manage_skills')
  if (!event) return params.current
  const input = parseJsonRecord(event.input)
  const output = parseJsonRecord(event.output)
  const action = typeof input?.action === 'string' ? input.action.trim().toLowerCase() : ''
  const nowTs = now()

  const candidateNames = (() => {
    const local = Array.isArray(output?.local)
      ? output?.local
      : Array.isArray(output)
        ? output
        : []
    return uniqueStrings(local.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const record = entry as Record<string, unknown>
      const nestedSkill = record.skill && typeof record.skill === 'object' ? record.skill as Record<string, unknown> : null
      const name = typeof record.skillName === 'string'
        ? record.skillName
        : typeof record.name === 'string'
          ? record.name
          : typeof nestedSkill?.name === 'string'
            ? nestedSkill.name
            : ''
      return name ? [name] : []
    }), 4)
  })()

  const installSkillName = (() => {
    if (typeof output?.skillName === 'string' && output.skillName.trim()) return output.skillName.trim()
    if (output?.skill && typeof output.skill === 'object') {
      const nested = output.skill as Record<string, unknown>
      if (typeof nested.name === 'string' && nested.name.trim()) return nested.name.trim()
    }
    if (typeof input?.name === 'string' && input.name.trim()) return input.name.trim()
    return candidateNames[0] || null
  })()

  if (action === 'install') {
    if (output?.ok === true && output.installed === true) {
      return normalizeSkillBlocker({
        summary: installSkillName
          ? `Installed skill "${installSkillName}". Use it on the next step instead of re-discovering skills.`
          : 'Installed a skill for this blocker. Use it before re-running discovery.',
        query: params.query,
        status: 'installed',
        attempts: (params.current?.attempts || 0) + 1,
        candidateSkills: installSkillName ? [installSkillName] : candidateNames,
        approvalId: null,
        updatedAt: nowTs,
      })
    }
    const approval = output?.approval && typeof output.approval === 'object'
      ? output.approval as Record<string, unknown>
      : null
    const approvalId = typeof approval?.id === 'string' ? approval.id.trim() : ''
    if (output?.requiresApproval === true || approvalId) {
      return normalizeSkillBlocker({
        summary: installSkillName
          ? `Install approval is pending for skill "${installSkillName}". Wait for the approval instead of retrying discovery.`
          : 'A skill install approval is pending. Wait for the approval instead of retrying discovery.',
        query: params.query,
        status: 'approval_requested',
        attempts: (params.current?.attempts || 0) + 1,
        candidateSkills: installSkillName ? [installSkillName] : candidateNames,
        approvalId: approvalId || params.current?.approvalId || null,
        updatedAt: nowTs,
      })
    }
  }

  if (action === 'recommend_for_task' || action === 'status' || action === 'search_available') {
    return normalizeSkillBlocker({
      summary: candidateNames.length > 0
        ? `Skill candidates found: ${candidateNames.join(', ')}. Use one of them or request install approval once if needed.`
        : 'Checked local skills for this blocker. Avoid repeating the same discovery loop without a materially different query.',
      query: params.query,
      status: candidateNames.length > 0 ? 'recommended' : 'searched',
      attempts: (params.current?.attempts || 0) + 1,
      candidateSkills: candidateNames,
      approvalId: params.current?.approvalId || null,
      updatedAt: nowTs,
    })
  }

  return params.current
}

function deriveSkillBlockerFromText(params: {
  text: string
  current: MainLoopState['skillBlocker']
  query: string | null
}): MainLoopState['skillBlocker'] {
  const blockerLine = firstMatchingLine(
    params.text,
    /\b(missing capability|missing (?:binary|binaries|env|tool|command)|not installed|install required|requires .* cli|requires .* binary)\b/i,
  )
  if (!blockerLine) return params.current
  return normalizeSkillBlocker({
    summary: blockerLine,
    query: params.query,
    status: params.current?.status === 'approval_requested' ? 'approval_requested' : 'new',
    attempts: params.current?.attempts || 0,
    candidateSkills: params.current?.candidateSkills || [],
    approvalId: params.current?.approvalId || null,
    updatedAt: now(),
  })
}

function summarizeSkillBlocker(blocker: MainLoopState['skillBlocker']): string {
  if (!blocker) return ''
  const lines = [
    `Summary: ${blocker.summary}`,
    blocker.query ? `Current query: ${blocker.query}` : '',
    blocker.candidateSkills.length > 0 ? `Candidate skills: ${blocker.candidateSkills.join(', ')}` : '',
    blocker.approvalId ? `Pending approval: ${blocker.approvalId}` : '',
    blocker.status === 'new'
      ? 'Next action: use manage_skills once this turn to recommend or inspect a fitting skill for the blocker.'
      : blocker.status === 'searched'
        ? 'Next action: do not repeat the same discovery blindly. Either adjust the query materially or proceed with the explicit blocker.'
        : blocker.status === 'recommended'
          ? 'Next action: use one recommended skill now, or request one explicit install approval if the best fit is not yet installed.'
          : blocker.status === 'approval_requested'
            ? 'Next action: wait for the pending approval instead of repeating discovery or install requests.'
            : 'Next action: use the installed skill before re-running generic exploration.',
  ]
  return lines.filter(Boolean).join('\n')
}

function extractWaitSignal(text: string, toolEvents: MessageToolEvent[]): boolean {
  const haystack = `${text}\n${toolEvents.map((event) => `${event.name} ${event.input || ''} ${event.output || ''}`).join('\n')}`
  return /\b(wait for|waiting for|approval|human reply|mailbox|watch job|pending approval)\b/i.test(haystack)
}

function followupLimit(): number {
  const settings = loadSettings()
  const raw = settings.maxFollowupChain
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string'
      ? Number.parseInt(raw, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_FOLLOWUP_CHAIN
  return Math.max(0, Math.min(12, Math.trunc(parsed)))
}

function eventStatusForType(type: string): MainLoopState['status'] {
  if (/fail|error|approval/i.test(type)) return 'blocked'
  if (/complete|done|ok|success/i.test(type)) return 'ok'
  return 'progress'
}

export function isMainSession(session: unknown): boolean {
  const candidate = asSession(session)
  if (!candidate) return false
  if (typeof candidate.parentSessionId === 'string' && candidate.parentSessionId.trim()) return false
  const sessionType = typeof (candidate as Record<string, unknown>).sessionType === 'string'
    ? (candidate as Record<string, unknown>).sessionType
    : null
  if (sessionType === 'orchestrated') return false
  const hasAgent = typeof candidate.agentId === 'string' && candidate.agentId.trim().length > 0
  if (!hasAgent) return false
  const shortcutThread = typeof candidate.shortcutForAgentId === 'string' && candidate.shortcutForAgentId.trim().length > 0
  const connectorScope = typeof candidate.connectorSessionScope === 'string' && candidate.connectorSessionScope === 'main'
  const contextScope = candidate.connectorContext && typeof candidate.connectorContext === 'object'
    ? (candidate.connectorContext as Record<string, unknown>).scope === 'main'
    : false
  const heartbeatOptIn = candidate.heartbeatEnabled === true
  return shortcutThread || connectorScope || contextScope || heartbeatOptIn
}

export function buildMainLoopHeartbeatPrompt(session: unknown, fallbackPrompt: string): string {
  const candidate = asSession(session)
  if (!candidate?.id) return fallbackPrompt
  const state = getOrCreateState(String(candidate.id))
  if (!state) return fallbackPrompt
  const latestExternalGoal = extractLatestGoal(Array.isArray(candidate.messages) ? candidate.messages as Message[] : [])
  const effectiveGoal = state.goal || latestExternalGoal.goal
  const effectiveGoalContract = latestExternalGoal.goalContract
    ? mergeGoalContracts(state.goalContract, latestExternalGoal.goalContract)
    : state.goalContract

  const planLines = state.planSteps.length > 0
    ? state.planSteps.slice(0, 5).map((step, index) => `${index + 1}. ${step}`).join('\n')
    : ''
  const boundedFallbackPrompt = cleanMultiline(fallbackPrompt, 500)
  const boundedSummary = cleanMultiline(state.summary, 500)

  return [
    'MAIN_AGENT_HEARTBEAT_TICK',
    `Time: ${new Date().toISOString()}`,
    effectiveGoal ? `Current goal:\n${effectiveGoal}` : '',
    formatGoalContract(effectiveGoalContract),
    `Current status: ${state.status}`,
    state.nextAction ? `Planned next action: ${state.nextAction}` : '',
    state.currentPlanStep ? `Current plan step: ${state.currentPlanStep}` : '',
    planLines ? `Plan:\n${planLines}` : '',
    state.pendingEvents.length > 0 ? `Pending external events:\n${summarizePendingEvents(state.pendingEvents)}` : '',
    state.skillBlocker ? `Active skill blocker:\n${summarizeSkillBlocker(state.skillBlocker)}` : '',
    summarizeSelectedSkillRuntime(candidate),
    boundedSummary ? `Latest summary:\n${boundedSummary}` : '',
    boundedFallbackPrompt ? `Base heartbeat instructions:\n${boundedFallbackPrompt}` : '',
    '',
    'You are checking the durable main mission thread for this agent.',
    'Use only the current goal, plan, next action, and pending external events shown above.',
    'Do not infer or repeat old tasks from prior heartbeats.',
    'Prefer taking the single highest-value next step over restating the plan. Do not repeat completed work.',
    'If you revise the plan, emit exactly one line like:',
    '[MAIN_LOOP_PLAN]{"steps":["step 1","step 2"],"current_step":"step 1"}',
    'After acting, emit exactly one review line like:',
    '[MAIN_LOOP_REVIEW]{"note":"what changed","confidence":0.72,"needs_replan":false}',
    'If you are actively progressing or you changed the plan, also emit [AGENT_HEARTBEAT_META] with goal/status/next_action.',
    'Reply HEARTBEAT_OK only when nothing needs action right now.',
  ].filter(Boolean).join('\n')
}

export function stripMainLoopMetaForPersistence(text: string): string {
  return (text || '')
    .split('\n')
    .filter((line) => !LEGACY_META_LINE_RE.test(line))
    .join('\n')
    .trim()
}

export function getMainLoopStateForSession(sessionId: string): MainLoopState | null {
  const state = getOrCreateState(sessionId)
  return state ? normalizeState(state) : null
}

export function clearMainLoopStateForSession(sessionId: string): boolean {
  return stateMap.delete(sessionId)
}

/**
 * Remove stateMap entries for sessions that no longer exist.
 * Called periodically by the daemon health sweep.
 */
export function pruneMainLoopState(liveSessionIds: Set<string>): number {
  let removed = 0
  for (const sessionId of stateMap.keys()) {
    if (!liveSessionIds.has(sessionId)) {
      stateMap.delete(sessionId)
      removed++
    }
  }
  return removed
}

export function setMainLoopStateForSession(sessionId: string, patch: Partial<MainLoopState>): MainLoopState | null {
  const current = getOrCreateState(sessionId)
  if (!current) return null
  const next = normalizeState({
    ...current,
    ...patch,
    planSteps: patch.planSteps ?? current.planSteps,
    pendingEvents: patch.pendingEvents ?? current.pendingEvents,
    timeline: patch.timeline ?? current.timeline,
    workingMemoryNotes: patch.workingMemoryNotes ?? current.workingMemoryNotes,
    updatedAt: now(),
  })
  stateMap.set(sessionId, next)
  return normalizeState(next)
}

export function pushMainLoopEventToMainSessions(input: PushMainLoopEventInput): number {
  const text = cleanText(input.text, 320)
  if (!text) return 0
  const sessions = loadSessions()
  const nowTs = now()
  let count = 0

  for (const session of Object.values(sessions)) {
    if (!isMainSession(session)) continue
    const state = getOrCreateState(session.id)
    if (!state) continue

    const eventText = input.user ? `${input.user}: ${text}` : text
    const previous = state.pendingEvents.at(-1)
    if (!previous || previous.type !== input.type || previous.text !== eventText) {
      state.pendingEvents.push({
        id: `evt-${nowTs}-${state.pendingEvents.length + 1}`,
        type: input.type || 'event',
        text: eventText,
        createdAt: nowTs,
      })
      state.pendingEvents = state.pendingEvents.slice(-MAX_PENDING_EVENTS)
    }
    state.status = eventStatusForType(input.type || 'event')
    appendTimeline(state, input.type || 'event', eventText, state.status)
    state.updatedAt = nowTs
    stateMap.set(session.id, clampState(state))
    enqueueSystemEvent(session.id, `[Main loop] ${eventText}`, `main-loop:${input.type || 'event'}`)
    count += 1
  }

  return count
}

export function handleMainLoopRunResult(input: HandleMainLoopRunResultInput): MainLoopFollowupRequest | null {
  const state = getOrCreateState(input.sessionId)
  if (!state) return null

  const sessions = loadSessions()
  const session = sessions[input.sessionId] as Session | undefined
  const resultText = input.resultText || ''
  const persistedText = stripMainLoopMetaForPersistence(resultText)
  const toolEvents = Array.isArray(input.toolEvents) ? input.toolEvents : []
  const toolNames = uniqueStrings(toolEvents.map((event) => event.name || '').filter(Boolean), 8)
  const heartbeat = parseHeartbeatMeta(resultText)
  const plan = parseMainLoopPlan(resultText)
  const review = parseMainLoopReview(resultText)
  const shouldCaptureMessageGoal = !input.internal
  const messageGoal = shouldCaptureMessageGoal ? parseGoalContractFromText(input.message || '') : null
  const nowTs = now()

  if (messageGoal) state.goalContract = mergeGoalContracts(state.goalContract, messageGoal)
  if (!state.goal && shouldCaptureMessageGoal) state.goal = cleanMultiline(input.message, 900)
  if (heartbeat?.goal) state.goal = heartbeat.goal
  if (heartbeat?.summary) state.summary = heartbeat.summary
  if (heartbeat?.nextAction) state.nextAction = heartbeat.nextAction
  if (heartbeat?.status) state.status = heartbeat.status

  if (plan?.steps?.length) state.planSteps = plan.steps
  if (plan?.current_step) state.currentPlanStep = plan.current_step
  if (plan) state.lastPlannedAt = nowTs

  if (review?.note) state.reviewNote = review.note
  if (typeof review?.confidence === 'number') state.reviewConfidence = review.confidence
  if (review) state.lastReviewedAt = nowTs

  if (toolNames.length > 0) {
    appendWorkingMemory(state, `Used tools: ${toolNames.join(', ')}`)
    state.momentumScore = Math.min(10, state.momentumScore + 1)
  } else if (persistedText && !/^HEARTBEAT_OK$/i.test(persistedText) && !/^NO_MESSAGE$/i.test(persistedText)) {
    state.momentumScore = Math.min(10, state.momentumScore + 1)
  } else {
    state.momentumScore = Math.max(-10, state.momentumScore - 1)
  }

  if (persistedText && !/^HEARTBEAT_OK$/i.test(persistedText) && !/^NO_MESSAGE$/i.test(persistedText)) {
    state.summary = cleanText(persistedText, 1000) || state.summary
    appendTimeline(state, input.source || 'run', persistedText, input.error ? 'blocked' : state.status)
  }

  if (input.error) {
    state.status = 'blocked'
    appendTimeline(state, input.source || 'run', `Error: ${input.error}`, 'blocked')
  }

  state.lastTickAt = nowTs
  state.updatedAt = nowTs
  state.missionTokens += Math.max(0, Math.trunc((input.inputTokens || 0) + (input.outputTokens || 0)))
  state.missionCostUsd += Math.max(0, Number(input.estimatedCost || 0))
  const cleanedResult = persistedText.trim()
  const waitingForExternal = extractWaitSignal(resultText, toolEvents)
  const gotTerminalAck = /^HEARTBEAT_OK$/i.test(cleanedResult) || /^NO_MESSAGE$/i.test(cleanedResult)
  const selectedSkillNote = summarizeUseSkillToolEvent(toolEvents)
  if (selectedSkillNote) appendWorkingMemory(state, selectedSkillNote)
  state.metaMissCount = heartbeat || plan || review || gotTerminalAck ? 0 : state.metaMissCount + 1
  const skillQuery = cleanText(state.nextAction || input.message || state.goal, 240)
  let skillBlocker = deriveSkillBlockerFromToolEvents({
    toolEvents,
    current: state.skillBlocker,
    query: skillQuery,
  })
  skillBlocker = deriveSkillBlockerFromText({
    text: `${resultText}\n${toolEvents.map((event) => event.output || '').join('\n')}`,
    current: skillBlocker,
    query: skillQuery,
  })
  if ((gotTerminalAck && state.status !== 'blocked') || (state.status === 'ok' && !waitingForExternal && !input.error)) {
    skillBlocker = null
  }
  state.skillBlocker = skillBlocker

  if (input.internal) {
    state.pendingEvents = []
  }

  const assessment = assessAutonomyRun({
    runId: input.runId || `main-loop-${input.sessionId}-${nowTs}`,
    sessionId: input.sessionId,
    source: input.source,
    status: input.error ? 'failed' : 'completed',
    resultText,
    error: input.error,
    toolEvents,
    mainLoopState: state,
    session: session || null,
    settings: loadSettings(),
  })
  for (const incident of assessment.incidents) {
    appendTimeline(
      state,
      'supervisor',
      `Supervisor: ${incident.summary}`,
      incident.autoAction === 'block' ? 'blocked' : 'reflection',
    )
  }
  const supervisorPrompt = assessment.shouldBlock ? null : assessment.interventionPrompt
  if (assessment.shouldBlock) {
    state.status = 'blocked'
    state.paused = true
    state.followupChainCount = 0
    appendTimeline(state, 'supervisor', 'Supervisor paused the run after detecting a hard blocker.', 'blocked')
  } else if (supervisorPrompt) {
    state.paused = false
  }

  const needsReplan = review?.needs_replan === true || ((review?.confidence ?? 1) < 0.45)
  const limit = followupLimit()
  const allowChatOriginFollowup = !input.internal
    && input.source === 'chat'
    && !input.error
    && !waitingForExternal
    && !gotTerminalAck
    && (
      !!supervisorPrompt
      || assessment.shouldBlock
      || needsReplan
      || heartbeat?.status === 'progress'
      || !!heartbeat?.nextAction
      || (!!plan?.current_step && toolNames.length > 0)
    )

  let followup: MainLoopFollowupRequest | null = null
  if (!input.internal && !allowChatOriginFollowup) {
    state.followupChainCount = 0
  } else if (input.error || waitingForExternal || gotTerminalAck) {
    state.followupChainCount = 0
    if (gotTerminalAck && state.status !== 'blocked') state.status = 'ok'
  } else {
    const shouldContinue = !!supervisorPrompt || needsReplan || state.status === 'progress' || (!!state.nextAction && toolNames.length > 0)
    if (shouldContinue && state.followupChainCount < limit) {
      state.followupChainCount += 1
      const message = supervisorPrompt
        || (needsReplan
          ? 'Replan from the latest outcome, then execute only the highest-value remaining step. Do not repeat completed work.'
          : state.nextAction
            ? `Continue the objective. Resume from this next action: ${state.nextAction}`
            : 'Continue the objective and finish the next highest-value remaining step.')
      followup = {
        message,
        delayMs: DEFAULT_FOLLOWUP_DELAY_MS,
        dedupeKey: `main-loop:${input.sessionId}:${state.followupChainCount}:${supervisorPrompt ? 'supervisor' : (state.currentPlanStep || state.nextAction || 'continue')}`,
      }
      appendTimeline(state, 'followup', message, 'progress')
    } else {
      state.followupChainCount = 0
    }
  }

  stateMap.set(input.sessionId, clampState(state))
  return followup
}
