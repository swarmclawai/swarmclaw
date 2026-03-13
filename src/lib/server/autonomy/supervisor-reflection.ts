import crypto from 'node:crypto'
import { HumanMessage } from '@langchain/core/messages'

import { genId } from '@/lib/id'
import { buildLLM } from '@/lib/server/build-llm'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import {
  loadRunReflections,
  loadSessions,
  loadSettings,
  loadSupervisorIncidents,
  saveRunReflections,
  saveSupervisorIncidents,
} from '@/lib/server/storage'
import type {
  AppSettings,
  GoalContract,
  Message,
  MessageToolEvent,
  RunReflection,
  Session,
  SessionRunStatus,
  SupervisorIncident,
  SupervisorIncidentKind,
  SupervisorIncidentSeverity,
} from '@/types'
import {
  normalizeSupervisorSettings,
  runtimeScopeIncludes,
  type AutonomyRuntimeScope,
  type NormalizedSupervisorSettings,
} from '@/lib/autonomy/supervisor-settings'

const MAIN_LOOP_META_LINE_RE = /\[(?:MAIN_LOOP_META|MAIN_LOOP_PLAN|MAIN_LOOP_REVIEW|AGENT_HEARTBEAT_META)\]\s*(\{[^\n]*\})?/i
const DEFAULT_TRANSCRIPT_MESSAGES = 12
const DEFAULT_SNIPPET_CHARS = 800
const HUMAN_SIGNAL_RE = /\b(?:prefer|please|call me|don't call me|do not call me|i like|i dislike|i hate|i love|my pronouns|my partner|my wife|my husband|my kid|my child|my mom|my dad|my sister|my brother|birthday|anniversary|wedding|married|divorc|pregnan|baby|moved|moving|relocat|promotion|promoted|laid off|new job|job change|graduat|hospital|sick|illness|diagnos|passed away|funeral|grief|bereave|deadline|launch|fundraising|closing|house|home|travel)\b/i
const SIGNIFICANT_EVENT_RE = /\b(?:birthday|anniversary|wedding|married|divorc|pregnan|baby|moved|moving|relocat|promotion|promoted|laid off|new job|job change|graduat|hospital|sick|illness|diagnos|passed away|funeral|grief|bereave|deadline|launch|fundraising|closing|house|home|travel)\b/i

export interface SupervisorStateSnapshot {
  followupChainCount?: number | null
  goalContract?: GoalContract | null
  missionCostUsd?: number | null
  status?: string | null
  nextAction?: string | null
  summary?: string | null
  metaMissCount?: number | null
}

export interface AutonomyAssessment {
  incidents: Array<Omit<SupervisorIncident, 'id' | 'createdAt'>>
  interventionPrompt: string | null
  shouldBlock: boolean
}

export interface ObserveAutonomyRunInput {
  runId: string
  sessionId: string
  taskId?: string | null
  agentId?: string | null
  source: string
  status: SessionRunStatus
  resultText?: string | null
  error?: string | null
  toolEvents?: MessageToolEvent[]
  mainLoopState?: SupervisorStateSnapshot | null
  sourceMessage?: string | null
}

function now(): number {
  return Date.now()
}

function cleanText(value: unknown, max = 320): string | null {
  if (typeof value !== 'string') return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return null
  return compact.slice(0, max)
}

function stripMainLoopMeta(text: string): string {
  return (text || '')
    .split('\n')
    .filter((line) => !MAIN_LOOP_META_LINE_RE.test(line))
    .join('\n')
    .trim()
}

function trimText(value: string, max = 400): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function classifySurface(source: string): 'chat' | 'task' | null {
  const normalized = (source || '').trim().toLowerCase()
  if (!normalized || normalized.includes('heartbeat')) return null
  if (normalized === 'task' || normalized.startsWith('task-') || normalized === 'schedule' || normalized === 'delegation') {
    return 'task'
  }
  return 'chat'
}

function severityRank(severity: SupervisorIncidentSeverity): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1
}

