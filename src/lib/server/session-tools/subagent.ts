import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage, sleep } from '@/lib/shared-utils'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { classifyMessage } from '@/lib/server/chat-execution/message-classifier'
import {
  buildDelegationTaskProfile,
  resolveBestDelegateTarget,
  type DelegationWorkType,
} from '@/lib/server/agents/delegation-advisory'
import {
  cancelDelegationJob,
  getDelegationJob,
  listDelegationJobs,
  recoverStaleDelegationJobs,
} from '@/lib/server/agents/delegation-jobs'
import {
  spawnSubagent,
  getHandle,
  getLineageNodeBySession,
  getAncestors,
  getChildren,
  buildLineageTree,
  cancelSubagentBySession,
} from '@/lib/server/agents/subagent-runtime'
import {
  spawnSwarm,
  getSwarm,
  getSwarmSnapshot,
  listSwarms,
  aggregateResults,
  waitForAll,
  SWARM_MAX_CONCURRENCY_HARD_LIMIT,
  SWARM_DEFAULT_PARALLEL_CONCURRENCY,
} from '@/lib/server/agents/subagent-swarm'
import { getSession } from '@/lib/server/sessions/session-repository'
import { getMission } from '@/lib/server/missions/mission-repository'

const SUBAGENT_ACTIONS = [
  'start',
  'status',
  'list',
  'wait',
  'wait_all',
  'cancel',
  'lineage',
  'batch',
  'aggregate',
  'swarm',
  'swarm_status',
  'swarm_list',
  'swarm_cancel',
] as const

const subagentTaskSchema = z.object({
  agentId: z.string(),
  message: z.string(),
  cwd: z.string().optional(),
  shareBrowserProfile: z.boolean().optional(),
}).passthrough()

const subagentToolSchema = z.object({
  action: z.enum(SUBAGENT_ACTIONS).optional(),
  agentId: z.string().optional(),
  message: z.string().optional(),
  selectionMode: z.enum(['explicit', 'best_fit']).optional(),
  workType: z.enum(['coding', 'research', 'writing', 'review', 'operations', 'general']).optional(),
  requiredCapabilities: z.union([z.array(z.string()), z.string()]).optional(),
  cwd: z.string().optional(),
  shareBrowserProfile: z.boolean().optional(),
  jobId: z.string().optional(),
  swarmId: z.string().optional(),
  jobIds: z.union([z.array(z.string()), z.string()]).optional(),
  tasks: z.union([z.array(subagentTaskSchema), z.string()]).optional(),
  executionMode: z.enum(['auto', 'parallel', 'serial']).optional(),
  maxConcurrency: z.union([z.number(), z.string()]).optional(),
  joinPolicy: z.enum(['all', 'first', 'quorum']).optional(),
  quorum: z.union([z.number(), z.string()]).optional(),
  cancelRemaining: z.boolean().optional(),
  waitForCompletion: z.boolean().optional(),
  background: z.boolean().optional(),
  timeoutSec: z.union([z.number(), z.string()]).optional(),
}).passthrough()

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
  agentId?: string
  sessionId?: string
  cwd: string
  delegationTargetMode?: 'all' | 'selected'
  delegationTargetAgentIds?: string[]
}

function validateAllowedSubagentTarget(agentId: string, ctx: ActionContext): string | null {
  if (ctx.delegationTargetMode !== 'selected') return null
  const allowedAgentIds = Array.isArray(ctx.delegationTargetAgentIds)
    ? ctx.delegationTargetAgentIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
  if (allowedAgentIds.length === 0 || allowedAgentIds.includes(agentId)) return null

  const agents = loadAgents()
  const allowedNames = allowedAgentIds
    .map(id => agents[id]?.name ? `${agents[id].name} [${id}]` : id)
    .join(', ')
  return `Error: agent "${agentId}" is not in your allowed delegation list. You may only delegate to: ${allowedNames}. Do not retry with this agent.`
}

function parseBooleanLike(value: unknown): boolean | unknown {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return value
}

