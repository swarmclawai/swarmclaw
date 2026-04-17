import { normalizeCapabilitySelection } from '@/lib/capability-selection'
import { normalizeAgentSandboxConfig } from '@/lib/agent-sandbox-defaults'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'

type StoredObject = Record<string, unknown>

// --- Schedule helpers ---

const VALID_SCHEDULE_STATUSES = new Set(['active', 'paused', 'completed', 'failed', 'archived'])

function normalizeStoredScheduleType(primary: unknown, legacy: unknown): 'cron' | 'interval' | 'once' {
  const explicit = primary === 'cron' || primary === 'interval' || primary === 'once'
    ? primary
    : null
  const legacyValue = legacy === 'cron' || legacy === 'interval' || legacy === 'once'
    ? legacy
    : null
  if (!explicit && legacyValue) return legacyValue
  if (explicit === 'interval' && legacyValue && legacyValue !== 'interval') return legacyValue
  return explicit || legacyValue || 'interval'
}

function normalizeStoredScheduleTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const intValue = Math.trunc(value)
    return intValue > 0 ? intValue : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  const parsedTime = Date.parse(trimmed)
  if (!Number.isFinite(parsedTime) || parsedTime <= 0) return null
  return Math.trunc(parsedTime)
}

function normalizeStoredSchedulePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const intValue = Math.trunc(value)
    return intValue > 0 ? intValue : null
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeStoredConnectorChannelId(platform: unknown, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (platform !== 'whatsapp') return trimmed
  const withoutPrefix = trimmed.replace(/^whatsapp:/i, '').trim()
  if (!withoutPrefix) return null
  if (/^[\d]+(-[\d]+)*@g\.us$/i.test(withoutPrefix)) return withoutPrefix
  const userMatch = withoutPrefix.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i)
  if (userMatch) return `${userMatch[1]}@s.whatsapp.net`
  const lidMatch = withoutPrefix.match(/^(\d+)(?::\d+)?@lid$/i)
  if (lidMatch) return withoutPrefix
  if (withoutPrefix.includes('@')) return withoutPrefix
  const digits = withoutPrefix.replace(/[^\d+]/g, '')
  const cleaned = digits.startsWith('+') ? digits.slice(1) : digits
  return cleaned ? `${cleaned}@s.whatsapp.net` : null
}

/**
 * Lookup function type for loading individual collection items.
 * Injected to avoid circular dependency between normalization and storage.
 */
export type CollectionItemLoader = (table: string, id: string) => unknown | null

function resolveStoredOwnerFollowupTarget(
  schedule: StoredObject,
  loadItem: CollectionItemLoader,
): {
  connectorId: string
  channelId: string
  senderId: string | null
  senderName: string | null
} | null {
  const createdInSessionId = typeof schedule.createdInSessionId === 'string' ? schedule.createdInSessionId.trim() : ''
  const agentId = typeof schedule.agentId === 'string' ? schedule.agentId.trim() : ''
  if (!createdInSessionId || !agentId) return null

  const sourceSession = loadItem('sessions', createdInSessionId) as StoredObject | null
  if (!sourceSession || isDirectConnectorSession(sourceSession)) return null

  const agent = loadItem('agents', agentId) as StoredObject | null
  const threadSessionId = typeof agent?.threadSessionId === 'string' ? agent.threadSessionId.trim() : ''
  if (threadSessionId && createdInSessionId !== threadSessionId) return null

  const sessionConnectorContext = sourceSession.connectorContext && typeof sourceSession.connectorContext === 'object'
    ? sourceSession.connectorContext as StoredObject
    : null
  const contextIsOwnerConversation = sessionConnectorContext?.isOwnerConversation === true
  const contextConnectorId = typeof sessionConnectorContext?.connectorId === 'string' ? sessionConnectorContext.connectorId.trim() : ''
  const contextChannelId = normalizeStoredConnectorChannelId(sessionConnectorContext?.platform, sessionConnectorContext?.channelId)
  if (contextIsOwnerConversation && contextConnectorId && contextChannelId) {
    const contextSenderId = typeof sessionConnectorContext?.senderId === 'string' ? sessionConnectorContext.senderId.trim() : ''
    const contextSenderName = typeof sessionConnectorContext?.senderName === 'string' ? sessionConnectorContext.senderName.trim() : ''
    return {
      connectorId: contextConnectorId,
      channelId: contextChannelId,
      senderId: contextSenderId || null,
      senderName: contextSenderName || null,
    }
  }

  const connectorId = typeof schedule.followupConnectorId === 'string' ? schedule.followupConnectorId.trim() : ''
  if (!connectorId) return null
  const connector = loadItem('connectors', connectorId) as StoredObject | null
  if (!connector) return null
  const connectorAgentId = typeof connector.agentId === 'string' ? connector.agentId.trim() : ''
  if (connectorAgentId && connectorAgentId !== agentId) return null

  const connectorConfig = connector.config && typeof connector.config === 'object'
    ? connector.config as Record<string, unknown>
    : {}
  const ownerSenderId = typeof connectorConfig.ownerSenderId === 'string' ? connectorConfig.ownerSenderId.trim() : ''
  const ownerChannelId = normalizeStoredConnectorChannelId(
    connector.platform,
    ownerSenderId || connectorConfig.outboundJid || connectorConfig.outboundTarget,
  )
  if (!ownerChannelId) return null

  return {
    connectorId,
    channelId: ownerChannelId,
    senderId: ownerSenderId || null,
    senderName: null,
  }
}