function summarizeToolNames(toolEvents: MessageToolEvent[]): { repeatedTool: string | null; counts: Map<string, number> } {
  const counts = new Map<string, number>()
  for (const event of toolEvents) {
    const name = cleanText(event?.name, 80)
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  let repeatedTool: string | null = null
  let repeatedCount = 0
  for (const [name, count] of counts.entries()) {
    if (count > repeatedCount) {
      repeatedTool = name
      repeatedCount = count
    }
  }
  return { repeatedTool, counts }
}

function buildIncident(
  input: Omit<SupervisorIncident, 'id' | 'createdAt'>,
): Omit<SupervisorIncident, 'id' | 'createdAt'> {
  return {
    ...input,
    summary: cleanText(input.summary, 320) || 'Autonomy supervisor incident',
    details: cleanText(input.details, 500),
    toolName: cleanText(input.toolName, 120),
  }
}

function sessionContextPressure(session: Session | null): boolean {
  if (!session || !Array.isArray(session.messages)) return false
  if (session.messages.length >= 60) return true
  const totalChars = session.messages.reduce((sum, message) => sum + String(message?.text || '').length, 0)
  return totalChars >= 18_000
}

export function assessAutonomyRun(input: {
  runId: string
  sessionId: string
  taskId?: string | null
  agentId?: string | null
  source: string
  status?: SessionRunStatus | null
  resultText?: string | null
  error?: string | null
  toolEvents?: MessageToolEvent[]
  mainLoopState?: SupervisorStateSnapshot | null
  session?: Session | null
  settings?: Partial<AppSettings> | NormalizedSupervisorSettings | null
}): AutonomyAssessment {
  const settings = normalizeSupervisorSettings(input.settings || loadSettings())
  const surface = classifySurface(input.source)
  if (!surface || !settings.supervisorEnabled || !runtimeScopeIncludes(settings.supervisorRuntimeScope, surface)) {
    return { incidents: [], interventionPrompt: null, shouldBlock: false }
  }

  const session = input.session || null
  const toolEvents = Array.isArray(input.toolEvents) ? input.toolEvents : []
  const stripped = stripMainLoopMeta(String(input.resultText || ''))
  const incidents: Array<Omit<SupervisorIncident, 'id' | 'createdAt'>> = []
  const { repeatedTool, counts } = summarizeToolNames(toolEvents)
  const repeatedCount = repeatedTool ? (counts.get(repeatedTool) || 0) : 0
  const state = input.mainLoopState || null
  const cost = typeof state?.missionCostUsd === 'number' ? state.missionCostUsd : 0
  const budgetUsd = typeof state?.goalContract?.budgetUsd === 'number' ? state.goalContract.budgetUsd : null
  const normalizedResult = stripped.toLowerCase()
  const repeatedSummary = Boolean(state?.summary && stripped && trimText(stripped, 220) === trimText(String(state.summary || ''), 220))
  const shortOrEmpty = !stripped || stripped.length < 80
  const status = input.status || 'completed'

  if (input.error) {
    incidents.push(buildIncident({
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId || null,
      agentId: input.agentId || null,
      source: input.source,
      kind: 'run_error',
      severity: 'high',
      summary: `Run failed: ${input.error}`,
      details: stripped || null,
      autoAction: 'block',
    }))
  }

  if (repeatedTool && repeatedCount >= settings.supervisorRepeatedToolLimit) {
    incidents.push(buildIncident({
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId || null,
      agentId: input.agentId || null,
      source: input.source,
      kind: 'repeated_tool',
      severity: repeatedCount >= settings.supervisorRepeatedToolLimit + 1 ? 'high' : 'medium',
      summary: `Repeated tool use detected: ${repeatedTool} ran ${repeatedCount} times in one run.`,
      details: stripped || null,
      toolName: repeatedTool,
      autoAction: 'replan',
    }))
  }

  if (
    !input.error
    && state
    && (state.followupChainCount || 0) >= settings.supervisorNoProgressLimit
    && (shortOrEmpty || repeatedSummary || /still working|continuing|trying again|retry/i.test(normalizedResult))
  ) {
    incidents.push(buildIncident({
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId || null,
      agentId: input.agentId || null,
      source: input.source,
      kind: 'no_progress',
      severity: 'medium',
      summary: 'No progress detected across recent autonomous turns.',
      details: stripped || null,
      autoAction: 'replan',
    }))
  }

  if (budgetUsd && Number.isFinite(budgetUsd) && budgetUsd > 0) {
    if (cost >= budgetUsd) {
      incidents.push(buildIncident({
        runId: input.runId,
        sessionId: input.sessionId,
        taskId: input.taskId || null,
        agentId: input.agentId || null,
        source: input.source,
        kind: 'budget_pressure',
        severity: 'high',
        summary: `Goal budget reached or exceeded ($${cost.toFixed(2)} / $${budgetUsd.toFixed(2)}).`,
        details: stripped || null,
        autoAction: 'budget_trim',
      }))
    } else if (cost >= budgetUsd * 0.9) {
      incidents.push(buildIncident({
        runId: input.runId,
        sessionId: input.sessionId,
        taskId: input.taskId || null,
        agentId: input.agentId || null,
        source: input.source,
        kind: 'budget_pressure',
        severity: 'medium',
        summary: `Goal budget nearly exhausted ($${cost.toFixed(2)} / $${budgetUsd.toFixed(2)}).`,
        details: stripped || null,
        autoAction: 'budget_trim',
      }))
    }
  }

  if (!input.error && sessionContextPressure(session)) {
    incidents.push(buildIncident({
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId || null,
      agentId: input.agentId || null,
      source: input.source,
      kind: 'context_pressure',
      severity: 'medium',
      summary: 'Context pressure detected; the session transcript is getting large.',
      details: null,
      autoAction: 'compact',
    }))
  }

  const strongest = [...incidents].sort((left, right) => severityRank(right.severity) - severityRank(left.severity))[0] || null
  let interventionPrompt: string | null = null
  let shouldBlock = false
  if (strongest?.kind === 'repeated_tool') {
    interventionPrompt = `Supervisor intervention: stop repeating ${strongest.toolName || 'the same tool'}. Summarize what has already been tried, identify why it is failing, then choose one materially different next step. Do not re-run the same tool call unless a concrete input has changed.`
  } else if (strongest?.kind === 'no_progress') {
    interventionPrompt = 'Supervisor intervention: no real progress has been made across recent autonomous turns. Summarize completed work, state the current blocker clearly, then either pick one different recovery step or mark the run blocked with the exact missing input.'
  } else if (strongest?.kind === 'budget_pressure' && strongest.severity !== 'high') {
    interventionPrompt = 'Supervisor intervention: budget is nearly exhausted. Skip exploratory work, avoid broad searches, and execute only the single highest-value remaining step needed to finish or surface the blocker.'
  } else if (strongest?.kind === 'context_pressure') {
    interventionPrompt = 'Supervisor intervention: compact context before continuing. Summarize objective, completed work, blocker state, and next action in a short execution brief, then continue from that brief only.'
  }

  if (strongest?.kind === 'budget_pressure' && strongest.severity === 'high') shouldBlock = true
  if (strongest?.kind === 'run_error' && (status === 'failed' || status === 'cancelled')) shouldBlock = true

  return { incidents, interventionPrompt, shouldBlock }
}

function buildSessionTranscript(session: Session, maxMessages = DEFAULT_TRANSCRIPT_MESSAGES): string {
  const messages = Array.isArray(session.messages) ? session.messages.slice(-maxMessages) : []
  const lines: string[] = []
  for (const message of messages) {
    if (!message || message.suppressed) continue
    const text = trimText(stripMainLoopMeta(String(message.text || '')), 700)
    const toolSummary = Array.isArray(message.toolEvents) && message.toolEvents.length > 0
      ? `\nTools: ${message.toolEvents.slice(0, 5).map((event) => {
        const status = event.error ? 'error' : 'ok'
        return `${event.name}(${status})`
      }).join(', ')}`
      : ''
    if (!text && !toolSummary) continue
    lines.push(`${message.role.toUpperCase()}: ${text}${toolSummary}`)
  }
  return lines.join('\n\n')
}

function latestAssistantToolEvents(session: Session | null): MessageToolEvent[] {
  if (!session || !Array.isArray(session.messages)) return []
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]
    if (message?.role !== 'assistant') continue
    if (Array.isArray(message.toolEvents) && message.toolEvents.length > 0) return message.toolEvents
  }
  return []
}

