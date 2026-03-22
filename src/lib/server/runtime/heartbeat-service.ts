import fs from 'fs'
import path from 'path'
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_HEARTBEAT_SHOW_ALERTS,
  DEFAULT_HEARTBEAT_SHOW_OK,
} from '@/lib/runtime/heartbeat-defaults'
import { logActivity } from '@/lib/server/activity/activity-log'
import { loadApprovals } from '@/lib/server/approvals/approval-repository'
import { loadAgents, patchAgent } from '@/lib/server/agents/agent-repository'
import { loadChatrooms } from '@/lib/server/chatrooms/chatroom-repository'
import { loadMission } from '@/lib/server/missions/mission-repository'
import { loadSessions, patchSession } from '@/lib/server/sessions/session-repository'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { buildGoalAncestrySection, buildPlatformStatusSummary } from '@/lib/server/chat-execution/situational-awareness'
import { drainDeferredWakes, hasDeferredWakes } from '@/lib/server/runtime/wake-dispatcher'
import { buildWakeTriggerContext } from '@/lib/server/runtime/heartbeat-wake'
import { enqueueSessionRun, getSessionRunState } from '@/lib/server/runtime/session-run-manager'
import { log } from '@/lib/server/logger'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { drainSystemEvents, drainOrchestratorEvents } from '@/lib/server/runtime/system-events'
import { buildMissionContextBlock } from '@/lib/server/missions/mission-service'
import { getMessages, getRecentMessages, clearMessages } from '@/lib/server/messages/message-repository'
import type { Agent, AppSettings, ApprovalRequest, Chatroom, Message, Session } from '@/types'
import { isOrchestratorEligible } from '@/lib/orchestrator-config'
import { buildIdentityContinuityContext } from '@/lib/server/identity-continuity'
import { buildMainLoopHeartbeatPrompt, getMainLoopStateForSession, isMainSession } from '@/lib/server/agents/main-agent-loop'
import { ensureAgentThreadSession } from '@/lib/server/agents/agent-thread-session'
import { isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { errorMessage, hmrSingleton, jitteredBackoff } from '@/lib/shared-utils'
import { logExecution } from '@/lib/server/execution-log'
import { createNotification } from '@/lib/server/create-notification'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'

const HEARTBEAT_TICK_MS = 60_000
const MAX_CONCURRENT_HEARTBEATS = 1
const BACKOFF_BASE_MS = 10_000
const BACKOFF_MAX_MS = 5 * 60_000
/** Auto-disable heartbeat after this many consecutive failures */
const MAX_CONSECUTIVE_FAILURES = 10
/** Grace period after startup before heartbeats fire — lets connectors/gateway stabilize */
const STARTUP_GRACE_MS = 180_000
/** Sessions idle longer than 7 days are skipped — active heartbeats self-refresh lastActiveAt */
const MAX_SESSION_IDLE_MS = 7 * 24 * 3600_000
/** Shorter heartbeat interval when an agent is actively progressing */
const ACTIVE_HEARTBEAT_INTERVAL_SEC = 120
/** Consider agent "active" if last main loop tick was within this window */
const ACTIVE_WINDOW_MS = 10 * 60_000

// --- Orchestrator mode constants ---
const ORCHESTRATOR_DEFAULT_INTERVAL_SEC = 300  // 5 min
const ORCHESTRATOR_MIN_INTERVAL_SEC = 60
const ORCHESTRATOR_MAX_INTERVAL_SEC = 86400    // 24h
const ORCHESTRATOR_MAX_PROMPT_CHARS = 4000

interface FailureRecord {
  count: number
  lastFailedAt: number
  /** Set when auto-disabled due to too many consecutive failures */
  autoDisabledAt?: number
  /** How many recovery attempts have been made since auto-disable */
  recoveryAttempts?: number
  /** Timestamp when the next recovery attempt is allowed */
  nextRecoveryAt?: number
}

interface HeartbeatState {
  timer: ReturnType<typeof setInterval> | null
  running: boolean
  startedAt: number
  lastBySession: Map<string, number>
  failures: Map<string, FailureRecord>
}

const state: HeartbeatState = hmrSingleton<HeartbeatState>('__swarmclaw_heartbeat_service__', () => ({
  timer: null,
  running: false,
  startedAt: 0,
  lastBySession: new Map<string, number>(),
  failures: new Map<string, FailureRecord>(),
}))

/** Track orchestrator wake times and failures per agent (separate from session-scoped heartbeat state) */
interface OrchestratorState {
  lastWakeByAgent: Map<string, number>
  failures: Map<string, FailureRecord>
  /** Tracks daily cycle counts: agentId:YYYY-MM-DD -> count */
  dailyCycles: Map<string, number>
}
const orchestratorState: OrchestratorState = hmrSingleton<OrchestratorState>('__swarmclaw_orchestrator_state__', () => ({
  lastWakeByAgent: new Map(),
  failures: new Map(),
  dailyCycles: new Map(),
}))

function parseIntBounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Parse a duration value into seconds.
 * Accepts: "30m", "1h", "2h30m", "45s", "1800", 1800, null/undefined.
 * Returns integer seconds clamped to [0, 86400].
 */
function parseDuration(value: unknown, fallbackSec: number): number {
  if (value === null || value === undefined) return fallbackSec
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallbackSec
    return Math.max(0, Math.min(86400, Math.trunc(value)))
  }
  if (typeof value !== 'string') return fallbackSec
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return fallbackSec
  // Plain numeric string — treat as seconds (backward compat)
  const asNum = Number(trimmed)
  if (Number.isFinite(asNum)) {
    return Math.max(0, Math.min(86400, Math.trunc(asNum)))
  }
  const m = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/)
  if (!m || (!m[1] && !m[2] && !m[3])) return fallbackSec
  const hours = m[1] ? Number.parseInt(m[1], 10) : 0
  const minutes = m[2] ? Number.parseInt(m[2], 10) : 0
  const seconds = m[3] ? Number.parseInt(m[3], 10) : 0
  const total = hours * 3600 + minutes * 60 + seconds
  return Math.max(0, Math.min(86400, total))
}

function parseTimeHHMM(raw: unknown): { h: number; m: number } | null {
  if (typeof raw !== 'string') return null
  const val = raw.trim()
  if (!val) return null
  const m = val.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number.parseInt(m[1], 10)
  const mm = Number.parseInt(m[2], 10)
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
  if (h < 0 || h > 24 || mm < 0 || mm > 59) return null
  if (h === 24 && mm !== 0) return null
  return { h, m: mm }
}

