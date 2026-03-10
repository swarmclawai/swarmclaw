export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 1800
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300
export const DEFAULT_HEARTBEAT_SHOW_OK = false
export const DEFAULT_HEARTBEAT_SHOW_ALERTS = true

function parseIntSetting(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function parseBoolSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

export interface NormalizedHeartbeatSettingFields {
  heartbeatIntervalSec: number
  heartbeatAckMaxChars: number
  heartbeatShowOk: boolean
  heartbeatShowAlerts: boolean
  heartbeatTarget: string | null
  heartbeatPrompt: string | null
}

export function normalizeHeartbeatSettingFields(settings: Record<string, unknown>): NormalizedHeartbeatSettingFields {
  return {
    heartbeatIntervalSec: parseIntSetting(settings.heartbeatIntervalSec, DEFAULT_HEARTBEAT_INTERVAL_SEC, 0, 86_400),
    heartbeatAckMaxChars: parseIntSetting(settings.heartbeatAckMaxChars, DEFAULT_HEARTBEAT_ACK_MAX_CHARS, 0, 8_000),
    heartbeatShowOk: parseBoolSetting(settings.heartbeatShowOk, DEFAULT_HEARTBEAT_SHOW_OK),
    heartbeatShowAlerts: parseBoolSetting(settings.heartbeatShowAlerts, DEFAULT_HEARTBEAT_SHOW_ALERTS),
    heartbeatTarget: typeof settings.heartbeatTarget === 'string' && settings.heartbeatTarget.trim()
      ? settings.heartbeatTarget.trim()
      : null,
    heartbeatPrompt: typeof settings.heartbeatPrompt === 'string' && settings.heartbeatPrompt.trim()
      ? settings.heartbeatPrompt.trim()
      : null,
  }
}
