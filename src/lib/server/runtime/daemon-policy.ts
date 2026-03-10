import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/runtime/heartbeat-defaults'
import { loadSettings } from '@/lib/server/storage'
import type { Session } from '@/types'

const SYNTHETIC_HEALTH_SESSION_USERS = new Set(['workbench', 'comparison-bench'])
const SYNTHETIC_HEALTH_SESSION_PREFIXES = ['wb-', 'cmp-']

function parseBoolish(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function daemonAutostartEnvEnabled(): boolean {
  if (typeof process.env.SWARMCLAW_DAEMON_AUTOSTART === 'string' && process.env.SWARMCLAW_DAEMON_AUTOSTART.trim()) {
    return parseBoolish(process.env.SWARMCLAW_DAEMON_AUTOSTART, true)
  }
  const settings = loadSettings()
  return parseBoolish(settings.daemonAutostartEnabled, true)
}

export function isDaemonBackgroundServicesEnabled(): boolean {
  return parseBoolish(process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES, true)
}

export function parseHeartbeatIntervalSec(
  value: unknown,
  fallback = DEFAULT_HEARTBEAT_INTERVAL_SEC,
): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(3600, Math.trunc(parsed)))
}

export function shouldNotifyProviderReachabilityIssue(provider: string): boolean {
  return provider !== 'openclaw'
}

function hasSyntheticHealthPrefix(value: unknown): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SYNTHETIC_HEALTH_SESSION_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export function shouldSuppressSessionHeartbeatHealthAlert(
  session: Pick<Session, 'id' | 'name' | 'user' | 'shortcutForAgentId'>,
): boolean {
  const user = typeof session.user === 'string' ? session.user.trim().toLowerCase() : ''
  if (SYNTHETIC_HEALTH_SESSION_USERS.has(user)) return true
  if (hasSyntheticHealthPrefix(session.id)) return true
  if (hasSyntheticHealthPrefix(session.shortcutForAgentId)) return true

  const name = typeof session.name === 'string' ? session.name.trim().toLowerCase() : ''
  return name.startsWith('workbench ')
    || name.startsWith('assistant benchmark ')
    || name.startsWith('comparison ')
}

export function shouldSuppressSyntheticAgentHealthAlert(agentId: string): boolean {
  return hasSyntheticHealthPrefix(agentId)
}

export function buildSessionHeartbeatHealthDedupKey(
  sessionId: string,
  state: 'stale' | 'auto-disabled',
): string {
  return `health-alert:session-heartbeat:${state}:${sessionId}`
}

export function parseCronToMs(cron: string | null | undefined, fallbackMs: number): number | null {
  if (!cron || typeof cron !== 'string') return null
  const hourMatch = cron.match(/\*\/(\d+)/)
  if (hourMatch) return parseInt(hourMatch[1], 10) * 3600_000
  return fallbackMs
}