function getMinutesInTimezone(date: Date, timezone?: string | null): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone || undefined,
    })
    const parts = formatter.formatToParts(date)
    const hh = Number.parseInt(parts.find((p) => p.type === 'hour')?.value || '', 10)
    const mm = Number.parseInt(parts.find((p) => p.type === 'minute')?.value || '', 10)
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
    return hh * 60 + mm
  } catch {
    return null
  }
}

function inActiveWindow(nowDate: Date, startRaw: unknown, endRaw: unknown, tzRaw: unknown): boolean {
  const start = parseTimeHHMM(startRaw)
  const end = parseTimeHHMM(endRaw)
  if (!start || !end) return true

  const tz = typeof tzRaw === 'string' && tzRaw.trim() ? tzRaw.trim() : undefined
  const current = getMinutesInTimezone(nowDate, tz)
  if (current == null) return true

  const startM = start.h * 60 + start.m
  const endM = end.h * 60 + end.m
  if (startM === endM) return true
  if (startM < endM) return current >= startM && current < endM
  return current >= startM || current < endM
}

export interface HeartbeatConfig {
  intervalSec: number
  prompt: string
  enabled: boolean
  model: string | null
  ackMaxChars: number
  showOk: boolean
  showAlerts: boolean
  target: string | null
  lightContext: boolean
}

interface HeartbeatFileSession {
  cwd?: string | null
}

type HeartbeatPromptSession = Partial<Session> & Record<string, unknown>
type HeartbeatPromptAgent = Partial<Agent>
type HeartbeatPromptMessage = Pick<Message, 'role' | 'text' | 'time' | 'toolEvents'>

const DEFAULT_HEARTBEAT_PROMPT = 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.'

export function readHeartbeatFile(session: HeartbeatFileSession): string {
  try {
    const filePath = path.join(session.cwd || WORKSPACE_DIR, 'HEARTBEAT.md')
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim()
    }
  } catch { /* ignore */ }
  return ''
}

const identityFileCache = hmrSingleton<Map<string, { data: Record<string, string>; expiresAt: number; mtimeMs: number | null }>>(
  '__hb_identity_cache__', () => new Map(),
)
const IDENTITY_CACHE_TTL_MS = 60_000

function readIdentityFile(session: { cwd?: string | null }): Record<string, string> {
  const cwd = typeof session.cwd === 'string' ? session.cwd : WORKSPACE_DIR
  const filePath = path.join(cwd, 'IDENTITY.md')
  let mtimeMs: number | null = null
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs
  } catch {
    mtimeMs = null
  }
  const cached = identityFileCache.get(cwd)
  if (cached && Date.now() < cached.expiresAt && cached.mtimeMs === mtimeMs) return cached.data
  try {
    if (mtimeMs !== null) {
      const content = fs.readFileSync(filePath, 'utf-8')
      const identity: Record<string, string> = {}
      for (const line of content.split('\n')) {
        const cleaned = line.trim().replace(/^\s*-\s*/, '')
        const colonIndex = cleaned.indexOf(':')
        if (colonIndex === -1) continue
        const label = cleaned.slice(0, colonIndex).replace(/[*_]/g, '').trim().toLowerCase()
        const value = cleaned.slice(colonIndex + 1).replace(/^[*_]+|[*_]+$/g, '').trim()
        if (value) identity[label] = value
      }
      identityFileCache.set(cwd, { data: identity, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS, mtimeMs })
      return identity
    }
  } catch { /* ignore */ }
  const empty: Record<string, string> = {}
  identityFileCache.set(cwd, { data: empty, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS, mtimeMs: null })
  return empty
}

export function buildIdentityContext(
  session: { cwd?: string | null } | undefined | null,
  agent: {
    name?: string | null
    emoji?: string | null
    creature?: string | null
    vibe?: string | null
    theme?: string | null
  } | undefined | null,
): string {
  const fileId = session ? readIdentityFile(session) : {}
  const name = fileId.name || agent?.name || ''
  const emoji = fileId.emoji || agent?.emoji || ''
  const creature = fileId.creature || agent?.creature || ''
  const vibe = fileId.vibe || agent?.vibe || ''
  const theme = fileId.theme || agent?.theme || ''

  const lines = []
  if (name) lines.push(`Name: ${name}`)
  if (emoji) lines.push(`Emoji: ${emoji}`)
  if (creature) lines.push(`Creature: ${creature}`)
  if (vibe) lines.push(`Vibe: ${vibe}`)
  if (theme) lines.push(`Theme: ${theme}`)

  if (lines.length === 0) return ''
  return `## Your Identity\n${lines.join('\n')}`
}

// ── Blocked-item suppression ────────────────────────────────────────────
// Duplicate-suppression: instead of letting
// the LLM see blocked tasks every tick (and parrot "still blocked"), we
// strip those lines before they ever reach the prompt.  A line is
// considered blocked if it contains "(blocked" anywhere (case-insensitive),
// which covers "(blocked, no update)", "(blocked: awaiting …)", etc.
const BLOCKED_MARKER_RE = /\(blocked\b/i

/**
 * Remove blocked checklist items from HEARTBEAT.md content so the LLM
 * doesn't keep surfacing them.  Headers and non-list lines pass through
 * unchanged.
 */
export function stripBlockedItems(content: string): string {
  if (!content) return ''
  const lines = content.split('\n')
  const filtered = lines.filter((line) => {
    const trimmed = line.trim()
    // Only filter checklist / list items that are explicitly marked blocked
    if (/^[-*+]\s/.test(trimmed) && BLOCKED_MARKER_RE.test(trimmed)) return false
    return true
  })
  return filtered.join('\n')
}

/** Detect HEARTBEAT.md files that contain only skeleton structure (headers, empty list items) but no real content. */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (!content || typeof content !== 'string') return true
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#+(\s|$)/.test(trimmed)) continue                           // ATX headers
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue        // empty list items / checkboxes
    return false  // real content found
  }
  return true
}

