import type { AppSettings } from '@/types'

export type AutonomyRuntimeScope = 'chat' | 'task' | 'both'

export const DEFAULT_SUPERVISOR_ENABLED = true
export const DEFAULT_SUPERVISOR_RUNTIME_SCOPE: AutonomyRuntimeScope = 'both'
export const DEFAULT_SUPERVISOR_NO_PROGRESS_LIMIT = 2
export const DEFAULT_SUPERVISOR_REPEATED_TOOL_LIMIT = 3
export const DEFAULT_REFLECTION_ENABLED = true
export const DEFAULT_REFLECTION_AUTO_WRITE_MEMORY = true

export const SUPERVISOR_NO_PROGRESS_LIMIT_MIN = 1
export const SUPERVISOR_NO_PROGRESS_LIMIT_MAX = 8
export const SUPERVISOR_REPEATED_TOOL_LIMIT_MIN = 2
export const SUPERVISOR_REPEATED_TOOL_LIMIT_MAX = 8

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

export interface NormalizedSupervisorSettings {
  supervisorEnabled: boolean
  supervisorRuntimeScope: AutonomyRuntimeScope
  supervisorNoProgressLimit: number
  supervisorRepeatedToolLimit: number
  reflectionEnabled: boolean
  reflectionAutoWriteMemory: boolean
}

export function normalizeSupervisorSettings(
  settings: Partial<AppSettings> | NormalizedSupervisorSettings | Record<string, unknown> | null | undefined,
): NormalizedSupervisorSettings {
  const current = settings || {}
  const runtimeScope = current.supervisorRuntimeScope === 'chat'
    || current.supervisorRuntimeScope === 'task'
    || current.supervisorRuntimeScope === 'both'
    ? current.supervisorRuntimeScope
    : DEFAULT_SUPERVISOR_RUNTIME_SCOPE
  return {
    supervisorEnabled: parseBoolSetting(current.supervisorEnabled, DEFAULT_SUPERVISOR_ENABLED),
    supervisorRuntimeScope: runtimeScope,
    supervisorNoProgressLimit: parseIntSetting(
      current.supervisorNoProgressLimit,
      DEFAULT_SUPERVISOR_NO_PROGRESS_LIMIT,
      SUPERVISOR_NO_PROGRESS_LIMIT_MIN,
      SUPERVISOR_NO_PROGRESS_LIMIT_MAX,
    ),
    supervisorRepeatedToolLimit: parseIntSetting(
      current.supervisorRepeatedToolLimit,
      DEFAULT_SUPERVISOR_REPEATED_TOOL_LIMIT,
      SUPERVISOR_REPEATED_TOOL_LIMIT_MIN,
      SUPERVISOR_REPEATED_TOOL_LIMIT_MAX,
    ),
    reflectionEnabled: parseBoolSetting(current.reflectionEnabled, DEFAULT_REFLECTION_ENABLED),
    reflectionAutoWriteMemory: parseBoolSetting(current.reflectionAutoWriteMemory, DEFAULT_REFLECTION_AUTO_WRITE_MEMORY),
  }
}

export function runtimeScopeIncludes(
  runtimeScope: AutonomyRuntimeScope,
  surface: 'chat' | 'task',
): boolean {
  return runtimeScope === 'both' || runtimeScope === surface
}
