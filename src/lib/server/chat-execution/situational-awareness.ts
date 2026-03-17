import { listAgentIncidents } from '@/lib/server/autonomy/supervisor-incident-repository'
import { listAgents } from '@/lib/server/agents/agent-repository'
import { loadChatrooms } from '@/lib/server/chatrooms/chatroom-repository'
import { loadConnectors } from '@/lib/server/connectors/connector-repository'
import { loadMission } from '@/lib/server/missions/mission-repository'
import { loadSchedules } from '@/lib/server/schedules/schedule-repository'
import { loadTasks } from '@/lib/server/tasks/task-repository'
import { loadUsage } from '@/lib/server/usage/usage-repository'
import { listPersistedRuns } from '@/lib/server/runtime/run-ledger'
import type { BoardTask, Mission, Schedule, SupervisorIncident, SessionRunRecord } from '@/types'

export interface SituationalAwarenessInput {
  agentId: string
  sessionId: string
  missionId?: string | null
}

/** Pre-loaded data passed to the pure formatter. Exported for testing. */
export interface SituationalAwarenessData {
  tasks: BoardTask[]
  schedules: Schedule[]
  failedRuns: SessionRunRecord[]
  incidents: SupervisorIncident[]
  mission: Mission | null
  now: number
}

const MAX_CHARS = 3200
const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000
const DEDUP_WINDOW_MS = 5000
const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'backlog'])

// --- helpers ---

export function timeAgo(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function formatNextRun(nextRunAt: number | undefined | null, now: number): string {
  if (!nextRunAt) return 'unknown'
  const diff = nextRunAt - now
  if (diff <= 0) return 'overdue'
  if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)}m`
  if (diff < 86_400_000) return `in ${Math.ceil(diff / 3_600_000)}h`
  const date = new Date(nextRunAt)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function scheduleFrequencyLabel(s: Schedule): string {
  if (s.frequency) return s.frequency
  if (s.cron) return `cron ${s.cron}`
  if (s.intervalMs) {
    const hrs = s.intervalMs / 3_600_000
    if (hrs >= 1) return `every ${hrs}h`
    return `every ${Math.round(s.intervalMs / 60_000)}m`
  }
  return 'once'
}

// --- failure merging & dedup ---

interface FailureEntry {
  timestamp: number
  label: string
  remedy?: string | null
}

function mergeFailures(
  failedRuns: SessionRunRecord[],
  incidents: SupervisorIncident[],
  now: number,
): FailureEntry[] {
  const cutoff = now - SEVENTY_TWO_HOURS_MS
  const entries: FailureEntry[] = []

  for (const run of failedRuns) {
    const ts = run.endedAt || run.startedAt || run.queuedAt
    if (ts < cutoff) continue
    entries.push({
      timestamp: ts,
      label: `run_error: ${run.error || run.messagePreview || 'unknown'}`.slice(0, 120),
    })
  }

  for (const incident of incidents) {
    if (incident.createdAt < cutoff) continue
    entries.push({
      timestamp: incident.createdAt,
      label: `${incident.kind}: ${incident.summary}`.slice(0, 120),
      remedy: incident.remediation || null,
    })
  }

  entries.sort((a, b) => b.timestamp - a.timestamp)

  const deduped: FailureEntry[] = []
  for (const entry of entries) {
    const isDupe = deduped.some(
      (existing) => Math.abs(existing.timestamp - entry.timestamp) < DEDUP_WINDOW_MS,
    )
    if (!isDupe) deduped.push(entry)
  }

  return deduped.slice(0, 3)
}

// --- predictive signals ---

function buildPredictiveSignalsSection(incidents: SupervisorIncident[], now: number): string | null {
  const cutoff = now - SEVENTY_TWO_HOURS_MS
  const familyCounts = new Map<string, { count: number; lastRemedy: string | null }>()

  for (const incident of incidents) {
    if (incident.createdAt < cutoff) continue
    const family = incident.failureFamily
    if (!family) continue
    const entry = familyCounts.get(family) || { count: 0, lastRemedy: null }
    entry.count += 1
    if (incident.remediation && !entry.lastRemedy) entry.lastRemedy = incident.remediation
    familyCounts.set(family, entry)
  }

  const warnings: string[] = []
  for (const [family, { count, lastRemedy }] of familyCounts) {
    if (count < 3) continue
    let line = `- WARNING: ${family} (${count}x in 72h) — recurring pattern, likely to recur`
    if (lastRemedy) line += `. Suggested: ${lastRemedy.slice(0, 100)}`
    warnings.push(line)
  }

  if (warnings.length === 0) return null
  return ['### Predictive Warnings', ...warnings].join('\n')
}

// --- section builders ---

function buildTasksSection(tasks: BoardTask[], now: number): string | null {
  if (tasks.length === 0) return null
  const lines = [`### Active Tasks (${tasks.length})`]
  for (const t of tasks) {
    const age = t.createdAt ? ` (${timeAgo(t.createdAt, now)})` : ''
    lines.push(`- [${t.status}] ${t.title.slice(0, 80)}${age}`)
  }
  return lines.join('\n')
}