export function buildAgentHeartbeatPrompt(
  session: HeartbeatPromptSession,
  agent: HeartbeatPromptAgent | null | undefined,
  fallbackPrompt: string,
  heartbeatFileContent: string,
  opts?: { approvals?: Record<string, ApprovalRequest>; chatrooms?: Record<string, Chatroom> },
): string {
  if (!agent) return fallbackPrompt

  const sections: string[] = []

  // ── Phase 1: Identity context ──
  sections.push('AGENT_HEARTBEAT_TICK')
  sections.push(`Time: ${new Date().toISOString()}`)
  const identityContext = buildIdentityContext(session, agent)
  const continuityContext = buildIdentityContinuityContext(session, agent)
  if (identityContext) sections.push(identityContext)
  if (continuityContext) sections.push(continuityContext)
  const description = agent.description || ''
  const soul = agent.soul || ''
  if (description) sections.push(`Description: ${description}`)
  if (soul) sections.push(`Persona: ${soul.slice(0, 300)}`)

  // ── Phase 2: Pending approvals ──
  const agentId = agent.id || session.agentId || ''
  if (agentId) {
    try {
      const allApprovals = opts?.approvals ?? loadApprovals()
      const pending = Object.values(allApprovals).filter(
        (a) => a.status === 'pending' && a.agentId === agentId,
      )
      if (pending.length > 0) {
        const approvalLines = pending.slice(0, 5).map(
          (a) => `- [${a.category}] ${a.title}${a.description ? `: ${a.description.slice(0, 100)}` : ''}`,
        )
        sections.push(`### Pending Approvals (${pending.length})\n${approvalLines.join('\n')}`)
      }
    } catch {
      // Approvals may not be available; skip silently
    }
  }

  // ── Phase 3: Goal ancestry ──
  const missionId = (session.missionId || (agent as Record<string, unknown>).missionId || null) as string | null
  const goalAncestry = buildGoalAncestrySection(missionId)
  if (goalAncestry) sections.push(goalAncestry)

  // ── Phase 4: Active task checkout & events ──
  const events = drainSystemEvents(session.id!)
  if (events.length > 0) {
    const eventBlock = events.map((e) => `- [${new Date(e.timestamp).toISOString()}] ${e.text}`).join('\n')
    sections.push(`Events since last heartbeat:\n${eventBlock}`)
  }

  const dynamicGoal = agent.heartbeatGoal || ''
  const dynamicNextAction = agent.heartbeatNextAction || ''
  const systemPrompt = agent.systemPrompt || ''
  const goalSummary = systemPrompt.slice(0, 500)

  if (dynamicGoal) {
    sections.push(`Current goal (self-set): ${dynamicGoal}`)
  } else if (goalSummary) {
    sections.push(`System prompt (initial goal):\n${goalSummary}`)
  }
  if (dynamicNextAction) sections.push(`Planned next action: ${dynamicNextAction}`)

  const strippedContent = stripBlockedItems(heartbeatFileContent)
  const effectiveFileContent = isHeartbeatContentEffectivelyEmpty(strippedContent) ? '' : strippedContent
  if (effectiveFileContent) sections.push(`\nHEARTBEAT.md contents:\n${effectiveFileContent.slice(0, 2000)}`)

  const recentMessages = (session.id ? getRecentMessages(session.id, 5) : []) as HeartbeatPromptMessage[]
  const recentContext = recentMessages
    .map((m) => {
      const text = (m.text || '').slice(0, 200)
      const tools = Array.isArray(m.toolEvents) && m.toolEvents.length > 0
        ? ` [tools used: ${m.toolEvents.map((t: { name: string }) => t.name).join(', ')}]`
        : ''
      return `[${m.role}]: ${text}${tools}`
    })
    .join('\n')
  if (recentContext) sections.push(`Recent conversation:\n${recentContext}`)

  // ── Phase 4b: Chatroom mentions since last heartbeat ──
  try {
    const chatrooms = Object.values(opts?.chatrooms ?? loadChatrooms()) as Chatroom[]
    const myChatrooms = chatrooms.filter((c) => !c.archivedAt && c.agentIds?.includes(agentId))
    if (myChatrooms.length > 0) {
      const lastHeartbeat = state.lastBySession.get(session.id!) || 0
      const chatroomLines = myChatrooms
        .map((c) => {
          const recent = (c.messages || []).filter((m: { time: number }) => m.time > lastHeartbeat)
          if (recent.length === 0) return null
          const mentions = recent.filter((m: { text?: string; mentions?: string[] }) =>
            m.text?.includes(`@${agent?.name}`) || m.mentions?.includes(agentId),
          )
          if (mentions.length === 0) return null
          const latest = mentions[mentions.length - 1] as { text?: string }
          return `- ${c.name}: ${mentions.length} new mention(s) — latest: "${latest?.text?.slice(0, 100)}"`
        })
        .filter(Boolean)
      if (chatroomLines.length > 0) {
        sections.push(`Chatroom mentions since last check:\n${chatroomLines.join('\n')}`)
      }
    }
  } catch { /* best-effort */ }

  // ── Phase 5: Execution instructions ──
  if (fallbackPrompt !== DEFAULT_HEARTBEAT_PROMPT) sections.push(`\nAgent instructions:\n${fallbackPrompt}`)

  sections.push('')
  sections.push('You are running an autonomous heartbeat tick. Review your goal and recent context.')
  sections.push('If there is meaningful work to do toward your goal, use your tools and take action.')
  sections.push('If nothing needs attention right now, reply exactly HEARTBEAT_OK.')
  sections.push('IMPORTANT: Do NOT repeat actions you already performed in recent context. If you already searched for something or completed a task (shown above), report your findings or reply HEARTBEAT_OK — do not search or act again unless there is a NEW reason to do so.')
  sections.push('Do not ask clarifying questions. Take the most reasonable next action.')
  sections.push('')
  sections.push('To update your goal or plan, include this line in your response:')
  sections.push('[AGENT_HEARTBEAT_META]{"goal": "your evolved goal", "status": "progress", "next_action": "what you plan to do next"}')
  sections.push('You can evolve your goal as you learn more. Set status to "progress" while working, "ok" when done, "idle" when waiting.')

  return sections.filter(Boolean).join('\n')
}

function resolveInterval(obj: object, currentSec: number): number {
  const r = obj as Record<string, unknown>
  // Prefer heartbeatInterval (duration string) over heartbeatIntervalSec (raw number)
  if (r.heartbeatInterval !== undefined && r.heartbeatInterval !== null) {
    return parseDuration(r.heartbeatInterval, currentSec)
  }
  if (r.heartbeatIntervalSec !== undefined && r.heartbeatIntervalSec !== null) {
    return parseIntBounded(r.heartbeatIntervalSec, currentSec, 0, 86400)
  }
  return currentSec
}