function buildReflectionPrompt(params: {
  session: Session
  source: string
  status: SessionRunStatus
  resultText: string
  incidents: SupervisorIncident[]
  sourceMessage?: string | null
}): string {
  const incidentLines = params.incidents.length > 0
    ? params.incidents.map((incident) => `- ${incident.kind}: ${incident.summary}`).join('\n')
    : '- none'
  const transcript = buildSessionTranscript(params.session)
  return [
    'You are the SwarmClaw autonomy distiller.',
    'Turn one completed run into reflection memory that improves future runs.',
    'Return JSON only.',
    'If there is nothing worth storing, return {"skip":true,"reason":"..."}',
    '',
    'Required JSON fields when useful learning exists:',
    '- summary: one sentence',
    '- invariants: 0-4 stable rules that should remain true for future similar work',
    '- derived: 0-4 short-lived heuristics or next-run adjustments',
    '- failures: 0-3 concise failure patterns to avoid repeating',
    '- lessons: 0-4 reusable lessons',
    '- communication: 0-4 communication or tone preferences about the user/person worth remembering',
    '- relationship: 0-4 durable human context notes such as trust boundaries, personal priorities, or recurring sensitivities',
    '- significant_events: 0-4 notable life/work events or milestones that should be remembered later; include timing when the transcript states it',
    '- profile: 0-4 stable profile facts stated explicitly in the transcript, such as role, pronouns, timezone, or family context',
    '- boundaries: 0-4 explicit do/don\'t rules, sensitive topics, consent limits, or interaction boundaries',
    '- open_loops: 0-4 ongoing human situations, promised follow-ups, or check-back items that should resurface later',
    '',
    'Rules:',
    '- Remove secrets, tokens, hostnames, and one-off identifiers.',
    '- Prefer operational guidance over transcript recap.',
    '- Only include communication, relationship, or significant event notes when the transcript genuinely supports them.',
    '- Do not repeat the same sentence across sections.',
    '- Leave arrays empty when not applicable.',
    '',
    `Source: ${params.source}`,
    `Status: ${params.status}`,
    params.sourceMessage ? `Run prompt: ${trimText(params.sourceMessage, 240)}` : '',
    `Supervisor incidents:\n${incidentLines}`,
    '',
    'Result:',
    trimText(stripMainLoopMeta(params.resultText), 900),
    '',
    'Transcript:',
    transcript,
  ].filter(Boolean).join('\n')
}

