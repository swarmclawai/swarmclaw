/**
 * Cascade operations for agent trash / permanent-delete.
 *
 * When an agent is trashed, related entities (tasks, schedules, watch jobs,
 * connectors, webhooks, delegation jobs, chatroom memberships) must be
 * suspended to prevent phantom daemon activity. On permanent delete the
 * referencing rows are hard-removed.
 */

import {
  deleteDelegationJob,
  loadDelegationJobs,
  saveDelegationJobRecords,
} from '@/lib/server/agents/delegation-job-repository'
import { loadChatrooms, saveChatrooms } from '@/lib/server/chatrooms/chatroom-repository'
import { loadConnectors, saveConnectors } from '@/lib/server/connectors/connector-repository'
import { deleteWatchJob, loadWatchJobs, upsertWatchJobs } from '@/lib/server/runtime/watch-job-repository'
import { deleteSchedule, loadSchedules, upsertSchedules } from '@/lib/server/schedules/schedule-repository'
import { deleteTask, loadTasks, saveTaskMany } from '@/lib/server/tasks/task-repository'
import { loadWebhooks, saveWebhooks } from '@/lib/server/webhooks/webhook-repository'

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
  const taskUpdates: Array<[string, Record<string, unknown>]> = []
  for (const t of Object.values(tasks) as unknown as Array<Record<string, unknown>>) {
    if (!t || t.agentId !== agentId) continue
    const status = t.status as string | undefined
    if (status === 'backlog' || status === 'queued' || status === 'running') {
      t.status = 'cancelled'
      t.cancelledAt = now
      taskUpdates.push([t.id as string, t])
    }
  }
  if (taskUpdates.length) {
    saveTaskMany(taskUpdates)
    counts.tasks = taskUpdates.length
  }

  // 2. Schedules — pause (with marker for restore)
  const schedules = loadSchedules()
  const schedUpdates: Array<[string, Record<string, unknown>]> = []
  for (const s of Object.values(schedules) as unknown as Array<Record<string, unknown>>) {
    if (!s || s.agentId !== agentId) continue
    if (s.enabled === false) continue
    s.enabled = false
    s.suspendedByTrash = true
    schedUpdates.push([s.id as string, s])
  }
  if (schedUpdates.length) {
    upsertSchedules(schedUpdates)
    counts.schedules = schedUpdates.length
  }

  // 3. Watch jobs — cancel active
  const watchJobs = loadWatchJobs()
  const wjUpdates: Array<[string, Record<string, unknown>]> = []
  for (const w of Object.values(watchJobs) as unknown as Array<Record<string, unknown>>) {
    if (!w || w.agentId !== agentId) continue
    if (w.status === 'cancelled') continue
    w.status = 'cancelled'
    wjUpdates.push([w.id as string, w])
  }
  if (wjUpdates.length) {
    upsertWatchJobs(wjUpdates)
    counts.watchJobs = wjUpdates.length
  }

  // 4. Connectors — detach agent (keep connector alive but unrouted)
  {
    const connectors = loadConnectors()
    let connectorUpdates = 0
    for (const c of Object.values(connectors)) {
      if (!c || c.agentId !== agentId) continue
      c.agentId = null
      connectorUpdates += 1
    }
    if (connectorUpdates > 0) {
      saveConnectors(connectors)
      counts.connectors = connectorUpdates
    }
  }

  // 5. Delegation jobs — cancel queued/running
  const delegationJobs = loadDelegationJobs()
  const djUpdates: Array<[string, Record<string, unknown>]> = []
  for (const d of Object.values(delegationJobs) as unknown as Array<Record<string, unknown>>) {
    if (!d || d.agentId !== agentId) continue
    const status = d.status as string | undefined
    if (status === 'queued' || status === 'running') {
      d.status = 'cancelled'
      djUpdates.push([d.id as string, d])
    }
  }
  if (djUpdates.length) {
    saveDelegationJobRecords(djUpdates)
    counts.delegationJobs = djUpdates.length
  }

  // 6. Webhooks — disable
  const webhooks = loadWebhooks()
  let webhookUpdates = 0
  for (const w of Object.values(webhooks)) {
    if (!w || w.agentId !== agentId) continue
    if (w.enabled === false) continue
    w.enabled = false
    webhookUpdates += 1
  }
  if (webhookUpdates > 0) {
    saveWebhooks(webhooks)
    counts.webhooks = webhookUpdates
  }

  // 7. Chatrooms — remove agent from member arrays
  counts.chatrooms = removeAgentFromChatrooms(agentId)

  return counts
}