function resolveStr(obj: object, key: string, current: string | null): string | null {
  const val = (obj as Record<string, unknown>)[key]
  if (typeof val === 'string' && val.trim()) return val.trim()
  return current
}

function resolveBool(obj: object, key: string, current: boolean): boolean {
  const r = obj as Record<string, unknown>
  if (r[key] === true) return true
  if (r[key] === false) return false
  return current
}

function resolveNum(obj: object, key: string, current: number): number {
  const val = (obj as Record<string, unknown>)[key]
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val)
  return current
}

export function heartbeatConfigForSession(
  session: HeartbeatPromptSession,
  settings: Partial<AppSettings>,
  agents: Record<string, HeartbeatPromptAgent>,
): HeartbeatConfig {
  // Global defaults — 30 min interval (was 120s)
  let intervalSec = resolveInterval(settings, DEFAULT_HEARTBEAT_INTERVAL_SEC)
  const globalPrompt = (typeof settings.heartbeatPrompt === 'string' && settings.heartbeatPrompt.trim())
    ? settings.heartbeatPrompt.trim()
    : DEFAULT_HEARTBEAT_PROMPT

  let enabled = intervalSec > 0
  let prompt = globalPrompt
  let model: string | null = resolveStr(settings, 'heartbeatModel', null)
  let ackMaxChars = resolveNum(settings, 'heartbeatAckMaxChars', DEFAULT_HEARTBEAT_ACK_MAX_CHARS)
  let showOk = resolveBool(settings, 'heartbeatShowOk', DEFAULT_HEARTBEAT_SHOW_OK)
  let showAlerts = resolveBool(settings, 'heartbeatShowAlerts', DEFAULT_HEARTBEAT_SHOW_ALERTS)
  let target: string | null = resolveStr(settings, 'heartbeatTarget', null)
  let lightContext = resolveBool(settings, 'heartbeatLightContext', false)

  // Agent layer overrides
  if (session.agentId) {
    const agent = agents[session.agentId]
    if (agent) {
      if (agent.heartbeatEnabled === false) enabled = false
      if (agent.heartbeatEnabled === true) enabled = true
      intervalSec = resolveInterval(agent, intervalSec)
      if (typeof agent.heartbeatPrompt === 'string' && agent.heartbeatPrompt.trim()) {
        prompt = agent.heartbeatPrompt.trim()
      }
      model = resolveStr(agent, 'heartbeatModel', model)
      ackMaxChars = resolveNum(agent, 'heartbeatAckMaxChars', ackMaxChars)
      showOk = resolveBool(agent, 'heartbeatShowOk', showOk)
      showAlerts = resolveBool(agent, 'heartbeatShowAlerts', showAlerts)
      target = resolveStr(agent, 'heartbeatTarget', target)
      lightContext = resolveBool(agent, 'heartbeatLightContext', lightContext)
    }
  }

  // Session layer overrides
  if (session.heartbeatEnabled === false) enabled = false
  if (session.heartbeatEnabled === true) enabled = true
  intervalSec = resolveInterval(session, intervalSec)
  if (typeof session.heartbeatPrompt === 'string' && session.heartbeatPrompt.trim()) {
    prompt = session.heartbeatPrompt.trim()
  }
  target = resolveStr(session, 'heartbeatTarget', target)

  return { enabled: enabled && intervalSec > 0, intervalSec, prompt, model, ackMaxChars, showOk, showAlerts, target, lightContext }
}

function lastUserMessageAt(session: HeartbeatPromptSession): number {
  if (!session?.id) return 0
  const messages = getMessages(session.id)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'user' && typeof msg.time === 'number' && msg.time > 0) {
      return msg.time
    }
  }
  return 0
}

function resolveHeartbeatUserIdleSec(settings: Partial<AppSettings>, fallbackSec: number): number {
  const configured = (settings as Record<string, unknown>).heartbeatUserIdleSec
  if (configured === undefined || configured === null || configured === '') {
    return fallbackSec
  }
  return parseIntBounded(configured, fallbackSec, 0, 86_400)
}

function shouldRunHeartbeats(settings: Partial<AppSettings>): boolean {
  const loopMode = settings.loopMode === 'ongoing' ? 'ongoing' : 'bounded'
  return loopMode === 'ongoing'
}

function isBackedOff(sessionId: string, now: number): boolean {
  const record = state.failures.get(sessionId)
  if (!record || record.count === 0) return false

  if (record.autoDisabledAt) {
    // Escalating recovery: ~10min, ~20min, ~40min, ~80min, capped at 4h
    const recoveryAttempts = record.recoveryAttempts || 0
    const nextRecoveryAt = record.nextRecoveryAt
      || (record.autoDisabledAt + jitteredBackoff(10 * 60_000, 0, 4 * 3600_000))
    if (now < nextRecoveryAt) return true

    // Time to try recovery — reset count so heartbeat fires again
    log.info('heartbeat', 'Recovered', { sessionId, recoveryAttempt: recoveryAttempts + 1 })
    record.count = 0
    record.autoDisabledAt = undefined
    record.recoveryAttempts = recoveryAttempts + 1
    record.nextRecoveryAt = now + jitteredBackoff(10 * 60_000, recoveryAttempts, 4 * 3600_000)
    return false
  }

  const backoffMs = jitteredBackoff(BACKOFF_BASE_MS, record.count - 1, BACKOFF_MAX_MS)
  return now < record.lastFailedAt + backoffMs
}

