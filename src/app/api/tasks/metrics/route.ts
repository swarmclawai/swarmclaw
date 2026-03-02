import { NextResponse } from 'next/server'
import { loadTasks, loadAgents } from '@/lib/server/storage'

type Range = '24h' | '7d' | '30d'

const RANGE_MS: Record<Range, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
  '30d': 30 * 86400_000,
}

function bucketKey(ts: number, range: Range): string {
  const d = new Date(ts)
  if (range === '24h') return d.toISOString().slice(0, 13) // "2026-03-01T14"
  return d.toISOString().slice(0, 10) // "2026-03-01"
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const range = (searchParams.get('range') as Range) || '7d'
  const cutoff = Date.now() - (RANGE_MS[range] || RANGE_MS['7d'])

  const tasks = loadTasks()
  const agents = loadAgents()
  const all = Object.values(tasks)

  // --- by-status counts ---
  const byStatus: Record<string, number> = {}
  for (const t of all) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1
  }

  // WIP = queued + running
  const wip = (byStatus['queued'] || 0) + (byStatus['running'] || 0)

  // --- completions in range ---
  const completedInRange = all.filter(
    (t) => t.status === 'completed' && t.completedAt && t.completedAt >= cutoff,
  )

  // --- cycle times (queuedAt → completedAt) ---
  const cycleTimes: number[] = []
  for (const t of completedInRange) {
    const start = t.queuedAt || t.createdAt
    const end = t.completedAt!
    if (end > start) cycleTimes.push(end - start)
  }
  cycleTimes.sort((a, b) => a - b)

  const avgCycleMs = cycleTimes.length
    ? Math.round(cycleTimes.reduce((s, v) => s + v, 0) / cycleTimes.length)
    : 0
  const p50CycleMs = cycleTimes.length ? cycleTimes[Math.floor(cycleTimes.length * 0.5)] : 0
  const p90CycleMs = cycleTimes.length ? cycleTimes[Math.floor(cycleTimes.length * 0.9)] : 0

  // --- velocity (completions per bucket) ---
  const velocityMap: Record<string, number> = {}
  for (const t of completedInRange) {
    const key = bucketKey(t.completedAt!, range)
    velocityMap[key] = (velocityMap[key] || 0) + 1
  }
  const velocity = Object.entries(velocityMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, count]) => ({ bucket, count }))

  // --- by-agent completions ---
  const byAgent: Record<string, { agentName: string; completed: number; failed: number }> = {}
  const recentTasks = all.filter(
    (t) => (t.completedAt && t.completedAt >= cutoff) || (t.status === 'failed' && t.updatedAt >= cutoff),
  )
  for (const t of recentTasks) {
    if (!t.agentId) continue
    if (!byAgent[t.agentId]) {
      const agent = agents[t.agentId]
      byAgent[t.agentId] = { agentName: agent?.name || t.agentId, completed: 0, failed: 0 }
    }
    if (t.status === 'completed') byAgent[t.agentId].completed++
    else if (t.status === 'failed') byAgent[t.agentId].failed++
  }
  const byAgentList = Object.values(byAgent).sort((a, b) => b.completed - a.completed)

  // --- by-priority counts ---
  const byPriority: Record<string, number> = {}
  for (const t of all) {
    const p = t.priority || 'none'
    byPriority[p] = (byPriority[p] || 0) + 1
  }

  return NextResponse.json({
    range,
    byStatus,
    wip,
    completedCount: completedInRange.length,
    avgCycleMs,
    p50CycleMs,
    p90CycleMs,
    velocity,
    byAgent: byAgentList,
    byPriority,
  })
}
