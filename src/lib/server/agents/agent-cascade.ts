/**
 * Cascade operations for agent trash / permanent-delete.
 *
 * When an agent is trashed, related entities (tasks, schedules, watch jobs,
 * connectors, webhooks, delegation jobs, chatroom memberships) must be
 * suspended to prevent phantom daemon activity.  On permanent delete the
 * referencing rows are hard-removed.
 */

import {
  loadTasks,
  upsertStoredItems,
  loadSchedules,
  loadWatchJobs,
  loadConnectors,
  loadDelegationJobs,
  loadWebhooks,
  loadChatrooms,
  deleteStoredItem,
} from '@/lib/server/storage'
import type { StorageCollection } from '@/lib/server/storage'

interface CascadeCounts {
  tasks: number
  schedules: number
  watchJobs: number
  connectors: number
  delegationJobs: number
  webhooks: number
  chatrooms: number
}

// ── Soft-delete (trash) ─────────────────────────────────────────────────

/** Disable/pause all entities referencing `agentId`. Fully reversible. */
export function suspendAgentReferences(agentId: string): CascadeCounts {
  const counts: CascadeCounts = { tasks: 0, schedules: 0, watchJobs: 0, connectors: 0, delegationJobs: 0, webhooks: 0, chatrooms: 0 }
  const now = Date.now()

  // 1. Tasks — cancel active ones
  const tasks = loadTasks()
  const taskUpdates: Array<[string, unknown]> = []
  for (const t of Object.values(tasks) as Array<Record<string, unknown>>) {
    if (!t || t.agentId !== agentId) continue
    const status = t.status as string | undefined
    if (status === 'backlog' || status === 'queued' || status === 'running') {
      t.status = 'cancelled'
      t.cancelledAt = now
      taskUpdates.push([t.id as string, t])
    }
  }
  if (taskUpdates.length) {
    upsertStoredItems('tasks', taskUpdates)
    counts.tasks = taskUpdates.length
  }

  // 2. Schedules — pause (with marker for restore)
  const schedules = loadSchedules()
  const schedUpdates: Array<[string, unknown]> = []
  for (const s of Object.values(schedules) as Array<Record<string, unknown>>) {
    if (!s || s.agentId !== agentId) continue
    if (s.enabled === false) continue
    s.enabled = false
    s.suspendedByTrash = true
    schedUpdates.push([s.id as string, s])
  }
  if (schedUpdates.length) {
    upsertStoredItems('schedules', schedUpdates)
    counts.schedules = schedUpdates.length
  }

  // 3. Watch jobs — cancel active
  const watchJobs = loadWatchJobs()
  const wjUpdates: Array<[string, unknown]> = []
  for (const w of Object.values(watchJobs) as Array<Record<string, unknown>>) {
    if (!w || w.agentId !== agentId) continue
    if (w.status === 'cancelled') continue
    w.status = 'cancelled'
    wjUpdates.push([w.id as string, w])
  }
  if (wjUpdates.length) {
    upsertStoredItems('watch_jobs', wjUpdates)
    counts.watchJobs = wjUpdates.length
  }

  // 4. Connectors — detach agent (keep connector alive but unrouted)
  const connectors = loadConnectors()
  const connUpdates: Array<[string, unknown]> = []
  for (const c of Object.values(connectors) as Array<Record<string, unknown>>) {
    if (!c || c.agentId !== agentId) continue
    c.agentId = null
    connUpdates.push([c.id as string, c])
  }
  if (connUpdates.length) {
    upsertStoredItems('connectors', connUpdates)
    counts.connectors = connUpdates.length
  }

  // 5. Delegation jobs — cancel queued/running
  const delegationJobs = loadDelegationJobs()
  const djUpdates: Array<[string, unknown]> = []
  for (const d of Object.values(delegationJobs) as Array<Record<string, unknown>>) {
    if (!d || d.agentId !== agentId) continue
    const status = d.status as string | undefined
    if (status === 'queued' || status === 'running') {
      d.status = 'cancelled'
      djUpdates.push([d.id as string, d])
    }
  }
  if (djUpdates.length) {
    upsertStoredItems('delegation_jobs', djUpdates)
    counts.delegationJobs = djUpdates.length
  }

  // 6. Webhooks — disable
  const webhooks = loadWebhooks()
  const whUpdates: Array<[string, unknown]> = []
  for (const w of Object.values(webhooks) as Array<Record<string, unknown>>) {
    if (!w || w.agentId !== agentId) continue
    if (w.enabled === false) continue
    w.enabled = false
    whUpdates.push([w.id as string, w])
  }
  if (whUpdates.length) {
    upsertStoredItems('webhooks', whUpdates)
    counts.webhooks = whUpdates.length
  }

  // 7. Chatrooms — remove agent from member arrays
  counts.chatrooms = removeAgentFromChatrooms(agentId)

  return counts
}

