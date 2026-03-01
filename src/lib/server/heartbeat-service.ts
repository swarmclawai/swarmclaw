import fs from 'fs'
import path from 'path'
import { loadAgents, loadSessions, loadSettings } from './storage'
import { enqueueSessionRun, getSessionRunState } from './session-run-manager'
import { log } from './logger'
import { buildMainLoopHeartbeatPrompt, getMainLoopStateForSession, isMainSession } from './main-agent-loop'
import { WORKSPACE_DIR } from './data-dir'

const HEARTBEAT_TICK_MS = 5_000

interface HeartbeatState {
  timer: ReturnType<typeof setInterval> | null
  running: boolean
  lastBySession: Map<string, number>
}

const globalKey = '__swarmclaw_heartbeat_service__' as const
const globalScope = globalThis as typeof globalThis & { [globalKey]?: HeartbeatState }
const state: HeartbeatState = globalScope[globalKey] ?? (globalScope[globalKey] = {
  timer: null,
  running: false,
  lastBySession: new Map<string, number>(),
})

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
}

const DEFAULT_HEARTBEAT_PROMPT = 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.'

function readHeartbeatFile(session: any): string {
  try {
    const filePath = path.join(session.cwd || WORKSPACE_DIR, 'HEARTBEAT.md')
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim()
    }
  } catch { /* ignore */ }
  return ''
}

function buildAgentHeartbeatPrompt(session: any, agent: any, fallbackPrompt: string, heartbeatFileContent: string): string {
  if (!agent) return fallbackPrompt

  // Dynamic goal (agent-set) takes priority over static system prompt
  const dynamicGoal = agent.heartbeatGoal || ''
  const dynamicNextAction = agent.heartbeatNextAction || ''
  const description = agent.description || ''
  const systemPrompt = agent.systemPrompt || ''
  const soul = agent.soul || ''
  const goalSummary = systemPrompt.slice(0, 500)
  const recentMessages = (session.messages || []).slice(-5)
  const recentContext = recentMessages
    .map((m: any) => `[${m.role}]: ${(m.text || '').slice(0, 200)}`)
    .join('\n')

  return [
    'AGENT_HEARTBEAT_TICK',
    `Time: ${new Date().toISOString()}`,
    `Agent: ${agent.name}`,
    description ? `Description: ${description}` : '',
    dynamicGoal
      ? `Current goal (self-set): ${dynamicGoal}`
      : goalSummary ? `System prompt (initial goal):\n${goalSummary}` : '',
    dynamicNextAction ? `Planned next action: ${dynamicNextAction}` : '',
    soul ? `Persona: ${soul.slice(0, 300)}` : '',
    heartbeatFileContent ? `\nHEARTBEAT.md contents:\n${heartbeatFileContent.slice(0, 2000)}` : '',
    recentContext ? `Recent conversation:\n${recentContext}` : '',
    '',
    'You are running an autonomous heartbeat tick. Review your goal and recent context.',
    'If there is meaningful work to do toward your goal, use your tools and take action.',
    'If nothing needs attention right now, reply exactly HEARTBEAT_OK.',
    'Do not ask clarifying questions. Take the most reasonable next action.',
    '',
    'To update your goal or plan, include this line in your response:',
    '[AGENT_HEARTBEAT_META]{"goal": "your evolved goal", "status": "progress", "next_action": "what you plan to do next"}',
    'You can evolve your goal as you learn more. Set status to "progress" while working, "ok" when done, "idle" when waiting.',
    fallbackPrompt !== DEFAULT_HEARTBEAT_PROMPT ? `\nAdditional instructions: ${fallbackPrompt}` : '',
  ].filter(Boolean).join('\n')
}

function resolveInterval(obj: Record<string, any>, currentSec: number): number {
  // Prefer heartbeatInterval (duration string) over heartbeatIntervalSec (raw number)
  if (obj.heartbeatInterval !== undefined && obj.heartbeatInterval !== null) {
    return parseDuration(obj.heartbeatInterval, currentSec)
  }
  if (obj.heartbeatIntervalSec !== undefined && obj.heartbeatIntervalSec !== null) {
    return parseIntBounded(obj.heartbeatIntervalSec, currentSec, 0, 86400)
  }
  return currentSec
}

function resolveStr(obj: Record<string, any>, key: string, current: string | null): string | null {
  const val = obj[key]
  if (typeof val === 'string' && val.trim()) return val.trim()
  return current
}

function resolveBool(obj: Record<string, any>, key: string, current: boolean): boolean {
  if (obj[key] === true) return true
  if (obj[key] === false) return false
  return current
}

function resolveNum(obj: Record<string, any>, key: string, current: number): number {
  const val = obj[key]
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val)
  return current
}

function heartbeatConfigForSession(session: any, settings: Record<string, any>, agents: Record<string, any>): HeartbeatConfig {
  // Global defaults — 30 min interval (was 120s)
  let intervalSec = resolveInterval(settings, 1800)
  const globalPrompt = (typeof settings.heartbeatPrompt === 'string' && settings.heartbeatPrompt.trim())
    ? settings.heartbeatPrompt.trim()
    : DEFAULT_HEARTBEAT_PROMPT

  let enabled = intervalSec > 0
  let prompt = globalPrompt
  let model: string | null = resolveStr(settings, 'heartbeatModel', null)
  let ackMaxChars = resolveNum(settings, 'heartbeatAckMaxChars', 300)
  let showOk = resolveBool(settings, 'heartbeatShowOk', false)
  let showAlerts = resolveBool(settings, 'heartbeatShowAlerts', true)
  let target: string | null = resolveStr(settings, 'heartbeatTarget', null)

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

  return { enabled: enabled && intervalSec > 0, intervalSec, prompt, model, ackMaxChars, showOk, showAlerts, target }
}