function parseNumberLike(value: unknown): number | unknown {
  if (typeof value !== 'string') return value
  const normalized = value.trim()
  if (!normalized) return value
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return value
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : value
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function coerceSubagentActionArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolInputArgs(rawArgs)
  const coerced: Record<string, unknown> = { ...normalized }

  for (const key of ['waitForCompletion', 'background', 'shareBrowserProfile', 'cancelRemaining'] as const) {
    coerced[key] = parseBooleanLike(coerced[key])
  }
  coerced.timeoutSec = parseNumberLike(coerced.timeoutSec)
  coerced.maxConcurrency = parseNumberLike(coerced.maxConcurrency)
  coerced.quorum = parseNumberLike(coerced.quorum)

  const parsedTasks = parseJsonLike(coerced.tasks)
  if (Array.isArray(parsedTasks)) {
    coerced.tasks = parsedTasks
  } else {
    const parsedTasksJson = parseJsonLike(coerced.tasksJson)
    if (Array.isArray(parsedTasksJson)) coerced.tasks = parsedTasksJson
  }

  const parsedJobIds = parseJsonLike(coerced.jobIds)
  if (Array.isArray(parsedJobIds)) coerced.jobIds = parsedJobIds
  const parsedRequiredCapabilities = parseJsonLike(coerced.requiredCapabilities)
  if (Array.isArray(parsedRequiredCapabilities)) coerced.requiredCapabilities = parsedRequiredCapabilities

  return coerced
}

function normalizeWorkType(value: unknown): DelegationWorkType | null {
  if (
    value === 'coding'
    || value === 'research'
    || value === 'writing'
    || value === 'review'
    || value === 'operations'
    || value === 'general'
  ) {
    return value
  }
  return null
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    const trimmed = typeof entry === 'string' ? entry.trim() : ''
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    out.push(trimmed)
  }
  return out
}

async function resolveBestFitAgentSelection(
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<{ agentId: string; workType: DelegationWorkType; requiredCapabilities: string[] } | null> {
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!message) return null
  const explicitWorkType = normalizeWorkType(args.workType)
  const explicitCapabilities = normalizeStringList(args.requiredCapabilities)
  const classification = (!explicitWorkType && explicitCapabilities.length === 0 && ctx.sessionId)
    ? await classifyMessage({
        sessionId: ctx.sessionId,
        agentId: ctx.agentId || null,
        message,
      }).catch(() => null)
    : null
  const profile = buildDelegationTaskProfile({
    classification,
    workType: explicitWorkType,
    requiredCapabilities: explicitCapabilities,
  })
  const selection = resolveBestDelegateTarget({
    currentAgentId: ctx.agentId || null,
    agents: loadAgents(),
    profile,
    delegationTargetMode: ctx.delegationTargetMode,
    delegationTargetAgentIds: ctx.delegationTargetAgentIds,
  })
  if (!selection) return null
  return {
    agentId: selection.agentId,
    workType: profile.workType,
    requiredCapabilities: profile.requiredCapabilities,
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const val = typeof args[key] === 'string' ? (args[key] as string).trim() : ''
  if (!val) throw new Error(`${key} is required.`)
  return val
}

type JoinPolicy =
  | { type: 'all' }
  | { type: 'first' }
  | { type: 'quorum'; count: number; cancelRemaining: boolean }

function parseJoinPolicy(args: Record<string, unknown>, taskCount: number): JoinPolicy {
  const raw = typeof args.joinPolicy === 'string' ? args.joinPolicy.trim().toLowerCase() : ''
  if (raw === 'first') return { type: 'first' }
  if (raw === 'quorum') {
    const parsed = typeof args.quorum === 'number' ? args.quorum : Number(args.quorum)
    const count = Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.floor(parsed), taskCount)
      : Math.max(1, Math.ceil(taskCount / 2))
    const cancelRemaining = args.cancelRemaining !== false
    return { type: 'quorum', count, cancelRemaining }
  }
  return { type: 'all' }
}

/**
 * Resolve the effective maxConcurrency for a swarm dispatch using the
 * precedence: explicit arg > agent.maxParallelDelegations > mission.budget.maxParallelBranches > system default.
 */
