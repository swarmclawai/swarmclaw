import { log } from '@/lib/server/logger'
import { genId } from '@/lib/id'
import type {
  ApprovalRequest,
  BoardTask,
  DelegationJobRecord,
  MessageToolEvent,
  Mission,
  MissionEvent,
  MissionPhase,
  MissionSource,
  MissionSourceRef,
  MissionStatus,
  MissionSummary,
  MissionVerificationVerdict,
  Schedule,
  Session,
  SessionQueuedTurn,
  SessionRunRecord,
} from '@/types'
import { getMessages } from '@/lib/server/messages/message-repository'
import { loadApprovals } from '@/lib/server/approvals/approval-repository'
import { loadDelegationJob } from '@/lib/server/agents/delegation-job-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import {
  classifyMissionTurn,
  planMissionTick,
  verifyMissionOutcome,
  type MissionOutcomeDecision,
  type MissionPlannerDecisionResult,
  type MissionTurnDecision,
} from '@/lib/server/missions/mission-intent'
import {
  loadMission,
  loadMissionEvents,
  loadMissions,
  patchMission,
  upsertMission,
  upsertMissionEvent,
} from '@/lib/server/missions/mission-repository'
import {
  releaseRuntimeLock,
  renewRuntimeLock,
  tryAcquireRuntimeLock,
} from '@/lib/server/runtime/runtime-lock-repository'
import { upsertSchedule } from '@/lib/server/schedules/schedule-repository'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { loadSession, patchSession } from '@/lib/server/sessions/session-repository'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import { getSessionQueueSnapshot, listRuns } from '@/lib/server/runtime/session-run-manager'
import { loadTask, loadTasks, patchTask } from '@/lib/server/tasks/task-repository'
import { notify } from '@/lib/server/ws-hub'
import { buildExecutionBrief, buildExecutionBriefContextBlock } from '@/lib/server/execution-brief'
import { cleanText } from '@/lib/server/text-normalization'

const TAG = 'mission-service'

function now(): number {
  return Date.now()
}

function uniqueStrings(values: unknown, maxItems: number, maxChars = 180): string[] {
  const source = Array.isArray(values) ? values : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of source) {
    const normalized = cleanText(entry, maxChars)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

const MISSION_LEASE_TTL_MS = 15_000
const MISSION_LEASE_OWNER = `mission:${process.pid}:${genId(6)}`
const recoveryState = hmrSingleton('__swarmclaw_mission_controller_recovery__', () => ({ running: false }))

function areMissionHumanLoopWaitsEnabled(): boolean {
  const settings = loadSettings() as { missionHumanLoopEnabled?: unknown }
  return settings.missionHumanLoopEnabled === true
}

function shouldSuppressMissionHumanLoopWait(waitKind: unknown): boolean {
  return waitKind === 'human_reply' && !areMissionHumanLoopWaitsEnabled()
}

function isMissionTerminal(status: MissionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function missionLeaseName(missionId: string): string {
  return `mission:${missionId}`
}

function listMissionIds(value: unknown, maxItems = 128): string[] {
  return uniqueStrings(value, maxItems, 48)
}

function pickMissionPhase(value: unknown, fallback: MissionPhase = 'planning'): MissionPhase {
  const phase = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (phase === 'intake' || phase === 'planning' || phase === 'dispatching' || phase === 'executing' || phase === 'verifying' || phase === 'waiting' || phase === 'completed' || phase === 'failed') {
    return phase
  }
  return fallback
}

function pickMissionWaitKind(value: unknown): NonNullable<Mission['waitState']>['kind'] {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (kind === 'human_reply' || kind === 'approval' || kind === 'external_dependency' || kind === 'provider' || kind === 'blocked_task' || kind === 'blocked_mission' || kind === 'scheduled') {
    return kind
  }
  return 'other'
}

function normalizeMissionSourceRef(source: MissionSource, mission: Partial<Mission>): MissionSourceRef {
  const sourceRef = mission.sourceRef
  if (sourceRef && typeof sourceRef === 'object' && 'kind' in sourceRef) return sourceRef
  if (source === 'schedule' && typeof (mission as { sourceScheduleId?: string | null }).sourceScheduleId === 'string') {
    return {
      kind: 'schedule',
      scheduleId: (mission as { sourceScheduleId?: string | null }).sourceScheduleId || '',
      recurring: true,
    }
  }
  if ((source === 'chat' || source === 'connector' || source === 'heartbeat' || source === 'main-loop-followup') && typeof mission.sessionId === 'string' && mission.sessionId.trim()) {
    return source === 'connector'
      ? { kind: 'connector', sessionId: mission.sessionId.trim(), connectorId: '', channelId: '' }
      : source === 'heartbeat'
        ? { kind: 'heartbeat', sessionId: mission.sessionId.trim() }
        : { kind: 'chat', sessionId: mission.sessionId.trim() }
  }
  if (source === 'task' && typeof mission.rootTaskId === 'string' && mission.rootTaskId.trim()) {
    return { kind: 'task', taskId: mission.rootTaskId.trim() }
  }
  return { kind: 'manual' }
}

function normalizeMissionRecord(mission: Mission): Mission {
  const rootMissionId = typeof mission.rootMissionId === 'string' && mission.rootMissionId.trim()
    ? mission.rootMissionId.trim()
    : mission.id
  const parentMissionId = typeof mission.parentMissionId === 'string' && mission.parentMissionId.trim()
    ? mission.parentMissionId.trim()
    : null
  const controllerState = mission.controllerState && typeof mission.controllerState === 'object'
    ? { ...mission.controllerState }
    : {}
  const plannerState = mission.plannerState && typeof mission.plannerState === 'object'
    ? { ...mission.plannerState }
    : {}
  const verificationState = mission.verificationState && typeof mission.verificationState === 'object'
    ? { ...mission.verificationState }
    : { candidate: false }
  return {
    ...mission,
    phase: pickMissionPhase(mission.phase),
    sourceRef: normalizeMissionSourceRef(mission.source, mission),
    rootMissionId,
    ...(parentMissionId ? { parentMissionId } : {}),
    childMissionIds: listMissionIds(mission.childMissionIds, 256),
    dependencyMissionIds: listMissionIds(mission.dependencyMissionIds, 256),
    dependencyTaskIds: listMissionIds(mission.dependencyTaskIds, 256),
    taskIds: listMissionIds(mission.taskIds, 256),
    controllerState,
    plannerState,
    verificationState: {
      candidate: verificationState.candidate === true,
      requiredTaskIds: listMissionIds(verificationState.requiredTaskIds, 128),
      requiredChildMissionIds: listMissionIds(verificationState.requiredChildMissionIds, 128),
      requiredArtifacts: uniqueStrings(verificationState.requiredArtifacts, 128, 240),
      evidenceSummary: cleanText(verificationState.evidenceSummary, 320) || null,
      lastVerdict: ((): MissionVerificationVerdict | null => {
        const verdict = typeof verificationState.lastVerdict === 'string' ? verificationState.lastVerdict.trim().toLowerCase() : ''
        return verdict === 'continue' || verdict === 'waiting' || verdict === 'completed' || verdict === 'failed' || verdict === 'replan'
          ? verdict
          : null
      })(),
      lastVerifiedAt: typeof verificationState.lastVerifiedAt === 'number' ? verificationState.lastVerifiedAt : null,
    },
    waitState: mission.waitState
      ? {
          kind: pickMissionWaitKind(mission.waitState.kind),
          reason: cleanText(mission.waitState.reason, 220) || 'Mission is waiting.',
          approvalId: typeof mission.waitState.approvalId === 'string' ? mission.waitState.approvalId : null,
          untilAt: typeof mission.waitState.untilAt === 'number' ? mission.waitState.untilAt : null,
          dependencyTaskId: typeof mission.waitState.dependencyTaskId === 'string' ? mission.waitState.dependencyTaskId : null,
          dependencyMissionId: typeof mission.waitState.dependencyMissionId === 'string' ? mission.waitState.dependencyMissionId : null,
          providerKey: typeof mission.waitState.providerKey === 'string' ? mission.waitState.providerKey : null,
        }
      : null,
  }
}

function missionSourceFromTask(task: BoardTask, fallback: MissionSource = 'manual'): MissionSource {
  if (task.sourceType === 'schedule') return 'schedule'
  if (task.sourceType === 'delegation') return 'delegation'
  return fallback
}

export function loadMissionById(id: string | null | undefined): Mission | null {
  const missionId = typeof id === 'string' ? id.trim() : ''
  if (!missionId) return null
  const mission = loadMission(missionId)
  return mission ? normalizeMissionRecord(mission) : null
}

export function findLatestMissionForSession(sessionId: string): Mission | null {
  const missions = Object.values(loadMissions())
    .map((mission) => normalizeMissionRecord(mission))
    .filter((mission) => mission.sessionId === sessionId)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
  const active = missions.find((mission) => !isMissionTerminal(mission.status))
  return active || missions[0] || null
}

export function getMissionForSession(session: Session | null | undefined): Mission | null {
  if (!session) return null
  const byId = loadMissionById(session.missionId)
  if (byId) return byId
  return findLatestMissionForSession(session.id)
}

function listTaskSummaries(taskIds: string[] | undefined): Array<{
  id: string
  title: string
  status: string
  result?: string | null
  error?: string | null
}> {
  const tasks = loadTasks()
  const source = Array.isArray(taskIds) ? taskIds : []
  return source
    .map((taskId) => tasks[taskId])
    .filter((task): task is BoardTask => Boolean(task))
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      result: task.result || null,
      error: task.error || null,
    }))
}