function lastUserMessageAt(session: any): number {
  if (!Array.isArray(session?.messages)) return 0
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]
    if (msg?.role === 'user' && typeof msg.time === 'number' && msg.time > 0) {
      return msg.time
    }
  }
  return 0
}

function resolveHeartbeatUserIdleSec(settings: Record<string, any>, fallbackSec: number): number {
  const configured = settings.heartbeatUserIdleSec
  if (configured === undefined || configured === null || configured === '') {
    return fallbackSec
  }
  return parseIntBounded(configured, fallbackSec, 0, 86_400)
}

function shouldRunHeartbeats(settings: Record<string, any>): boolean {
  const loopMode = settings.loopMode === 'ongoing' ? 'ongoing' : 'bounded'
  return loopMode === 'ongoing'
}

async function tickHeartbeats() {
  const settings = loadSettings()
  const globalOngoing = shouldRunHeartbeats(settings)

  const now = Date.now()
  const nowDate = new Date(now)
  if (!inActiveWindow(nowDate, settings.heartbeatActiveStart, settings.heartbeatActiveEnd, settings.heartbeatTimezone)) {
    return
  }

  const sessions = loadSessions()
  const agents = loadAgents()
  const hasScopedAgents = Object.values(agents).some((a: any) => a?.heartbeatEnabled === true)

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

  for (const session of Object.values(sessions) as any[]) {
    if (!session?.id) continue
    if (!Array.isArray(session.tools) || session.tools.length === 0) continue
    if (session.sessionType && session.sessionType !== 'human' && session.sessionType !== 'orchestrated') continue

    // Check if this session or its agent has explicit heartbeat opt-in
    const agent = session.agentId ? agents[session.agentId] : null
    const explicitOptIn = session.heartbeatEnabled === true || (agent && agent.heartbeatEnabled === true)

    // If global loopMode is bounded, only allow sessions with explicit opt-in
    if (!globalOngoing && !explicitOptIn) continue

    if (hasScopedAgents && !explicitOptIn) {
      const sessionForcedOn = session.heartbeatEnabled === true
      if (!sessionForcedOn && (!agent || agent.heartbeatEnabled !== true)) continue
    }

    const cfg = heartbeatConfigForSession(session, settings, agents)
    if (!cfg.enabled) continue

    // For sessions with explicit opt-in, use a shorter idle threshold (just intervalSec * 2).
    // For inherited/global heartbeats, keep the 180s minimum to avoid noisy auto-fire.
    const defaultIdleSec = explicitOptIn
      ? cfg.intervalSec * 2
      : Math.max(cfg.intervalSec * 2, 180)
    const userIdleThresholdSec = resolveHeartbeatUserIdleSec(settings, defaultIdleSec)
    const lastUserAt = lastUserMessageAt(session)
    if (lastUserAt <= 0) continue
    const idleMs = now - lastUserAt
    if (idleMs < userIdleThresholdSec * 1000) continue

    if (isMainSession(session)) {
      const loopState = getMainLoopStateForSession(session.id)
      if (loopState?.paused) continue
      const loopStatus = loopState?.status || 'idle'
      const pendingEvents = loopState?.pendingEvents?.length || 0
      if ((loopStatus === 'ok' || loopStatus === 'idle') && pendingEvents === 0) continue
    }

    const last = state.lastBySession.get(session.id) || 0
    if (now - last < cfg.intervalSec * 1000) continue

    const runState = getSessionRunState(session.id)
    if (runState.runningRunId) continue

    let heartbeatMessage: string
    if (isMainSession(session)) {
      heartbeatMessage = buildMainLoopHeartbeatPrompt(session, cfg.prompt)
    } else {
      const heartbeatFileContent = readHeartbeatFile(session)
      const hasGoal = !!(agent?.heartbeatGoal || agent?.description || agent?.systemPrompt || agent?.soul)
      const hasCustomPrompt = cfg.prompt !== DEFAULT_HEARTBEAT_PROMPT
      // Skip heartbeat only if there's truly nothing to drive it:
      // no agent goal, no HEARTBEAT.md content, AND no custom prompt configured
      if (!hasGoal && !heartbeatFileContent && !hasCustomPrompt) {
        continue
      }
      heartbeatMessage = buildAgentHeartbeatPrompt(session, agent, cfg.prompt, heartbeatFileContent)
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
      },
    })

    // Set timestamp AFTER successful enqueue so a busy session retries next tick
    state.lastBySession.set(session.id, now)

    enqueue.promise.catch((err) => {
      log.warn('heartbeat', `Heartbeat run failed for session ${session.id}`, err?.message || String(err))
    })
  }
}

/**
 * Seed lastBySession from persisted lastActiveAt values so that a cold restart
 * doesn't cause every session to fire a heartbeat immediately on the first tick.
 */
function seedLastActive() {
  const sessions = loadSessions()
  for (const session of Object.values(sessions) as any[]) {
    if (!session?.id) continue
    if (typeof session.lastActiveAt === 'number' && session.lastActiveAt > 0) {
      // Only seed entries we don't already have (preserves HMR state)
      if (!state.lastBySession.has(session.id)) {
        state.lastBySession.set(session.id, session.lastActiveAt)
      }
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
  seedLastActive()
  state.timer = setInterval(() => {
    tickHeartbeats().catch((err) => {
      log.error('heartbeat', 'Heartbeat tick failed', err?.message || String(err))
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

export function getHeartbeatServiceStatus() {
  return {
    running: state.running,
    trackedSessions: state.lastBySession.size,
  }
}
