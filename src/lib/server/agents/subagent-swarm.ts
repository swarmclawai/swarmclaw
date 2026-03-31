/**
 * Subagent Swarm — Parallel Spawn & Result Aggregation
 *
 * Unified module for spawning multiple subagents in parallel and collecting
 * their results. Supports both event-driven (swarm) and poll-based (aggregate)
 * result collection patterns.
 *
 * Replaces the separate subagent-batch module — batch operations are now
 * thin wrappers over spawnSwarm.
 */

import { genId } from '@/lib/id'
import { errorMessage, hmrSingleton, sleep } from '@/lib/shared-utils'
import { log } from '@/lib/server/logger'
import { logExecution } from '@/lib/server/execution-log'
import { logActivity } from '@/lib/server/activity/activity-log'
import { createNotification } from '@/lib/server/create-notification'
import { notify } from '@/lib/server/ws-hub'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import {
  spawnSubagent,
  type SubagentContext,
  type SubagentHandle,
  type SubagentResult,
} from '@/lib/server/agents/subagent-runtime'
import { getDelegationJob } from '@/lib/server/agents/delegation-jobs'
import {
  getLineageNode,
  cancelLineageNode,
  type SubagentState,
} from '@/lib/server/agents/subagent-lineage'
import { loadSessions } from '@/lib/server/sessions/session-repository'
import type { Agent } from '@/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwarmStatus = 'spawning' | 'running' | 'completed' | 'partial' | 'failed' | 'lost'

export interface SwarmMember {
  /** Position in the spawn order */
  index: number
  /** Agent handle from spawnSubagent */
  handle: SubagentHandle
  /** Result (populated when the agent completes) */
  result: SubagentResult | null
  /** Error if spawn itself failed (before execution) */
  spawnError: string | null
}

export interface SwarmHandle {
  /** Unique swarm ID */
  swarmId: string
  /** Session that spawned this swarm */
  parentSessionId: string | null
  /** All members (spawned or failed-to-spawn) */
  members: SwarmMember[]
  /** Swarm-level status */
  status: SwarmStatus
  /** When the swarm was created */
  createdAt: number
  /** When all members finished (null if still running) */
  completedAt: number | null
  /** Promise that resolves when ALL members complete */
  allSettled: Promise<SwarmAggregateResult>
  /** Promise that resolves when the FIRST member completes */
  firstSettled: Promise<{ index: number; result: SubagentResult }>
  /** Cancel all running members */
  cancelAll: () => void
}

export interface SwarmAggregateResult {
  swarmId: string
  parentSessionId: string | null
  totalSpawned: number
  totalCompleted: number
  totalFailed: number
  totalCancelled: number
  totalSpawnErrors: number
  durationMs: number
  results: Array<{
    index: number
    agentId: string
    agentName: string
    jobId: string
    sessionId: string
    status: SubagentResult['status'] | 'spawn_error'
    response: string | null
    error: string | null
    durationMs: number
  }>
}

export interface BatchSpawnInput {
  /** Tasks to spawn — each gets its own subagent */
  tasks: Array<{
    agentId: string
    message: string
    cwd?: string
    shareBrowserProfile?: boolean
  }>
  /** Optional swarm-level label */
  label?: string
  /** Callback when each member completes */
  onMemberComplete?: (member: SwarmMember, swarm: SwarmHandle) => void
  /** Callback when all members complete */
  onSwarmComplete?: (result: SwarmAggregateResult) => void
  /** Execution mode for sibling subagents. Auto defaults to serial for Ollama-backed targets. */
  executionMode?: 'auto' | 'parallel' | 'serial'
}

// ---------------------------------------------------------------------------
// Batch types (absorbed from subagent-batch)
// ---------------------------------------------------------------------------

export interface BatchTask {
  agentId: string
  message: string
  cwd?: string
  shareBrowserProfile?: boolean
}

export function _resolveSwarmExecutionMode(
  tasks: BatchTask[],
  executionMode: BatchSpawnInput['executionMode'],
  agents = loadAgents() as Record<string, Agent>,
): 'parallel' | 'serial' {
  if (executionMode === 'parallel' || executionMode === 'serial') return executionMode
  const hasOllamaTarget = tasks.some((task) => agents[task.agentId]?.provider === 'ollama')
  return hasOllamaTarget ? 'serial' : 'parallel'
}

