/**
 * Native Subagent Runtime
 *
 * Replaces CLI bridge delegation with direct, in-process subagent execution.
 * Uses lineage nodes for lifecycle state tracking (no separate state machine
 * registry). Provides a handle registry for promise-based waiting.
 */

import { genId } from '@/lib/id'
import { DEFAULT_DELEGATION_MAX_DEPTH } from '@/lib/runtime/runtime-loop'
import { loadAgents, loadSessions, saveSessions } from '@/lib/server/storage'
import { enqueueSessionRun, type EnqueueSessionRunResult } from '@/lib/server/runtime/session-run-manager'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { resolveSubagentBrowserProfileId } from '@/lib/server/session-tools/subagent'
import { runCapabilityHook, runCapabilitySubagentSpawning } from '@/lib/server/native-capabilities'
import {
  appendDelegationCheckpoint,
  completeDelegationJob,
  createDelegationJob,
  failDelegationJob,
  getDelegationJob,
  registerDelegationRuntime,
  startDelegationJob,
} from '@/lib/server/agents/delegation-jobs'
import {
  createLineageNode,
  completeLineageNode,
  failLineageNode,
  cancelLineageNode,
  getLineageNode,
  getLineageNodeBySession,
  getAncestors,
  getChildren,
  getDescendants,
  buildLineageTree,
  cancelSubtree,
  transitionState,
  isTerminalState,
  cleanupTerminalNodes,
  type LineageNode,
  type LineageTree,
  type SubagentState,
} from '@/lib/server/agents/subagent-lineage'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import { getEnabledCapabilityIds, splitCapabilityIds } from '@/lib/capability-selection'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnSubagentInput {
  /** Agent to spawn */
  agentId: string
  /** Message/task for the subagent */
  message: string
  /** Working directory override */
  cwd?: string
  /** Inherit parent's browser profile */
  shareBrowserProfile?: boolean
  /** Inherit parent session's plugins/tools (default true) */
  inheritPlugins?: boolean
  /** Wait for completion (default true) */
  waitForCompletion?: boolean
  /** Timeout in seconds for waiting */
  timeoutSec?: number
  /** Optional shared execution lane key for serializing sibling runs. */
  executionGroupKey?: string
}

export interface SubagentHandle {
  /** Delegation job ID */
  jobId: string
  /** Child session ID */
  sessionId: string
  /** Lineage node ID */
  lineageId: string
  /** Agent info */
  agentId: string
  agentName: string
  /** Session run handle (for abort) */
  run: EnqueueSessionRunResult
  /** Promise that resolves when the subagent completes */
  promise: Promise<SubagentResult>
}

export interface SubagentResult {
  jobId: string
  sessionId: string
  lineageId: string
  agentId: string
  agentName: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  response: string | null
  error: string | null
  depth: number
  parentSessionId: string | null
  childCount: number
  durationMs: number
}

