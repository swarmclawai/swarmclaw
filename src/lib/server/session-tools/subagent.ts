import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import {
  cancelDelegationJob,
  getDelegationJob,
  listDelegationJobs,
  recoverStaleDelegationJobs,
} from '../delegation-jobs'
import {
  spawnSubagent,
  getHandle,
  getLineageNodeBySession,
  getAncestors,
  getChildren,
  buildLineageTree,
  cancelSubagentBySession,
} from '../subagent-runtime'
import {
  spawnSwarm,
  getSwarm,
  getSwarmSnapshot,
  listSwarms,
  aggregateResults,
  waitForAll,
} from '../subagent-swarm'

export function resolveSubagentBrowserProfileId(
  parentSession: Record<string, unknown> | null | undefined,
  childSessionId: string,
  shareBrowserProfile: boolean,
): string {
  if (!shareBrowserProfile) return childSessionId
  const inherited = typeof parentSession?.browserProfileId === 'string' && parentSession.browserProfileId.trim()
    ? parentSession.browserProfileId.trim()
    : typeof parentSession?.id === 'string' && parentSession.id.trim()
      ? parentSession.id.trim()
      : ''
  return inherited || childSessionId
}

// ---------------------------------------------------------------------------
// Action context & helpers
// ---------------------------------------------------------------------------

interface ActionContext {
  sessionId?: string
  cwd: string
}

function requireString(args: Record<string, unknown>, key: string): string {
  const val = typeof args[key] === 'string' ? (args[key] as string).trim() : ''
  if (!val) throw new Error(`${key} is required.`)
  return val
}

// ---------------------------------------------------------------------------
// Promise-based wait (no polling when handle exists)
// ---------------------------------------------------------------------------