function normalizeStoredScheduleRecord(value: unknown, loadItem: CollectionItemLoader): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value

  const schedule = value as StoredObject
  schedule.scheduleType = normalizeStoredScheduleType(schedule.scheduleType, schedule.type)
  if ('type' in schedule) delete schedule.type

  const status = typeof schedule.status === 'string' ? schedule.status.trim().toLowerCase() : ''
  schedule.status = VALID_SCHEDULE_STATUSES.has(status) ? status : 'active'

  const intervalMs = normalizeStoredSchedulePositiveInt(schedule.intervalMs)
  if (intervalMs != null) schedule.intervalMs = intervalMs
  else delete schedule.intervalMs

  const staggerSec = normalizeStoredSchedulePositiveInt(schedule.staggerSec)
  if (staggerSec != null) schedule.staggerSec = staggerSec
  else delete schedule.staggerSec

  const runAt = normalizeStoredScheduleTimestamp(schedule.runAt)
  if (runAt != null) schedule.runAt = runAt
  else delete schedule.runAt

  const lastRunAt = normalizeStoredScheduleTimestamp(schedule.lastRunAt)
  if (lastRunAt != null) schedule.lastRunAt = lastRunAt
  else delete schedule.lastRunAt

  const nextRunAt = normalizeStoredScheduleTimestamp(schedule.nextRunAt)
  if (nextRunAt != null) schedule.nextRunAt = nextRunAt
  else delete schedule.nextRunAt

  const archivedAt = normalizeStoredScheduleTimestamp(schedule.archivedAt)
  if (archivedAt != null) schedule.archivedAt = archivedAt
  else delete schedule.archivedAt

  const archivedFromStatus = typeof schedule.archivedFromStatus === 'string'
    ? schedule.archivedFromStatus.trim().toLowerCase()
    : ''
  if (archivedFromStatus === 'active' || archivedFromStatus === 'paused' || archivedFromStatus === 'completed' || archivedFromStatus === 'failed') {
    schedule.archivedFromStatus = archivedFromStatus
  } else {
    delete schedule.archivedFromStatus
  }

  if (schedule.status === 'archived') {
    delete schedule.nextRunAt
  } else if (schedule.scheduleType === 'once') {
    if (typeof schedule.runAt === 'number') {
      if (schedule.status === 'completed' || schedule.status === 'failed') {
        delete schedule.nextRunAt
      } else if (typeof schedule.nextRunAt !== 'number' || schedule.nextRunAt !== schedule.runAt) {
        schedule.nextRunAt = schedule.runAt
      }
    }
  } else if (schedule.scheduleType === 'cron') {
    if (!schedule.cron) delete schedule.nextRunAt
  }

  const ownerTarget = resolveStoredOwnerFollowupTarget(schedule, loadItem)
  if (ownerTarget) {
    schedule.followupConnectorId = ownerTarget.connectorId
    schedule.followupChannelId = ownerTarget.channelId
    if (ownerTarget.senderId) schedule.followupSenderId = ownerTarget.senderId
    else delete schedule.followupSenderId
    if (ownerTarget.senderName) schedule.followupSenderName = ownerTarget.senderName
    else delete schedule.followupSenderName
    delete schedule.followupThreadId
  }

  return schedule
}

// --- String array helper ---

function normalizeStoredStringArray(value: unknown, maxItems = 128): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= maxItems) break
  }
  return out
}

// --- Mission normalizer ---

function normalizeStoredMissionRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const mission = value as StoredObject

  const validStatuses = new Set(['active', 'waiting', 'completed', 'failed', 'cancelled'])
  const validPhases = new Set(['intake', 'planning', 'dispatching', 'executing', 'verifying', 'waiting', 'completed', 'failed'])
  const validWaitKinds = new Set(['human_reply', 'approval', 'external_dependency', 'provider', 'blocked_task', 'blocked_mission', 'scheduled', 'other'])
  const validPlannerDecisions = new Set(['dispatch_task', 'dispatch_session_turn', 'spawn_child_mission', 'wait', 'verify_now', 'complete_candidate', 'replan', 'fail_terminal', 'cancel'])
  const validVerificationVerdicts = new Set(['continue', 'waiting', 'completed', 'failed', 'replan'])

  const status = typeof mission.status === 'string' ? mission.status.trim().toLowerCase() : ''
  mission.status = validStatuses.has(status) ? status : 'active'

  const phase = typeof mission.phase === 'string' ? mission.phase.trim().toLowerCase() : ''
  mission.phase = validPhases.has(phase) ? phase : 'planning'

  const sourceRef = mission.sourceRef && typeof mission.sourceRef === 'object' && !Array.isArray(mission.sourceRef)
    ? mission.sourceRef as StoredObject
    : null
  if (sourceRef && typeof sourceRef.kind === 'string') {
    mission.sourceRef = sourceRef
  } else if (typeof mission.sessionId === 'string' && mission.sessionId.trim()) {
    mission.sourceRef = { kind: 'chat', sessionId: mission.sessionId.trim() }
  } else {
    mission.sourceRef = { kind: 'manual' }
  }

  const childMissionIds = normalizeStoredStringArray(mission.childMissionIds, 256)
  if (childMissionIds.length > 0) mission.childMissionIds = childMissionIds
  else delete mission.childMissionIds

  const dependencyMissionIds = normalizeStoredStringArray(mission.dependencyMissionIds, 256)
  if (dependencyMissionIds.length > 0) mission.dependencyMissionIds = dependencyMissionIds
  else delete mission.dependencyMissionIds

  const dependencyTaskIds = normalizeStoredStringArray(mission.dependencyTaskIds, 256)
  if (dependencyTaskIds.length > 0) mission.dependencyTaskIds = dependencyTaskIds
  else delete mission.dependencyTaskIds

  const taskIds = normalizeStoredStringArray(mission.taskIds, 256)
  if (taskIds.length > 0) mission.taskIds = taskIds
  else delete mission.taskIds

  const parentMissionId = typeof mission.parentMissionId === 'string' && mission.parentMissionId.trim()
    ? mission.parentMissionId.trim()
    : ''
  if (parentMissionId) mission.parentMissionId = parentMissionId
  else delete mission.parentMissionId

  const rootMissionId = typeof mission.rootMissionId === 'string' && mission.rootMissionId.trim()
    ? mission.rootMissionId.trim()
    : ''
  mission.rootMissionId = rootMissionId || (typeof mission.id === 'string' ? mission.id : null)

  const waitState = mission.waitState && typeof mission.waitState === 'object' && !Array.isArray(mission.waitState)
    ? mission.waitState as StoredObject
    : null
  if (waitState) {
    const waitKind = typeof waitState.kind === 'string' ? waitState.kind.trim().toLowerCase() : ''
    waitState.kind = validWaitKinds.has(waitKind) ? waitKind : 'other'
    if (typeof waitState.reason !== 'string' || !waitState.reason.trim()) waitState.reason = 'Mission is waiting.'
    const dependencyTaskId = typeof waitState.dependencyTaskId === 'string' && waitState.dependencyTaskId.trim()
      ? waitState.dependencyTaskId.trim()
      : ''
    if (dependencyTaskId) waitState.dependencyTaskId = dependencyTaskId
    else delete waitState.dependencyTaskId
    const dependencyMissionId = typeof waitState.dependencyMissionId === 'string' && waitState.dependencyMissionId.trim()
      ? waitState.dependencyMissionId.trim()
      : ''
    if (dependencyMissionId) waitState.dependencyMissionId = dependencyMissionId
    else delete waitState.dependencyMissionId
    const providerKey = typeof waitState.providerKey === 'string' && waitState.providerKey.trim()
      ? waitState.providerKey.trim()
      : ''
    if (providerKey) waitState.providerKey = providerKey
    else delete waitState.providerKey
    mission.waitState = waitState
  } else {
    delete mission.waitState
  }

  const controllerState = mission.controllerState && typeof mission.controllerState === 'object' && !Array.isArray(mission.controllerState)
    ? mission.controllerState as StoredObject
    : null
  if (controllerState) mission.controllerState = controllerState
  else delete mission.controllerState

  const plannerState = mission.plannerState && typeof mission.plannerState === 'object' && !Array.isArray(mission.plannerState)
    ? mission.plannerState as StoredObject
    : null
  if (plannerState) {
    const decision = typeof plannerState.lastDecision === 'string' ? plannerState.lastDecision.trim() : ''
    if (!validPlannerDecisions.has(decision)) delete plannerState.lastDecision
    mission.plannerState = plannerState
  } else {
    delete mission.plannerState
  }

  const verificationState = mission.verificationState && typeof mission.verificationState === 'object' && !Array.isArray(mission.verificationState)
    ? mission.verificationState as StoredObject
    : { candidate: false }
  verificationState.candidate = verificationState.candidate === true
  const requiredTaskIds = normalizeStoredStringArray(verificationState.requiredTaskIds, 128)
  if (requiredTaskIds.length > 0) verificationState.requiredTaskIds = requiredTaskIds
  else delete verificationState.requiredTaskIds
  const requiredChildMissionIds = normalizeStoredStringArray(verificationState.requiredChildMissionIds, 128)
  if (requiredChildMissionIds.length > 0) verificationState.requiredChildMissionIds = requiredChildMissionIds
  else delete verificationState.requiredChildMissionIds
  const requiredArtifacts = normalizeStoredStringArray(verificationState.requiredArtifacts, 128)
  if (requiredArtifacts.length > 0) verificationState.requiredArtifacts = requiredArtifacts
  else delete verificationState.requiredArtifacts
  const lastVerdict = typeof verificationState.lastVerdict === 'string' ? verificationState.lastVerdict.trim().toLowerCase() : ''
  if (validVerificationVerdicts.has(lastVerdict)) verificationState.lastVerdict = lastVerdict
  else delete verificationState.lastVerdict
  mission.verificationState = verificationState

  return mission
}

