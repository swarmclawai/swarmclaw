import type { Agent, AppSettings, Session, SessionResetMode, SessionResetType } from '@/types'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import { clearMessages, getMessageCount } from '@/lib/server/messages/message-repository'

export interface ResolvedSessionResetPolicy {
  type: SessionResetType
  mode: SessionResetMode
  idleTimeoutSec: number | null
  maxAgeSec: number | null
  dailyResetAt: string | null
  timezone: string | null
}

export interface SessionFreshnessSnapshot {
  fresh: boolean
  reason?: string
  policy: ResolvedSessionResetPolicy
  idleExpiresAt: number | null
  dailyBoundaryKey: string | null
}

const DEFAULT_POLICIES: Record<SessionResetType, ResolvedSessionResetPolicy> = {
  direct: {
    type: 'direct',
    mode: 'idle',
    idleTimeoutSec: 12 * 60 * 60,
    maxAgeSec: 7 * 24 * 60 * 60,
    dailyResetAt: null,
    timezone: null,
  },
  group: {
    type: 'group',
    mode: 'idle',
    idleTimeoutSec: 6 * 60 * 60,
    maxAgeSec: 3 * 24 * 60 * 60,
    dailyResetAt: null,
    timezone: null,
  },
  thread: {
    type: 'thread',
    mode: 'idle',
    idleTimeoutSec: 4 * 60 * 60,
    maxAgeSec: 2 * 24 * 60 * 60,
    dailyResetAt: null,
    timezone: null,
  },
  main: {
    type: 'main',
    mode: 'daily',
    idleTimeoutSec: 24 * 60 * 60,
    maxAgeSec: 14 * 24 * 60 * 60,
    dailyResetAt: '04:00',
    timezone: null,
  },
}

function parseIntBounded(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value.trim(), 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeMode(raw: unknown, fallback: SessionResetMode): SessionResetMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return value === 'daily' ? 'daily' : value === 'idle' ? 'idle' : fallback
}

function normalizeTimeHHMM(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function normalizeTimezone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value || null
}

function getClockParts(date: Date, timezone?: string | null): { dateKey: string; minutes: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone || undefined,
    })
    const parts = formatter.formatToParts(date)
    const year = parts.find((part) => part.type === 'year')?.value
    const month = parts.find((part) => part.type === 'month')?.value
    const day = parts.find((part) => part.type === 'day')?.value
    const hour = Number.parseInt(parts.find((part) => part.type === 'hour')?.value || '', 10)
    const minute = Number.parseInt(parts.find((part) => part.type === 'minute')?.value || '', 10)
    if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return {
      dateKey: `${year}-${month}-${day}`,
      minutes: hour * 60 + minute,
    }
  } catch {
    return null
  }
}

function boundaryKeyForNow(now: number, boundaryMinutes: number, timezone?: string | null): string | null {
  const current = getClockParts(new Date(now), timezone)
  if (!current) return null
  if (current.minutes >= boundaryMinutes) return current.dateKey
  const previous = getClockParts(new Date(now - 24 * 60 * 60 * 1000), timezone)
  return previous?.dateKey || null
}

function rawField(
  session: Partial<Session> | null | undefined,
  overrides: Record<string, unknown> | undefined,
  agent: Partial<Agent> | null | undefined,
  settings: Partial<AppSettings> | null | undefined,
  key: 'sessionResetMode' | 'sessionIdleTimeoutSec' | 'sessionMaxAgeSec' | 'sessionDailyResetAt' | 'sessionResetTimezone',
): unknown {
  if (session && session[key] !== undefined) return session[key]
  if (overrides && overrides[key] !== undefined) return overrides[key]
  if (agent && agent[key] !== undefined) return agent[key]
  if (settings && settings[key] !== undefined) return settings[key]
  return undefined
}

export function inferSessionResetType(
  session: Partial<Session> | null | undefined,
  opts?: { isGroup?: boolean | null; threadId?: string | null },
): SessionResetType {
  if ((session?.sessionType as string | undefined) === 'delegated' || (session?.sessionType as string | undefined) === 'orchestrated') return 'main'
  const connectorContext = isDirectConnectorSession(session) ? session?.connectorContext : null
  const threadId = opts?.threadId ?? connectorContext?.threadId ?? null
  if (threadId) return 'thread'
  const isGroup = opts?.isGroup ?? connectorContext?.isGroup ?? false
  return isGroup ? 'group' : 'direct'
}