export interface AggregatedResult {
  results: Array<{
    jobId: string
    status: string
    response: string | null
    error: string | null
    agentName: string | null
  }>
  pending: string[]
  allCompleted: boolean
  completed: number
  failed: number
  cancelled: number
  total: number
}

// ---------------------------------------------------------------------------
// Storage (globalThis-scoped for HMR safety)
// ---------------------------------------------------------------------------

const swarmRegistry = hmrSingleton('__swarmclaw_swarm_registry__', () => new Map<string, SwarmHandle>())

function notifySwarmChanged() {
  notify('swarm_status')
}

function persistSwarmSnapshot(swarm: SwarmHandle): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { upsertStoredItem } = require('../storage')
    upsertStoredItem('swarm_snapshots', swarm.swarmId, {
      swarmId: swarm.swarmId,
      parentSessionId: swarm.parentSessionId,
      status: swarm.status,
      memberCount: swarm.members.length,
      createdAt: swarm.createdAt,
      completedAt: swarm.completedAt,
      updatedAt: Date.now(),
    })
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Core: Spawn Swarm
// ---------------------------------------------------------------------------

/**
 * Spawn multiple subagents in parallel. Returns immediately with handles
 * for all agents. Each agent runs with waitForCompletion: false.
 *
 * Usage:
 *   const swarm = spawnSwarm({
 *     tasks: [
 *       { agentId: 'researcher', message: 'Find API docs' },
 *       { agentId: 'coder', message: 'Scaffold the module' },
 *     ],
 *   }, { sessionId: parentSession, cwd: '/workspace' })
 *
 *   const aggregate = await swarm.allSettled
 */