function buildSchedulesSection(schedules: Schedule[], now: number): string | null {
  if (schedules.length === 0) return null
  const lines = ['### My Schedule']
  for (const s of schedules) {
    const next = formatNextRun(s.nextRunAt, now)
    const freq = scheduleFrequencyLabel(s)
    lines.push(`- ${s.name}: next run ${next} (${freq})`)
  }
  return lines.join('\n')
}

function buildFailuresSection(failures: FailureEntry[], now: number): string | null {
  if (failures.length === 0) return null
  const lines = ['### Recent Failures']
  for (const f of failures) {
    let line = `- [${timeAgo(f.timestamp, now)}] ${f.label}`
    if (f.remedy) line += ` -- remedy: ${f.remedy.slice(0, 100)}`
    lines.push(line)
  }
  return lines.join('\n')
}

export function buildGoalAncestrySection(missionId: string | null | undefined): string | null {
  if (!missionId) return null
  const chain: string[] = []
  let currentId: string | null = missionId
  const visited = new Set<string>()
  while (currentId && chain.length < 10) {
    if (visited.has(currentId)) break
    visited.add(currentId)
    const mission = loadMission(currentId)
    if (!mission) break
    chain.unshift(mission.objective.slice(0, 80))
    currentId = mission.parentMissionId || null
  }
  if (chain.length <= 1) return null
  return `### Goal Ancestry\n${chain.map((obj, i) => `${'  '.repeat(i)}${i === chain.length - 1 ? '→' : '↓'} ${obj}`).join('\n')}`
}

function buildMissionSection(mission: Mission | null): string | null {
  if (!mission) return null
  if (mission.status === 'completed' || mission.status === 'failed' || mission.status === 'cancelled') return null
  return `### Current Mission\nObjective: ${mission.objective.slice(0, 100)} | Status: ${mission.status} | Phase: ${mission.phase}`
}

// --- pure formatter (testable) ---

export function formatSituationalAwareness(data: SituationalAwarenessData): string {
  const { tasks, schedules, failedRuns, incidents, mission, now } = data

  const filteredTasks = tasks
    .filter((t) => ACTIVE_TASK_STATUSES.has(t.status))
    .sort((a, b) => {
      const order = { running: 0, queued: 1, backlog: 2 } as Record<string, number>
      return (order[a.status] ?? 3) - (order[b.status] ?? 3)
    })
    .slice(0, 5)

  const filteredSchedules = schedules
    .filter((s) => s.status === 'active')
    .sort((a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity))
    .slice(0, 3)

  const failures = mergeFailures(failedRuns, incidents, now)

  const sections: string[] = []
  let charCount = 0
  const header = '## My Situational Awareness'

  // Priority 1: Active Tasks
  const tasksSection = buildTasksSection(filteredTasks, now)
  if (tasksSection && charCount + tasksSection.length + header.length < MAX_CHARS) {
    sections.push(tasksSection)
    charCount += tasksSection.length
  }

  // Priority 2: Recent Failures
  const failuresSection = buildFailuresSection(failures, now)
  if (failuresSection && charCount + failuresSection.length + header.length < MAX_CHARS) {
    sections.push(failuresSection)
    charCount += failuresSection.length
  }

  // Priority 2.5: Predictive Warnings (recurring failure families)
  const predictiveSection = buildPredictiveSignalsSection(incidents, now)
  if (predictiveSection && charCount + predictiveSection.length + header.length < MAX_CHARS) {
    sections.push(predictiveSection)
    charCount += predictiveSection.length
  }

  // Priority 3: Schedules
  const schedulesSection = buildSchedulesSection(filteredSchedules, now)
  if (schedulesSection && charCount + schedulesSection.length + header.length < MAX_CHARS) {
    sections.push(schedulesSection)
    charCount += schedulesSection.length
  }

  // Priority 4: Mission
  const missionSection = buildMissionSection(mission)
  if (missionSection && charCount + missionSection.length + header.length < MAX_CHARS) {
    sections.push(missionSection)
    charCount += missionSection.length
  }

  if (sections.length === 0) return ''

  return [header, ...sections].join('\n\n')
}

