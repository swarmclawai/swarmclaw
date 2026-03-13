import { NextResponse } from 'next/server'
import { normalizeHeartbeatSettingFields } from '@/lib/runtime/heartbeat-defaults'
import { normalizeWhatsAppApprovedContacts } from '@/lib/server/connectors/pairing'
import { loadPublicSettings, loadSettings, saveSettings } from '@/lib/server/storage'
import { normalizeRuntimeSettingFields } from '@/lib/runtime/runtime-loop'
import { normalizeSupervisorSettings } from '@/lib/autonomy/supervisor-settings'
export const dynamic = 'force-dynamic'


const MEMORY_DEPTH_MIN = 0
const MEMORY_DEPTH_MAX = 12
const MEMORY_PER_LOOKUP_MIN = 1
const MEMORY_PER_LOOKUP_MAX = 200
const MEMORY_LINKED_MIN = 0
const MEMORY_LINKED_MAX = 1000
const RESPONSE_CACHE_TTL_MIN_SEC = 5
const RESPONSE_CACHE_TTL_MAX_SEC = 7 * 24 * 3600
const RESPONSE_CACHE_MAX_ENTRIES_MIN = 1
const RESPONSE_CACHE_MAX_ENTRIES_MAX = 20_000
const TASK_QG_MIN_RESULT_MIN = 10
const TASK_QG_MIN_RESULT_MAX = 2000
const TASK_QG_MIN_EVIDENCE_MIN = 0
const TASK_QG_MIN_EVIDENCE_MAX = 8
const SESSION_RESET_TIMEOUT_MIN = 0
const SESSION_RESET_TIMEOUT_MAX = 365 * 24 * 60 * 60
const SECRET_SETTING_KEYS = ['elevenLabsApiKey', 'tavilyApiKey', 'braveApiKey'] as const

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
  return NextResponse.json(loadPublicSettings())
}

export async function PUT(req: Request) {
  const body = await req.json() as Record<string, unknown>
  const sanitizedBody: Record<string, unknown> = { ...body }

  delete sanitizedBody.__encryptedAppSettings

  for (const key of SECRET_SETTING_KEYS) {
    const configuredKey = `${key}Configured`
    if (sanitizedBody[key] === null && sanitizedBody[configuredKey] === true) {
      delete sanitizedBody[key]
    }
    delete sanitizedBody[configuredKey]
  }

  const settings = loadSettings()
  Object.assign(settings, sanitizedBody)

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
  const normalizedRuntime = normalizeRuntimeSettingFields(settings)
  const normalizedHeartbeat = normalizeHeartbeatSettingFields(settings)
  const normalizedSupervisor = normalizeSupervisorSettings(settings)
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
  Object.assign(settings, normalizedRuntime)
  Object.assign(settings, normalizedHeartbeat)
  Object.assign(settings, normalizedSupervisor)
  settings.responseCacheTtlSec = nextResponseCacheTtlSec
  settings.responseCacheMaxEntries = nextResponseCacheMaxEntries
  settings.responseCacheEnabled = parseBoolSetting(settings.responseCacheEnabled, true)
  settings.taskQualityGateEnabled = parseBoolSetting(settings.taskQualityGateEnabled, true)
  settings.taskQualityGateMinResultChars = nextTaskQgMinResultChars
  settings.taskQualityGateMinEvidenceItems = nextTaskQgMinEvidenceItems
  settings.taskQualityGateRequireVerification = parseBoolSetting(settings.taskQualityGateRequireVerification, false)
  settings.taskQualityGateRequireArtifact = parseBoolSetting(settings.taskQualityGateRequireArtifact, false)
  settings.taskQualityGateRequireReport = parseBoolSetting(settings.taskQualityGateRequireReport, false)
  settings.taskManagementEnabled = parseBoolSetting(settings.taskManagementEnabled, true)
  settings.projectManagementEnabled = parseBoolSetting(settings.projectManagementEnabled, true)
  settings.walletApprovalsEnabled = parseBoolSetting(settings.walletApprovalsEnabled, true)
  settings.integrityMonitorEnabled = parseBoolSetting(settings.integrityMonitorEnabled, true)
  settings.daemonAutostartEnabled = parseBoolSetting(settings.daemonAutostartEnabled, true)
  settings.sessionResetMode = settings.sessionResetMode === 'daily' ? 'daily' : settings.sessionResetMode === 'idle' ? 'idle' : null
  settings.whatsappApprovedContacts = normalizeWhatsAppApprovedContacts(settings.whatsappApprovedContacts)
  settings.sessionIdleTimeoutSec = parseIntSetting(
    settings.sessionIdleTimeoutSec,
    12 * 60 * 60,
    SESSION_RESET_TIMEOUT_MIN,
    SESSION_RESET_TIMEOUT_MAX,
  )
  settings.sessionMaxAgeSec = parseIntSetting(
    settings.sessionMaxAgeSec,
    7 * 24 * 60 * 60,
    SESSION_RESET_TIMEOUT_MIN,
    SESSION_RESET_TIMEOUT_MAX,
  )
  if (typeof settings.sessionDailyResetAt === 'string') settings.sessionDailyResetAt = settings.sessionDailyResetAt.trim() || null
  if (typeof settings.sessionResetTimezone === 'string') settings.sessionResetTimezone = settings.sessionResetTimezone.trim() || null

  saveSettings(settings)

  if ('daemonAutostartEnabled' in sanitizedBody && settings.daemonAutostartEnabled) {
    import('@/lib/server/runtime/daemon-state').then(({ startDaemon }) => {
      startDaemon({ source: 'api/settings:put:daemon-autostart', manualStart: true })
    }).catch(() => { /* daemon runtime may not be initialized yet */ })
  }

  // Restart heartbeat service when heartbeat-related settings change
  const heartbeatKeys = [
    'heartbeatIntervalSec',
    'heartbeatInterval',
    'heartbeatPrompt',
    'heartbeatEnabled',
    'heartbeatActiveStart',
    'heartbeatActiveEnd',
    'sessionResetMode',
    'sessionIdleTimeoutSec',
    'sessionMaxAgeSec',
    'sessionDailyResetAt',
    'sessionResetTimezone',
  ]
  if (heartbeatKeys.some((k) => k in sanitizedBody)) {
    import('@/lib/server/runtime/heartbeat-service').then(({ restartHeartbeatService }) => {
      restartHeartbeatService()
    }).catch(() => { /* heartbeat service may not be initialized yet */ })
  }

  return NextResponse.json(loadPublicSettings())
}