function maybeParseJson(text: string): Record<string, unknown> | null {
  const raw = text.trim()
  const candidates = [
    raw,
    raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // ignore and continue
    }
  }
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function normalizeNoteArray(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const note = cleanText(entry, 220)
    if (!note) continue
    const key = note.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(note)
    if (out.length >= limit) break
  }
  return out
}

function transcriptHasHumanSignals(session: Session | null): boolean {
  if (!session || !Array.isArray(session.messages)) return false
  const recentMessages = session.messages.slice(-8)
  return recentMessages.some((message) => HUMAN_SIGNAL_RE.test(stripMainLoopMeta(String(message?.text || ''))))
}

function parseReflectionResponse(raw: string): {
  skip: boolean
  reason?: string
  summary?: string
  invariants: string[]
  derived: string[]
  failures: string[]
  lessons: string[]
  communication: string[]
  relationship: string[]
  significantEvents: string[]
  profile: string[]
  boundaries: string[]
  openLoops: string[]
} {
  const parsed = maybeParseJson(raw)
  if (!parsed) throw new Error('Model did not return valid JSON for the run reflection.')
  if (parsed.skip === true) {
    return {
      skip: true,
      reason: cleanText(parsed.reason, 220) || 'No durable learning found for this run.',
      invariants: [],
      derived: [],
      failures: [],
      lessons: [],
      communication: [],
      relationship: [],
      significantEvents: [],
      profile: [],
      boundaries: [],
      openLoops: [],
    }
  }
  const summary = cleanText(parsed.summary, 220)
  const invariants = normalizeNoteArray(parsed.invariants, 4)
  const derived = normalizeNoteArray(parsed.derived, 4)
  const failures = normalizeNoteArray(parsed.failures, 3)
  const lessons = normalizeNoteArray(parsed.lessons, 4)
  const communication = normalizeNoteArray(parsed.communication, 4)
  const relationship = normalizeNoteArray(parsed.relationship, 4)
  const significantEvents = normalizeNoteArray(parsed.significant_events, 4)
  const profile = normalizeNoteArray(parsed.profile, 4)
  const boundaries = normalizeNoteArray(parsed.boundaries, 4)
  const openLoops = normalizeNoteArray(parsed.open_loops, 4)
  if (
    !summary
    && invariants.length === 0
    && derived.length === 0
    && failures.length === 0
    && lessons.length === 0
    && communication.length === 0
    && relationship.length === 0
    && significantEvents.length === 0
    && profile.length === 0
    && boundaries.length === 0
    && openLoops.length === 0
  ) {
    return {
      skip: true,
      reason: 'No durable learning found for this run.',
      invariants: [],
      derived: [],
      failures: [],
      lessons: [],
      communication: [],
      relationship: [],
      significantEvents: [],
      profile: [],
      boundaries: [],
      openLoops: [],
    }
  }
  return {
    skip: false,
    summary: summary || 'Autonomy reflection',
    invariants,
    derived,
    failures,
    lessons,
    communication,
    relationship,
    significantEvents,
    profile,
    boundaries,
    openLoops,
  }
}