export async function spawnSwarm(
  input: BatchSpawnInput,
  context: SubagentContext,
): Promise<SwarmHandle> {
  const swarmId = genId(10)
  const createdAt = Date.now()
  const members: SwarmMember[] = []
  const executionMode = _resolveSwarmExecutionMode(input.tasks, input.executionMode)
  const executionGroupKey = executionMode === 'serial'
    ? `swarm:${context.sessionId || 'root'}:${swarmId}`
    : undefined

  // Pre-load sessions once for all spawns (avoids N SQLite reads)
  const cachedSessions = context._sessions ?? loadSessions()
  const cachedContext: SubagentContext = { ...context, _sessions: cachedSessions }

  // Spawn all agents — failures are captured per-member, not thrown
  let spawnErrorCount = 0
  for (let i = 0; i < input.tasks.length; i++) {
    const task = input.tasks[i]
    try {
      const handle = await spawnSubagent(
        {
          agentId: task.agentId,
          message: task.message,
          cwd: task.cwd,
          shareBrowserProfile: task.shareBrowserProfile,
          waitForCompletion: false,
          executionGroupKey,
        },
        cachedContext,
      )
      members.push({ index: i, handle, result: null, spawnError: null })
    } catch (err: unknown) {
      spawnErrorCount++
      const errMsg = errorMessage(err)
      log.warn('swarm', 'Member spawn failed', { swarmId, index: i, agentId: task.agentId, error: errMsg })
      members.push({
        index: i,
        handle: null as unknown as SubagentHandle,
        result: null,
        spawnError: errMsg,
      })
    }
  }

  // Incremental counters — O(1) per completion instead of O(n)
  const counters = { completed: 0, failed: 0, cancelled: 0 }

  // Track completion per member
  const memberPromises: Promise<{ index: number; result: SubagentResult }>[] = []

  const swarm: SwarmHandle = {
    swarmId,
    parentSessionId: context.sessionId || null,
    members,
    status: 'running',
    createdAt,
    completedAt: null,
    allSettled: null as unknown as Promise<SwarmAggregateResult>,
    firstSettled: null as unknown as Promise<{ index: number; result: SubagentResult }>,
    cancelAll: () => {
      for (const member of members) {
        if (member.handle && !member.result && !member.spawnError) {
          try {
            member.handle.run.abort()
            cancelLineageNode(member.handle.lineageId)
          } catch { /* best-effort */ }
        }
      }
      swarm.status = 'failed'
      notifySwarmChanged()
      persistSwarmSnapshot(swarm)
    },
  }

  for (const member of members) {
    if (member.spawnError || !member.handle) continue

    const memberPromise = member.handle.promise.then((result) => {
      member.result = result

      // Increment counters
      if (result.status === 'completed') counters.completed++
      else if (result.status === 'failed' || result.status === 'timed_out') counters.failed++
      else if (result.status === 'cancelled') counters.cancelled++

      if (input.onMemberComplete) {
        try { input.onMemberComplete(member, swarm) } catch { /* callback errors don't break the swarm */ }
      }

      // Update swarm status using counters (O(1))
      updateSwarmStatus(swarm, counters, spawnErrorCount)
      notifySwarmChanged()
      persistSwarmSnapshot(swarm)

      return { index: member.index, result }
    })

    memberPromises.push(memberPromise)
  }

  // allSettled — resolves when every member is done (or had a spawn error)
  swarm.allSettled = Promise.allSettled(memberPromises).then(() => {
    swarm.completedAt = Date.now()
    updateSwarmStatus(swarm, counters, spawnErrorCount)
    const aggregate = buildAggregateResult(swarm)
    if (input.onSwarmComplete) {
      try { input.onSwarmComplete(aggregate) } catch { /* callback errors don't break */ }
    }
    notifySwarmChanged()
    persistSwarmSnapshot(swarm)
    return aggregate
  })

  // firstSettled — resolves when the first member completes
  swarm.firstSettled = memberPromises.length > 0
    ? Promise.race(memberPromises)
    : swarm.allSettled.then((agg) => {
        // All members had spawn errors — return first spawn error entry
        const first = agg.results[0]
        return {
          index: first?.index ?? -1,
          result: {
            jobId: first?.jobId ?? '',
            sessionId: first?.sessionId ?? '',
            lineageId: '',
            agentId: first?.agentId ?? '',
            agentName: first?.agentName ?? '',
            status: 'failed' as const,
            response: null,
            error: first?.error ?? 'No members spawned',
            depth: 0,
            parentSessionId: context.sessionId || null,
            childCount: 0,
            durationMs: 0,
          } satisfies SubagentResult,
        }
      })

  // Register in swarm registry
  swarmRegistry.set(swarmId, swarm)
  notifySwarmChanged()
  persistSwarmSnapshot(swarm)

  const sid = context.sessionId || ''
  log.info('swarm', 'Spawned', { swarmId, taskCount: input.tasks.length, mode: executionMode, spawnErrors: spawnErrorCount })
  logExecution(sid, 'swarm_spawn', `Swarm spawned: ${input.tasks.length} members (${executionMode})`, {
    detail: { swarmId, taskCount: input.tasks.length, mode: executionMode, spawnErrors: spawnErrorCount },
  })
  logActivity({
    entityType: 'swarm',
    entityId: swarmId,
    action: 'spawned',
    actor: 'agent',
    summary: `Swarm spawned: ${input.tasks.length} members (${executionMode})`,
  })

  // Wire up completion logging
  swarm.allSettled.then((aggregate) => {
    const status = aggregate.totalFailed + aggregate.totalSpawnErrors === aggregate.totalSpawned ? 'failed' : 'completed'
    const durationMs = aggregate.durationMs
    log.info('swarm', 'Completed', { swarmId, status, durationMs, completed: aggregate.totalCompleted, failed: aggregate.totalFailed })
    logExecution(sid, 'swarm_complete', `Swarm ${status}: ${aggregate.totalCompleted}/${aggregate.totalSpawned} succeeded`, {
      detail: { swarmId, status, durationMs, totalCompleted: aggregate.totalCompleted, totalFailed: aggregate.totalFailed, totalSpawned: aggregate.totalSpawned },
    })
    logActivity({
      entityType: 'swarm',
      entityId: swarmId,
      action: status === 'failed' ? 'failed' : 'completed',
      actor: 'agent',
      summary: `Swarm ${status}: ${aggregate.totalCompleted}/${aggregate.totalSpawned} succeeded in ${Math.round(durationMs / 1000)}s`,
    })
    if (status === 'failed') {
      createNotification({
        type: 'error',
        title: 'Swarm failed',
        message: `All ${aggregate.totalSpawned} members failed`,
        entityType: 'swarm',
        entityId: swarmId,
        dedupKey: `swarm_fail:${swarmId}`,
      })
    }
  }).catch(() => { /* swarm allSettled should not throw, but guard anyway */ })

  return swarm
}