// --- Mission event normalizer ---

function normalizeStoredMissionEventRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const event = value as StoredObject
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) event.data = null
  if (typeof event.source !== 'string' || !event.source.trim()) event.source = 'system'
  return event
}

// --- Agent Mission normalizers (autonomous goal-driven runs, v1.5.49+) ---

const VALID_AGENT_MISSION_STATUSES = new Set([
  'draft',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
])

const VALID_AGENT_MISSION_REPORT_FORMATS = new Set(['markdown', 'slack', 'discord', 'email', 'audio'])

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  const n = normalizeFiniteNumber(value)
  if (n == null || n < 0) return fallback
  return n
}

function normalizeStoredAgentMissionRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const mission = value as StoredObject

  const status = typeof mission.status === 'string' ? mission.status.trim().toLowerCase() : ''
  mission.status = VALID_AGENT_MISSION_STATUSES.has(status) ? status : 'draft'

  mission.successCriteria = normalizeStoredStringArray(mission.successCriteria, 64)
  mission.agentIds = normalizeStoredStringArray(mission.agentIds, 32)
  mission.reportConnectorIds = normalizeStoredStringArray(mission.reportConnectorIds, 16)

  const budget = mission.budget && typeof mission.budget === 'object' && !Array.isArray(mission.budget)
    ? mission.budget as StoredObject
    : {}
  budget.maxUsd = normalizeFiniteNumber(budget.maxUsd)
  budget.maxTokens = normalizeFiniteNumber(budget.maxTokens)
  budget.maxToolCalls = normalizeFiniteNumber(budget.maxToolCalls)
  budget.maxWallclockSec = normalizeFiniteNumber(budget.maxWallclockSec)
  budget.maxTurns = normalizeFiniteNumber(budget.maxTurns)
  budget.maxParallelBranches = normalizeFiniteNumber(budget.maxParallelBranches)
  if (!Array.isArray(budget.warnAtFractions)) {
    budget.warnAtFractions = [0.5, 0.8, 0.95]
  } else {
    budget.warnAtFractions = (budget.warnAtFractions as unknown[])
      .map((entry) => normalizeFiniteNumber(entry))
      .filter((entry): entry is number => entry != null && entry > 0 && entry < 1)
    if ((budget.warnAtFractions as number[]).length === 0) {
      budget.warnAtFractions = [0.5, 0.8, 0.95]
    }
  }
  mission.budget = budget

  const usage = mission.usage && typeof mission.usage === 'object' && !Array.isArray(mission.usage)
    ? mission.usage as StoredObject
    : {}
  usage.usdSpent = normalizeNonNegativeNumber(usage.usdSpent, 0)
  usage.tokensUsed = normalizeNonNegativeNumber(usage.tokensUsed, 0)
  usage.toolCallsUsed = normalizeNonNegativeNumber(usage.toolCallsUsed, 0)
  usage.turnsRun = normalizeNonNegativeNumber(usage.turnsRun, 0)
  usage.wallclockMsElapsed = normalizeNonNegativeNumber(usage.wallclockMsElapsed, 0)
  usage.startedAt = normalizeFiniteNumber(usage.startedAt)
  usage.lastUpdatedAt = normalizeNonNegativeNumber(usage.lastUpdatedAt, 0)
  if (!Array.isArray(usage.warnFractionsHit)) {
    usage.warnFractionsHit = []
  } else {
    usage.warnFractionsHit = (usage.warnFractionsHit as unknown[])
      .map((entry) => normalizeFiniteNumber(entry))
      .filter((entry): entry is number => entry != null)
  }
  mission.usage = usage

  if (!Array.isArray(mission.milestones)) mission.milestones = []
  // Cap the stored tail so missions don't balloon
  if ((mission.milestones as unknown[]).length > 200) {
    mission.milestones = (mission.milestones as unknown[]).slice(-200)
  }

  const reportSchedule = mission.reportSchedule
    && typeof mission.reportSchedule === 'object'
    && !Array.isArray(mission.reportSchedule)
    ? mission.reportSchedule as StoredObject
    : null
  if (reportSchedule) {
    const format = typeof reportSchedule.format === 'string' ? reportSchedule.format.trim().toLowerCase() : ''
    reportSchedule.format = VALID_AGENT_MISSION_REPORT_FORMATS.has(format) ? format : 'markdown'
    reportSchedule.intervalSec = normalizeNonNegativeNumber(reportSchedule.intervalSec, 3600)
    reportSchedule.enabled = reportSchedule.enabled !== false
    reportSchedule.lastReportAt = normalizeFiniteNumber(reportSchedule.lastReportAt)
    mission.reportSchedule = reportSchedule
  } else if (mission.reportSchedule !== undefined) {
    mission.reportSchedule = null
  }

  if (typeof mission.createdAt !== 'number') mission.createdAt = Date.now()
  if (typeof mission.updatedAt !== 'number') mission.updatedAt = mission.createdAt as number
  if (mission.startedAt === undefined) mission.startedAt = null
  if (mission.endedAt === undefined) mission.endedAt = null
  if (mission.endReason === undefined) mission.endReason = null

  if (typeof mission.templateId === 'string' && mission.templateId.trim()) {
    mission.templateId = mission.templateId.trim().slice(0, 64)
  } else {
    mission.templateId = null
  }

  return mission
}

function normalizeStoredMissionReportRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const report = value as StoredObject
  const format = typeof report.format === 'string' ? report.format.trim().toLowerCase() : ''
  report.format = VALID_AGENT_MISSION_REPORT_FORMATS.has(format) ? format : 'markdown'
  if (!Array.isArray(report.highlights)) report.highlights = []
  if (!Array.isArray(report.deliveredTo)) report.deliveredTo = []
  if (typeof report.body !== 'string') report.body = ''
  if (typeof report.title !== 'string') report.title = 'Mission report'
  return report
}

function normalizeStoredAgentMissionEventRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const event = value as StoredObject
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    event.payload = {}
  }
  if (typeof event.kind !== 'string' || !event.kind.trim()) event.kind = 'unknown'
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) event.at = Date.now()
  return event
}

// --- Delegation job normalizer ---

function normalizeStoredDelegationJobRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const job = value as StoredObject
  const missionId = typeof job.missionId === 'string' && job.missionId.trim() ? job.missionId.trim() : ''
  if (missionId) job.missionId = missionId
  else delete job.missionId
  const parentMissionId = typeof job.parentMissionId === 'string' && job.parentMissionId.trim() ? job.parentMissionId.trim() : ''
  if (parentMissionId) job.parentMissionId = parentMissionId
  else delete job.parentMissionId
  return job
}

function normalizeStoredRuntimeRunRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const run = value as StoredObject

  if (typeof run.kind !== 'string' || !run.kind.trim()) run.kind = 'session_turn'
  if (run.ownerType === undefined) run.ownerType = 'session'
  if (run.ownerId === undefined) {
    const sessionId = typeof run.sessionId === 'string' && run.sessionId.trim() ? run.sessionId.trim() : ''
    run.ownerId = sessionId || null
  }
  if (run.parentExecutionId === undefined) run.parentExecutionId = null
  if (run.recoveryPolicy === undefined) {
    const source = typeof run.source === 'string' ? run.source.trim().toLowerCase() : ''
    run.recoveryPolicy = source === 'heartbeat'
      || source === 'heartbeat-wake'
      || source === 'schedule'
      || source === 'task'
      || source === 'delegation'
      || source === 'subagent'
      ? 'restart_recoverable'
      : 'ephemeral'
  }

  return run
}

function normalizeStoredRuntimeRunEventRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const event = value as StoredObject

  if (typeof event.kind !== 'string' || !event.kind.trim()) event.kind = 'session_turn'
  if (event.ownerType === undefined) event.ownerType = 'session'
  if (event.ownerId === undefined) {
    const sessionId = typeof event.sessionId === 'string' && event.sessionId.trim() ? event.sessionId.trim() : ''
    event.ownerId = sessionId || null
  }
  if (event.parentExecutionId === undefined) event.parentExecutionId = null

  return event
}