function shouldReflectRun(params: {
  source: string
  status: SessionRunStatus
  resultText: string
  incidents: SupervisorIncident[]
  toolEvents: MessageToolEvent[]
  session: Session | null
  runtimeScope: AutonomyRuntimeScope
}): boolean {
  const surface = classifySurface(params.source)
  if (!surface || !runtimeScopeIncludes(params.runtimeScope, surface)) return false
  if (params.status === 'cancelled') return false
  if (surface === 'task') return Boolean(params.resultText.trim() || params.incidents.length > 0)
  const meaningfulMessages = Array.isArray(params.session?.messages)
    ? params.session.messages.filter((message) => message && !message.suppressed && (message.text || message.toolEvents?.length)).length
    : 0
  if (transcriptHasHumanSignals(params.session)) return true
  if (params.incidents.length > 0) return true
  if (params.toolEvents.length > 0) return true
  if (params.resultText.trim().length >= 180) return true
  if (meaningfulMessages >= 6 && params.resultText.trim().length >= 100) return true
  if (meaningfulMessages >= 4 && params.resultText.trim().length >= 60) return true
  return false
}

type ReflectionMemoryKind =
  | 'invariant'
  | 'derived'
  | 'failure'
  | 'lesson'
  | 'communication'
  | 'relationship'
  | 'significant_event'
  | 'profile'
  | 'boundary'
  | 'open_loop'

function buildMemoryTitle(kind: ReflectionMemoryKind, summary: string): string {
  const prefix = kind === 'invariant'
    ? 'Reflection Invariant'
    : kind === 'derived'
      ? 'Reflection Heuristic'
      : kind === 'failure'
        ? 'Reflection Failure'
        : kind === 'lesson'
          ? 'Reflection Lesson'
          : kind === 'communication'
          ? 'Communication Preference'
          : kind === 'relationship'
            ? 'Relationship Context'
            : kind === 'significant_event'
              ? 'Significant Event'
              : kind === 'profile'
                ? 'Profile Context'
                : kind === 'boundary'
                  ? 'Interaction Boundary'
                  : 'Open Loop'
  return `${prefix}: ${trimText(summary, 100)}`
}

function memoryCategoryForKind(kind: ReflectionMemoryKind): string {
  if (kind === 'invariant') return 'reflection/invariant'
  if (kind === 'derived') return 'reflection/derived'
  if (kind === 'failure') return 'reflection/failure'
  if (kind === 'lesson') return 'reflection/lesson'
  if (kind === 'communication') return 'reflection/communication'
  if (kind === 'relationship') return 'reflection/relationship'
  if (kind === 'significant_event') return 'reflection/significant_event'
  if (kind === 'profile') return 'reflection/profile'
  if (kind === 'boundary') return 'reflection/boundary'
  return 'reflection/open_loop'
}

