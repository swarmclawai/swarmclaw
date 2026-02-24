import { loadAgents, loadSessions, loadSettings } from './storage'
import { enqueueSessionRun, getSessionRunState } from './session-run-manager'
import { log } from './logger'
import { buildMainLoopHeartbeatPrompt, getMainLoopStateForSession, isMainSession } from './main-agent-loop'

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

function heartbeatConfigForSession(session: any, settings: Record<string, any>, agents: Record<string, any>): {
  intervalSec: number
  prompt: string
  enabled: boolean
} {
  const globalIntervalSec = parseIntBounded(settings.heartbeatIntervalSec, 120, 0, 3600)
  const globalPrompt = (typeof settings.heartbeatPrompt === 'string' && settings.heartbeatPrompt.trim())
    ? settings.heartbeatPrompt.trim()
    : 'SWARM_HEARTBEAT_CHECK'

  let enabled = globalIntervalSec > 0
  let intervalSec = globalIntervalSec
  let prompt = globalPrompt

  if (session.agentId) {
    const agent = agents[session.agentId]
    if (agent) {
      if (agent.heartbeatEnabled === false) enabled = false
      if (agent.heartbeatEnabled === true) enabled = true
      if (agent.heartbeatIntervalSec !== undefined && agent.heartbeatIntervalSec !== null) {
        intervalSec = parseIntBounded(agent.heartbeatIntervalSec, intervalSec, 0, 3600)
      }
      if (typeof agent.heartbeatPrompt === 'string' && agent.heartbeatPrompt.trim()) {
        prompt = agent.heartbeatPrompt.trim()
      }
    }
  }

  if (session.heartbeatEnabled === false) enabled = false
  if (session.heartbeatEnabled === true) enabled = true
  if (session.heartbeatIntervalSec !== undefined && session.heartbeatIntervalSec !== null) {
    intervalSec = parseIntBounded(session.heartbeatIntervalSec, intervalSec, 0, 3600)
  }
  if (typeof session.heartbeatPrompt === 'string' && session.heartbeatPrompt.trim()) {
    prompt = session.heartbeatPrompt.trim()
  }

  return { enabled: enabled && intervalSec > 0, intervalSec, prompt }
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
    if (lastUserAt <= 0) {
      log.debug('heartbeat', `skip ${session.id}: no user messages`)
      continue
    }
    const idleMs = now - lastUserAt
    if (idleMs < userIdleThresholdSec * 1000) {
      log.debug('heartbeat', `skip ${session.id}: user idle ${Math.round(idleMs / 1000)}s < threshold ${userIdleThresholdSec}s`)
      continue
    }

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
    if (runState.runningRunId) {
      log.debug('heartbeat', `skip ${session.id}: already running`)
      continue
    }

    state.lastBySession.set(session.id, now)
    const heartbeatMessage = isMainSession(session)
      ? buildMainLoopHeartbeatPrompt(session, cfg.prompt)
      : cfg.prompt

    log.info('heartbeat', `firing for session ${session.id} (interval=${cfg.intervalSec}s, idle=${Math.round(idleMs / 1000)}s)`)

    const enqueue = enqueueSessionRun({
      sessionId: session.id,
      message: heartbeatMessage,
      internal: true,
      source: 'heartbeat',
      mode: 'collect',
      dedupeKey: `heartbeat:${session.id}`,
    })

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
  log.info('heartbeat', `Heartbeat service started (tick every ${HEARTBEAT_TICK_MS}ms, tracking ${state.lastBySession.size} sessions)`)
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