async function waitForJob(jobId: string, timeoutSec = 30): Promise<string> {
  const timeoutMs = Math.max(1, timeoutSec) * 1000

  // Try handle-based wait first (instant if already resolved)
  const handle = getHandle(jobId)
  if (handle) {
    const result = await Promise.race([
      handle.promise,
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ])
    if (result) return JSON.stringify(result)
    // Timed out — return current job state with explicit timeout indicator
    const job = getDelegationJob(jobId)
    if (job) return JSON.stringify({ ...job, _timedOut: true })
    return `Error: delegation job "${jobId}" not found.`
  }

  // Legacy fallback: poll delegation job store
  const timeoutAt = Date.now() + timeoutMs
  while (Date.now() < timeoutAt) {
    const job = getDelegationJob(jobId)
    if (!job) return `Error: delegation job "${jobId}" not found.`
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return JSON.stringify(job)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const latest = getDelegationJob(jobId)
  return latest ? JSON.stringify(latest) : `Error: delegation job "${jobId}" not found.`
}

// ---------------------------------------------------------------------------
// Action handlers (dispatch map)
// ---------------------------------------------------------------------------

async function handleStatus(args: Record<string, unknown>): Promise<string> {
  const jobId = requireString(args, 'jobId')
  const job = getDelegationJob(jobId)
  if (!job) return `Error: delegation job "${jobId}" not found.`
  const lineage = job.childSessionId ? getLineageNodeBySession(job.childSessionId) : null
  return JSON.stringify({
    ...job,
    lineage: lineage ? {
      id: lineage.id,
      depth: lineage.depth,
      status: lineage.status,
      parentSessionId: lineage.parentSessionId,
      childCount: getChildren(lineage.id).length,
      ancestors: getAncestors(lineage.id).map((a) => ({ id: a.id, agentName: a.agentName, depth: a.depth })),
    } : null,
  })
}

function handleList(_args: Record<string, unknown>, ctx: ActionContext): string {
  return JSON.stringify(listDelegationJobs({ parentSessionId: ctx.sessionId || null }))
}

function handleCancel(args: Record<string, unknown>): string {
  const jobId = requireString(args, 'jobId')
  const job = getDelegationJob(jobId)
  if (!job) return `Error: delegation job "${jobId}" not found.`
  if (job.childSessionId) cancelSubagentBySession(job.childSessionId)
  const cancelled = cancelDelegationJob(jobId)
  return cancelled ? JSON.stringify(cancelled) : `Error: delegation job "${jobId}" not found.`
}

async function handleWait(args: Record<string, unknown>): Promise<string> {
  const jobId = requireString(args, 'jobId')
  const timeoutSec = typeof args.timeoutSec === 'number' ? args.timeoutSec : 30
  return waitForJob(jobId, timeoutSec)
}

function handleLineage(args: Record<string, unknown>, ctx: ActionContext): string {
  const targetSessionId = (args.sessionId as string) || ctx.sessionId
  if (!targetSessionId) return 'Error: sessionId is required for lineage query.'
  const node = getLineageNodeBySession(targetSessionId)
  if (!node) return JSON.stringify({ lineage: null })
  const tree = buildLineageTree(node.id)
  return JSON.stringify({ lineage: tree })
}

async function handleBatch(args: Record<string, unknown>, ctx: ActionContext): Promise<string> {
  const tasks = args.tasks as Array<{ agentId: string; message: string; cwd?: string; shareBrowserProfile?: boolean }> | undefined
  if (!Array.isArray(tasks) || tasks.length === 0) return 'Error: tasks array is required for batch action.'
  for (const t of tasks) {
    if (!t.agentId || !t.message) return 'Error: each task requires agentId and message.'
  }
  const waitForCompletion = args.waitForCompletion !== false && args.background !== true

  // Use spawnSwarm internally — batch is a simplified interface
  const swarm = spawnSwarm({ tasks }, { sessionId: ctx.sessionId, cwd: ctx.cwd })
  const jobIds = swarm.members
    .filter((m) => !m.spawnError && m.handle)
    .map((m) => m.handle.jobId)

  if (!waitForCompletion) {
    return JSON.stringify({
      action: 'batch',
      status: 'running',
      jobIds,
      taskCount: tasks.length,
    })
  }
  const aggregate = await swarm.allSettled
  return JSON.stringify({
    action: 'batch',
    status: 'completed',
    jobIds,
    completed: aggregate.totalCompleted,
    failed: aggregate.totalFailed + aggregate.totalSpawnErrors,
    cancelled: aggregate.totalCancelled,
    timedOut: 0,
    totalDurationMs: aggregate.durationMs,
    results: aggregate.results.map((r) => ({
      jobId: r.jobId,
      agentName: r.agentName,
      status: r.status === 'spawn_error' ? 'failed' : r.status,
      response: r.response?.slice(0, 2000) || null,
      error: r.error,
    })),
  })
}

async function handleAggregate(args: Record<string, unknown>): Promise<string> {
  const jobIds = args.jobIds as string[] | undefined
  if (!Array.isArray(jobIds) || jobIds.length === 0) return 'Error: jobIds array is required for aggregate action.'
  return JSON.stringify(aggregateResults(jobIds))
}

async function handleWaitAll(args: Record<string, unknown>): Promise<string> {
  const jobIds = args.jobIds as string[] | undefined
  if (!Array.isArray(jobIds) || jobIds.length === 0) return 'Error: jobIds array is required for wait_all action.'
  const timeoutSec = typeof args.timeoutSec === 'number' ? args.timeoutSec : 300
  const agg = await waitForAll(jobIds, timeoutSec)
  return JSON.stringify(agg)
}

async function handleSwarm(args: Record<string, unknown>, ctx: ActionContext): Promise<string> {
  const tasks = args.tasks as Array<{ agentId: string; message: string; cwd?: string; shareBrowserProfile?: boolean }> | undefined
  if (!Array.isArray(tasks) || tasks.length === 0) return 'Error: tasks array is required for swarm action.'
  for (const t of tasks) {
    if (!t.agentId || !t.message) return 'Error: each task requires agentId and message.'
  }
  const waitForCompletion = args.waitForCompletion !== false && args.background !== true

  const swarm = spawnSwarm({ tasks }, { sessionId: ctx.sessionId, cwd: ctx.cwd })
  if (!waitForCompletion) {
    const snapshot = getSwarmSnapshot(swarm.swarmId)
    return JSON.stringify({
      action: 'swarm',
      status: 'running',
      swarmId: swarm.swarmId,
      memberCount: swarm.members.length,
      snapshot,
    })
  }
  const aggregate = await swarm.allSettled
  const snapshot = getSwarmSnapshot(swarm.swarmId)
  return JSON.stringify({
    action: 'swarm',
    ...aggregate,
    status: swarm.status,
    snapshot,
  })
}

function handleSwarmStatus(args: Record<string, unknown>): string {
  const swarmId = requireString(args, 'swarmId')
  const snapshot = getSwarmSnapshot(swarmId)
  if (!snapshot) return `Error: swarm "${swarmId}" not found.`
  return JSON.stringify(snapshot)
}

function handleSwarmList(_args: Record<string, unknown>, ctx: ActionContext): string {
  const swarms = listSwarms(ctx.sessionId)
  return JSON.stringify(swarms.map((s) => ({
    swarmId: s.swarmId,
    status: s.status,
    memberCount: s.members.length,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
  })))
}

function handleSwarmCancel(args: Record<string, unknown>): string {
  const swarmId = requireString(args, 'swarmId')
  const swarm = getSwarm(swarmId)
  if (!swarm) return `Error: swarm "${swarmId}" not found.`
  swarm.cancelAll()
  const snapshot = getSwarmSnapshot(swarmId)
  return JSON.stringify({ cancelled: true, snapshot })
}

async function handleStart(args: Record<string, unknown>, ctx: ActionContext): Promise<string> {
  const agentId = (args.agentId ?? args.agent_id) as string | undefined
  const message = args.message as string | undefined
  if (!agentId) return 'Error: agentId is required.'
  if (!message) return 'Error: message is required.'

  const cwd = args.cwd as string | undefined
  const shareBrowserProfile = args.shareBrowserProfile === true || args.share_browser_profile === true
  const waitForCompletion = args.waitForCompletion !== false && args.background !== true

  const handle = spawnSubagent(
    { agentId, message, cwd, shareBrowserProfile, waitForCompletion },
    { sessionId: ctx.sessionId, cwd: ctx.cwd },
  )

  if (!waitForCompletion) {
    return JSON.stringify({
      jobId: handle.jobId,
      status: 'running',
      agentId: handle.agentId,
      agentName: handle.agentName,
      sessionId: handle.sessionId,
      lineageId: handle.lineageId,
    })
  }

  const result = await handle.promise
  return JSON.stringify({
    jobId: result.jobId,
    status: result.status,
    agentId: result.agentId,
    agentName: result.agentName,
    sessionId: result.sessionId,
    lineageId: result.lineageId,
    response: result.response,
    depth: result.depth,
    childCount: result.childCount,
    durationMs: result.durationMs,
  })
}

// ---------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------

type ActionHandler = (args: Record<string, unknown>, ctx: ActionContext) => Promise<string> | string
const ACTIONS: Record<string, ActionHandler> = {
  status: handleStatus,
  list: handleList,
  cancel: handleCancel,
  wait: handleWait,
  lineage: handleLineage,
  batch: handleBatch,
  aggregate: handleAggregate,
  wait_all: handleWaitAll,
  swarm: handleSwarm,
  swarm_status: handleSwarmStatus,
  swarm_list: handleSwarmList,
  swarm_cancel: handleSwarmCancel,
}

/**
 * Core Subagent Execution Logic — powered by native subagent runtime.
 * Uses dispatch map instead of if-else chain for maintainability.
 */
async function executeSubagentAction(args: unknown, context: ActionContext) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = String(normalized.action || 'start').trim().toLowerCase()

  recoverStaleDelegationJobs()

  try {
    const handler = ACTIONS[action]
    if (handler) return handler(normalized, context)
    // Default: single agent spawn
    return handleStart(normalized, context)
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const SubagentPlugin: Plugin = {
  name: 'Core Subagents',
  description: 'Delegate tasks to other specialized agents with resumable job handles.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'spawn_subagent',
      description: 'Delegate tasks to other agents with native execution and lineage tracking. Actions: start (single), batch (simple parallel), swarm (event-driven parallel with callbacks), swarm_status, swarm_list, swarm_cancel, status, list, wait, wait_all, cancel, lineage, aggregate.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'status', 'list', 'wait', 'wait_all', 'cancel', 'lineage', 'batch', 'aggregate', 'swarm', 'swarm_status', 'swarm_list', 'swarm_cancel'] },
          agentId: { type: 'string' },
          message: { type: 'string' },
          cwd: { type: 'string' },
          shareBrowserProfile: {
            type: 'boolean',
            description: 'When true, inherit the parent session browser profile. Defaults to false so subagents get isolated browser state.',
          },
          jobId: { type: 'string' },
          swarmId: { type: 'string', description: 'Swarm ID for swarm_status/swarm_cancel actions.' },
          jobIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of job IDs for aggregate/wait_all actions.',
          },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                agentId: { type: 'string' },
                message: { type: 'string' },
                cwd: { type: 'string' },
                shareBrowserProfile: { type: 'boolean' },
              },
              required: ['agentId', 'message'],
            },
            description: 'Array of tasks for batch/swarm action.',
          },
          waitForCompletion: { type: 'boolean' },
          background: { type: 'boolean' },
          timeoutSec: { type: 'number' },
        },
        required: []
      },
      execute: async (args, context) => executeSubagentAction(args, { sessionId: context.session.id, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('subagent', SubagentPlugin)

/**
 * Legacy Bridge
 */
export function buildSubagentTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('spawn_subagent')) return []
  return [
    tool(
      async (args) => executeSubagentAction(args, { sessionId: bctx.ctx?.sessionId || undefined, cwd: bctx.cwd }),
      {
        name: 'spawn_subagent',
        description: SubagentPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