export async function tickHeartbeats() {
  const settings = loadSettings()
  const globalOngoing = shouldRunHeartbeats(settings)

  const now = Date.now()
  const nowDate = new Date(now)
  if (!inActiveWindow(nowDate, settings.heartbeatActiveStart, settings.heartbeatActiveEnd, settings.heartbeatTimezone)) {
    return
  }

  // Startup grace period — let connectors/gateway stabilize before firing heartbeats
  if (state.startedAt > 0 && (now - state.startedAt) < STARTUP_GRACE_MS) return

  const agents = loadAgents()
  const hbAgents = (Object.values(agents) as any[]).filter(
    (a) => a?.id && a.heartbeatEnabled === true && !isAgentDisabled(a) && !WORKER_ONLY_PROVIDER_IDS.has(a.provider),
  )
  for (const agent of hbAgents) {
    ensureAgentThreadSession(String(agent.id))
  }
  const hasScopedAgents = hbAgents.length > 0

  // Short-circuit: if no agents have heartbeat enabled and global loop mode is
  // bounded, skip the expensive loadSessions() — nothing will be eligible.
  if (!hasScopedAgents && !globalOngoing) {
    // Prune any stale tracking entries
    if (state.lastBySession.size > 0) state.lastBySession.clear()
    return
  }

  const sessions = loadSessions()

  // Pre-load shared data once for all agents (avoids N separate full-table scans)
  const sharedApprovals = loadApprovals()
  const sharedChatrooms = loadChatrooms()

  // Prune tracked sessions that no longer exist or have heartbeat disabled
  for (const trackedId of state.lastBySession.keys()) {
    const s = sessions[trackedId] as any
    if (!s) {
      state.lastBySession.delete(trackedId)
      continue
    }
    const cfg = heartbeatConfigForSession(s, settings, agents)
    if (!cfg.enabled) {
      state.lastBySession.delete(trackedId)
    }
  }

  // Prune failure records for sessions that no longer exist
  for (const trackedId of state.failures.keys()) {
    if (!sessions[trackedId]) {
      state.failures.delete(trackedId)
    }
  }

  let enqueued = 0

  for (const session of Object.values(sessions) as any[]) {
    if (enqueued >= MAX_CONCURRENT_HEARTBEATS) break

    if (!session?.id) continue
    if (session.sessionType && session.sessionType !== 'human') continue

    // Check if this session or its agent has explicit heartbeat opt-in
    const agent = session.agentId ? agents[session.agentId] : null
    // Skip sessions whose agent was deleted or trashed
    if (session.agentId && !agent) continue
    if (isAgentDisabled(agent)) continue

    // Explicit per-session opt-in (user toggled heartbeat on this specific chat)
    const sessionOptIn = session.heartbeatEnabled === true

    // Agent-level heartbeat — only applies to the agent's thread session,
    // not connector/webhook/chatroom sessions that happen to share the agentId
    const isThreadSession = !!(
      agent
      && agent.heartbeatEnabled === true
      && (session.shortcutForAgentId === agent.id || agent.threadSessionId === session.id)
    )

    const explicitOptIn = sessionOptIn || isThreadSession

    // If global loopMode is bounded, only allow sessions with explicit opt-in
    if (!globalOngoing && !explicitOptIn) continue

    if (hasScopedAgents && !explicitOptIn) {
      const sessionForcedOn = session.heartbeatEnabled === true
      if (!sessionForcedOn && (!agent || agent.heartbeatEnabled !== true)) continue
    }

    const cfg = heartbeatConfigForSession(session, settings, agents)
    if (!cfg.enabled) continue

    if (isBackedOff(session.id, now)) continue

    // For sessions with explicit opt-in, use a shorter idle threshold (just intervalSec * 2).
    // For inherited/global heartbeats, keep the 180s minimum to avoid noisy auto-fire.
    const defaultIdleSec = explicitOptIn
      ? cfg.intervalSec * 2
      : Math.max(cfg.intervalSec * 2, 180)
    const userIdleThresholdSec = resolveHeartbeatUserIdleSec(settings, defaultIdleSec)
    const lastUserAt = lastUserMessageAt(session)
    const baselineAt = lastUserAt > 0
      ? lastUserAt
      : explicitOptIn
        ? (typeof session.lastActiveAt === 'number' ? session.lastActiveAt : (typeof session.createdAt === 'number' ? session.createdAt : 0))
        : 0
    if (baselineAt <= 0) continue
    const idleMs = now - baselineAt
    if (idleMs < userIdleThresholdSec * 1000) continue
    // Skip sessions idle longer than 7 days — truly abandoned
    if (idleMs > MAX_SESSION_IDLE_MS) continue

    const last = state.lastBySession.get(session.id) || 0
    const mainLoopState = getMainLoopStateForSession(session.id)
    const isActivelyProgressing = mainLoopState
      && mainLoopState.status === 'progress'
      && mainLoopState.lastTickAt
      && (now - mainLoopState.lastTickAt) < ACTIVE_WINDOW_MS
      && !mainLoopState.paused
    const effectiveIntervalSec = isActivelyProgressing
      ? Math.max(ACTIVE_HEARTBEAT_INTERVAL_SEC, Math.min(cfg.intervalSec, 300))
      : cfg.intervalSec
    if (now - last < effectiveIntervalSec * 1000) continue

    const runState = getSessionRunState(session.id)
    if (runState.runningRunId) continue

    const rawHeartbeatFileContent = readHeartbeatFile(session)
    const heartbeatFileContent = isHeartbeatContentEffectivelyEmpty(rawHeartbeatFileContent) ? '' : rawHeartbeatFileContent
    const hasExplicitGoal = !!(agent?.heartbeatGoal || agent?.heartbeatNextAction)
    const hasAgentContext = !!(agent?.description || agent?.systemPrompt || agent?.soul)
    const hasCustomPrompt = cfg.prompt !== DEFAULT_HEARTBEAT_PROMPT
    const hasUserMessages = lastUserMessageAt(session) > 0
    // Check for deferred wakes queued via dispatchWake({ mode: 'next_heartbeat' })
    const agentId = session.agentId ? String(session.agentId) : undefined
    const sessionHasDeferredWakes = hasDeferredWakes(agentId, session.id)

    // Skip heartbeat if there's nothing to drive it. An agent description alone
    // is not enough — the session needs at least one user message or an explicit
    // heartbeat goal/HEARTBEAT.md content. This prevents noise on unused sessions.
    // Exception: deferred wakes always get processed.
    if (!sessionHasDeferredWakes && !hasExplicitGoal && !heartbeatFileContent && !hasCustomPrompt) {
      if (!hasAgentContext || !hasUserMessages) continue
    }
    const baseHeartbeatMessage = buildAgentHeartbeatPrompt(session, agent, cfg.prompt, heartbeatFileContent, {
      approvals: sharedApprovals,
      chatrooms: sharedChatrooms,
    })
    let heartbeatMessage = isMainSession(session)
      ? buildMainLoopHeartbeatPrompt(session, baseHeartbeatMessage)
      : baseHeartbeatMessage

    // Drain deferred wakes and inject their context into the heartbeat prompt
    if (sessionHasDeferredWakes) {
      const deferredWakes = drainDeferredWakes(agentId, session.id)
      if (deferredWakes.length > 0) {
        const deferredEvents = deferredWakes.map((w) => ({
          eventId: w.eventId,
          reason: w.reason || 'deferred-wake',
          source: w.source,
          resumeMessage: w.resumeMessage,
          detail: w.detail,
          occurredAt: Date.now(),
          priority: w.priority ?? 40,
        }))
        const triggerContext = buildWakeTriggerContext(deferredEvents)
        heartbeatMessage = `${heartbeatMessage}\n\n${triggerContext}`
      }
    }

    // Isolated mode: clear message history before each heartbeat for a fresh context
    const resetMode = session.sessionResetMode ?? agent?.sessionResetMode
    if (resetMode === 'isolated') {
      clearMessages(session.id)
      patchSession(session.id, (s) => {
        if (!s) return s
        s.updatedAt = Date.now()
        return s
      })
      log.info('heartbeat', `Cleared message history for isolated heartbeat: ${session.id}`)
    }

    const enqueue = enqueueSessionRun({
      sessionId: session.id,
      message: heartbeatMessage,
      internal: true,
      source: 'heartbeat',
      mode: 'collect',
      dedupeKey: `heartbeat:${session.id}`,
      modelOverride: cfg.model || undefined,
      heartbeatConfig: {
        ackMaxChars: cfg.ackMaxChars,
        showOk: cfg.showOk,
        showAlerts: cfg.showAlerts,
        target: cfg.target,
        lightContext: cfg.lightContext,
      },
    })

    enqueued++
    state.lastBySession.set(session.id, now)

    const sid = session.id as string
    enqueue.promise.then(() => {
      const prev = state.failures.get(sid)
      if (prev?.recoveryAttempts) {
        log.info('heartbeat', `Recovery successful for session ${sid} after ${prev.recoveryAttempts} attempt(s)`)
      }
      state.failures.delete(sid)
      // Track successful delivery
      patchSession(sid, (s) => {
        if (!s) return s
        s.lastDeliveryStatus = 'ok'
        s.lastDeliveredAt = Date.now()
        return s
      })
    }).catch((err: unknown) => {
      const prev = state.failures.get(sid)
      const newCount = (prev?.count ?? 0) + 1
      const record: FailureRecord = { count: newCount, lastFailedAt: Date.now() }
      // Auto-disable heartbeat after too many consecutive failures to prevent resource waste
      if (newCount >= MAX_CONSECUTIVE_FAILURES) {
        record.autoDisabledAt = Date.now()
        log.warn('heartbeat', `Auto-disabling heartbeat for session ${sid} after ${newCount} consecutive failures`)
        logExecution(sid, 'heartbeat_failure', `Heartbeat auto-disabled after ${newCount} consecutive failures`)
        logActivity({
          entityType: 'session',
          entityId: sid,
          action: 'failed',
          actor: 'system',
          summary: `Heartbeat auto-disabled after ${newCount} consecutive failures`,
        })
        createNotification({
          type: 'error',
          title: 'Heartbeat auto-disabled',
          message: `Session ${sid} heartbeat disabled after ${newCount} consecutive failures`,
          entityType: 'session',
          entityId: sid,
          dedupKey: `heartbeat_disable:${sid}`,
        })
      }
      state.failures.set(sid, record)
      const msg = errorMessage(err)
      log.warn('heartbeat', `Heartbeat run failed for session ${sid} (${newCount}/${MAX_CONSECUTIVE_FAILURES})`, msg)
      // Track failed delivery
      patchSession(sid, (s) => {
        if (!s) return s
        s.lastDeliveryStatus = 'error'
        s.lastDeliveryError = msg
        s.lastDeliveredAt = Date.now()
        return s
      })
    })
  }
}