function writeReflectionMemories(params: {
  reflectionId: string
  runId: string
  sessionId: string
  agentId?: string | null
  incidents: SupervisorIncident[]
  summary: string
  invariants: string[]
  derived: string[]
  failures: string[]
  lessons: string[]
  communication: string[]
  relationship: string[]
  significantEvents: string[]
  profile: string[]
  boundaries: string[]
  openLoops: string[]
}): string[] {
  const memoryDb = getMemoryDb()
  const memoryIds: string[] = []
  const incidentIds = params.incidents.map((incident) => incident.id)
  const groups: Array<{ kind: ReflectionMemoryKind; notes: string[] }> = [
    { kind: 'invariant', notes: params.invariants },
    { kind: 'derived', notes: params.derived },
    { kind: 'failure', notes: params.failures },
    { kind: 'lesson', notes: params.lessons },
    { kind: 'communication', notes: params.communication },
    { kind: 'relationship', notes: params.relationship },
    { kind: 'significant_event', notes: params.significantEvents },
    { kind: 'profile', notes: params.profile },
    { kind: 'boundary', notes: params.boundaries },
    { kind: 'open_loop', notes: params.openLoops },
  ]

  for (const group of groups) {
    for (const note of group.notes) {
      const metadata: Record<string, unknown> = {
        origin: 'autonomy-reflection',
        reflectionId: params.reflectionId,
        reflectionKind: group.kind,
        runId: params.runId,
        incidentIds,
        autoWritten: true,
        tier: 'durable',
      }
      if (group.kind === 'communication' || group.kind === 'relationship' || group.kind === 'profile' || group.kind === 'boundary') {
        metadata.memoryFacet = 'human'
      }
      if (group.kind === 'significant_event') {
        metadata.memoryFacet = 'event'
        metadata.eventSalience = SIGNIFICANT_EVENT_RE.test(note) ? 'high' : 'medium'
      }
      if (group.kind === 'open_loop') metadata.memoryFacet = 'followup'
      const entry = memoryDb.add({
        agentId: params.agentId || null,
        sessionId: params.sessionId,
        category: memoryCategoryForKind(group.kind),
        title: buildMemoryTitle(group.kind, params.summary),
        content: note,
        metadata,
      })
      memoryIds.push(entry.id)
    }
  }

  return [...new Set(memoryIds)]
}

export function listSupervisorIncidents(filters?: { sessionId?: string; taskId?: string; limit?: number }): SupervisorIncident[] {
  const sessionId = cleanText(filters?.sessionId, 120)
  const taskId = cleanText(filters?.taskId, 120)
  const limit = Math.max(1, Math.min(200, Number(filters?.limit || 100)))
  return Object.values(loadSupervisorIncidents())
    .filter((incident) => (!sessionId || incident.sessionId === sessionId) && (!taskId || incident.taskId === taskId))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
}

export function listRunReflections(filters?: { sessionId?: string; taskId?: string; limit?: number }): RunReflection[] {
  const sessionId = cleanText(filters?.sessionId, 120)
  const taskId = cleanText(filters?.taskId, 120)
  const limit = Math.max(1, Math.min(200, Number(filters?.limit || 100)))
  return Object.values(loadRunReflections())
    .filter((reflection) => (!sessionId || reflection.sessionId === sessionId) && (!taskId || reflection.taskId === taskId))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
}

function persistIncidents(incidents: Array<Omit<SupervisorIncident, 'id' | 'createdAt'>>): SupervisorIncident[] {
  if (!incidents.length) return []
  const store = loadSupervisorIncidents()
  const created: SupervisorIncident[] = []
  const createdAt = now()
  for (const incident of incidents) {
    const signature = crypto.createHash('sha1')
      .update(JSON.stringify({
        runId: incident.runId,
        sessionId: incident.sessionId,
        kind: incident.kind,
        summary: incident.summary,
        toolName: incident.toolName || null,
      }))
      .digest('hex')
    const existing = Object.values(store).find((entry) =>
      entry.runId === incident.runId
      && entry.kind === incident.kind
      && entry.summary === incident.summary
      && (entry.toolName || null) === (incident.toolName || null),
    )
    const next: SupervisorIncident = existing || {
      ...incident,
      id: `sup-${signature.slice(0, 12)}`,
      createdAt,
    }
    store[next.id] = next
    created.push(next)
  }
  saveSupervisorIncidents(store)
  return created
}

