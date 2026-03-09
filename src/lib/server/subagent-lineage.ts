/**
 * Subagent Lineage & Lifecycle Tracker
 *
 * Tracks parent → child relationships between subagent sessions and manages
 * lifecycle state transitions. The lifecycle state lives directly on the
 * lineage node (single source of truth), eliminating the need for a separate
 * state machine registry.
 *
 * Lineage nodes are stored in-memory (globalThis-scoped for HMR safety).
 */

import { genId } from '@/lib/id'
import { notify } from './ws-hub'

// ---------------------------------------------------------------------------
// Lifecycle States & Events
// ---------------------------------------------------------------------------

export type SubagentState =
  | 'initializing'  // Being set up (session creation, lineage registration)
  | 'ready'         // Session created, queued for execution
  | 'running'       // Actively executing
  | 'waiting'       // Paused while a child subagent completes
  | 'completed'     // Finished successfully
  | 'failed'        // Finished with error
  | 'cancelled'     // Cancelled by parent or user
  | 'timed_out'     // Exceeded time limit

export type SubagentEvent =
  | 'READY'         // Setup complete, queued
  | 'START'         // Begin execution
  | 'SPAWN_CHILD'   // Spawned a child subagent, waiting
  | 'CHILD_DONE'    // Child subagent completed, resume
  | 'COMPLETE'      // Execution finished successfully
  | 'FAIL'          // Execution finished with error
  | 'CANCEL'        // Cancelled externally
  | 'TIMEOUT'       // Time limit exceeded

const TRANSITIONS: Record<SubagentState, Partial<Record<SubagentEvent, SubagentState>>> = {
  initializing: { READY: 'ready', FAIL: 'failed', CANCEL: 'cancelled' },
  ready:        { START: 'running', FAIL: 'failed', CANCEL: 'cancelled' },
  running:      { SPAWN_CHILD: 'waiting', COMPLETE: 'completed', FAIL: 'failed', CANCEL: 'cancelled', TIMEOUT: 'timed_out' },
  waiting:      { CHILD_DONE: 'running', COMPLETE: 'completed', FAIL: 'failed', CANCEL: 'cancelled', TIMEOUT: 'timed_out' },
  completed:    {},
  failed:       {},
  cancelled:    {},
  timed_out:    {},
}