// --- Main dispatch function ---

export interface NormalizationResult {
  value: unknown
  changed: boolean
}

/**
 * Normalize a stored record based on its table.
 * Returns `{ value, changed }` so callers can skip re-serialization when nothing was modified.
 * Requires a `loadItem` callback to resolve cross-table references
 * (used by schedule normalization to look up sessions and connectors).
 */
export function normalizeStoredRecord(
  table: string,
  value: unknown,
  loadItem: CollectionItemLoader,
): NormalizationResult {
  // Tables with no normalization, early exit.
  if (
    table !== 'agents' && table !== 'tasks' && table !== 'missions'
    && table !== 'mission_events' && table !== 'delegation_jobs'
    && table !== 'schedules' && table !== 'sessions'
    && table !== 'provider_configs'
    && table !== 'runtime_runs' && table !== 'runtime_run_events'
    && table !== 'wallets'
    && table !== 'agent_missions'
    && table !== 'mission_reports'
    && table !== 'agent_mission_events'
  ) {
    return { value, changed: false }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value, changed: false }
  }

  // Snapshot before mutation for dirty tracking
  const before = JSON.stringify(value)

  const normalized = normalizeStoredRecordInner(table, value, loadItem)

  const after = JSON.stringify(normalized)
  return { value: normalized, changed: after !== before }
}