/**
 * Seed lastBySession with `now - jitter` so that after the startup grace period,
 * sessions become eligible gradually (over ~5 min) instead of all at once.
 * Previous approach seeded from historical lastActiveAt which made old sessions
 * trivially pass the interval check on the first tick.
 */
function seedLastActive() {
  const now = Date.now()
  const agents = loadAgents()
  const hbAgentIds = new Set(
    (Object.values(agents) as unknown as Record<string, unknown>[])
      .filter((a) => a?.heartbeatEnabled === true && !isAgentDisabled(a) && !WORKER_ONLY_PROVIDER_IDS.has(a.provider as string))
      .map((a) => String(a.id)),
  )
  const sessions = loadSessions()
  for (const session of Object.values(sessions) as any[]) {
    if (!session?.id) continue
    // Only seed sessions that are actually heartbeat-eligible (thread sessions only for agent-level)
    const eligible = session.heartbeatEnabled === true
      || (
        session.agentId
        && hbAgentIds.has(session.agentId)
        && (session.shortcutForAgentId === session.agentId
            || agents[session.agentId]?.threadSessionId === session.id)
      )
    if (!eligible) continue
    if (!state.lastBySession.has(session.id)) {
      // Random jitter 0-5 min so sessions stagger after grace period
      const jitterMs = Math.floor(Math.random() * 5 * 60_000)
      state.lastBySession.set(session.id, now - jitterMs)
    }
  }
}

export function startHeartbeatService() {
  // Always replace the timer so HMR picks up the latest tickHeartbeats function.
  // Without this, the old setInterval closure keeps running stale code.
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  state.running = true
  state.startedAt = Date.now()
  seedLastActive()
  state.timer = setInterval(() => {
    tickHeartbeats().catch((err) => {
      log.error('heartbeat', 'Heartbeat tick failed', err?.message || String(err))
    })
    tickOrchestratorAgents().catch((err) => {
      log.error('orchestrator', 'Orchestrator tick failed', err?.message || String(err))
    })
  }, HEARTBEAT_TICK_MS)
}