export function buildMissionSummary(mission: Mission): MissionSummary {
  const taskSummaries = listTaskSummaries(mission.taskIds)
  const completedTaskCount = taskSummaries.filter((task) => task.status === 'completed').length
  const openTaskCount = taskSummaries.filter((task) => !['completed', 'failed', 'cancelled', 'archived'].includes(task.status)).length
  return {
    id: mission.id,
    objective: mission.objective,
    status: mission.status,
    phase: mission.phase,
    source: mission.source,
    currentStep: mission.currentStep || null,
    waitingReason: mission.waitState?.reason || null,
    sessionId: mission.sessionId || null,
    agentId: mission.agentId || null,
    projectId: mission.projectId || null,
    parentMissionId: mission.parentMissionId || null,
    rootMissionId: mission.rootMissionId || mission.id,
    taskIds: Array.isArray(mission.taskIds) ? mission.taskIds : [],
    openTaskCount,
    completedTaskCount,
    childCount: Array.isArray(mission.childMissionIds) ? mission.childMissionIds.length : 0,
    sourceRef: mission.sourceRef,
    updatedAt: mission.updatedAt,
  }
}

export function enrichSessionWithMissionSummary<T extends Session>(session: T): T {
  const mission = getMissionForSession(session)
  if (!mission) return { ...session, missionSummary: null } as T
  return {
    ...session,
    missionId: mission.id,
    missionSummary: buildMissionSummary(mission),
  } as T
}

export function enrichTaskWithMissionSummary<T extends BoardTask>(task: T): T {
  const mission = loadMissionById(task.missionId)
  if (!mission) return { ...task, missionSummary: null } as T
  return {
    ...task,
    missionSummary: buildMissionSummary(mission),
  } as T
}

export function listMissionEventsForMission(missionId: string, limit = 200): MissionEvent[] {
  const safeLimit = Math.max(1, Math.min(2000, Math.trunc(limit)))
  return Object.values(loadMissionEvents())
    .filter((event) => event.missionId === missionId)
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-safeLimit)
}

export function listMissions(options?: {
  sessionId?: string | null
  status?: MissionStatus | 'non_terminal'
  phase?: MissionPhase | null
  source?: MissionSource | null
  agentId?: string | null
  projectId?: string | null
  parentMissionId?: string | null
  limit?: number
}): Mission[] {
  const missions = Object.values(loadMissions())
    .map((mission) => normalizeMissionRecord(mission))
    .filter((mission) => {
      if (options?.sessionId && mission.sessionId !== options.sessionId) return false
      if (!options?.status) return true
      if (options.status === 'non_terminal') return !isMissionTerminal(mission.status)
      return mission.status === options.status
    })
    .filter((mission) => !options?.phase || mission.phase === options.phase)
    .filter((mission) => !options?.source || mission.source === options.source)
    .filter((mission) => !options?.agentId || mission.agentId === options.agentId)
    .filter((mission) => !options?.projectId || mission.projectId === options.projectId)
    .filter((mission) => !options?.parentMissionId || mission.parentMissionId === options.parentMissionId)
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))

  const limit = typeof options?.limit === 'number'
    ? Math.max(1, Math.min(500, Math.trunc(options.limit)))
    : null
  return limit ? missions.slice(0, limit) : missions
}

export function listChildMissions(parentMissionId: string, limit?: number): Mission[] {
  const missions = listMissions({ parentMissionId })
  if (typeof limit !== 'number') return missions
  return missions.slice(0, Math.max(1, Math.trunc(limit)))
}

function listMissionApprovals(mission: Mission): ApprovalRequest[] {
  const approvals = Object.values(loadApprovals()) as ApprovalRequest[]
  return approvals
    .filter((approval) =>
      approval.id === mission.waitState?.approvalId
      || (typeof approval.sessionId === 'string' && approval.sessionId === mission.sessionId)
    )
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
}

function listMissionQueuedTurns(mission: Mission): SessionQueuedTurn[] {
  const queue = mission.sessionId ? getSessionQueueSnapshot(mission.sessionId) : null
  if (!queue) return []
  return queue.items.filter((item) => item.missionId === mission.id)
}

function listMissionRuns(mission: Mission, limit = 20): SessionRunRecord[] {
  return listRuns({ limit: Math.max(20, limit * 4) })
    .filter((run) => run.missionId === mission.id)
    .slice(0, limit)
}

function listRecentMissionEvents(missionId: string, limit = 12): MissionEvent[] {
  return listMissionEventsForMission(missionId, limit)
}

function hasTerminalMissionEvidence(mission: Mission): boolean {
  const requiredTaskIds = mission.verificationState?.requiredTaskIds || mission.taskIds || []
  const requiredChildMissionIds = mission.verificationState?.requiredChildMissionIds || mission.childMissionIds || []
  const tasks = loadTasks()
  const requiredTasksSatisfied = requiredTaskIds.every((taskId) => {
    const task = tasks[taskId]
    return Boolean(task && task.status === 'completed')
  })
  const requiredChildrenSatisfied = requiredChildMissionIds.every((childId) => {
    const child = loadMissionById(childId)
    return Boolean(child && child.status === 'completed')
  })
  return requiredTasksSatisfied && requiredChildrenSatisfied
}

function missionNeedsStartupRecovery(mission: Mission): boolean {
  if (isMissionTerminal(mission.status)) return false
  if (mission.status === 'waiting') return false
  return mission.phase === 'dispatching' || mission.phase === 'executing' || mission.phase === 'verifying'
}

function recoverMissionOnStartup(mission: Mission): { mission: Mission | null; rerunVerification: boolean } {
  const reconciled = reconcileMissionState(mission)
  if (!missionNeedsStartupRecovery(reconciled)) return { mission: loadMissionById(reconciled.id) || reconciled, rerunVerification: false }
  const hasLiveExecution = missionHasActiveTask(reconciled) || missionHasActiveRun(reconciled) || missionHasActiveChild(reconciled)
  if (hasLiveExecution) return { mission: loadMissionById(reconciled.id) || reconciled, rerunVerification: false }
  if (reconciled.phase === 'verifying' && hasTerminalMissionEvidence(reconciled)) {
    const updated = patchMissionStatus(reconciled.id, (current) => ({
      ...current,
      status: 'active',
      phase: 'verifying',
      controllerState: {
        ...(current.controllerState || {}),
        activeRunId: null,
        currentTaskId: null,
        currentChildMissionId: null,
        tickRequestedAt: now(),
        tickReason: 'restart_recovery',
      },
    }))
    if (updated) {
      appendMissionEvent({
        missionId: updated.id,
        type: 'interrupted',
        source: 'system',
        summary: 'Mission verification recovered after restart.',
        sessionId: updated.sessionId || null,
        runId: updated.lastRunId || null,
        data: { phase: mission.phase, recoveredPhase: 'verifying' },
      })
    }
    return { mission: updated, rerunVerification: Boolean(updated) }
  }

  const updated = patchMissionStatus(reconciled.id, (current) => ({
    ...clearMissionExecutionPointers(current),
    status: 'active',
    phase: 'planning',
    waitState: null,
    controllerState: {
      ...(current.controllerState || {}),
      tickRequestedAt: now(),
      tickReason: 'restart_recovery',
    },
  }))
  if (updated) {
    appendMissionEvent({
      missionId: updated.id,
      type: 'interrupted',
      source: 'system',
      summary: 'Mission execution was interrupted and returned to planning.',
      sessionId: updated.sessionId || null,
      runId: updated.lastRunId || null,
      data: { phase: mission.phase, recoveredPhase: 'planning' },
    })
  }
  return { mission: updated, rerunVerification: Boolean(updated) }
}

export function runMissionControllerStartupRecovery(): { recovered: number; rerunVerification: number } {
  if (recoveryState.running) return { recovered: 0, rerunVerification: 0 }
  recoveryState.running = true
  const rerunTickIds = new Set<string>()
  let recoveredCount = 0
  try {
    for (const mission of Object.values(loadMissions()).map((entry) => normalizeMissionRecord(entry))) {
      if (isMissionTerminal(mission.status)) continue
      const recovered = recoverMissionOnStartup(mission)
      if (recovered.mission && (
        recovered.mission.status !== mission.status
        || recovered.mission.phase !== mission.phase
        || recovered.rerunVerification
      )) {
        recoveredCount++
      }
      if (recovered.rerunVerification && recovered.mission?.id) rerunTickIds.add(recovered.mission.id)
    }
  } finally {
    recoveryState.running = false
  }
  for (const missionId of rerunTickIds) {
    queueMicrotask(() => {
      requestMissionTick(missionId, 'restart_recovery', { recovered: true })
    })
  }
  return { recovered: recoveredCount, rerunVerification: rerunTickIds.size }
}

export function getMissionDetail(missionId: string): {
  mission: Mission
  summary: MissionSummary
  parent: MissionSummary | null
  children: MissionSummary[]
  linkedTasks: BoardTask[]
  recentRuns: SessionRunRecord[]
  queuedTurns: SessionQueuedTurn[]
  approvals: ApprovalRequest[]
  events: MissionEvent[]
} | null {
  const mission = loadMissionById(missionId)
  if (!mission) return null
  const tasks = loadTasks()
  const parentMission = mission.parentMissionId ? loadMissionById(mission.parentMissionId) : null
  return {
    mission,
    summary: buildMissionSummary(mission),
    parent: parentMission ? buildMissionSummary(parentMission) : null,
    children: listChildMissions(mission.id).map((child) => buildMissionSummary(child)),
    linkedTasks: (mission.taskIds || [])
      .map((taskId) => tasks[taskId])
      .filter((task): task is BoardTask => Boolean(task))
      .map((task) => enrichTaskWithMissionSummary(task)),
    recentRuns: listMissionRuns(mission),
    queuedTurns: listMissionQueuedTurns(mission),
    approvals: listMissionApprovals(mission),
    events: listMissionEventsForMission(mission.id, 80),
  }
}

export function appendMissionEvent(input: Omit<MissionEvent, 'id' | 'createdAt'> & { createdAt?: number }): MissionEvent {
  const event: MissionEvent = {
    id: genId(12),
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now(),
    ...input,
  }
  upsertMissionEvent(event.id, event)
  notify('missions')
  return event
}