export function resolveSessionResetPolicy(params: {
  session?: Partial<Session> | null
  agent?: Partial<Agent> | null
  settings?: Partial<AppSettings> | null
  resetType?: SessionResetType
  overrides?: Record<string, unknown>
}): ResolvedSessionResetPolicy {
  const type = params.resetType ?? inferSessionResetType(params.session)
  const defaults = DEFAULT_POLICIES[type]
  return {
    type,
    mode: normalizeMode(
      rawField(params.session, params.overrides, params.agent, params.settings, 'sessionResetMode'),
      defaults.mode,
    ),
    idleTimeoutSec: parseIntBounded(
      rawField(params.session, params.overrides, params.agent, params.settings, 'sessionIdleTimeoutSec'),
      0,
      180 * 24 * 60 * 60,
    ) ?? defaults.idleTimeoutSec,
    maxAgeSec: parseIntBounded(
      rawField(params.session, params.overrides, params.agent, params.settings, 'sessionMaxAgeSec'),
      0,
      365 * 24 * 60 * 60,
    ) ?? defaults.maxAgeSec,
    dailyResetAt: normalizeTimeHHMM(
      rawField(params.session, params.overrides, params.agent, params.settings, 'sessionDailyResetAt'),
    ) ?? defaults.dailyResetAt,
    timezone: normalizeTimezone(
      rawField(params.session, params.overrides, params.agent, params.settings, 'sessionResetTimezone'),
    ) ?? defaults.timezone,
  }
}

export function evaluateSessionFreshness(params: {
  session?: Partial<Session> | null
  policy: ResolvedSessionResetPolicy
  now?: number
}): SessionFreshnessSnapshot {
  const now = typeof params.now === 'number' ? params.now : Date.now()
  const session = params.session
  const policy = params.policy
  const messageCount = typeof session?.id === 'string' ? getMessageCount(session.id) : 0
  const createdAt = typeof session?.createdAt === 'number' ? session.createdAt : now
  const lastActiveAt = typeof session?.lastActiveAt === 'number' ? session.lastActiveAt : createdAt
  const idleExpiresAt = typeof policy.idleTimeoutSec === 'number' && policy.idleTimeoutSec > 0
    ? lastActiveAt + policy.idleTimeoutSec * 1000
    : null

  if (!session || messageCount === 0) {
    return {
      fresh: true,
      policy,
      idleExpiresAt,
      dailyBoundaryKey: null,
    }
  }

  if (idleExpiresAt !== null && now > idleExpiresAt) {
    return {
      fresh: false,
      reason: `idle_timeout:${policy.idleTimeoutSec}`,
      policy,
      idleExpiresAt,
      dailyBoundaryKey: null,
    }
  }

  if (typeof policy.maxAgeSec === 'number' && policy.maxAgeSec > 0) {
    const maxAgeMs = policy.maxAgeSec * 1000
    if (now - createdAt > maxAgeMs) {
      return {
        fresh: false,
        reason: `max_age:${policy.maxAgeSec}`,
        policy,
        idleExpiresAt,
        dailyBoundaryKey: null,
      }
    }
  }

  if (policy.mode === 'daily' && policy.dailyResetAt) {
    const boundary = normalizeTimeHHMM(policy.dailyResetAt)
    if (boundary) {
      const [hours, minutes] = boundary.split(':').map((value) => Number.parseInt(value, 10))
      const boundaryMinutes = hours * 60 + minutes
      const nowBoundaryKey = boundaryKeyForNow(now, boundaryMinutes, policy.timezone)
      const lastActiveParts = getClockParts(new Date(lastActiveAt), policy.timezone)
      if (
        nowBoundaryKey
        && lastActiveParts
        && (
          lastActiveParts.dateKey < nowBoundaryKey
          || (lastActiveParts.dateKey === nowBoundaryKey && lastActiveParts.minutes < boundaryMinutes)
        )
      ) {
        return {
          fresh: false,
          reason: `daily_reset:${policy.dailyResetAt}`,
          policy,
          idleExpiresAt,
          dailyBoundaryKey: nowBoundaryKey,
        }
      }
      return {
        fresh: true,
        policy,
        idleExpiresAt,
        dailyBoundaryKey: nowBoundaryKey,
      }
    }
  }

  return {
    fresh: true,
    policy,
    idleExpiresAt,
    dailyBoundaryKey: null,
  }
}

export function resetSessionRuntime(
  session: Session,
  reason: string,
  opts?: { now?: number },
): number {
  const now = typeof opts?.now === 'number' ? opts.now : Date.now()
  const cleared = getMessageCount(session.id)

  clearMessages(session.id)
  session.claudeSessionId = null
  session.codexThreadId = null
  session.opencodeSessionId = null
  session.delegateResumeIds = {
    claudeCode: null,
    codex: null,
    opencode: null,
    gemini: null,
  }
  session.createdAt = now
  session.lastActiveAt = now
  session.lastAutoMemoryAt = null
  session.lastHeartbeatText = null
  session.lastHeartbeatSentAt = null
  session.conversationTone = undefined
  session.lastSessionResetAt = now
  session.lastSessionResetReason = reason

  if (session.connectorContext) {
    session.connectorContext = {
      ...session.connectorContext,
      lastResetAt: now,
      lastResetReason: reason,
      lastInboundMessageId: null,
      lastInboundReplyToMessageId: null,
      lastInboundThreadId: null,
      lastOutboundMessageId: null,
      lastOutboundAt: null,
    }
  }

  return cleared
}
