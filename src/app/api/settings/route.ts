import { NextResponse } from 'next/server'
import { loadSettings, saveSettings } from '@/lib/server/storage'
import { DEFAULT_DELEGATION_MAX_DEPTH } from '@/lib/runtime-loop'
export const dynamic = 'force-dynamic'


const MEMORY_DEPTH_MIN = 0
const MEMORY_DEPTH_MAX = 12
const MEMORY_PER_LOOKUP_MIN = 1
const MEMORY_PER_LOOKUP_MAX = 200
const MEMORY_LINKED_MIN = 0
const MEMORY_LINKED_MAX = 1000
const DELEGATION_DEPTH_MIN = 1
const DELEGATION_DEPTH_MAX = 12
const RESPONSE_CACHE_TTL_MIN_SEC = 5
const RESPONSE_CACHE_TTL_MAX_SEC = 7 * 24 * 3600
const RESPONSE_CACHE_MAX_ENTRIES_MIN = 1
const RESPONSE_CACHE_MAX_ENTRIES_MAX = 20_000
const TASK_QG_MIN_RESULT_MIN = 10
const TASK_QG_MIN_RESULT_MAX = 2000
const TASK_QG_MIN_EVIDENCE_MIN = 0
const TASK_QG_MIN_EVIDENCE_MAX = 8

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

export async function GET(_req: Request) {
  return NextResponse.json(loadSettings())
}

export async function PUT(req: Request) {
  const body = await req.json()
  const settings = loadSettings()
  Object.assign(settings, body)

  const nextDepth = parseIntSetting(
    settings.memoryReferenceDepth ?? settings.memoryMaxDepth,
    3,
    MEMORY_DEPTH_MIN,
    MEMORY_DEPTH_MAX,
  )
  const nextPerLookup = parseIntSetting(
    settings.maxMemoriesPerLookup ?? settings.memoryMaxPerLookup,
    20,
    MEMORY_PER_LOOKUP_MIN,
    MEMORY_PER_LOOKUP_MAX,
  )
  const nextLinked = parseIntSetting(
    settings.maxLinkedMemoriesExpanded,
    60,
    MEMORY_LINKED_MIN,
    MEMORY_LINKED_MAX,
  )
  const nextDelegationDepth = parseIntSetting(
    settings.delegationMaxDepth,
    DEFAULT_DELEGATION_MAX_DEPTH,
    DELEGATION_DEPTH_MIN,
    DELEGATION_DEPTH_MAX,
  )
  const nextResponseCacheTtlSec = parseIntSetting(
    settings.responseCacheTtlSec,
    15 * 60,
    RESPONSE_CACHE_TTL_MIN_SEC,
    RESPONSE_CACHE_TTL_MAX_SEC,
  )
  const nextResponseCacheMaxEntries = parseIntSetting(
    settings.responseCacheMaxEntries,
    500,
    RESPONSE_CACHE_MAX_ENTRIES_MIN,
    RESPONSE_CACHE_MAX_ENTRIES_MAX,
  )
  const nextTaskQgMinResultChars = parseIntSetting(
    settings.taskQualityGateMinResultChars,
    80,
    TASK_QG_MIN_RESULT_MIN,
    TASK_QG_MIN_RESULT_MAX,
  )
  const nextTaskQgMinEvidenceItems = parseIntSetting(
    settings.taskQualityGateMinEvidenceItems,
    2,
    TASK_QG_MIN_EVIDENCE_MIN,
    TASK_QG_MIN_EVIDENCE_MAX,
  )

  // Keep new and legacy keys synchronized for backward compatibility.
  settings.memoryReferenceDepth = nextDepth
  settings.memoryMaxDepth = nextDepth
  settings.maxMemoriesPerLookup = nextPerLookup
  settings.memoryMaxPerLookup = nextPerLookup
  settings.maxLinkedMemoriesExpanded = nextLinked
  settings.delegationMaxDepth = nextDelegationDepth
  settings.responseCacheTtlSec = nextResponseCacheTtlSec
  settings.responseCacheMaxEntries = nextResponseCacheMaxEntries
  settings.responseCacheEnabled = parseBoolSetting(settings.responseCacheEnabled, true)
  settings.taskQualityGateEnabled = parseBoolSetting(settings.taskQualityGateEnabled, true)
  settings.taskQualityGateMinResultChars = nextTaskQgMinResultChars
  settings.taskQualityGateMinEvidenceItems = nextTaskQgMinEvidenceItems
  settings.taskQualityGateRequireVerification = parseBoolSetting(settings.taskQualityGateRequireVerification, false)
  settings.taskQualityGateRequireArtifact = parseBoolSetting(settings.taskQualityGateRequireArtifact, false)
  settings.taskQualityGateRequireReport = parseBoolSetting(settings.taskQualityGateRequireReport, false)
  settings.integrityMonitorEnabled = parseBoolSetting(settings.integrityMonitorEnabled, true)

  saveSettings(settings)

  // Restart heartbeat service when heartbeat-related settings change
  const heartbeatKeys = ['heartbeatIntervalSec', 'heartbeatInterval', 'heartbeatPrompt', 'heartbeatEnabled', 'heartbeatActiveStart', 'heartbeatActiveEnd']
  if (heartbeatKeys.some((k) => k in body)) {
    import('@/lib/server/heartbeat-service').then(({ restartHeartbeatService }) => {
      restartHeartbeatService()
    }).catch(() => { /* heartbeat service may not be initialized yet */ })
  }

  return NextResponse.json(settings)
}