export function stopHeartbeatService() {
  state.running = false
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

/** Clear tracked state and restart the heartbeat timer. Call when heartbeat config changes. */
export function restartHeartbeatService() {
  stopHeartbeatService()
  state.lastBySession.clear()
  state.failures.clear()
  startHeartbeatService()
}

export function getHeartbeatServiceStatus() {
  return {
    running: state.running,
    trackedSessions: state.lastBySession.size,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Orchestrator Mode — wake prompt + tick loop
// ═══════════════════════════════════════════════════════════════════════

function getOrchestratorDailyCycleKey(agentId: string): string {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return `${agentId}:${today}`
}

function getOrchestratorDailyCycles(agentId: string): number {
  return orchestratorState.dailyCycles.get(getOrchestratorDailyCycleKey(agentId)) || 0
}

function incrementOrchestratorDailyCycles(agentId: string): void {
  const key = getOrchestratorDailyCycleKey(agentId)
  orchestratorState.dailyCycles.set(key, (orchestratorState.dailyCycles.get(key) || 0) + 1)

  // Prune old daily cycle entries (keep only today's)
  const today = new Date().toISOString().slice(0, 10)
  for (const k of orchestratorState.dailyCycles.keys()) {
    if (!k.endsWith(today)) orchestratorState.dailyCycles.delete(k)
  }
}

export function buildOrchestratorWakePrompt(session: any, agent: Agent): string {
  const sections: string[] = []
  let charCount = 0

  const addSection = (text: string) => {
    if (charCount + text.length > ORCHESTRATOR_MAX_PROMPT_CHARS) return false
    sections.push(text)
    charCount += text.length
    return true
  }

  // 1. Identity context
  sections.push('ORCHESTRATOR_WAKE_TICK')
  sections.push(`Time: ${new Date().toISOString()}`)
  charCount += 60

  const identityContext = buildIdentityContext(session, agent)
  if (identityContext) addSection(identityContext)

  const description = agent.description || ''
  if (description) addSection(`Description: ${description.slice(0, 200)}`)

  // 2. Mission
  if (agent.orchestratorMission) {
    addSection(`## Mission\n${agent.orchestratorMission.slice(0, 500)}`)
  }

  // 3. Governance instructions
  const governance = agent.orchestratorGovernance || 'autonomous'
  if (governance === 'approval-required') {
    addSection('## Governance\nYou are in APPROVAL-REQUIRED mode. Use `ask_human` before destructive actions (deleting agents, changing providers, spending over budget).')
  } else if (governance === 'notify-only') {
    addSection('## Governance\nYou are in NOTIFY-ONLY mode. Report observations and recommendations but do NOT take autonomous actions. Post updates in chatrooms instead.')
  }

  // 4. Platform status summary
  try {
    const platformStatus = buildPlatformStatusSummary()
    addSection(platformStatus)
  } catch { /* best-effort */ }

  // 5. Orchestrator event highlights
  const orchEvents = drainOrchestratorEvents(agent.id)
  if (orchEvents.length > 0) {
    const eventLines = orchEvents.slice(-15).map((e) => `- [${new Date(e.timestamp).toISOString().slice(11, 19)}] ${e.text}`)
    addSection(`## Event Highlights\n${eventLines.join('\n')}`)
  }

  // 6. System events (session-scoped)
  const sysEvents = drainSystemEvents(session.id)
  if (sysEvents.length > 0) {
    const eventBlock = sysEvents.map((e) => `- [${new Date(e.timestamp).toISOString().slice(11, 19)}] ${e.text}`).join('\n')
    addSection(`## System Events\n${eventBlock}`)
  }

  // 7. Active mission state
  const missionId = session.missionId || null
  if (missionId) {
    try {
      const missionBlock = buildMissionContextBlock(loadMission(missionId))
      if (missionBlock) addSection(missionBlock)
    } catch { /* ignore */ }
  }

  // 8. Goal ancestry
  const goalAncestry = buildGoalAncestrySection(missionId)
  if (goalAncestry) addSection(goalAncestry)

  // 9. Chatroom membership
  try {
    const chatrooms = Object.values(loadChatrooms()) as Chatroom[]
    const myChatrooms = chatrooms.filter((c) => !c.archivedAt && c.agentIds?.includes(agent.id))
    if (myChatrooms.length > 0) {
      const chatroomLines = myChatrooms.slice(0, 5).map((c) => {
        const recentCount = c.messages?.filter((m) => m.time > (agent.orchestratorLastWakeAt || 0)).length || 0
        return `- ${c.name}${c.temporary ? ' (session)' : ''}: ${recentCount} new messages`
      })
      addSection(`## My Chatrooms\n${chatroomLines.join('\n')}`)
    }
  } catch { /* best-effort */ }

  // 10. Instructions
  sections.push('')
  sections.push('You are an autonomous orchestrator. Review your mission, platform state, and recent events. Decide what needs attention.')
  sections.push('You can: delegate tasks to agents, send messages in chatrooms you\'re part of (use @AgentName to direct to a specific agent), create temporary sessions for focused discussions, manage schedules, adjust connectors, spawn subagents.')
  sections.push('If nothing needs attention, reply ORCHESTRATOR_OK.')
  sections.push('Do not ask clarifying questions. Take the most reasonable action based on your mission.')

  return sections.filter(Boolean).join('\n')
}

export async function tickOrchestratorAgents() {
  const now = Date.now()
  const settings = loadSettings()

  // Respect active window (same as heartbeats)
  const nowDate = new Date(now)
  if (!inActiveWindow(nowDate, settings.heartbeatActiveStart, settings.heartbeatActiveEnd, settings.heartbeatTimezone)) {
    return
  }

  // Startup grace period
  if (state.startedAt > 0 && (now - state.startedAt) < STARTUP_GRACE_MS) return

  const agents = loadAgents()
  const orchestrators = (Object.values(agents) as Agent[]).filter(
    (a) => a?.id
      && a.orchestratorEnabled === true
      && !isAgentDisabled(a)
      && isOrchestratorEligible(a),
  )

  if (orchestrators.length === 0) return

  // Prune orchestrator tracking maps for agents no longer in the active set
  const activeAgentIds = new Set(orchestrators.map((a) => a.id))
  for (const agentId of orchestratorState.lastWakeByAgent.keys()) {
    if (!activeAgentIds.has(agentId)) orchestratorState.lastWakeByAgent.delete(agentId)
  }
  for (const agentId of orchestratorState.failures.keys()) {
    if (!activeAgentIds.has(agentId)) orchestratorState.failures.delete(agentId)
  }
  // Prune stale daily cycle entries (keys are agentId:YYYY-MM-DD)
  const todayStr = new Date(now).toISOString().slice(0, 10)
  for (const key of orchestratorState.dailyCycles.keys()) {
    const dateStr = key.slice(key.lastIndexOf(':') + 1)
    if (dateStr !== todayStr) orchestratorState.dailyCycles.delete(key)
  }

  for (const agent of orchestrators) {
    try {
      // Check interval elapsed
      const intervalSec = agent.orchestratorWakeInterval != null
        ? parseDuration(agent.orchestratorWakeInterval, ORCHESTRATOR_DEFAULT_INTERVAL_SEC)
        : ORCHESTRATOR_DEFAULT_INTERVAL_SEC
      const clampedIntervalSec = Math.min(Math.max(intervalSec, ORCHESTRATOR_MIN_INTERVAL_SEC), ORCHESTRATOR_MAX_INTERVAL_SEC)

      const lastWake = orchestratorState.lastWakeByAgent.get(agent.id) || (agent.orchestratorLastWakeAt || 0)
      if (now - lastWake < clampedIntervalSec * 1000) continue

      // Check daily cycle limit
      if (agent.orchestratorMaxCyclesPerDay != null && agent.orchestratorMaxCyclesPerDay > 0) {
        const todayCycles = getOrchestratorDailyCycles(agent.id)
        if (todayCycles >= agent.orchestratorMaxCyclesPerDay) {
          log.info('orchestrator', `Agent ${agent.name} (${agent.id}) hit daily cycle limit (${todayCycles}/${agent.orchestratorMaxCyclesPerDay})`)
          continue
        }
      }

      // Check backoff from failures
      const failRecord = orchestratorState.failures.get(agent.id)
      if (failRecord) {
        if (failRecord.autoDisabledAt) continue
        const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, failRecord.count - 1), BACKOFF_MAX_MS)
        if (now < failRecord.lastFailedAt + backoffMs) continue
      }

      // Ensure thread session exists
      const threadSession = ensureAgentThreadSession(agent.id)
      if (!threadSession) continue

      // Skip if session is already running
      const runState = getSessionRunState(threadSession.id)
      if (runState.runningRunId) continue

      // Build wake prompt
      const prompt = buildOrchestratorWakePrompt(threadSession, agent)

      // Enqueue the run
      const enqueue = enqueueSessionRun({
        sessionId: threadSession.id,
        message: prompt,
        internal: true,
        source: 'orchestrator-wake',
        mode: 'collect',
        dedupeKey: `orchestrator:${agent.id}`,
      })

      // Update tracking state
      orchestratorState.lastWakeByAgent.set(agent.id, now)
      incrementOrchestratorDailyCycles(agent.id)

      // Update agent storage
      patchAgent(agent.id, (current) => {
        if (!current) return current
        return {
          ...current,
          orchestratorLastWakeAt: now,
          orchestratorCycleCount: (typeof current.orchestratorCycleCount === 'number' ? current.orchestratorCycleCount : 0) + 1,
          updatedAt: now,
        }
      })

      log.info('orchestrator', `Woke orchestrator agent ${agent.name} (${agent.id}), cycle #${(agent.orchestratorCycleCount || 0) + 1}`)

      // Track success/failure
      enqueue.promise.then(() => {
        orchestratorState.failures.delete(agent.id)
      }).catch((err: unknown) => {
        const prev = orchestratorState.failures.get(agent.id)
        const newCount = (prev?.count ?? 0) + 1
        const record: FailureRecord = { count: newCount, lastFailedAt: Date.now() }
        if (newCount >= MAX_CONSECUTIVE_FAILURES) {
          record.autoDisabledAt = Date.now()
          log.warn('orchestrator', `Auto-disabling orchestrator for agent ${agent.id} after ${newCount} consecutive failures`)
          logExecution(agent.id, 'heartbeat_failure', `Orchestrator auto-disabled after ${newCount} consecutive failures`)
          logActivity({
            entityType: 'agent',
            entityId: agent.id,
            action: 'failed',
            actor: 'system',
            summary: `Orchestrator auto-disabled for ${agent.name} after ${newCount} consecutive failures`,
          })
          createNotification({
            type: 'error',
            title: 'Orchestrator auto-disabled',
            message: `${agent.name} orchestrator disabled after ${newCount} consecutive failures`,
            entityType: 'agent',
            entityId: agent.id,
            dedupKey: `orchestrator_disable:${agent.id}`,
          })
        }
        orchestratorState.failures.set(agent.id, record)
        log.warn('orchestrator', `Orchestrator wake failed for agent ${agent.id} (${newCount}/${MAX_CONSECUTIVE_FAILURES})`, errorMessage(err))
      })
    } catch (err) {
      log.warn('orchestrator', `Error ticking orchestrator agent ${agent.id}:`, errorMessage(err))
    }
  }
}

/**
 * Remove tracking entries for sessions that no longer exist.
 * Called periodically by the daemon health sweep.
 */
export function pruneHeartbeatState(liveSessionIds: Set<string>): number {
  let removed = 0
  for (const id of state.lastBySession.keys()) {
    if (!liveSessionIds.has(id)) {
      state.lastBySession.delete(id)
      state.failures.delete(id)
      removed++
    }
  }
  // Also clean up orphaned failure entries
  for (const id of state.failures.keys()) {
    if (!liveSessionIds.has(id)) {
      state.failures.delete(id)
    }
  }
  return removed
}

/**
 * Remove orchestrator tracking entries for agents that no longer exist.
 * Called periodically by the daemon health sweep.
 */
export function pruneOrchestratorState(liveAgentIds: Set<string>): number {
  let removed = 0
  for (const agentId of orchestratorState.lastWakeByAgent.keys()) {
    if (!liveAgentIds.has(agentId)) { orchestratorState.lastWakeByAgent.delete(agentId); removed++ }
  }
  for (const agentId of orchestratorState.failures.keys()) {
    if (!liveAgentIds.has(agentId)) { orchestratorState.failures.delete(agentId); removed++ }
  }
  const todayStr = new Date().toISOString().slice(0, 10)
  for (const key of orchestratorState.dailyCycles.keys()) {
    const agentId = key.slice(0, key.lastIndexOf(':'))
    if (!liveAgentIds.has(agentId) || key.slice(key.lastIndexOf(':') + 1) !== todayStr) {
      orchestratorState.dailyCycles.delete(key)
      removed++
    }
  }
  return removed
}