function ensureMissionTaskLink(mission: Mission, taskId: string): Mission {
  const taskIds = uniqueStrings([...(mission.taskIds || []), taskId], 128, 48)
  return {
    ...mission,
    taskIds,
    rootTaskId: mission.rootTaskId || taskId,
    verificationState: {
      candidate: mission.verificationState?.candidate === true,
      requiredTaskIds: uniqueStrings([...(mission.verificationState?.requiredTaskIds || []), taskId], 128, 48),
      requiredChildMissionIds: listMissionIds(mission.verificationState?.requiredChildMissionIds, 128),
      requiredArtifacts: uniqueStrings(mission.verificationState?.requiredArtifacts, 128, 240),
      evidenceSummary: mission.verificationState?.evidenceSummary || null,
      lastVerdict: mission.verificationState?.lastVerdict || null,
      lastVerifiedAt: mission.verificationState?.lastVerifiedAt || null,
    },
  }
}

function patchMissionStatus(
  missionId: string,
  updater: (mission: Mission) => Mission,
): Mission | null {
  const updated = patchMission(missionId, (current) => {
    if (!current) return current
    return normalizeMissionRecord({
      ...updater(current),
      updatedAt: now(),
      lastActiveAt: now(),
    })
  })
  if (updated) notify('missions')
  return updated ? normalizeMissionRecord(updated) : null
}

export function acquireMissionLease(missionId: string, ttlMs = MISSION_LEASE_TTL_MS): (() => void) | null {
  if (!tryAcquireRuntimeLock(missionLeaseName(missionId), MISSION_LEASE_OWNER, ttlMs)) return null
  let released = false
  return () => {
    if (released) return
    released = true
    releaseRuntimeLock(missionLeaseName(missionId), MISSION_LEASE_OWNER)
  }
}

export function renewMissionLease(missionId: string, ttlMs = MISSION_LEASE_TTL_MS): boolean {
  return renewRuntimeLock(missionLeaseName(missionId), MISSION_LEASE_OWNER, ttlMs)
}

function missionHasActiveTask(mission: Mission): boolean {
  const taskId = mission.controllerState?.currentTaskId
  if (!taskId) return false
  const task = loadTask(taskId)
  return Boolean(task && (task.status === 'queued' || task.status === 'running'))
}

function missionHasActiveRun(mission: Mission): boolean {
  const runId = mission.controllerState?.activeRunId || mission.lastRunId
  if (!runId) return false
  const runs = listMissionRuns(mission, 50)
  return runs.some((run) => run.id === runId && (run.status === 'queued' || run.status === 'running'))
}

function missionHasActiveChild(mission: Mission): boolean {
  const currentChildMissionId = mission.controllerState?.currentChildMissionId
  if (currentChildMissionId) {
    const child = loadMissionById(currentChildMissionId)
    if (child && !isMissionTerminal(child.status)) return true
  }
  return (mission.childMissionIds || []).some((childId) => {
    const child = loadMissionById(childId)
    return Boolean(child && !isMissionTerminal(child.status))
  })
}

function isWaitSatisfied(mission: Mission): boolean {
  const waitState = mission.waitState
  if (!waitState) return true
  if (waitState.approvalId) {
    const approval = listMissionApprovals(mission).find((entry) => entry.id === waitState.approvalId)
    if (!approval || approval.status === 'pending') return false
  }
  if (waitState.untilAt && waitState.untilAt > now()) return false
  if (waitState.dependencyTaskId) {
    const task = loadTask(waitState.dependencyTaskId)
    if (!task || !['completed', 'failed', 'cancelled', 'archived'].includes(task.status)) return false
  }
  if (waitState.dependencyMissionId) {
    const child = loadMissionById(waitState.dependencyMissionId)
    if (!child || !isMissionTerminal(child.status)) return false
  }
  return true
}

function clearMissionExecutionPointers(mission: Mission): Mission {
  return {
    ...mission,
    controllerState: {
      ...(mission.controllerState || {}),
      activeRunId: null,
      currentTaskId: null,
      currentChildMissionId: null,
    },
  }
}

function maybePromoteChildOutcome(mission: Mission): Mission {
  const childIds = mission.childMissionIds || []
  if (!childIds.length) return mission
  const children = childIds.map((childId) => loadMissionById(childId)).filter((child): child is Mission => Boolean(child))
  const activeChild = children.find((child) => !isMissionTerminal(child.status))
  if (activeChild) {
    return {
      ...mission,
      status: 'waiting',
      phase: 'waiting',
      waitState: {
        kind: 'blocked_mission',
        reason: activeChild.waitState?.reason || `Waiting on child mission: ${activeChild.objective}`,
        dependencyMissionId: activeChild.id,
      },
      controllerState: {
        ...(mission.controllerState || {}),
        currentChildMissionId: activeChild.id,
      },
    }
  }
  const failedChild = children.find((child) => child.status === 'failed')
  if (failedChild) {
    return {
      ...mission,
      status: 'waiting',
      phase: 'waiting',
      blockerSummary: failedChild.blockerSummary || failedChild.verifierSummary || `Child mission failed: ${failedChild.objective}`,
      waitState: {
        kind: 'blocked_mission',
        reason: failedChild.blockerSummary || failedChild.verifierSummary || `Child mission failed: ${failedChild.objective}`,
        dependencyMissionId: failedChild.id,
      },
    }
  }
  return mission
}

function reconcileMissionState(mission: Mission): Mission {
  let next = normalizeMissionRecord(mission)
  next = maybePromoteChildOutcome(next)
  if (!missionHasActiveTask(next) && !missionHasActiveRun(next) && !missionHasActiveChild(next)) {
    next = clearMissionExecutionPointers(next)
  }
  if (next.status === 'waiting' && isWaitSatisfied(next)) {
    next = {
      ...next,
      status: 'active',
      phase: 'planning',
      waitState: null,
      blockerSummary: null,
    }
  }
  return next
}

function isAutoMissionSource(source: MissionSource): boolean {
  return source === 'schedule' || source === 'heartbeat' || source === 'main-loop-followup' || source === 'delegation'
}

function buildMissionFollowupMessage(mission: Mission): string {
  return [
    'MISSION_CONTROLLER_TICK',
    buildMissionContextBlock(mission),
    'Take the single highest-value next step for this mission.',
    'If the mission is blocked on a real dependency, say so plainly.',
    'If the mission is complete, explain the actual completed outcome instead of promising future work.',
  ].filter(Boolean).join('\n\n')
}

function plannerDecisionSummary(
  decision: MissionPlannerDecisionResult,
  mission: Mission,
): string {
  const explicit = cleanText((decision as { summary?: string | null }).summary, 360)
  if (explicit) return explicit
  if (decision.decision === 'dispatch_task') return `Queue linked task ${decision.taskId}.`
  if (decision.decision === 'dispatch_session_turn') return 'Queue a mission follow-up turn.'
  if (decision.decision === 'spawn_child_mission') return `Create child mission: ${decision.childObjective}`
  if (decision.decision === 'wait') return cleanText(decision.waitReason, 220) || 'Mission is waiting.'
  if (decision.decision === 'verify_now') return 'Verify mission completion from current durable evidence.'
  if (decision.decision === 'complete_candidate') return `Mission looks complete and should enter verification: ${mission.objective}`
  if (decision.decision === 'fail_terminal') return `Mission failed: ${mission.objective}`
  return 'Mission replanned.'
}

function areMissionDependenciesSatisfied(mission: Mission): { satisfied: boolean; blockerSummary: string | null } {
  const depMissionIds = Array.isArray(mission.dependencyMissionIds) ? mission.dependencyMissionIds : []
  for (const depId of depMissionIds) {
    const dep = loadMissionById(depId)
    if (!dep || !isMissionTerminal(dep.status) || dep.status !== 'completed') {
      return { satisfied: false, blockerSummary: `Blocked by mission: ${dep?.objective || depId} (${dep?.status || 'not found'})` }
    }
  }
  const depTaskIds = Array.isArray(mission.dependencyTaskIds) ? mission.dependencyTaskIds : []
  for (const depId of depTaskIds) {
    const dep = loadTask(depId)
    if (!dep || dep.status !== 'completed') {
      return { satisfied: false, blockerSummary: `Blocked by task: ${dep?.title || depId} (${dep?.status || 'not found'})` }
    }
  }
  return { satisfied: true, blockerSummary: null }
}

function deterministicPlannerDecision(mission: Mission): MissionPlannerDecisionResult | null {
  // Check external dependencies (dependencyMissionIds / dependencyTaskIds)
  const depCheck = areMissionDependenciesSatisfied(mission)
  if (!depCheck.satisfied) {
    return {
      decision: 'wait',
      confidence: 1,
      summary: depCheck.blockerSummary || 'Blocked by unsatisfied dependency.',
      waitKind: 'blocked_mission',
      waitReason: depCheck.blockerSummary || 'Blocked by unsatisfied dependency.',
    }
  }

  const tasks = listTaskSummaries(mission.taskIds)
  const failedTask = tasks.find((task) => task.status === 'failed')
  if (failedTask) {
    return {
      decision: 'wait',
      confidence: 1,
      summary: failedTask.error || `Waiting on failed task: ${failedTask.title}`,
      waitKind: 'blocked_task',
      waitReason: failedTask.error || `Waiting on failed task: ${failedTask.title}`,
    }
  }

  const nonTerminalChild = (mission.childMissionIds || [])
    .map((childId) => loadMissionById(childId))
    .find((child): child is Mission => Boolean(child && !isMissionTerminal(child.status)))
  if (nonTerminalChild) {
    return {
      decision: 'wait',
      confidence: 1,
      summary: nonTerminalChild.waitState?.reason || `Waiting on child mission: ${nonTerminalChild.objective}`,
      waitKind: 'blocked_mission',
      waitReason: nonTerminalChild.waitState?.reason || `Waiting on child mission: ${nonTerminalChild.objective}`,
    }
  }

  const completedTasks = tasks.filter((task) => task.status === 'completed')
  const hasTerminalTaskSet = tasks.length > 0 && completedTasks.length === tasks.length
  const requiredArtifacts = mission.verificationState?.requiredArtifacts || []
  if (hasTerminalTaskSet && requiredArtifacts.length === 0) {
    return {
      decision: 'verify_now',
      confidence: 1,
      summary: 'All required linked tasks are complete.',
    }
  }

  return null
}