// --- platform status summary (for orchestrator wake prompts) ---

export function buildPlatformStatusSummary(): string {
  const now = Date.now()
  const oneHourAgo = now - 3_600_000
  const oneDayAgo = now - 86_400_000

  // Agents
  const agents = Object.values(listAgents())
  const activeAgents = agents.filter((a) => a.lastUsedAt && a.lastUsedAt > oneHourAgo)

  // Tasks
  const allTasks = Object.values(loadTasks() as Record<string, BoardTask>)
  const queued = allTasks.filter((t) => t.status === 'queued').length
  const running = allTasks.filter((t) => t.status === 'running').length
  const failed24h = allTasks.filter((t) => t.status === 'failed' && t.updatedAt && t.updatedAt > oneDayAgo).length

  // Schedules
  const allSchedules = Object.values(loadSchedules())
  const activeSchedules = allSchedules.filter((s) => s.status === 'active')
  const overdueSchedules = activeSchedules.filter((s) => s.nextRunAt && s.nextRunAt < now)

  // Connectors
  const connectors = Object.values(loadConnectors())
  const connectorLines: string[] = []
  for (const c of connectors) {
    const status = c.status === 'running' ? '✓' : `✗ (${c.status})`
    connectorLines.push(`${c.platform || c.id} ${status}`)
  }

  // Chatrooms
  const chatrooms = Object.values(loadChatrooms())
  const activeChatrooms = chatrooms.filter((c) => !c.archivedAt && !c.temporary)

  // Incidents
  const recentIncidents = listAgentIncidents().filter((i) => i.createdAt > oneDayAgo)
  const warnings = recentIncidents.filter((i) => i.severity === 'medium').length
  const errors = recentIncidents.filter((i) => i.severity === 'high').length

  // Budget (today's spend)
  const todaySpend = computeTodaySpend(oneDayAgo)

  const lines = [
    '## Platform Status',
    `- Agents: ${agents.filter((a) => !a.disabled && !a.trashedAt).length} total (${activeAgents.length} active in last hour)`,
    `- Tasks: ${queued} queued, ${running} running${failed24h ? `, ${failed24h} failed (last 24h)` : ''}`,
    `- Schedules: ${activeSchedules.length} active${overdueSchedules.length ? `, ${overdueSchedules.length} overdue` : ''}`,
  ]

  if (connectorLines.length > 0) {
    lines.push(`- Connectors: ${connectorLines.join(', ')}`)
  }

  if (recentIncidents.length > 0) {
    lines.push(`- Incidents: ${recentIncidents.length} open (${warnings} warning, ${errors} error)`)
  }

  if (activeChatrooms.length > 0) {
    lines.push(`- Chatrooms: ${activeChatrooms.length} active`)
  }

  if (todaySpend > 0) {
    lines.push(`- Budget: $${todaySpend.toFixed(2)} today`)
  }

  return lines.join('\n')
}

function computeTodaySpend(sinceTs: number): number {
  try {
    const usage = loadUsage()
    let total = 0
    for (const records of Object.values(usage)) {
      for (const r of records) {
        if (r.timestamp >= sinceTs) total += r.estimatedCost || 0
      }
    }
    return total
  } catch {
    return 0
  }
}

// --- main builder (loads data, calls formatter) ---

export function buildSituationalAwarenessBlock(input: SituationalAwarenessInput): string {
  const { agentId, sessionId, missionId } = input
  const now = Date.now()

  const allTasks = loadTasks() as Record<string, BoardTask>
  const tasks = Object.values(allTasks).filter((t) => t.agentId === agentId)

  const allSchedules = loadSchedules()
  const schedules = Object.values(allSchedules).filter((s) => s.agentId === agentId)

  const failedRuns = listPersistedRuns({ sessionId, status: 'failed', limit: 10 })

  const incidents = listAgentIncidents(agentId)

  const mission = missionId ? loadMission(missionId) : null

  return formatSituationalAwareness({ tasks, schedules, failedRuns, incidents, mission, now })
}