// ── Hard-delete (permanent) ─────────────────────────────────────────────

/** Remove all entities referencing `agentId`. Called on permanent delete. */
export function purgeAgentReferences(agentId: string): CascadeCounts {
  const counts: CascadeCounts = { tasks: 0, schedules: 0, watchJobs: 0, connectors: 0, delegationJobs: 0, webhooks: 0, chatrooms: 0 }

  counts.tasks = deleteMatching('tasks', loadTasks(), agentId)
  counts.schedules = deleteMatching('schedules', loadSchedules(), agentId)
  counts.watchJobs = deleteMatching('watch_jobs', loadWatchJobs(), agentId)
  counts.delegationJobs = deleteMatching('delegation_jobs', loadDelegationJobs(), agentId)
  counts.webhooks = deleteMatching('webhooks', loadWebhooks(), agentId)

  // Connectors: detach agent but keep the connector record
  const connectors = loadConnectors()
  const connUpdates: Array<[string, unknown]> = []
  for (const c of Object.values(connectors) as Array<Record<string, unknown>>) {
    if (!c || c.agentId !== agentId) continue
    c.agentId = null
    connUpdates.push([c.id as string, c])
  }
  if (connUpdates.length) {
    upsertStoredItems('connectors', connUpdates)
    counts.connectors = connUpdates.length
  }

  counts.chatrooms = removeAgentFromChatrooms(agentId)

  return counts
}

// ── Restore helper ──────────────────────────────────────────────────────

/** Re-enable schedules that were paused by trash. */
export function restoreAgentSchedules(agentId: string): number {
  const schedules = loadSchedules()
  const updates: Array<[string, unknown]> = []
  for (const s of Object.values(schedules) as Array<Record<string, unknown>>) {
    if (!s || s.agentId !== agentId) continue
    if (!s.suspendedByTrash) continue
    s.enabled = true
    delete s.suspendedByTrash
    updates.push([s.id as string, s])
  }
  if (updates.length) {
    upsertStoredItems('schedules', updates)
  }
  return updates.length
}

// ── Internals ───────────────────────────────────────────────────────────

function deleteMatching(
  table: StorageCollection,
  collection: Record<string, Record<string, unknown>>,
  agentId: string,
): number {
  let count = 0
  for (const item of Object.values(collection)) {
    if (!item || item.agentId !== agentId) continue
    deleteStoredItem(table, item.id as string)
    count++
  }
  return count
}

function removeAgentFromChatrooms(agentId: string): number {
  const chatrooms = loadChatrooms()
  const updates: Array<[string, unknown]> = []
  for (const room of Object.values(chatrooms) as Array<Record<string, unknown>>) {
    if (!room) continue
    let changed = false
    if (Array.isArray(room.members)) {
      const members = room.members as unknown[]
      const before = members.length
      room.members = members.filter((m: unknown) => {
        if (typeof m === 'string') return m !== agentId
        if (m && typeof m === 'object' && 'agentId' in m) return (m as Record<string, unknown>).agentId !== agentId
        return true
      })
      if ((room.members as unknown[]).length !== before) changed = true
    }
    if (Array.isArray(room.agentIds)) {
      const agentIds = room.agentIds as string[]
      const before = agentIds.length
      room.agentIds = agentIds.filter((id) => id !== agentId)
      if ((room.agentIds as string[]).length !== before) changed = true
    }
    if (changed) updates.push([room.id as string, room])
  }
  if (updates.length) {
    upsertStoredItems('chatrooms', updates)
  }
  return updates.length
}