export function isTerminalState(state: SubagentState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

/** Resolve next state for a (state, event) pair. Returns undefined if invalid. */
function resolveTransition(state: SubagentState, event: SubagentEvent): SubagentState | undefined {
  return TRANSITIONS[state]?.[event]
}

/**
 * Check if a transition is valid without performing it.
 */
export function canTransition(nodeOrState: string | SubagentState, event: SubagentEvent): boolean {
  // If it looks like a lineage node ID, look it up
  const state: SubagentState | undefined =
    (nodeOrState in TRANSITIONS)
      ? nodeOrState as SubagentState
      : store.get(nodeOrState)?.status
  if (!state) return false
  return resolveTransition(state, event) !== undefined
}

/**
 * Get valid events from a state (for tests / introspection).
 */
export function validEvents(state: SubagentState): SubagentEvent[] {
  return Object.keys(TRANSITIONS[state] ?? {}) as SubagentEvent[]
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LineageNode {
  /** Unique lineage node ID */
  id: string
  /** Session ID of this subagent */
  sessionId: string
  /** Agent ID executing in this session */
  agentId: string
  /** Agent display name */
  agentName: string
  /** Parent lineage node ID (null for root agents) */
  parentId: string | null
  /** Parent session ID (null for root agents) */
  parentSessionId: string | null
  /** Delegation job ID that spawned this subagent */
  jobId: string | null
  /** Nesting depth (0 = root, 1 = first-level subagent, etc.) */
  depth: number
  /** Task/message that was delegated */
  task: string
  /** Working directory */
  cwd: string | null
  /** Timestamps */
  createdAt: number
  completedAt: number | null
  /** Lifecycle state — single source of truth for execution status */
  status: SubagentState
  /** Result summary (truncated) */
  resultPreview: string | null
  /** Error message if failed */
  error: string | null
}

export interface LineageTree {
  node: LineageNode
  children: LineageTree[]
}

export interface LineageQuery {
  sessionId?: string
  agentId?: string
  parentId?: string | null
  status?: SubagentState
  minDepth?: number
  maxDepth?: number
}

// ---------------------------------------------------------------------------
// Storage (globalThis-scoped, HMR-safe)
// ---------------------------------------------------------------------------

const LINEAGE_KEY = '__swarmclaw_subagent_lineage__' as const
const scope = globalThis as typeof globalThis & {
  [LINEAGE_KEY]?: Map<string, LineageNode>
}
const store = scope[LINEAGE_KEY] ?? (scope[LINEAGE_KEY] = new Map())

// Session → lineage node index for fast lookup
const SESSION_INDEX_KEY = '__swarmclaw_lineage_session_idx__' as const
const sessionScope = globalThis as typeof globalThis & {
  [SESSION_INDEX_KEY]?: Map<string, string>
}
const sessionIndex = sessionScope[SESSION_INDEX_KEY] ?? (sessionScope[SESSION_INDEX_KEY] = new Map())

// Debounced notification — collapses rapid-fire updates into one per microtask
let notifyPending = false
function notifyLineageChanged() {
  if (notifyPending) return
  notifyPending = true
  queueMicrotask(() => {
    notifyPending = false
    notify('delegation_jobs')
  })
}

// ---------------------------------------------------------------------------
// Lifecycle Transitions
// ---------------------------------------------------------------------------

/**
 * Transition a lineage node's lifecycle state. Returns the new state,
 * or null if the transition is invalid or the node doesn't exist.
 */
export function transitionState(nodeId: string, event: SubagentEvent): SubagentState | null {
  const node = store.get(nodeId)
  if (!node) return null
  const next = resolveTransition(node.status, event)
  if (!next) return null
  store.set(nodeId, { ...node, status: next })
  notifyLineageChanged()
  return next
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

export interface CreateLineageNodeInput {
  sessionId: string
  agentId: string
  agentName: string
  parentSessionId?: string | null
  jobId?: string | null
  task: string
  cwd?: string | null
}

export function createLineageNode(input: CreateLineageNodeInput): LineageNode {
  const parentNodeId = input.parentSessionId
    ? sessionIndex.get(input.parentSessionId) ?? null
    : null
  const parentNode = parentNodeId ? store.get(parentNodeId) ?? null : null
  const depth = parentNode ? parentNode.depth + 1 : 0

  const node: LineageNode = {
    id: genId(10),
    sessionId: input.sessionId,
    agentId: input.agentId,
    agentName: input.agentName,
    parentId: parentNodeId,
    parentSessionId: input.parentSessionId ?? null,
    jobId: input.jobId ?? null,
    depth,
    task: input.task,
    cwd: input.cwd ?? null,
    createdAt: Date.now(),
    completedAt: null,
    status: 'initializing',
    resultPreview: null,
    error: null,
  }

  store.set(node.id, node)
  sessionIndex.set(node.sessionId, node.id)
  notifyLineageChanged()
  return node
}

export function getLineageNode(id: string): LineageNode | null {
  return store.get(id) ?? null
}

export function getLineageNodeBySession(sessionId: string): LineageNode | null {
  const nodeId = sessionIndex.get(sessionId)
  return nodeId ? store.get(nodeId) ?? null : null
}

export function updateLineageNode(
  id: string,
  patch: Partial<Pick<LineageNode, 'completedAt' | 'resultPreview' | 'error'>>,
): LineageNode | null {
  const current = store.get(id)
  if (!current) return null
  const updated = { ...current, ...patch }
  store.set(id, updated)
  notifyLineageChanged()
  return updated
}

export function completeLineageNode(id: string, resultPreview: string | null): LineageNode | null {
  const node = store.get(id)
  if (!node) return null
  if (isTerminalState(node.status)) return node
  const next = resolveTransition(node.status, 'COMPLETE')
  if (!next) return null
  const updated = { ...node, status: next, completedAt: Date.now(), resultPreview }
  store.set(id, updated)
  notifyLineageChanged()
  return updated
}

export function failLineageNode(id: string, error: string): LineageNode | null {
  const node = store.get(id)
  if (!node) return null
  if (isTerminalState(node.status)) return node
  const next = resolveTransition(node.status, 'FAIL')
  if (!next) return null
  const updated = { ...node, status: next, completedAt: Date.now(), error }
  store.set(id, updated)
  notifyLineageChanged()
  return updated
}

export function cancelLineageNode(id: string): LineageNode | null {
  const node = store.get(id)
  if (!node) return null
  if (isTerminalState(node.status)) return node
  const next = resolveTransition(node.status, 'CANCEL')
  if (!next) return null
  const updated = { ...node, status: next, completedAt: Date.now() }
  store.set(id, updated)
  notifyLineageChanged()
  return updated
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listLineageNodes(query?: LineageQuery): LineageNode[] {
  let nodes = Array.from(store.values())

  if (query?.sessionId) {
    nodes = nodes.filter((n) => n.sessionId === query.sessionId)
  }
  if (query?.agentId) {
    nodes = nodes.filter((n) => n.agentId === query.agentId)
  }
  if (query?.parentId !== undefined) {
    nodes = nodes.filter((n) => n.parentId === query.parentId)
  }
  if (query?.status) {
    nodes = nodes.filter((n) => n.status === query.status)
  }
  if (query?.minDepth !== undefined) {
    nodes = nodes.filter((n) => n.depth >= query.minDepth!)
  }
  if (query?.maxDepth !== undefined) {
    nodes = nodes.filter((n) => n.depth <= query.maxDepth!)
  }

  return nodes.sort((a, b) => a.createdAt - b.createdAt)
}

/** Get all ancestors of a node, from immediate parent to root */
export function getAncestors(nodeId: string): LineageNode[] {
  const ancestors: LineageNode[] = []
  let currentId: string | null = nodeId
  const visited = new Set<string>()

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const node = store.get(currentId)
    if (!node?.parentId) break
    const parent = store.get(node.parentId)
    if (!parent) break
    ancestors.push(parent)
    currentId = parent.id
  }

  return ancestors
}

/** Get direct children of a node */
export function getChildren(nodeId: string): LineageNode[] {
  return Array.from(store.values())
    .filter((n) => n.parentId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Get all descendants of a node (breadth-first) */
export function getDescendants(nodeId: string): LineageNode[] {
  const descendants: LineageNode[] = []
  const queue = [nodeId]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const currentId = queue.shift()!
    if (visited.has(currentId)) continue
    visited.add(currentId)

    const children = getChildren(currentId)
    for (const child of children) {
      descendants.push(child)
      queue.push(child.id)
    }
  }

  return descendants
}

/** Get siblings (other children of the same parent) */
export function getSiblings(nodeId: string): LineageNode[] {
  const node = store.get(nodeId)
  if (!node?.parentId) return []
  return getChildren(node.parentId).filter((n) => n.id !== nodeId)
}

/** Build a full lineage tree starting from a node */
export function buildLineageTree(nodeId: string): LineageTree | null {
  const node = store.get(nodeId)
  if (!node) return null

  const children = getChildren(nodeId)
    .map((child) => buildLineageTree(child.id))
    .filter((tree): tree is LineageTree => tree !== null)

  return { node, children }
}

/** Find all root nodes (nodes with no parent) */
export function getRootNodes(): LineageNode[] {
  return Array.from(store.values())
    .filter((n) => n.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Get the root ancestor of a node */
export function getRootAncestor(nodeId: string): LineageNode | null {
  const ancestors = getAncestors(nodeId)
  return ancestors.length > 0 ? ancestors[ancestors.length - 1] : store.get(nodeId) ?? null
}

/** Get the depth of the deepest descendant */
export function getMaxDepth(nodeId: string): number {
  const descendants = getDescendants(nodeId)
  if (descendants.length === 0) {
    const node = store.get(nodeId)
    return node?.depth ?? 0
  }
  return Math.max(...descendants.map((d) => d.depth))
}

/** Cancel a node and all its active descendants */
export function cancelSubtree(nodeId: string): number {
  let cancelled = 0
  const node = store.get(nodeId)
  if (node && !isTerminalState(node.status)) {
    cancelLineageNode(nodeId)
    cancelled++
  }
  for (const desc of getDescendants(nodeId)) {
    if (!isTerminalState(desc.status)) {
      cancelLineageNode(desc.id)
      cancelled++
    }
  }
  return cancelled
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove terminal lineage nodes older than maxAgeMs.
 * Returns the IDs of removed nodes so callers can clean up related resources.
 */
export function cleanupTerminalNodes(maxAgeMs = 30 * 60_000): string[] {
  const threshold = Date.now() - maxAgeMs
  const removed: string[] = []
  for (const [id, node] of store.entries()) {
    if (!isTerminalState(node.status)) continue
    if (node.completedAt && node.completedAt < threshold) {
      store.delete(id)
      sessionIndex.delete(node.sessionId)
      removed.push(id)
    }
  }
  return removed
}

// ---------------------------------------------------------------------------
// Testing utilities
// ---------------------------------------------------------------------------

/** Clear all lineage data (for tests only) */
export function _clearLineage(): void {
  store.clear()
  sessionIndex.clear()
}