// ---------------------------------------------------------------------------
// Status computation (O(1) with incremental counters)
// ---------------------------------------------------------------------------

function updateSwarmStatus(
  swarm: SwarmHandle,
  counters: { completed: number; failed: number; cancelled: number },
  spawnErrors: number,
): void {
  const total = swarm.members.length
  const settled = spawnErrors + counters.completed + counters.failed + counters.cancelled

  if (settled >= total) {
    if (counters.failed + spawnErrors === total) {
      swarm.status = 'failed'
    } else if (counters.completed === total) {
      swarm.status = 'completed'
    } else {
      swarm.status = 'partial'
    }
  } else {
    swarm.status = 'running'
  }
}

// ---------------------------------------------------------------------------
// Result aggregation
// ---------------------------------------------------------------------------

function buildAggregateResult(swarm: SwarmHandle): SwarmAggregateResult {
  const results = swarm.members.map((member) => {
    if (member.spawnError) {
      return {
        index: member.index,
        agentId: '',
        agentName: '',
        jobId: '',
        sessionId: '',
        status: 'spawn_error' as const,
        response: null,
        error: member.spawnError,
        durationMs: 0,
      }
    }
    const r = member.result
    return {
      index: member.index,
      agentId: r?.agentId || member.handle?.agentId || '',
      agentName: r?.agentName || member.handle?.agentName || '',
      jobId: r?.jobId || member.handle?.jobId || '',
      sessionId: r?.sessionId || member.handle?.sessionId || '',
      status: r?.status || 'failed' as SubagentResult['status'],
      response: r?.response || null,
      error: r?.error || null,
      durationMs: r?.durationMs || 0,
    }
  })

  return {
    swarmId: swarm.swarmId,
    parentSessionId: swarm.parentSessionId,
    totalSpawned: swarm.members.length,
    totalCompleted: results.filter((r) => r.status === 'completed').length,
    totalFailed: results.filter((r) => r.status === 'failed' || r.status === 'timed_out').length,
    totalCancelled: results.filter((r) => r.status === 'cancelled').length,
    totalSpawnErrors: results.filter((r) => r.status === 'spawn_error').length,
    durationMs: (swarm.completedAt || Date.now()) - swarm.createdAt,
    results,
  }
}

// ---------------------------------------------------------------------------
// Delegation job polling (absorbed from subagent-batch)
// ---------------------------------------------------------------------------

/**
 * Poll delegation jobs for instant snapshot of results.
 * Useful when the caller only has job IDs (no SwarmHandle).
 */
export function aggregateResults(jobIds: string[]): AggregatedResult {
  const results: AggregatedResult['results'] = []
  const pending: string[] = []
  let completed = 0
  let failed = 0
  let cancelled = 0

  for (const jobId of jobIds) {
    const job = getDelegationJob(jobId)
    if (!job) {
      results.push({
        jobId,
        status: 'not_found',
        response: null,
        error: `Job "${jobId}" not found`,
        agentName: null,
      })
      failed++
      continue
    }

    results.push({
      jobId,
      status: job.status,
      response: job.resultPreview || job.result || null,
      error: job.error || null,
      agentName: job.agentName || null,
    })

    if (job.status === 'completed') completed++
    else if (job.status === 'failed') failed++
    else if (job.status === 'cancelled') cancelled++
    else pending.push(jobId)
  }

  return {
    results,
    pending,
    allCompleted: pending.length === 0,
    completed,
    failed,
    cancelled,
    total: jobIds.length,
  }
}

/**
 * Wait for multiple jobs to complete (poll-based with timeout).
 */
export async function waitForAll(
  jobIds: string[],
  timeoutSec = 300,
): Promise<AggregatedResult> {
  const timeoutAt = Date.now() + Math.max(1, timeoutSec) * 1000
  const pollIntervalMs = 1000

  while (Date.now() < timeoutAt) {
    const snapshot = aggregateResults(jobIds)
    if (snapshot.allCompleted) return snapshot
    await sleep(pollIntervalMs)
  }

  // Final snapshot after timeout
  return aggregateResults(jobIds)
}

// ---------------------------------------------------------------------------
// Query API (for UI / session tools)
// ---------------------------------------------------------------------------

export function getSwarm(swarmId: string): SwarmHandle | null {
  return swarmRegistry.get(swarmId) || null
}