function normalizeStoredRecordInner(
  table: string,
  value: unknown,
  loadItem: CollectionItemLoader,
): unknown {
  if (table === 'agents') {
    const agent = value as StoredObject
    const normalizedCapabilities = normalizeCapabilitySelection({
      tools: Array.isArray(agent.tools) ? agent.tools as string[] : undefined,
      extensions: Array.isArray(agent.extensions) ? agent.extensions as string[] : undefined,
    })
    agent.tools = normalizedCapabilities.tools
    agent.extensions = normalizedCapabilities.extensions
    if ('plugins' in agent) delete agent.plugins
    const legacyAssignScope = agent.platformAssignScope === 'all' || agent.platformAssignScope === 'self'
      ? agent.platformAssignScope
      : null
    const legacyTargetIds = Array.isArray(agent.subAgentIds)
      ? agent.subAgentIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : []
    if (typeof agent.delegationEnabled !== 'boolean') {
      agent.delegationEnabled = legacyAssignScope === 'all'
    }
    if (agent.delegationTargetMode !== 'all' && agent.delegationTargetMode !== 'selected') {
      agent.delegationTargetMode = legacyTargetIds.length > 0 ? 'selected' : 'all'
    }
    if (!Array.isArray(agent.delegationTargetAgentIds)) {
      agent.delegationTargetAgentIds = legacyTargetIds
    }
    agent.maxParallelDelegations = normalizeFiniteNumber(agent.maxParallelDelegations)
    delete agent.platformAssignScope
    delete agent.subAgentIds
    agent.sandboxConfig = normalizeAgentSandboxConfig(agent.sandboxConfig)
    // Default executeConfig — null means not configured (falls back to defaults in execute.ts)
    if (agent.executeConfig === undefined) agent.executeConfig = null
    // Default proactiveMemory to true for existing agents
    if (agent.proactiveMemory === undefined) agent.proactiveMemory = true
    if (!Array.isArray(agent.capabilities)) agent.capabilities = []
    // Role normalization — default to 'worker'
    if (agent.role !== 'worker' && agent.role !== 'coordinator') {
      agent.role = 'worker'
    }
    // Coordinators always have delegation enabled
    if (agent.role === 'coordinator') {
      agent.delegationEnabled = true
      if (agent.delegationTargetMode !== 'selected') {
        agent.delegationTargetMode = 'all'
      }
    }
    // Worker-only providers cannot be coordinators, delegate, or have heartbeats
    if (WORKER_ONLY_PROVIDER_IDS.has(agent.provider as string)) {
      agent.role = 'worker'
      agent.delegationEnabled = false
      agent.heartbeatEnabled = false
    }
    // Dreaming defaults
    if (agent.dreamEnabled === undefined) agent.dreamEnabled = false
    if (agent.dreamConfig === undefined) agent.dreamConfig = null
    if (agent.lastDreamAt === undefined) agent.lastDreamAt = null
    if (typeof agent.dreamCycleCount !== 'number') agent.dreamCycleCount = 0
    // Persisted spend rollup defaults
    if (typeof agent.spentMonthlyCents !== 'number') agent.spentMonthlyCents = 0
    if (typeof agent.spentDailyCents !== 'number') agent.spentDailyCents = 0
    if (typeof agent.spentHourlyCents !== 'number') agent.spentHourlyCents = 0
    if (typeof agent.lastSpendRollupAt !== 'number') agent.lastSpendRollupAt = 0
    // SwarmFeed defaults
    if (typeof agent.swarmfeedEnabled !== 'boolean') agent.swarmfeedEnabled = false
    if (agent.swarmfeedJoinedAt === undefined) agent.swarmfeedJoinedAt = null
    if (typeof agent.swarmfeedBio !== 'string' && agent.swarmfeedBio !== null) agent.swarmfeedBio = null
    if (agent.swarmfeedPinnedPostId === undefined) agent.swarmfeedPinnedPostId = null
    if (typeof agent.swarmfeedAutoPost !== 'boolean') agent.swarmfeedAutoPost = false
    if (!Array.isArray(agent.swarmfeedAutoPostChannels)) agent.swarmfeedAutoPostChannels = []
    if (typeof agent.swarmfeedApiKey !== 'string' && agent.swarmfeedApiKey !== null) agent.swarmfeedApiKey = null
    if (typeof agent.swarmfeedAgentId !== 'string' && agent.swarmfeedAgentId !== null) agent.swarmfeedAgentId = null
    if (typeof agent.swarmfeedLastAutoPostAt !== 'number' && agent.swarmfeedLastAutoPostAt !== null) agent.swarmfeedLastAutoPostAt = null
    if (!agent.origin) agent.origin = 'swarmclaw'
    if (agent.swarmfeedHeartbeat === undefined) agent.swarmfeedHeartbeat = null
    // SwarmDock defaults
    if (typeof agent.swarmdockEnabled !== 'boolean') agent.swarmdockEnabled = false
    if (agent.swarmdockListedAt === undefined) agent.swarmdockListedAt = null
    if (typeof agent.swarmdockDescription !== 'string' && agent.swarmdockDescription !== null) agent.swarmdockDescription = null
    if (!Array.isArray(agent.swarmdockSkills)) agent.swarmdockSkills = []
    if (typeof agent.swarmdockWalletId !== 'string' && agent.swarmdockWalletId !== null) agent.swarmdockWalletId = null
    if (typeof agent.swarmdockAgentId !== 'string' && agent.swarmdockAgentId !== null) agent.swarmdockAgentId = null
    if (typeof agent.swarmdockDid !== 'string' && agent.swarmdockDid !== null) agent.swarmdockDid = null
    if (typeof agent.swarmdockApiKey !== 'string' && agent.swarmdockApiKey !== null) agent.swarmdockApiKey = null
    if (agent.swarmdockMarketplace === undefined) agent.swarmdockMarketplace = null
    // Org chart normalization
    if (agent.orgChart && typeof agent.orgChart === 'object' && !Array.isArray(agent.orgChart)) {
      const oc = agent.orgChart as Record<string, unknown>
      oc.parentId ??= null
      oc.teamLabel ??= null
      oc.teamColor ??= null
      oc.x ??= null
      oc.y ??= null
    } else {
      agent.orgChart = null
    }
    return agent
  }

  if (table === 'tasks') {
    const task = value as StoredObject
    if ('missionSummary' in task) delete task.missionSummary
    if (!Array.isArray(task.subtaskIds)) task.subtaskIds = []
    return task
  }

  if (table === 'provider_configs') {
    const provider = value as StoredObject
    provider.type = provider.type === 'builtin' ? 'builtin' : 'custom'
    if (typeof provider.name !== 'string' || !provider.name.trim()) {
      provider.name = provider.type === 'builtin' ? 'Built-in Provider' : 'Custom Provider'
    } else {
      provider.name = provider.name.trim()
    }
    provider.baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : ''
    provider.models = normalizeStoredStringArray(provider.models)

    if (typeof provider.requiresApiKey !== 'boolean') provider.requiresApiKey = true
    if (typeof provider.isEnabled !== 'boolean') provider.isEnabled = true

    const credentialId = typeof provider.credentialId === 'string' ? provider.credentialId.trim() : ''
    provider.credentialId = credentialId || null

    if (typeof provider.createdAt !== 'number') provider.createdAt = Date.now()
    if (typeof provider.updatedAt !== 'number') provider.updatedAt = provider.createdAt as number
    return provider
  }

  if (table === 'missions') {
    return normalizeStoredMissionRecord(value)
  }

  if (table === 'mission_events') {
    return normalizeStoredMissionEventRecord(value)
  }

  if (table === 'agent_missions') {
    return normalizeStoredAgentMissionRecord(value)
  }

  if (table === 'mission_reports') {
    return normalizeStoredMissionReportRecord(value)
  }

  if (table === 'agent_mission_events') {
    return normalizeStoredAgentMissionEventRecord(value)
  }

  if (table === 'delegation_jobs') {
    return normalizeStoredDelegationJobRecord(value)
  }

  if (table === 'runtime_runs') {
    return normalizeStoredRuntimeRunRecord(value)
  }

  if (table === 'runtime_run_events') {
    return normalizeStoredRuntimeRunEventRecord(value)
  }

  if (table === 'schedules') {
    return normalizeStoredScheduleRecord(value, loadItem)
  }

  if (table === 'wallets') {
    const wallet = value as StoredObject
    if (wallet.chain !== 'base') wallet.chain = 'base'
    if (typeof wallet.createdAt !== 'number') wallet.createdAt = Date.now()
    return wallet
  }

  // sessions
  const session = value as StoredObject
  // Migrate legacy 'orchestrated' → 'delegated'
  if (session.sessionType === 'orchestrated') session.sessionType = 'delegated'
  if (session.sessionType !== 'human' && session.sessionType !== 'delegated') session.sessionType = 'human'
  const isLegacyShortcut = (
    (typeof session.id === 'string' && session.id.startsWith('agent-thread-'))
    || (typeof session.name === 'string' && session.name.startsWith('agent-thread:'))
  )
  if (
    isLegacyShortcut
    && typeof session.agentId === 'string'
    && session.agentId.trim()
    && (!session.shortcutForAgentId || session.shortcutForAgentId !== session.agentId)
  ) {
    session.shortcutForAgentId = session.agentId
  }
  const normalizedCapabilities = normalizeCapabilitySelection({
    tools: Array.isArray(session.tools) ? session.tools as string[] : undefined,
    extensions: Array.isArray(session.extensions) ? session.extensions as string[] : undefined,
  })
  session.tools = normalizedCapabilities.tools
  session.extensions = normalizedCapabilities.extensions
  if ('plugins' in session) delete session.plugins
  if ('mainLoopState' in session) delete session.mainLoopState
  if ('missionSummary' in session) delete session.missionSummary
  // Messages are now stored in session_messages table — ensure default empty array
  if (!Array.isArray(session.messages)) session.messages = []
  // Default messageCount for pre-migration blobs
  if (typeof session.messageCount !== 'number') {
    session.messageCount = (session.messages as unknown[]).length
  }
  // Default geminiSessionId for new field
  if (session.geminiSessionId === undefined) session.geminiSessionId = null
  // Default copilotSessionId for new field
  if (session.copilotSessionId === undefined) session.copilotSessionId = null
  if (session.droidSessionId === undefined) session.droidSessionId = null
  if (session.cursorSessionId === undefined) session.cursorSessionId = null
  if (session.qwenSessionId === undefined) session.qwenSessionId = null
  if (session.acpSessionId === undefined) session.acpSessionId = null
  if (!session.delegateResumeIds || typeof session.delegateResumeIds !== 'object') {
    session.delegateResumeIds = {
      claudeCode: null,
      codex: null,
      opencode: null,
      gemini: null,
      copilot: null,
      droid: null,
      cursor: null,
      qwen: null,
    }
  } else {
    const resumeIds = session.delegateResumeIds as Record<string, unknown>
    if (resumeIds.copilot === undefined) resumeIds.copilot = null
    if (resumeIds.droid === undefined) resumeIds.droid = null
    if (resumeIds.cursor === undefined) resumeIds.cursor = null
    if (resumeIds.qwen === undefined) resumeIds.qwen = null
  }
  // Default injectedMemoryIds for proactive recall dedup
  if (!session.injectedMemoryIds || typeof session.injectedMemoryIds !== 'object') {
    session.injectedMemoryIds = {}
  }
  // Validate runContext if present — leave null/undefined alone (created on demand)
  if (session.runContext != null) {
    if (typeof session.runContext !== 'object' || Array.isArray(session.runContext)) {
      session.runContext = null
    } else {
      const rc = session.runContext as Record<string, unknown>
      if (typeof rc.objective !== 'string' && rc.objective !== null) rc.objective = null
      if (!Array.isArray(rc.constraints)) rc.constraints = []
      if (!Array.isArray(rc.keyFacts)) rc.keyFacts = []
      if (!Array.isArray(rc.discoveries)) rc.discoveries = []
      if (!Array.isArray(rc.failedApproaches)) rc.failedApproaches = []
      if (!Array.isArray(rc.currentPlan)) rc.currentPlan = []
      if (!Array.isArray(rc.completedSteps)) rc.completedSteps = []
      if (!Array.isArray(rc.blockers)) rc.blockers = []
      if (typeof rc.parentContext !== 'string' && rc.parentContext !== null) rc.parentContext = null
      if (typeof rc.updatedAt !== 'number') rc.updatedAt = Date.now()
      if (typeof rc.version !== 'number') rc.version = 0
    }
  }
  return session
}