function resolveSwarmMaxConcurrency(
  args: Record<string, unknown>,
  ctx: ActionContext,
): number {
  const pickFinite = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
  }
  const explicit = pickFinite(args.maxConcurrency)
  if (explicit !== null) return Math.min(explicit, SWARM_MAX_CONCURRENCY_HARD_LIMIT)

  if (ctx.agentId) {
    const agent = loadAgents()[ctx.agentId]
    const agentCap = pickFinite(agent?.maxParallelDelegations)
    if (agentCap !== null) return Math.min(agentCap, SWARM_MAX_CONCURRENCY_HARD_LIMIT)
  }

  if (ctx.sessionId) {
    const session = getSession(ctx.sessionId) as { missionId?: string | null } | null
    const missionId = typeof session?.missionId === 'string' && session.missionId.trim()
      ? session.missionId.trim()
      : null
    if (missionId) {
      const mission = getMission(missionId)
      const missionCap = pickFinite(mission?.budget?.maxParallelBranches)
      if (missionCap !== null) return Math.min(missionCap, SWARM_MAX_CONCURRENCY_HARD_LIMIT)
    }
  }

  return SWARM_DEFAULT_PARALLEL_CONCURRENCY
}

async function awaitSwarmByPolicy(
  swarm: Awaited<ReturnType<typeof spawnSwarm>>,
  policy: JoinPolicy,
): Promise<ReturnType<typeof spawnSwarm> extends Promise<infer T> ? T extends { allSettled: Promise<infer A> } ? A : never : never> {
  if (policy.type === 'first') {
    await swarm.firstSettled
    swarm.cancelAll()
    return swarm.allSettled
  }
  if (policy.type === 'quorum') {
    return swarm.quorumSettled(policy.count, { cancelRemaining: policy.cancelRemaining })
  }
  return swarm.allSettled
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
      sleep(timeoutMs).then(() => null),
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
    await sleep(1000)
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
    const targetError = validateAllowedSubagentTarget(t.agentId, ctx)
    if (targetError) return targetError
  }
  const waitForCompletion = args.waitForCompletion !== false && args.background !== true
  const executionMode = args.executionMode === 'parallel' || args.executionMode === 'serial'
    ? args.executionMode
    : 'auto'
  const maxConcurrency = resolveSwarmMaxConcurrency(args, ctx)
  const policy = parseJoinPolicy(args, tasks.length)

  // Use spawnSwarm internally — batch is a simplified interface
  const swarm = await spawnSwarm({ tasks, executionMode, maxConcurrency }, { sessionId: ctx.sessionId, cwd: ctx.cwd })
  const jobIds = swarm.members
    .filter((m) => !m.spawnError && m.handle)
    .map((m) => m.handle.jobId)

  if (!waitForCompletion) {
    return JSON.stringify({
      action: 'batch',
      status: 'running',
      jobIds,
      taskCount: tasks.length,
      maxConcurrency: swarm.maxConcurrency,
    })
  }
  const aggregate = await awaitSwarmByPolicy(swarm, policy)
  return JSON.stringify({
    action: 'batch',
    status: 'completed',
    jobIds,
    maxConcurrency: swarm.maxConcurrency,
    joinPolicy: policy.type,
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
    const targetError = validateAllowedSubagentTarget(t.agentId, ctx)
    if (targetError) return targetError
  }
  const waitForCompletion = args.waitForCompletion !== false && args.background !== true
  const executionMode = args.executionMode === 'parallel' || args.executionMode === 'serial'
    ? args.executionMode
    : 'auto'
  const maxConcurrency = resolveSwarmMaxConcurrency(args, ctx)
  const policy = parseJoinPolicy(args, tasks.length)

  const swarm = await spawnSwarm({ tasks, executionMode, maxConcurrency }, { sessionId: ctx.sessionId, cwd: ctx.cwd })
  if (!waitForCompletion) {
    const snapshot = getSwarmSnapshot(swarm.swarmId)
    return JSON.stringify({
      action: 'swarm',
      status: 'running',
      swarmId: swarm.swarmId,
      memberCount: swarm.members.length,
      maxConcurrency: swarm.maxConcurrency,
      snapshot,
    })
  }
  const aggregate = await awaitSwarmByPolicy(swarm, policy)
  const snapshot = getSwarmSnapshot(swarm.swarmId)
  return JSON.stringify({
    action: 'swarm',
    ...aggregate,
    status: swarm.status,
    maxConcurrency: swarm.maxConcurrency,
    joinPolicy: policy.type,
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
  const selectionMode = args.selectionMode === 'best_fit' ? 'best_fit' : 'explicit'
  let agentId = (args.agentId ?? args.agent_id) as string | undefined
  const message = args.message as string | undefined
  if (!message) return 'Error: message is required.'
  let selectedProfile: { workType: DelegationWorkType; requiredCapabilities: string[] } | null = null
  if (selectionMode === 'best_fit') {
    const resolved = await resolveBestFitAgentSelection(args, ctx)
    if (!resolved) return 'Error: no eligible delegate agent available for best_fit selection.'
    agentId = resolved.agentId
    selectedProfile = {
      workType: resolved.workType,
      requiredCapabilities: resolved.requiredCapabilities,
    }
  }
  if (!agentId) return 'Error: agentId is required.'
  const targetError = validateAllowedSubagentTarget(agentId, ctx)
  if (targetError) return targetError

  const cwd = args.cwd as string | undefined
  const shareBrowserProfile = args.shareBrowserProfile === true || args.share_browser_profile === true
  const waitForCompletion = args.waitForCompletion !== false && args.background !== true

  const handle = await spawnSubagent(
    { agentId, message, cwd, shareBrowserProfile, waitForCompletion },
    { sessionId: ctx.sessionId, cwd: ctx.cwd },
  )

  if (!waitForCompletion) {
    return JSON.stringify({
      jobId: handle.jobId,
      status: 'running',
      selectionMode,
      agentId: handle.agentId,
      agentName: handle.agentName,
      sessionId: handle.sessionId,
      lineageId: handle.lineageId,
      workType: selectedProfile?.workType || null,
      requiredCapabilities: selectedProfile?.requiredCapabilities || [],
    })
  }

  const result = await handle.promise
  return JSON.stringify({
    jobId: result.jobId,
    status: result.status,
    selectionMode,
    agentId: result.agentId,
    agentName: result.agentName,
    sessionId: result.sessionId,
    lineageId: result.lineageId,
    response: result.response,
    depth: result.depth,
    childCount: result.childCount,
    durationMs: result.durationMs,
    workType: selectedProfile?.workType || null,
    requiredCapabilities: selectedProfile?.requiredCapabilities || [],
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
  const normalized = coerceSubagentActionArgs((args ?? {}) as Record<string, unknown>)
  const action = String(normalized.action || 'start').trim().toLowerCase()

  recoverStaleDelegationJobs()

  try {
    const handler = ACTIONS[action]
    if (handler) return handler(normalized, context)
    // Default: single agent spawn
    return handleStart(normalized, context)
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Extension
 */
const SubagentExtension: Extension = {
  name: 'Core Subagents',
  description: 'Delegate tasks to other specialized agents with resumable job handles.',
  hooks: {
    getCapabilityDescription: () =>
      'Delegate tasks to other agents (spawn_subagent). Single task: action "start" with `agentId`, or use `selectionMode:"best_fit"` with `message` plus optional `workType`/`requiredCapabilities`. '
      + 'Multiple independent tasks: action "batch" with a tasks array. '
      + 'Event-driven parallel with status tracking: action "swarm" with a tasks array. '
      + 'Background swarms return a swarmId you can pass to swarm_status, swarm_list, and swarm_cancel.',
    getOperatingGuidance: () => [
      'SUBAGENT DISPATCH RULES:',
      '- Single task → action "start" with `agentId` + `message`, or `selectionMode:"best_fit"` with `message` and optional `workType` / `requiredCapabilities`.',
      '- 2+ independent tasks → action "batch" with tasks array [{agentId, message}, ...]. Use `executionMode:"serial"` when local models are rate-limited.',
      '- Background coordination example → `{"action":"swarm","tasks":[...],"background":true}` and then read the returned `swarmId` before calling `swarm_status` or `swarm_cancel`.',
      '- If your final answer depends on all delegated results, set `waitForCompletion:true` and do not summarize early.',
      '- Prefer one coordinated `batch`/`swarm` call over mixing `start`, `delegate`, and follow-up retries for the same set of sibling tasks.',
      '- DO NOT call "start" in a loop when tasks are independent — use "batch" or "swarm" instead.',
      '- Only use subagents when the task genuinely requires another agent\'s specialization or parallel execution.',
      '- If you can answer directly from your own knowledge, do NOT spawn a subagent.',
    ],
  } as ExtensionHooks,
  tools: [
    {
      name: 'spawn_subagent',
      description: 'Delegate tasks to other agents. '
            + 'Actions: start (single agent, either explicit `agentId` or `selectionMode:"best_fit"`), batch (2+ tasks via "tasks" array), swarm (multi-agent execution with status tracking via "tasks" array). '
            + 'Management: status, list, wait, wait_all, cancel, lineage, aggregate, swarm_status, swarm_list, swarm_cancel. '
            + 'In `best_fit` mode, provide `message` and optionally `workType` / `requiredCapabilities`; the runtime will choose the best allowed teammate and return the chosen agent in the tool output. '
            + 'For multiple independent tasks, prefer one `batch` or `swarm` call with tasks:[{agentId,message},...] over calling `start` repeatedly. '
            + 'When the final answer depends on every delegated result, keep waitForCompletion enabled so you can synthesize after all children finish. '
            + 'Use executionMode:"serial" to avoid rate limits on local models. '
            + 'Example background swarm: {"action":"swarm","tasks":[{"agentId":"agent-a","message":"..."},{"agentId":"agent-b","message":"..."}],"background":true}.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'status', 'list', 'wait', 'wait_all', 'cancel', 'lineage', 'batch', 'aggregate', 'swarm', 'swarm_status', 'swarm_list', 'swarm_cancel'] },
          agentId: { type: 'string' },
          message: { type: 'string' },
          selectionMode: {
            type: 'string',
            enum: ['explicit', 'best_fit'],
            description: 'Use "explicit" to target `agentId` directly, or "best_fit" to let the runtime choose the best allowed delegate.',
          },
          workType: {
            type: 'string',
            enum: ['coding', 'research', 'writing', 'review', 'operations', 'general'],
            description: 'Optional hint for `best_fit` selection.',
          },
          requiredCapabilities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional explicit capability requirements for `best_fit` selection.',
          },
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
          executionMode: {
            type: 'string',
            enum: ['auto', 'parallel', 'serial'],
            description: 'How to schedule sibling subagents. "auto" defaults to serial for Ollama-backed targets and parallel otherwise.',
          },
          maxConcurrency: {
            type: 'number',
            description: 'Max sibling branches that may run at the same time when parallel. Defaults to agent/mission policy or 4. Hard-capped at 16.',
          },
          joinPolicy: {
            type: 'string',
            enum: ['all', 'first', 'quorum'],
            description: 'How to wait. "all" (default) waits for every branch. "first" resolves when one succeeds and cancels the rest. "quorum" resolves when `quorum` branches succeed.',
          },
          quorum: {
            type: 'number',
            description: 'Required when joinPolicy="quorum" — number of successful branches needed before resolving.',
          },
          cancelRemaining: {
            type: 'boolean',
            description: 'When joinPolicy="quorum", cancel in-flight branches after quorum is reached. Default true.',
          },
          waitForCompletion: { type: 'boolean' },
          background: { type: 'boolean' },
          timeoutSec: { type: 'number' },
        },
        required: []
      },
      execute: async (args, context) => {
        const sessionAgentId = context.session.agentId || undefined
        const sessionAgent = sessionAgentId ? loadAgents()[sessionAgentId] : null
        return executeSubagentAction(args, {
          agentId: sessionAgentId,
          sessionId: context.session.id,
          cwd: context.session.cwd || process.cwd(),
          delegationTargetMode: sessionAgent?.delegationTargetMode,
          delegationTargetAgentIds: sessionAgent?.delegationTargetAgentIds,
        })
      }
    }
  ]
}

registerNativeCapability('subagent', SubagentExtension)

/**
 * Legacy Bridge
 */
export function buildSubagentTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.ctx?.delegationEnabled || !bctx.hasExtension('spawn_subagent')) return []

  let description = SubagentExtension.tools![0].description
  if (bctx.ctx?.delegationTargetMode === 'selected') {
    const allowedIds = (bctx.ctx.delegationTargetAgentIds || []).filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    )
    if (allowedIds.length > 0) {
      const agents = loadAgents()
      const allowedSummary = allowedIds
        .map(id => agents[id]?.name ? `${agents[id].name} [${id}]` : id)
        .join(', ')
      description += ` DELEGATION RESTRICTED: You may ONLY delegate to these agents: ${allowedSummary}. Attempts to delegate to any other agent will be rejected.`
    }
  }

  return [
    tool(
      async (args) => executeSubagentAction(args, {
        agentId: bctx.ctx?.agentId || undefined,
        sessionId: bctx.ctx?.sessionId || undefined,
        cwd: bctx.cwd,
        delegationTargetMode: bctx.ctx?.delegationTargetMode,
        delegationTargetAgentIds: bctx.ctx?.delegationTargetAgentIds,
      }),
      {
        name: 'spawn_subagent',
        description,
        schema: subagentToolSchema
      }
    )
  ]
}
