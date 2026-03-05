import type { AppSettings, TaskQualityGateConfig } from '@/types'

export interface NormalizedTaskQualityGate {
  enabled: boolean
  minResultChars: number
  minEvidenceItems: number
  requireVerification: boolean
  requireArtifact: boolean
  requireReport: boolean
}

export const DEFAULT_TASK_QUALITY_GATE: NormalizedTaskQualityGate = {
  enabled: true,
  minResultChars: 80,
  minEvidenceItems: 2,
  requireVerification: false,
  requireArtifact: false,
  requireReport: false,
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function normalizeSettingsDefaults(settings?: AppSettings | Record<string, unknown> | null): NormalizedTaskQualityGate {
  const raw = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {}
  return {
    enabled: normalizeBool(raw.taskQualityGateEnabled, DEFAULT_TASK_QUALITY_GATE.enabled),
    minResultChars: normalizeInt(raw.taskQualityGateMinResultChars, DEFAULT_TASK_QUALITY_GATE.minResultChars, 10, 2000),
    minEvidenceItems: normalizeInt(raw.taskQualityGateMinEvidenceItems, DEFAULT_TASK_QUALITY_GATE.minEvidenceItems, 0, 8),
    requireVerification: normalizeBool(raw.taskQualityGateRequireVerification, DEFAULT_TASK_QUALITY_GATE.requireVerification),
    requireArtifact: normalizeBool(raw.taskQualityGateRequireArtifact, DEFAULT_TASK_QUALITY_GATE.requireArtifact),
    requireReport: normalizeBool(raw.taskQualityGateRequireReport, DEFAULT_TASK_QUALITY_GATE.requireReport),
  }
}

export function normalizeTaskQualityGate(
  rawGate?: TaskQualityGateConfig | Record<string, unknown> | null,
  settings?: AppSettings | Record<string, unknown> | null,
): NormalizedTaskQualityGate {
  const defaults = normalizeSettingsDefaults(settings)
  const raw = rawGate && typeof rawGate === 'object' ? rawGate as Record<string, unknown> : {}
  return {
    enabled: normalizeBool(raw.enabled, defaults.enabled),
    minResultChars: normalizeInt(raw.minResultChars, defaults.minResultChars, 10, 2000),
    minEvidenceItems: normalizeInt(raw.minEvidenceItems, defaults.minEvidenceItems, 0, 8),
    requireVerification: normalizeBool(raw.requireVerification, defaults.requireVerification),
    requireArtifact: normalizeBool(raw.requireArtifact, defaults.requireArtifact),
    requireReport: normalizeBool(raw.requireReport, defaults.requireReport),
  }
}