export interface SubagentContext {
  sessionId?: string
  cwd: string
  /** Pre-loaded sessions map — avoids repeated SQLite reads in batch/swarm */
  _sessions?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Handle Registry (for promise-based waiting instead of polling)
// ---------------------------------------------------------------------------

const handleRegistry = hmrSingleton('__swarmclaw_subagent_handles__', () => new Map<string, SubagentHandle>())

/** Retrieve a handle by job ID (for promise-based waiting). */
export function getHandle(jobId: string): SubagentHandle | null {
  return handleRegistry.get(jobId) ?? null
}

// ---------------------------------------------------------------------------
// Plugin Inheritance
// ---------------------------------------------------------------------------

/**
 * Merge parent session plugins with agent-defined plugins.
 * Agent plugins take precedence (listed first), parent plugins fill in gaps.
 * Case-insensitive deduplication, original casing preserved.
 */
function mergeCapabilities(
  agentCapabilities: string[],
  parentSession: Record<string, unknown> | null | undefined,
): string[] {
  const parentCapabilities = getEnabledCapabilityIds(parentSession as { tools?: string[] | null, extensions?: string[] | null } | null)

  if (parentCapabilities.length === 0) return agentCapabilities
  if (agentCapabilities.length === 0) return [...parentCapabilities]

  const seen = new Set<string>()
  const merged: string[] = []
  for (const id of [...agentCapabilities, ...parentCapabilities]) {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    const normalized = trimmed.toLowerCase()
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      merged.push(trimmed)
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Depth Guard
// ---------------------------------------------------------------------------

export function getSessionDepth(
  sessionId: string | undefined,
  maxDepth: number,
  sessions?: Record<string, unknown>,
): number {
  if (!sessionId) return 0
  const allSessions = sessions ?? loadSessions()
  let depth = 0
  let current = sessionId
  while (current && depth < maxDepth + 1) {
    const session = allSessions[current] as unknown as Record<string, unknown> | undefined
    if (!session?.parentSessionId) break
    current = session.parentSessionId as string
    depth++
  }
  return depth
}

// ---------------------------------------------------------------------------
// Core: Spawn a Native Subagent
// ---------------------------------------------------------------------------

export function spawnSubagent(
  input: SpawnSubagentInput,
  context: SubagentContext,
): Promise<SubagentHandle> {
  return spawnSubagentImpl(input, context)
}

async function spawnSubagentImpl(
  input: SpawnSubagentInput,
  context: SubagentContext,
): Promise<SubagentHandle> {
  const runtime = loadRuntimeSettings()
  const maxDepth = runtime.delegationMaxDepth || DEFAULT_DELEGATION_MAX_DEPTH
  const agents = loadAgents()
  const agent = agents[input.agentId]

  if (!agent) {
    throw new Error(`Agent "${input.agentId}" not found.`)
  }

  // Use cached sessions if available (batch/swarm pass this to avoid N reads)
  const sessions = (context._sessions ?? loadSessions()) as Record<string, Record<string, unknown>>
  const depth = getSessionDepth(context.sessionId, maxDepth, sessions)
  if (depth >= maxDepth) {
    throw new Error(`Max subagent depth (${maxDepth}) reached.`)
  }
  const parent = context.sessionId ? sessions[context.sessionId] : null
  const parentPlugins = getEnabledCapabilityIds(parent as { tools?: string[] | null, extensions?: string[] | null } | null)
  const spawningResult = await runCapabilitySubagentSpawning(
    {
      parentSessionId: context.sessionId || null,
      agentId: input.agentId,
      agentName: agent.name,
      message: input.message,
      cwd: input.cwd || context.cwd,
      mode: 'run',
      threadRequested: false,
    },
    { enabledIds: parentPlugins },
  )
  if (spawningResult.status === 'error') {
    throw new Error(spawningResult.error || 'Subagent spawn blocked by plugin hook')
  }

  // 1. Create delegation job
  const job = createDelegationJob({
    kind: 'subagent',
    parentSessionId: context.sessionId || null,
    agentId: input.agentId,
    task: input.message,
    cwd: input.cwd || context.cwd,
  })
  appendDelegationCheckpoint(job.id, `Initializing subagent ${agent.name}`, 'queued')

  // 2. Create child session
  const sid = genId()
  const now = Date.now()
  const browserProfileId = resolveSubagentBrowserProfileId(
    parent,
    sid,
    input.shareBrowserProfile === true,
  )

  const agentPlugins = getEnabledCapabilityIds(agent)
  const effectivePlugins = input.inheritPlugins === false
    ? agentPlugins
    : mergeCapabilities(agentPlugins, parent)
  const effectiveSelection = splitCapabilityIds(effectivePlugins)

  const nextSession = {
    id: sid,
    name: `subagent-${agent.name}`,
    cwd: input.cwd || context.cwd,
    user: 'agent',
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId || null,
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    sessionType: 'orchestrated',
    agentId: agent.id,
    parentSessionId: context.sessionId || null,
    tools: effectiveSelection.tools,
    extensions: effectiveSelection.extensions,
    browserProfileId,
  }
  sessions[sid] = applyResolvedRoute(nextSession, resolvePrimaryAgentRoute(agent))
  saveSessions(sessions)

  // 3. Create lineage node (starts in 'initializing')
  const lineageNode = createLineageNode({
    sessionId: sid,
    agentId: agent.id,
    agentName: agent.name,
    parentSessionId: context.sessionId || null,
    jobId: job.id,
    task: input.message,
    cwd: input.cwd || context.cwd,
  })

  // 4. Transition: initializing → ready
  transitionState(lineageNode.id, 'READY')

  // 5. Start delegation job
  startDelegationJob(job.id, {
    childSessionId: sid,
    agentId: agent.id,
    agentName: agent.name,
    cwd: input.cwd || context.cwd,
  })
  appendDelegationCheckpoint(job.id, `Created child session ${sid}`, 'running')

  // 6. Transition: ready → running
  transitionState(lineageNode.id, 'START')

  // 7. Enqueue session run (native execution — no CLI)
  const run = enqueueSessionRun({
    sessionId: sid,
    message: input.message,
    internal: true,
    source: 'subagent',
    mode: 'followup',
    executionGroupKey: input.executionGroupKey,
  })
  await runCapabilityHook(
    'subagentSpawned',
    {
      parentSessionId: context.sessionId || null,
      childSessionId: sid,
      agentId: agent.id,
      agentName: agent.name,
      runId: run.runId,
      mode: 'run',
      threadRequested: false,
    },
    { enabledIds: parentPlugins },
  )

  // 8. Register runtime handle for cancellation
  registerDelegationRuntime(job.id, {
    cancel: () => {
      run.abort()
      const node = getLineageNode(lineageNode.id)
      if (node && !isTerminalState(node.status)) {
        cancelLineageNode(lineageNode.id)
      }
    },
  })

  // 9. Build result promise
  const resultPromise = run.promise
    .then(async (result): Promise<SubagentResult> => {
      const latest = getDelegationJob(job.id)
      const node = getLineageNode(lineageNode.id)
      let subagentResult: SubagentResult
      if (latest?.status === 'cancelled' || node?.status === 'cancelled') {
        subagentResult = buildResult(job.id, sid, lineageNode, agent, 'cancelled', null, null)
      } else {
        const responseText = (result.text || '').slice(0, 32_000)
        completeLineageNode(lineageNode.id, responseText.slice(0, 1000))
        appendDelegationCheckpoint(job.id, 'Child session completed', 'completed')
        completeDelegationJob(job.id, responseText, { childSessionId: sid })

        subagentResult = buildResult(job.id, sid, lineageNode, agent, 'completed', responseText, null)
      }
      await runCapabilityHook(
        'subagentEnded',
        {
          parentSessionId: context.sessionId || null,
          childSessionId: sid,
          agentId: agent.id,
          agentName: agent.name,
          status: subagentResult.status,
          response: subagentResult.response,
          error: subagentResult.error,
          durationMs: subagentResult.durationMs,
        },
        { enabledIds: parentPlugins },
      )
      await runCapabilityHook(
        'sessionEnd',
        {
          sessionId: sid,
          session: loadSessions()[sid] || null,
          messageCount: Array.isArray(loadSessions()[sid]?.messages) ? loadSessions()[sid].messages.length : 0,
          durationMs: subagentResult.durationMs,
          reason: subagentResult.status,
        },
        { enabledIds: parentPlugins },
      )
      return subagentResult
    })
    .catch(async (err: unknown): Promise<SubagentResult> => {
      const message = errorMessage(err)
      const latest = getDelegationJob(job.id)
      const node = getLineageNode(lineageNode.id)
      let subagentResult: SubagentResult
      if (latest?.status === 'cancelled' || node?.status === 'cancelled') {
        subagentResult = buildResult(job.id, sid, lineageNode, agent, 'cancelled', null, null)
      } else {
        failLineageNode(lineageNode.id, message)
        appendDelegationCheckpoint(job.id, `Child session failed: ${message}`, 'failed')
        failDelegationJob(job.id, message, { childSessionId: sid })

        subagentResult = buildResult(job.id, sid, lineageNode, agent, 'failed', null, message)
      }
      await runCapabilityHook(
        'subagentEnded',
        {
          parentSessionId: context.sessionId || null,
          childSessionId: sid,
          agentId: agent.id,
          agentName: agent.name,
          status: subagentResult.status,
          response: subagentResult.response,
          error: subagentResult.error,
          durationMs: subagentResult.durationMs,
        },
        { enabledIds: parentPlugins },
      )
      await runCapabilityHook(
        'sessionEnd',
        {
          sessionId: sid,
          session: loadSessions()[sid] || null,
          messageCount: Array.isArray(loadSessions()[sid]?.messages) ? loadSessions()[sid].messages.length : 0,
          durationMs: subagentResult.durationMs,
          reason: subagentResult.status,
        },
        { enabledIds: parentPlugins },
      )
      return subagentResult
    })

  const handle: SubagentHandle = {
    jobId: job.id,
    sessionId: sid,
    lineageId: lineageNode.id,
    agentId: agent.id,
    agentName: agent.name,
    run,
    promise: resultPromise,
  }

  // Register handle for promise-based waiting
  handleRegistry.set(job.id, handle)

  return handle
}

// ---------------------------------------------------------------------------
// Result Builder
// ---------------------------------------------------------------------------

function buildResult(
  jobId: string,
  sessionId: string,
  lineageNode: LineageNode,
  agent: { id?: string; name?: string },
  status: SubagentResult['status'],
  response: string | null,
  error: string | null,
): SubagentResult {
  const children = getChildren(lineageNode.id)
  return {
    jobId,
    sessionId,
    lineageId: lineageNode.id,
    agentId: String(agent.id ?? ''),
    agentName: String(agent.name ?? ''),
    status,
    response,
    error,
    depth: lineageNode.depth,
    parentSessionId: lineageNode.parentSessionId,
    childCount: children.length,
    durationMs: Date.now() - lineageNode.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Query helpers (re-exported for convenience)
// ---------------------------------------------------------------------------

export {
  getLineageNodeBySession,
  getAncestors,
  getChildren,
  getDescendants,
  buildLineageTree,
  cancelSubtree,
  mergeCapabilities as _mergePlugins,
}

export type {
  LineageNode,
  LineageTree,
  SubagentState,
}

// ---------------------------------------------------------------------------
// Cancel a running subagent by session ID
// ---------------------------------------------------------------------------

export function cancelSubagentBySession(sessionId: string): boolean {
  const node = getLineageNodeBySession(sessionId)
  if (!node) return false

  if (!isTerminalState(node.status)) {
    cancelLineageNode(node.id)
  }

  cancelSubtree(node.id)
  return true
}

// ---------------------------------------------------------------------------
// Cleanup finished subagents (call periodically)
// ---------------------------------------------------------------------------

export function cleanupFinishedSubagents(maxAgeMs = 30 * 60_000): number {
  const removedIds = cleanupTerminalNodes(maxAgeMs)
  const removedSet = new Set(removedIds)
  // Clean up handle registry entries for removed lineage nodes
  // Also purge stale handles whose lineage nodes no longer exist (TTL safety net)
  for (const [jobId, handle] of handleRegistry.entries()) {
    if (removedSet.has(handle.lineageId)) {
      handleRegistry.delete(jobId)
    } else if (!getLineageNode(handle.lineageId)) {
      // Lineage node already gone — handle is orphaned, clean it up
      handleRegistry.delete(jobId)
    }
  }
  return removedIds.length
}