async function planMissionAction(
  mission: Mission,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<MissionPlannerDecisionResult> {
  const deterministic = deterministicPlannerDecision(mission)
  if (deterministic) return deterministic

  const taskSummaries = listTaskSummaries(mission.taskIds)
  const childMissionSummaries = listChildMissions(mission.id, 8).map((child) => buildMissionSummary(child))
  const queuedTurns = listMissionQueuedTurns(mission)
  const recentRuns = listMissionRuns(mission, 8).map((run) => ({
    id: run.id,
    status: run.status,
    source: run.source,
    queuedAt: run.queuedAt,
    messagePreview: run.messagePreview,
    resultPreview: run.resultPreview,
    error: run.error,
  }))
  const recentEvents = listRecentMissionEvents(mission.id, 10).map((event) => ({
    type: event.type,
    summary: event.summary,
    createdAt: event.createdAt,
  }))

  const planned = await planMissionTick({
    sessionId: mission.sessionId || mission.id,
    agentId: mission.agentId || null,
    mission,
    linkedTaskSummaries: taskSummaries,
    childMissionSummaries,
    recentRuns,
    queuedTurns,
    recentEvents,
  }, options)

  if (planned) return planned

  if (isAutoMissionSource(mission.source) && mission.sessionId) {
    return {
      decision: 'dispatch_session_turn',
      confidence: 0,
      summary: 'Queue a mission follow-up turn using the durable mission context.',
      sessionMessage: buildMissionFollowupMessage(mission),
      ...(mission.currentStep ? { currentStep: mission.currentStep } : {}),
    }
  }

  return {
    decision: 'replan',
    confidence: 0,
    summary: 'Mission remains active and is waiting for the next concrete planner decision.',
    ...(mission.currentStep ? { currentStep: mission.currentStep } : {}),
  }
}

function applyMissionPlannerPolicies(
  mission: Mission,
  decision: MissionPlannerDecisionResult,
): MissionPlannerDecisionResult {
  if (decision.decision !== 'wait' || !shouldSuppressMissionHumanLoopWait(decision.waitKind)) return decision
  const currentStep = decision.currentStep || mission.currentStep || undefined
  if (hasTerminalMissionEvidence(mission) || ((mission.taskIds?.length || 0) === 0 && (mission.childMissionIds?.length || 0) === 0)) {
    return {
      decision: 'verify_now',
      confidence: decision.confidence,
      summary: 'Mission human-loop waits are disabled, so the mission will close instead of waiting for another reply.',
      ...(currentStep ? { currentStep } : {}),
    }
  }
  return {
    decision: 'replan',
    confidence: decision.confidence,
    summary: 'Mission human-loop waits are disabled, so the mission stays active instead of pausing for another reply.',
    ...(currentStep ? { currentStep } : {}),
  }
}

async function executeMissionPlannerDecision(
  mission: Mission,
  decision: MissionPlannerDecisionResult,
  trigger: string,
): Promise<Mission | null> {
  const summary = plannerDecisionSummary(decision, mission)
  const basePatch = (updater: (current: Mission) => Mission) => patchMissionStatus(mission.id, (current) => ({
    ...updater(current),
    plannerState: {
      ...(current.plannerState || {}),
      lastDecision: decision.decision,
      lastPlannedAt: now(),
      planSummary: summary,
    },
    controllerState: {
      ...(current.controllerState || {}),
      tickRequestedAt: now(),
      tickReason: trigger,
    },
  }))

  appendMissionEvent({
    missionId: mission.id,
    type: 'planner_decision',
    source: 'system',
    summary,
    sessionId: mission.sessionId || null,
    runId: mission.lastRunId || null,
    data: {
      decision: decision.decision,
      trigger,
    },
  })

  if (decision.decision === 'wait') {
    const waitReason = cleanText(decision.waitReason, 220) || summary
    const updated = basePatch((current) => ({
      ...current,
      status: 'waiting',
      phase: 'waiting',
      waitState: {
        kind: decision.waitKind || 'other',
        reason: waitReason,
      },
      blockerSummary: waitReason,
      currentStep: decision.currentStep || current.currentStep || null,
    }))
    if (updated) {
      appendMissionEvent({
        missionId: updated.id,
        type: 'waiting',
        source: 'system',
        summary: waitReason,
        sessionId: updated.sessionId || null,
        runId: updated.lastRunId || null,
        data: updated.waitState ? updated.waitState as unknown as Record<string, unknown> : null,
      })
    }
    return updated
  }

  if (decision.decision === 'complete_candidate') {
    return basePatch((current) => ({
      ...current,
      status: 'active',
      phase: 'verifying',
      currentStep: decision.currentStep || current.currentStep || null,
      verificationState: {
        ...(current.verificationState || { candidate: false }),
        candidate: true,
        evidenceSummary: summary,
      },
    }))
  }

  if (decision.decision === 'verify_now') {
    const updated = basePatch((current) => ({
      ...current,
      status: 'completed',
      phase: 'completed',
      waitState: null,
      blockerSummary: null,
      verifierSummary: current.verifierSummary || summary,
      currentStep: decision.currentStep || current.currentStep || null,
      verificationState: {
        ...(current.verificationState || { candidate: false }),
        candidate: true,
        evidenceSummary: summary,
        lastVerdict: 'completed',
        lastVerifiedAt: now(),
      },
      completedAt: current.completedAt || now(),
    }))
    if (updated) {
      appendMissionEvent({
        missionId: updated.id,
        type: 'verifier_decision',
        source: 'system',
        summary,
        sessionId: updated.sessionId || null,
        runId: updated.lastRunId || null,
        data: { verdict: 'completed' },
      })
      appendMissionEvent({
        missionId: updated.id,
        type: 'completed',
        source: 'system',
        summary: updated.verifierSummary || summary,
        sessionId: updated.sessionId || null,
        runId: updated.lastRunId || null,
        data: { status: updated.status },
      })
      if (updated.parentMissionId) noteParentMissionChildOutcome(updated)
    }
    return updated
  }

  if (decision.decision === 'dispatch_task') {
    const { enqueueTask } = await import('@/lib/server/runtime/queue')
    const task = loadTask(decision.taskId)
    if (!task) {
      return basePatch((current) => ({
        ...current,
        status: 'waiting',
        phase: 'waiting',
        waitState: {
          kind: 'blocked_task',
          reason: `Linked task ${decision.taskId} was not found.`,
        },
        blockerSummary: `Linked task ${decision.taskId} was not found.`,
      }))
    }
    enqueueTask(decision.taskId)
    const updated = basePatch((current) => ({
      ...current,
      status: 'active',
      phase: 'dispatching',
      currentStep: decision.currentStep || current.currentStep || task.title || null,
      controllerState: {
        ...(current.controllerState || {}),
        currentTaskId: decision.taskId,
        tickRequestedAt: now(),
        tickReason: trigger,
      },
    }))
    if (updated) {
      appendMissionEvent({
        missionId: updated.id,
        type: 'dispatch_started',
        source: 'system',
        summary,
        sessionId: updated.sessionId || null,
        taskId: decision.taskId,
        runId: updated.lastRunId || null,
        data: { taskId: decision.taskId },
      })
    }
    return updated
  }

  if (decision.decision === 'dispatch_session_turn') {
    if (!mission.sessionId) {
      return basePatch((current) => ({
        ...current,
        status: 'waiting',
        phase: 'waiting',
        waitState: {
          kind: 'external_dependency',
          reason: 'Mission follow-up needs a linked session before it can continue.',
        },
        blockerSummary: 'Mission follow-up needs a linked session before it can continue.',
      }))
    }
    const { enqueueSessionRun } = await import('@/lib/server/runtime/session-run-manager')
    const queued = enqueueSessionRun({
      sessionId: mission.sessionId || '',
      missionId: mission.id,
      message: decision.sessionMessage,
      internal: true,
      source: 'main-loop-followup',
      mode: 'followup',
      dedupeKey: `mission-tick:${mission.id}`,
    })
    const updated = basePatch((current) => ({
      ...current,
      status: 'active',
      phase: 'dispatching',
      currentStep: decision.currentStep || current.currentStep || null,
      controllerState: {
        ...(current.controllerState || {}),
        activeRunId: queued.runId,
        tickRequestedAt: now(),
        tickReason: trigger,
      },
    }))
    if (updated) {
      appendMissionEvent({
        missionId: updated.id,
        type: 'dispatch_started',
        source: 'system',
        summary,
        sessionId: updated.sessionId || null,
        runId: queued.runId,
        data: { queuedRunId: queued.runId },
      })
    }
    return updated
  }

  if (decision.decision === 'spawn_child_mission') {
    const childMission = createMission({
      source: mission.source === 'delegation' ? 'delegation' : 'manual',
      sourceRef: mission.source === 'delegation'
        ? { kind: 'delegation', parentMissionId: mission.id, backend: 'agent' }
        : { kind: 'manual' },
      objective: decision.childObjective,
      successCriteria: decision.childSuccessCriteria,
      currentStep: decision.childCurrentStep || decision.currentStep || null,
      plannerSummary: decision.childPlannerSummary || summary,
      sessionId: mission.sessionId || null,
      agentId: mission.agentId || null,
      projectId: mission.projectId || null,
      parentMissionId: mission.id,
      sourceMessage: decision.childPlannerSummary || decision.childObjective,
    })
    const updated = basePatch((current) => ({
      ...current,
      status: 'waiting',
      phase: 'waiting',
      currentStep: decision.currentStep || current.currentStep || null,
      waitState: {
        kind: 'blocked_mission',
        reason: `Waiting on child mission: ${childMission.objective}`,
        dependencyMissionId: childMission.id,
      },
      controllerState: {
        ...(current.controllerState || {}),
        currentChildMissionId: childMission.id,
        tickRequestedAt: now(),
        tickReason: trigger,
      },
    }))
    if (updated) {
      requestMissionTick(childMission.id, 'child_created', { parentMissionId: mission.id })
    }
    return updated
  }

  if (decision.decision === 'fail_terminal') {
    const updated = basePatch((current) => ({
      ...current,
      status: 'failed',
      phase: 'failed',
      blockerSummary: summary,
      verifierSummary: summary,
      failedAt: current.failedAt || now(),
    }))
    if (updated) {
      appendMissionEvent({
        missionId: updated.id,
        type: 'failed',
        source: 'system',
        summary,
        sessionId: updated.sessionId || null,
        runId: updated.lastRunId || null,
        data: { status: updated.status },
      })
      if (updated.parentMissionId) noteParentMissionChildOutcome(updated)
    }
    return updated
  }

  return basePatch((current) => ({
    ...current,
    status: 'active',
    phase: 'planning',
    currentStep: decision.currentStep || current.currentStep || null,
  }))
}

export function requestMissionTick(
  missionId: string,
  trigger: string,
  data?: Record<string, unknown> | null,
): Mission | null {
  const mission = patchMissionStatus(missionId, (current) => ({
    ...reconcileMissionState(current),
    controllerState: {
      ...(current.controllerState || {}),
      tickRequestedAt: now(),
      tickReason: trigger,
    },
  }))
  if (!mission) return null
  appendMissionEvent({
    missionId,
    type: 'source_triggered',
    source: 'system',
    summary: `Mission tick requested: ${trigger}`,
    sessionId: mission.sessionId || null,
    runId: mission.lastRunId || null,
    data: data || null,
  })
  queueMicrotask(() => {
    void runMissionTick(missionId, trigger).catch((err: unknown) => {
      log.warn(TAG, `mission tick failed for ${missionId}: ${errorMessage(err)}`)
    })
  })
  return mission
}

export function requestMissionTicksForApprovalDecision(params: {
  approvalId: string
  status: 'approved' | 'rejected'
  sessionId?: string | null
}): Mission[] {
  const candidates = listMissions({ status: 'non_terminal' }).filter((mission) => (
    mission.waitState?.kind === 'approval'
    && (
      mission.waitState?.approvalId === params.approvalId
      || (params.sessionId && mission.sessionId === params.sessionId)
    )
  ))
  return candidates
    .map((mission) => requestMissionTick(mission.id, 'approval_resolved', {
      approvalId: params.approvalId,
      status: params.status,
    }))
    .filter((mission): mission is Mission => Boolean(mission))
}

export function requestMissionTicksForHumanReply(params: {
  sessionId: string
  correlationId?: string | null
  envelopeId?: string | null
  payload?: string | null
  fromSessionId?: string | null
}): Mission[] {
  const candidates = listMissions({ sessionId: params.sessionId, status: 'non_terminal' }).filter((mission) => (
    mission.status === 'waiting'
    && mission.waitState?.kind === 'human_reply'
  ))
  return candidates
    .map((mission) => requestMissionTick(mission.id, 'human_reply', {
      correlationId: params.correlationId || null,
      envelopeId: params.envelopeId || null,
      payload: cleanText(params.payload, 320) || null,
      fromSessionId: params.fromSessionId || null,
    }))
    .filter((mission): mission is Mission => Boolean(mission))
}

export function requestMissionTicksForProviderRecovery(providerKey: string): Mission[] {
  const normalizedProviderKey = cleanText(providerKey, 80)
  if (!normalizedProviderKey) return []
  const candidates = listMissions({ status: 'non_terminal' }).filter((mission) => (
    mission.waitState?.kind === 'provider'
    && cleanText(mission.waitState?.providerKey, 80) === normalizedProviderKey
  ))
  return candidates
    .map((mission) => requestMissionTick(mission.id, 'provider_recovered', {
      providerKey: normalizedProviderKey,
    }))
    .filter((mission): mission is Mission => Boolean(mission))
}

export async function runMissionTick(
  missionId: string,
  trigger = 'manual',
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<Mission | null> {
  const release = acquireMissionLease(missionId)
  if (!release) return loadMissionById(missionId)
  try {
    let mission = loadMissionById(missionId)
    if (!mission) return null
    if (isMissionTerminal(mission.status)) return mission
    const reconciled = patchMissionStatus(missionId, (current) => reconcileMissionState(current))
    mission = reconciled || mission
    if (mission.status === 'waiting' && !isWaitSatisfied(mission)) return mission
    if (missionHasActiveTask(mission) || missionHasActiveRun(mission) || missionHasActiveChild(mission)) {
      return patchMissionStatus(missionId, (current) => ({
        ...current,
        status: current.status === 'waiting' ? current.status : 'active',
        phase: current.status === 'waiting' ? 'waiting' : 'executing',
        controllerState: {
          ...(current.controllerState || {}),
          tickRequestedAt: now(),
          tickReason: trigger,
        },
      })) || mission
    }
    const planned = applyMissionPlannerPolicies(mission, await planMissionAction(mission, options))
    return await executeMissionPlannerDecision(mission, planned, trigger)
  } finally {
    release()
  }
}

export function bindMissionToSession(sessionId: string, missionId: string): void {
  patchSession(sessionId, (current) => {
    if (!current) return current
    if (current.missionId === missionId) return current
    return {
      ...current,
      missionId,
      updatedAt: now(),
    }
  })
}

export function bindMissionToTask(taskId: string, missionId: string): void {
  patchTask(taskId, (current) => {
    if (!current) return current
    if (current.missionId === missionId) return current
    return {
      ...current,
      missionId,
      updatedAt: now(),
    }
  })
}

function createMission(input: {
  source: MissionSource
  sourceRef?: MissionSourceRef
  objective: string
  successCriteria?: string[]
  currentStep?: string | null
  plannerSummary?: string | null
  sessionId?: string | null
  agentId?: string | null
  projectId?: string | null
  taskId?: string | null
  runId?: string | null
  sourceMessage?: string | null
  parentMissionId?: string | null
  dependencyMissionIds?: string[]
  dependencyTaskIds?: string[]
}): Mission {
  const timestamp = now()
  const parentMission = input.parentMissionId ? loadMissionById(input.parentMissionId) : null
  const mission = normalizeMissionRecord({
    id: genId(),
    source: input.source,
    sourceRef: input.sourceRef,
    objective: cleanText(input.objective, 300),
    successCriteria: uniqueStrings(input.successCriteria, 6, 180),
    status: 'active',
    phase: 'intake',
    sessionId: input.sessionId || null,
    agentId: input.agentId || null,
    projectId: input.projectId || null,
    rootMissionId: parentMission?.rootMissionId || parentMission?.id || null,
    parentMissionId: input.parentMissionId || null,
    childMissionIds: [],
    dependencyMissionIds: listMissionIds(input.dependencyMissionIds, 128),
    dependencyTaskIds: listMissionIds(input.dependencyTaskIds, 128),
    taskIds: input.taskId ? [input.taskId] : [],
    rootTaskId: input.taskId || null,
    currentStep: cleanText(input.currentStep, 200) || null,
    plannerSummary: cleanText(input.plannerSummary, 320) || null,
    verifierSummary: null,
    blockerSummary: null,
    waitState: null,
    controllerState: {
      tickRequestedAt: timestamp,
      tickReason: 'mission_created',
      attemptCount: 0,
    },
    plannerState: {
      lastDecision: null,
      lastPlannedAt: null,
      planSummary: cleanText(input.plannerSummary, 320) || null,
    },
    verificationState: {
      candidate: false,
      requiredTaskIds: input.taskId ? [input.taskId] : [],
      requiredChildMissionIds: [],
      requiredArtifacts: [],
      evidenceSummary: null,
      lastVerdict: null,
      lastVerifiedAt: null,
    },
    lastRunId: input.runId || null,
    sourceRunId: input.runId || null,
    sourceMessage: cleanText(input.sourceMessage, 600) || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActiveAt: timestamp,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
  })
  if (!mission.rootMissionId) mission.rootMissionId = mission.parentMissionId || mission.id
  upsertMission(mission.id, mission)
  notify('missions')
  appendMissionEvent({
    missionId: mission.id,
    type: 'created',
    source: input.source,
    summary: `Mission created: ${mission.objective}`,
    sessionId: mission.sessionId || null,
    taskId: input.taskId || null,
    runId: input.runId || null,
    data: {
      successCriteria: mission.successCriteria || [],
      currentStep: mission.currentStep || null,
      plannerSummary: mission.plannerSummary || null,
      sourceRef: mission.sourceRef || null,
    },
  })
  if (mission.parentMissionId) {
    patchMissionStatus(mission.parentMissionId, (parent) => ({
      ...parent,
      childMissionIds: listMissionIds([...(parent.childMissionIds || []), mission.id], 256),
      phase: parent.phase === 'completed' ? 'planning' : parent.phase,
      status: parent.status === 'completed' ? 'active' : parent.status,
      waitState: {
        kind: 'blocked_mission',
        reason: `Waiting on child mission: ${mission.objective}`,
        dependencyMissionId: mission.id,
      },
      dependencyMissionIds: listMissionIds([...(parent.dependencyMissionIds || []), mission.id], 256),
    }))
    appendMissionEvent({
      missionId: mission.parentMissionId,
      type: 'child_created',
      source: input.source,
      summary: `Child mission created: ${mission.objective}`,
      sessionId: mission.sessionId || null,
      runId: input.runId || null,
      data: {
        childMissionId: mission.id,
        objective: mission.objective,
      },
    })
  }
  return mission
}

export function ensureMissionForTask(
  task: BoardTask,
  options?: {
    source?: MissionSource
    sessionId?: string | null
    runId?: string | null
  },
): Mission | null {
  if (!task || !task.id) return null
  const existingMission = loadMissionById(task.missionId)
  if (existingMission) {
    const linked = patchMissionStatus(existingMission.id, (mission) => ensureMissionTaskLink(mission, task.id))
    if (linked) bindMissionToTask(task.id, linked.id)
    if (task.sessionId && linked) bindMissionToSession(task.sessionId, linked.id)
    return linked
  }

  const sourceTaskMission = (() => {
    const tasks = loadTasks()
    const sourceTaskId = typeof task.delegatedFromTaskId === 'string' && task.delegatedFromTaskId.trim()
      ? task.delegatedFromTaskId.trim()
      : Array.isArray(task.blockedBy) && task.blockedBy.length > 0
        ? task.blockedBy[0]
        : ''
    if (!sourceTaskId) return null
    return loadMissionById(tasks[sourceTaskId]?.missionId)
  })()

  if (sourceTaskMission) {
    const linked = patchMissionStatus(sourceTaskMission.id, (mission) => ensureMissionTaskLink(mission, task.id))
    if (linked) {
      bindMissionToTask(task.id, linked.id)
      if (task.sessionId) bindMissionToSession(task.sessionId, linked.id)
      appendMissionEvent({
        missionId: linked.id,
        type: 'task_linked',
        source: options?.source || missionSourceFromTask(task),
        summary: `Linked task: ${task.title}`,
        sessionId: task.sessionId || null,
        taskId: task.id,
        runId: options?.runId || null,
        data: { taskStatus: task.status },
      })
    }
    return linked
  }

  const session = task.sessionId ? loadSession(task.sessionId) : null
  const sessionMission = getMissionForSession(session)
  if (sessionMission && !isMissionTerminal(sessionMission.status)) {
    const linked = patchMissionStatus(sessionMission.id, (mission) => ensureMissionTaskLink(mission, task.id))
    if (linked) {
      bindMissionToTask(task.id, linked.id)
      if (task.sessionId) bindMissionToSession(task.sessionId, linked.id)
      appendMissionEvent({
        missionId: linked.id,
        type: 'task_linked',
        source: options?.source || missionSourceFromTask(task),
        summary: `Linked task: ${task.title}`,
        sessionId: task.sessionId || null,
        taskId: task.id,
        runId: options?.runId || null,
        data: { taskStatus: task.status },
      })
    }
    return linked
  }

  const objective = cleanText(task.goalContract?.objective, 300) || cleanText(task.title, 300)
  if (!objective) return null
  const mission = createMission({
    source: options?.source || missionSourceFromTask(task),
    objective,
    successCriteria: task.goalContract?.constraints || [],
    currentStep: cleanText(task.description, 200) || null,
    plannerSummary: task.description || task.title,
    sessionId: options?.sessionId || task.sessionId || null,
    agentId: task.agentId,
    projectId: task.projectId || null,
    taskId: task.id,
    runId: options?.runId || null,
    sourceMessage: task.description || task.title,
  })
  bindMissionToTask(task.id, mission.id)
  if (task.sessionId) bindMissionToSession(task.sessionId, mission.id)
  appendMissionEvent({
    missionId: mission.id,
    type: 'task_linked',
    source: options?.source || missionSourceFromTask(task),
    summary: `Linked task: ${task.title}`,
    sessionId: task.sessionId || null,
    taskId: task.id,
    runId: options?.runId || null,
    data: { taskStatus: task.status },
  })
  return loadMissionById(mission.id)
}

function applyTurnDecisionToMission(
  decision: MissionTurnDecision,
  params: {
    session: Session
    source: MissionSource
    runId?: string | null
    message: string
    currentMission: Mission | null
  },
): Mission | null {
  if (decision.action === 'none') return null
  if (decision.action === 'attach_current' && params.currentMission) {
    const updated = patchMissionStatus(params.currentMission.id, (mission) => ({
      ...mission,
      phase: mission.status === 'waiting' ? 'waiting' : mission.phase,
      currentStep: decision.currentStep || mission.currentStep || null,
      plannerSummary: decision.plannerSummary || mission.plannerSummary || null,
      lastRunId: params.runId || mission.lastRunId || null,
    }))
    if (updated) {
      bindMissionToSession(params.session.id, updated.id)
      appendMissionEvent({
        missionId: updated.id,
        type: 'attached',
        source: params.source,
        summary: `Attached turn to mission: ${updated.objective}`,
        sessionId: params.session.id,
        runId: params.runId || null,
        data: { message: cleanText(params.message, 320) },
      })
    }
    return updated
  }
  if (decision.action !== 'create_new') return null
  const mission = createMission({
    source: params.source,
    objective: decision.objective,
    successCriteria: decision.successCriteria,
    currentStep: decision.currentStep || null,
    plannerSummary: decision.plannerSummary || null,
    sessionId: params.session.id,
    agentId: params.session.agentId || null,
    projectId: params.session.projectId || null,
    runId: params.runId || null,
    sourceMessage: params.message,
  })
  bindMissionToSession(params.session.id, mission.id)
  return loadMissionById(mission.id)
}

export async function resolveMissionForTurn(params: {
  session: Session
  message: string
  source: string
  internal: boolean
  runId?: string | null
  explicitMissionId?: string | null
  generateText?: (prompt: string) => Promise<string>
}): Promise<Mission | null> {
  const explicitMission = loadMissionById(params.explicitMissionId)
  if (explicitMission) {
    bindMissionToSession(params.session.id, explicitMission.id)
    return explicitMission
  }

  const currentMission = getMissionForSession(params.session)
  if (params.source === 'task' && currentMission) {
    bindMissionToSession(params.session.id, currentMission.id)
    return currentMission
  }
  if (params.internal) {
    if (currentMission) bindMissionToSession(params.session.id, currentMission.id)
    return currentMission
  }

  let decision: MissionTurnDecision | null = null
  try {
    decision = await classifyMissionTurn({
      sessionId: params.session.id,
      agentId: params.session.agentId || null,
      message: params.message,
      recentMessages: getMessages(params.session.id),
      currentMission: currentMission ? buildMissionSummary(currentMission) : null,
      session: params.session,
    }, params.generateText ? { generateText: params.generateText } : undefined)
  } catch (err: unknown) {
    log.warn(TAG, `resolveMissionForTurn failed for ${params.session.id}: ${errorMessage(err)}`)
    return null
  }

  if (!decision) return null
  return applyTurnDecisionToMission(decision, {
    session: params.session,
    source: params.source === 'chat' ? 'chat' : 'connector',
    runId: params.runId || null,
    message: params.message,
    currentMission,
  })
}

function missionPhaseForVerdict(decision: MissionOutcomeDecision, mission: Mission): MissionPhase {
  if (decision.phase) return decision.phase
  if (decision.verdict === 'completed') return 'completed'
  if (decision.verdict === 'failed') return 'failed'
  if (decision.verdict === 'waiting') return 'waiting'
  if (decision.verdict === 'replan') return 'planning'
  if (mission.phase === 'planning') return 'executing'
  return 'verifying'
}

function applyMissionOutcomePolicies(
  mission: Mission,
  decision: MissionOutcomeDecision,
): MissionOutcomeDecision {
  if (decision.verdict !== 'waiting' || !shouldSuppressMissionHumanLoopWait(decision.waitKind)) return decision
  const currentStep = decision.currentStep || mission.currentStep
  if (hasTerminalMissionEvidence(mission) || ((mission.taskIds?.length || 0) === 0 && (mission.childMissionIds?.length || 0) === 0)) {
    return {
      verdict: 'completed',
      confidence: decision.confidence,
      phase: 'completed',
      ...(currentStep ? { currentStep } : {}),
      verifierSummary: 'Mission human-loop waits are disabled, so the completed work was closed instead of waiting for another reply.',
    }
  }
  return {
    verdict: 'replan',
    confidence: decision.confidence,
    phase: 'planning',
    ...(currentStep ? { currentStep } : {}),
    verifierSummary: 'Mission human-loop waits are disabled, so the controller kept the mission active instead of waiting for another reply.',
  }
}

function summaryForOutcome(decision: MissionOutcomeDecision, fallback: string): string {
  return cleanText(decision.verifierSummary, 360) || cleanText(fallback, 360) || 'Mission updated.'
}

export async function applyMissionOutcomeForTurn(params: {
  session: Session
  missionId: string
  source: string
  runId?: string | null
  message: string
  assistantText?: string | null
  error?: string | null
  toolEvents?: MessageToolEvent[]
  generateText?: (prompt: string) => Promise<string>
}): Promise<Mission | null> {
  const mission = loadMissionById(params.missionId)
  if (!mission) return null
  const taskSummaries = listTaskSummaries(mission.taskIds)
  let decision: MissionOutcomeDecision | null = null
  try {
    decision = await verifyMissionOutcome({
      sessionId: params.session.id,
      agentId: params.session.agentId || null,
      userMessage: params.message,
      assistantText: params.assistantText || null,
      error: params.error || null,
      toolEvents: params.toolEvents,
      currentMission: buildMissionSummary(mission),
      linkedTaskSummaries: taskSummaries,
    }, params.generateText ? { generateText: params.generateText } : undefined)
  } catch (err: unknown) {
    log.warn(TAG, `applyMissionOutcomeForTurn failed for ${params.session.id}: ${errorMessage(err)}`)
    return mission
  }
  if (!decision) return mission
  decision = applyMissionOutcomePolicies(mission, decision)

  const fallbackSummary = params.error
    ? `Run ended with error: ${params.error}`
    : cleanText(params.assistantText, 360) || 'Mission run completed.'
  const outcomeSummary = summaryForOutcome(decision, fallbackSummary)
  const updated = patchMissionStatus(mission.id, (current) => {
    const next: Mission = {
      ...current,
      phase: missionPhaseForVerdict(decision, current),
      currentStep: decision.currentStep || current.currentStep || null,
      verifierSummary: outcomeSummary,
      lastRunId: params.runId || current.lastRunId || null,
      waitState: null,
      blockerSummary: null,
      completedAt: current.completedAt || null,
      failedAt: current.failedAt || null,
      cancelledAt: current.cancelledAt || null,
    }
    if (decision.verdict === 'completed') {
      next.status = 'completed'
      next.phase = 'completed'
      next.waitState = null
      next.completedAt = now()
    } else if (decision.verdict === 'failed') {
      next.status = 'failed'
      next.phase = 'failed'
      next.failedAt = now()
      next.blockerSummary = outcomeSummary
    } else if (decision.verdict === 'waiting') {
      next.status = 'waiting'
      next.phase = 'waiting'
      next.waitState = {
        kind: decision.waitKind || 'other',
        reason: cleanText(decision.waitReason, 220) || outcomeSummary,
      }
    } else if (decision.verdict === 'replan') {
      next.status = 'active'
      next.phase = 'planning'
      next.waitState = null
      next.blockerSummary = null
    } else {
      next.status = 'active'
      if (next.phase === 'completed' || next.phase === 'failed' || next.phase === 'waiting') {
        next.phase = 'executing'
      }
    }
    return next
  })
  if (!updated) return mission

  logActivity({
    entityType: 'mission',
    entityId: updated.id,
    action: `phase_${updated.phase}`,
    actor: 'system',
    summary: `Mission "${updated.objective?.slice(0, 60) || updated.id}" → ${updated.phase} (${decision.verdict})`,
  })

  appendMissionEvent({
    missionId: updated.id,
    type: 'run_result',
    source: params.source === 'heartbeat' || params.source === 'main-loop-followup'
      ? (params.source as MissionSource)
      : 'chat',
    summary: outcomeSummary,
    sessionId: params.session.id,
    runId: params.runId || null,
    data: {
      verdict: decision.verdict,
      phase: updated.phase,
      status: updated.status,
      currentStep: updated.currentStep || null,
      waitState: updated.waitState || null,
    },
  })

  if (decision.verdict === 'waiting') {
    appendMissionEvent({
      missionId: updated.id,
      type: 'waiting',
      source: params.source === 'heartbeat' || params.source === 'main-loop-followup'
        ? (params.source as MissionSource)
        : 'chat',
      summary: updated.waitState?.reason || outcomeSummary,
      sessionId: params.session.id,
      runId: params.runId || null,
      data: updated.waitState ? updated.waitState as unknown as Record<string, unknown> : null,
    })
  } else if (decision.verdict === 'completed') {
    appendMissionEvent({
      missionId: updated.id,
      type: 'completed',
      source: params.source === 'heartbeat' || params.source === 'main-loop-followup'
        ? (params.source as MissionSource)
        : 'chat',
      summary: outcomeSummary,
      sessionId: params.session.id,
      runId: params.runId || null,
      data: { status: updated.status },
    })
  } else if (decision.verdict === 'failed') {
    appendMissionEvent({
      missionId: updated.id,
      type: 'failed',
      source: params.source === 'heartbeat' || params.source === 'main-loop-followup'
        ? (params.source as MissionSource)
        : 'chat',
      summary: outcomeSummary,
      sessionId: params.session.id,
      runId: params.runId || null,
      data: { status: updated.status },
    })
  }

  bindMissionToSession(params.session.id, updated.id)
  if (
    params.source !== 'chat'
    && updated.status === 'active'
    && updated.phase !== 'executing'
    && updated.phase !== 'dispatching'
    && !missionHasActiveTask(updated)
    && !missionHasActiveRun(updated)
    && !missionHasActiveChild(updated)
  ) {
    requestMissionTick(updated.id, 'run_outcome', {
      source: params.source,
      verdict: decision.verdict,
      runId: params.runId || null,
    })
  }
  if (updated.parentMissionId && isMissionTerminal(updated.status)) {
    noteParentMissionChildOutcome(updated)
  }
  return updated
}

function noteParentMissionChildOutcome(childMission: Mission): void {
  if (!childMission.parentMissionId) return
  const parent = loadMissionById(childMission.parentMissionId)
  if (!parent) return
  const summary = childMission.status === 'completed'
    ? `Child mission completed: ${childMission.objective}`
    : childMission.status === 'failed'
      ? `Child mission failed: ${childMission.objective}`
      : `Child mission updated: ${childMission.objective}`
  appendMissionEvent({
    missionId: parent.id,
    type: childMission.status === 'completed' ? 'child_completed' : childMission.status === 'failed' ? 'child_failed' : 'status_change',
    source: childMission.source,
    summary,
    sessionId: parent.sessionId || null,
    runId: childMission.lastRunId || null,
    data: {
      childMissionId: childMission.id,
      childStatus: childMission.status,
      childPhase: childMission.phase,
    },
  })
  requestMissionTick(parent.id, 'child_mission_changed', {
    childMissionId: childMission.id,
    childStatus: childMission.status,
  })
  wakeDependentMissions(childMission.id, 'mission')
}

function wakeDependentMissions(completedId: string, kind: 'mission' | 'task'): void {
  const allMissions = Object.values(loadMissions()).map(normalizeMissionRecord)
  for (const candidate of allMissions) {
    if (isMissionTerminal(candidate.status)) continue
    const deps = kind === 'mission'
      ? Array.isArray(candidate.dependencyMissionIds) ? candidate.dependencyMissionIds : []
      : Array.isArray(candidate.dependencyTaskIds) ? candidate.dependencyTaskIds : []
    if (deps.includes(completedId)) {
      requestMissionTick(candidate.id, `dependency_${kind}_completed`, { [`completed${kind === 'mission' ? 'Mission' : 'Task'}Id`]: completedId })
    }
  }
}

export function performMissionAction(params: {
  missionId: string
  action: 'resume' | 'replan' | 'cancel' | 'retry_verification' | 'wait'
  reason?: string | null
  waitKind?: NonNullable<Mission['waitState']>['kind']
  untilAt?: number | null
}): { mission: Mission; event: MissionEvent } | null {
  const mission = loadMissionById(params.missionId)
  if (!mission) return null
  const summaryReason = cleanText(params.reason, 220) || null
  const updated = patchMissionStatus(mission.id, (current) => {
    if (params.action === 'cancel') {
      return {
        ...current,
        status: 'cancelled',
        phase: 'failed',
        blockerSummary: summaryReason || 'Mission cancelled by operator.',
        waitState: null,
        cancelledAt: now(),
      }
    }
    if (params.action === 'wait') {
      return {
        ...current,
        status: 'waiting',
        phase: 'waiting',
        waitState: {
          kind: params.waitKind || 'other',
          reason: summaryReason || 'Mission paused by operator.',
          untilAt: typeof params.untilAt === 'number' ? params.untilAt : null,
        },
      }
    }
    if (params.action === 'retry_verification') {
      return {
        ...current,
        status: 'active',
        phase: 'verifying',
        waitState: null,
        blockerSummary: null,
        verificationState: {
          ...(current.verificationState || { candidate: false }),
          candidate: true,
        },
      }
    }
    return {
      ...current,
      status: 'active',
      phase: 'planning',
      waitState: null,
      blockerSummary: null,
      controllerState: {
        ...(current.controllerState || {}),
        tickRequestedAt: now(),
        tickReason: params.action,
      },
    }
  })
  if (!updated) return null
  const event = appendMissionEvent({
    missionId: updated.id,
    type: 'operator_action',
    source: 'system',
    summary: `${params.action.replace(/_/g, ' ')} mission`,
    sessionId: updated.sessionId || null,
    runId: updated.lastRunId || null,
    data: {
      action: params.action,
      reason: summaryReason,
      waitKind: params.waitKind || null,
      untilAt: typeof params.untilAt === 'number' ? params.untilAt : null,
    },
  })
  if (params.action !== 'wait' && params.action !== 'cancel') {
    requestMissionTick(updated.id, `operator:${params.action}`, {
      reason: summaryReason,
    })
  }
  return { mission: updated, event }
}

export function ensureMissionForSchedule(
  schedule: Schedule,
  options?: {
    sessionId?: string | null
    runId?: string | null
  },
): Mission | null {
  if (!schedule?.id) return null
  const linked = loadMissionById(schedule.linkedMissionId)
  if (linked) return linked
  const objective = cleanText(schedule.taskPrompt, 300)
    || cleanText(schedule.message, 300)
    || cleanText(schedule.name, 300)
  if (!objective) return null
  const mission = createMission({
    source: 'schedule',
    sourceRef: {
      kind: 'schedule',
      scheduleId: schedule.id,
      recurring: schedule.scheduleType !== 'once',
    },
    objective,
    currentStep: cleanText(schedule.taskPrompt || schedule.message || schedule.name, 200) || null,
    plannerSummary: schedule.taskPrompt || schedule.message || schedule.name,
    sessionId: options?.sessionId || schedule.createdInSessionId || null,
    agentId: schedule.agentId,
    projectId: schedule.projectId || null,
    runId: options?.runId || null,
    sourceMessage: schedule.taskPrompt || schedule.message || schedule.name,
  })
  schedule.linkedMissionId = mission.id
  upsertSchedule(schedule.id, {
    ...schedule,
    linkedMissionId: mission.id,
  })
  return mission
}

export function noteScheduleMissionTriggered(
  schedule: Schedule,
  options?: {
    runId?: string | null
    taskId?: string | null
    wakeOnly?: boolean
    sessionId?: string | null
  },
): Mission | null {
  const mission = ensureMissionForSchedule(schedule, {
    sessionId: options?.sessionId || schedule.createdInSessionId || null,
    runId: options?.runId || null,
  })
  if (!mission) return null
  const updated = patchMissionStatus(mission.id, (current) => ({
    ...current,
    status: 'active',
    phase: options?.wakeOnly ? 'planning' : 'dispatching',
    currentStep: cleanText(schedule.taskPrompt || schedule.message || schedule.name, 200) || current.currentStep || null,
    controllerState: {
      ...(current.controllerState || {}),
      tickRequestedAt: now(),
      tickReason: options?.wakeOnly ? 'schedule_wake' : 'schedule_task',
      currentTaskId: options?.taskId || current.controllerState?.currentTaskId || null,
    },
  }))
  const sessionId = options?.sessionId || schedule.createdInSessionId || null
  if (updated && sessionId) bindMissionToSession(sessionId, updated.id)
  if (updated) {
    appendMissionEvent({
      missionId: updated.id,
      type: 'source_triggered',
      source: 'schedule',
      summary: options?.wakeOnly
        ? `Schedule wake fired: ${schedule.name}`
        : `Schedule task fired: ${schedule.name}`,
      sessionId,
      runId: options?.runId || null,
      taskId: options?.taskId || null,
      data: {
        scheduleId: schedule.id,
        wakeOnly: options?.wakeOnly === true,
      },
    })
  }
  return updated
}

export function ensureDelegationMission(input: {
  task: string
  backend?: DelegationJobRecord['backend']
  parentSessionId?: string | null
  childSessionId?: string | null
  agentId?: string | null
  parentMissionId?: string | null
  jobId?: string | null
}): Mission | null {
  const explicitParent = loadMissionById(input.parentMissionId)
  const sessionParent = input.parentSessionId ? getMissionForSession(loadSession(input.parentSessionId)) : null
  const parentMission = explicitParent || sessionParent
  if (!parentMission) return null
  const childSession = input.childSessionId ? loadSession(input.childSessionId) : null
  const existing = childSession?.missionId ? loadMissionById(childSession.missionId) : null
  if (existing && existing.parentMissionId === parentMission.id) return existing
  const childMission = createMission({
    source: 'delegation',
    sourceRef: {
      kind: 'delegation',
      parentMissionId: parentMission.id,
      backend: input.backend === 'codex' || input.backend === 'claude' || input.backend === 'opencode' || input.backend === 'gemini'
        ? input.backend
        : 'agent',
    },
    objective: cleanText(input.task, 300) || 'Delegated work',
    currentStep: cleanText(input.task, 200) || 'Execute delegated task',
    plannerSummary: cleanText(input.task, 320) || 'Execute delegated task',
    sessionId: input.childSessionId || input.parentSessionId || null,
    agentId: input.agentId || null,
    projectId: parentMission.projectId || null,
    sourceMessage: cleanText(input.task, 600) || null,
    parentMissionId: parentMission.id,
  })
  if (input.childSessionId) bindMissionToSession(input.childSessionId, childMission.id)
  return childMission
}

export function syncDelegationMissionFromJob(jobId: string): Mission | null {
  const job = loadDelegationJob(jobId)
  if (!job) return null
  const mission = loadMissionById(job.missionId) || ensureDelegationMission({
    task: job.task,
    backend: job.backend,
    parentSessionId: job.parentSessionId || null,
    childSessionId: job.childSessionId || null,
    agentId: job.agentId || null,
    parentMissionId: job.parentMissionId || null,
    jobId,
  })
  if (!mission) return null
  const status = job.status
  const updated = patchMissionStatus(mission.id, (current) => {
    if (status === 'queued' || status === 'running') {
      return {
        ...current,
        status: 'active',
        phase: 'executing',
        currentStep: cleanText(job.task, 200) || current.currentStep || null,
      }
    }
    if (status === 'completed') {
      return {
        ...current,
        status: 'completed',
        phase: 'completed',
        verifierSummary: cleanText(job.result || job.resultPreview, 320) || current.verifierSummary || null,
        completedAt: now(),
      }
    }
    if (status === 'failed') {
      return {
        ...current,
        status: 'failed',
        phase: 'failed',
        blockerSummary: cleanText(job.error, 240) || 'Delegation failed.',
        failedAt: now(),
      }
    }
    return {
      ...current,
      status: 'cancelled',
      phase: 'failed',
      cancelledAt: now(),
    }
  })
  if (updated && updated.parentMissionId && isMissionTerminal(updated.status)) noteParentMissionChildOutcome(updated)
  return updated
}

export function noteMissionTaskStarted(task: BoardTask, runId?: string | null): Mission | null {
  const mission = ensureMissionForTask(task, {
    source: missionSourceFromTask(task),
    runId: runId || null,
  })
  if (!mission) return null
  const updated = patchMissionStatus(mission.id, (current) => ({
    ...ensureMissionTaskLink(current, task.id),
    status: 'active',
    phase: 'executing',
    currentStep: cleanText(task.title, 200) || current.currentStep || null,
    controllerState: {
      ...(current.controllerState || {}),
      activeRunId: runId || current.controllerState?.activeRunId || null,
      currentTaskId: task.id,
      tickRequestedAt: now(),
      tickReason: 'task_started',
    },
  }))
  if (updated) {
    appendMissionEvent({
      missionId: updated.id,
      type: 'task_started',
      source: missionSourceFromTask(task),
      summary: `Task started: ${task.title}`,
      sessionId: task.sessionId || null,
      taskId: task.id,
      runId: runId || null,
      data: { taskStatus: task.status },
    })
  }
  return updated
}

export function noteMissionTaskFinished(task: BoardTask, status: 'completed' | 'failed' | 'cancelled', runId?: string | null): Mission | null {
  const mission = loadMissionById(task.missionId) || ensureMissionForTask(task, {
    source: missionSourceFromTask(task),
    runId: runId || null,
  })
  if (!mission) return null
  const summary = status === 'completed'
    ? `Task completed: ${task.title}`
    : status === 'cancelled'
      ? `Task cancelled: ${task.title}`
      : `Task failed: ${task.title}`
  const updated = patchMissionStatus(mission.id, (current) => {
    const linked = ensureMissionTaskLink(current, task.id)
    const taskSummaries = listTaskSummaries(linked.taskIds)
    const hasOpenTask = taskSummaries.some((row) => !['completed', 'failed', 'cancelled', 'archived'].includes(row.status))
    const hasFailedTask = taskSummaries.some((row) => row.status === 'failed')
    const allCancelled = taskSummaries.length > 0 && taskSummaries.every((row) => row.status === 'cancelled')
    const completedAt = !hasOpenTask && !hasFailedTask && status === 'completed'
      ? now()
      : current.completedAt || null
    const cancelledAt = allCancelled ? now() : current.cancelledAt || null
    return {
      ...linked,
      status: hasFailedTask
        ? 'waiting'
        : allCancelled
          ? 'cancelled'
          : hasOpenTask
            ? 'active'
            : 'completed',
      phase: hasFailedTask
        ? 'waiting'
        : allCancelled
          ? 'failed'
          : hasOpenTask
            ? 'planning'
            : 'completed',
      blockerSummary: status === 'failed' ? cleanText(task.error, 240) || summary : current.blockerSummary || null,
      waitState: status === 'failed'
        ? {
            kind: 'blocked_task',
            reason: cleanText(task.error, 220) || summary,
            dependencyTaskId: task.id,
          }
        : null,
      controllerState: {
        ...(current.controllerState || {}),
        activeRunId: null,
        currentTaskId: hasOpenTask ? current.controllerState?.currentTaskId || null : null,
        tickRequestedAt: now(),
        tickReason: status === 'completed' ? 'task_completed' : status === 'failed' ? 'task_failed' : 'task_cancelled',
      },
      completedAt,
      cancelledAt,
      failedAt: status === 'failed' ? now() : current.failedAt || null,
    }
  })
  if (updated) {
    appendMissionEvent({
      missionId: updated.id,
      type: status === 'completed' ? 'task_completed' : 'task_failed',
      source: missionSourceFromTask(task),
      summary,
      sessionId: task.sessionId || null,
      taskId: task.id,
      runId: runId || null,
      data: {
        taskStatus: status,
        result: cleanText(task.result, 280) || null,
        error: cleanText(task.error, 220) || null,
      },
    })
  }
  if (updated && !isMissionTerminal(updated.status)) {
    requestMissionTick(updated.id, status === 'completed' ? 'task_state_changed' : 'task_blocked', {
      taskId: task.id,
      taskStatus: status,
    })
  }
  wakeDependentMissions(task.id, 'task')
  return updated
}

export function buildMissionContextBlock(mission: Mission | null | undefined): string {
  if (!mission) return ''
  const summary = buildMissionSummary(mission)
  const linkedTasks = listTaskSummaries(summary.taskIds)
  const childMissions = listChildMissions(mission.id, 4)
  const taskBlock = linkedTasks.length > 0
    ? linkedTasks
      .slice(0, 6)
      .map((task) => {
        const base = `- [${task.status}] ${task.title}`
        if (task.status === 'completed' && task.result) {
          return `${base}: ${task.result.slice(0, 120)}`
        }
        return base
      })
      .join('\n')
    : ''
  const childBlock = childMissions.length > 0
    ? childMissions.map((child) => `- [${child.status}/${child.phase}] ${child.objective}`).join('\n')
    : ''
  return [
    '## Active Mission',
    `Objective: ${summary.objective}`,
    mission.successCriteria?.length ? `Success criteria: ${mission.successCriteria.join(' | ')}` : '',
    `Status: ${summary.status}`,
    `Phase: ${summary.phase}`,
    mission.sourceRef ? `Source: ${mission.sourceRef.kind}` : '',
    summary.currentStep ? `Current step: ${summary.currentStep}` : '',
    summary.waitingReason ? `Waiting reason: ${summary.waitingReason}` : '',
    mission.plannerSummary ? `Planner summary: ${mission.plannerSummary}` : '',
    mission.verifierSummary ? `Verifier summary: ${mission.verifierSummary}` : '',
    mission.verificationState?.candidate ? 'Verification candidate: true' : '',
    taskBlock ? `Linked tasks:\n${taskBlock}` : '',
    childBlock ? `Child missions:\n${childBlock}` : '',
    'Advance the mission. Do not confuse planning, promises, or partial progress with completion.',
  ].filter(Boolean).join('\n')
}

export function buildMissionHeartbeatPrompt(session: Session, fallbackPrompt: string): string | null {
  const mission = getMissionForSession(session)
  if (!mission || isMissionTerminal(mission.status)) return null
  const contextBlock = buildExecutionBriefContextBlock(buildExecutionBrief({
    session,
    mission,
  }))
  return [
    'MAIN_AGENT_HEARTBEAT_TICK',
    `Time: ${new Date().toISOString()}`,
    contextBlock,
    fallbackPrompt ? `Base heartbeat instructions:\n${fallbackPrompt}` : '',
    '',
    'You are checking the durable mission state for this agent.',
    'Take the single highest-value next step for the mission.',
    'If the mission is genuinely waiting on an external dependency, say so plainly.',
    'Reply HEARTBEAT_OK only when the mission is completed or waiting and no immediate action should be taken.',
  ].filter(Boolean).join('\n')
}