// ── Hard-delete (permanent) ─────────────────────────────────────────────

/** Remove all entities referencing `agentId`. Called on permanent delete. */
export function purgeAgentReferences(agentId: string): CascadeCounts {
  const counts: CascadeCounts = { tasks: 0, schedules: 0, watchJobs: 0, connectors: 0, delegationJobs: 0, webhooks: 0, chatrooms: 0 }

  counts.tasks = deleteMatching(loadTasks(), agentId, deleteTask)
  counts.schedules = deleteMatching(loadSchedules(), agentId, deleteSchedule)
  counts.watchJobs = deleteMatching(loadWatchJobs(), agentId, deleteWatchJob)
  counts.delegationJobs = deleteMatching(loadDelegationJobs(), agentId, deleteDelegationJob)
  counts.webhooks = purgeWebhooks(agentId)

  // Connectors: detach agent but keep the connector record
  {
    const connectors = loadConnectors()
    let connectorUpdates = 0
    for (const c of Object.values(connectors)) {
      if (!c || c.agentId !== agentId) continue
      c.agentId = null
      connectorUpdates += 1
    }
    if (connectorUpdates > 0) {
      saveConnectors(connectors)
      counts.connectors = connectorUpdates
    }
  }

  counts.chatrooms = removeAgentFromChatrooms(agentId)

  return counts
}

// ── Restore helper ──────────────────────────────────────────────────────

/** Re-enable schedules that were paused by trash. */
export function restoreAgentSchedules(agentId: string): number {
  const schedules = loadSchedules()
  const updates: Array<[string, Record<string, unknown>]> = []
  for (const s of Object.values(schedules) as unknown as Array<Record<string, unknown>>) {
    if (!s || s.agentId !== agentId) continue
    if (!s.suspendedByTrash) continue
    s.enabled = true
    delete s.suspendedByTrash
    updates.push([s.id as string, s])
  }
  if (updates.length) {
    upsertSchedules(updates)
  }
  return updates.length
}

// ── Internals ───────────────────────────────────────────────────────────

function deleteMatching<T extends { agentId?: string | null; id?: string | null }>(
  collection: Record<string, T>,
  agentId: string,
  deleteItem: (id: string) => void,
): number {
  let count = 0
  for (const item of Object.values(collection)) {
    if (!item || item.agentId !== agentId) continue
    if (!item.id) continue
    deleteItem(item.id)
    count++
  }
  return count
}

function removeAgentFromChatrooms(agentId: string): number {
  const chatrooms = loadChatrooms()
  let changedCount = 0
  for (const room of Object.values(chatrooms) as unknown as Array<Record<string, unknown>>) {
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
    if (changed) changedCount += 1
  }
  if (changedCount > 0) {
    saveChatrooms(chatrooms)
  }
  return changedCount
}

function purgeWebhooks(agentId: string): number {
  const webhooks = loadWebhooks() as Record<string, Record<string, unknown>>
  const remaining: Record<string, Record<string, unknown>> = {}
  let count = 0
  for (const [id, webhook] of Object.entries(webhooks)) {
    if (webhook && webhook.agentId === agentId) {
      count += 1
      continue
    }
    remaining[id] = webhook
  }
  if (count > 0) {
    saveWebhooks(remaining)
  }
  return count
}