export async function observeAutonomyRunOutcome(
  input: ObserveAutonomyRunInput,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<{ incidents: SupervisorIncident[]; reflection: RunReflection | null }> {
  const settings = normalizeSupervisorSettings(loadSettings())
  const surface = classifySurface(input.source)
  if (!surface || !runtimeScopeIncludes(settings.supervisorRuntimeScope, surface)) {
    return { incidents: [], reflection: null }
  }

  const sessions = loadSessions()
  const session = sessions[input.sessionId] as Session | undefined
  const toolEvents = Array.isArray(input.toolEvents) && input.toolEvents.length > 0
    ? input.toolEvents
    : latestAssistantToolEvents(session || null)
  const resultText = String(input.resultText || input.error || '')
  const assessment = assessAutonomyRun({
    ...input,
    resultText,
    toolEvents,
    session: session || null,
    settings,
  })
  const incidents = persistIncidents(assessment.incidents)

  if (!settings.reflectionEnabled || !shouldReflectRun({
    source: input.source,
    status: input.status,
    resultText,
    incidents,
    toolEvents,
    session: session || null,
    runtimeScope: settings.supervisorRuntimeScope,
  })) {
    return { incidents, reflection: null }
  }

  const existing = Object.values(loadRunReflections()).find((entry) => entry.runId === input.runId)
  if (existing) return { incidents, reflection: existing }
  if (!session) return { incidents, reflection: null }

  const prompt = buildReflectionPrompt({
    session,
    source: input.source,
    status: input.status,
    resultText,
    incidents,
    sourceMessage: input.sourceMessage,
  })
  const responseText = options?.generateText
    ? await options.generateText(prompt)
    : await (async () => {
      const { llm } = await buildLLM()
      const response = await llm.invoke([new HumanMessage(prompt)])
      if (typeof response.content === 'string') return response.content
      if (Array.isArray(response.content)) {
        return response.content
          .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
          .join('')
      }
      return ''
    })()
  const parsed = parseReflectionResponse(responseText)
  if (parsed.skip) return { incidents, reflection: null }

  const reflectionId = genId()
  const autoMemoryIds = settings.reflectionAutoWriteMemory
    ? writeReflectionMemories({
        reflectionId,
        runId: input.runId,
        sessionId: input.sessionId,
        agentId: input.agentId || null,
        incidents,
        summary: parsed.summary || 'Autonomy reflection',
        invariants: parsed.invariants,
        derived: parsed.derived,
        failures: parsed.failures,
        lessons: parsed.lessons,
        communication: parsed.communication,
        relationship: parsed.relationship,
        significantEvents: parsed.significantEvents,
        profile: parsed.profile,
        boundaries: parsed.boundaries,
        openLoops: parsed.openLoops,
      })
    : []

  const reflection: RunReflection = {
    id: reflectionId,
    runId: input.runId,
    sessionId: input.sessionId,
    taskId: input.taskId || null,
    agentId: input.agentId || null,
    source: input.source,
    status: input.status,
    summary: parsed.summary || 'Autonomy reflection',
    sourceSnippet: trimText(buildSessionTranscript(session), DEFAULT_SNIPPET_CHARS),
    invariantNotes: parsed.invariants,
    derivedNotes: parsed.derived,
    failureNotes: parsed.failures,
    lessonNotes: parsed.lessons,
    communicationNotes: parsed.communication,
    relationshipNotes: parsed.relationship,
    significantEventNotes: parsed.significantEvents,
    profileNotes: parsed.profile,
    boundaryNotes: parsed.boundaries,
    openLoopNotes: parsed.openLoops,
    incidentIds: incidents.map((incident) => incident.id),
    autoMemoryIds,
    createdAt: now(),
    updatedAt: now(),
  }

  const reflections = loadRunReflections()
  reflections[reflection.id] = reflection
  saveRunReflections(reflections)
  return { incidents, reflection }
}