export function listSwarms(parentSessionId?: string): SwarmHandle[] {
  const all = Array.from(swarmRegistry.values())
  if (parentSessionId) {
    return all.filter((s) => s.parentSessionId === parentSessionId)
  }
  return all
}

/**
 * Get a serializable snapshot of a swarm's current state.
 * Used by the UI to render SwarmStatusCard.
 */
export function getSwarmSnapshot(swarmId: string): SwarmSnapshot | null {
  const swarm = swarmRegistry.get(swarmId)
  if (swarm) return buildSwarmSnapshot(swarm)
  // Fallback to persisted store for swarms from previous process lifetimes
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadStoredItem } = require('../storage')
    const persisted = loadStoredItem('swarm_snapshots', swarmId)
    return persisted ? (persisted as SwarmSnapshot) : null
  } catch { return null }
}

export interface SwarmMemberSnapshot {
  index: number
  agentId: string
  agentName: string
  jobId: string
  sessionId: string
  task: string
  status: SubagentState | 'spawn_error'
  resultPreview: string | null
  error: string | null
  durationMs: number
}

export interface SwarmSnapshot {
  swarmId: string
  parentSessionId: string | null
  status: SwarmStatus
  createdAt: number
  completedAt: number | null
  memberCount: number
  completedCount: number
  failedCount: number
  members: SwarmMemberSnapshot[]
}

function buildSwarmSnapshot(swarm: SwarmHandle): SwarmSnapshot {
  const members: SwarmMemberSnapshot[] = swarm.members.map((m) => {
    if (m.spawnError || !m.handle) {
      return {
        index: m.index,
        agentId: '',
        agentName: '',
        jobId: '',
        sessionId: '',
        task: '',
        status: 'spawn_error' as const,
        resultPreview: null,
        error: m.spawnError || 'Spawn failed (no handle)',
        durationMs: 0,
      }
    }
    // Read state from lineage node (single source of truth) with fallbacks
    const node = getLineageNode(m.handle.lineageId)
    const status = m.result?.status ?? node?.status ?? 'running'
    return {
      index: m.index,
      agentId: m.handle.agentId,
      agentName: m.handle.agentName,
      jobId: m.handle.jobId,
      sessionId: m.handle.sessionId,
      task: getDelegationJob(m.handle.jobId)?.task || '',
      status,
      resultPreview: m.result?.response?.slice(0, 500) || null,
      error: m.result?.error || null,
      durationMs: m.result?.durationMs || (Date.now() - swarm.createdAt),
    }
  })

  return {
    swarmId: swarm.swarmId,
    parentSessionId: swarm.parentSessionId,
    status: swarm.status,
    createdAt: swarm.createdAt,
    completedAt: swarm.completedAt,
    memberCount: members.length,
    completedCount: members.filter((m) => m.status === 'completed').length,
    failedCount: members.filter((m) =>
      m.status === 'failed' || m.status === 'timed_out' || m.status === 'spawn_error',
    ).length,
    members,
  }
}

// ---------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------

/**
 * On daemon startup, scan persisted swarm snapshots and mark any that were
 * still running/spawning as "lost" — they cannot be resumed after a restart.
 * Returns the number of swarms marked lost.
 */
export function restoreSwarmRegistry(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadCollection, upsertStoredItem } = require('../storage')
    const persisted = loadCollection('swarm_snapshots') as Record<string, SwarmSnapshot>
    let lost = 0
    for (const [id, record] of Object.entries(persisted)) {
      if (swarmRegistry.has(id)) continue
      if (record.status === 'running' || record.status === 'spawning') {
        record.status = 'lost'
        record.completedAt = record.completedAt || Date.now()
        upsertStoredItem('swarm_snapshots', id, record)
        lost++
      }
    }
    return lost
  } catch { return 0 }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function removeSwarm(swarmId: string): boolean {
  return swarmRegistry.delete(swarmId)
}

export function cleanupFinishedSwarms(maxAgeMs = 60 * 60_000): number {
  const threshold = Date.now() - maxAgeMs
  let cleaned = 0
  for (const [id, swarm] of swarmRegistry.entries()) {
    if (swarm.completedAt && swarm.completedAt < threshold) {
      swarmRegistry.delete(id)
      cleaned++
    }
  }
  return cleaned
}

/** For tests only */
export function _clearSwarmRegistry(): void {
  swarmRegistry.clear()
}
