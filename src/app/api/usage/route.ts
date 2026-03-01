import { NextResponse } from 'next/server'
import { loadUsage } from '@/lib/server/storage'
import type { UsageRecord } from '@/types'
export const dynamic = 'force-dynamic'

type Range = '24h' | '7d' | '30d'

const RANGE_MS: Record<Range, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

function bucketKey(ts: number, range: Range): string {
  const d = new Date(ts)
  if (range === '24h') {
    // hourly buckets: "2026-03-01T14"
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`
  }
  // daily buckets: "2026-03-01"
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const rangeParam = searchParams.get('range') ?? '24h'
  const range: Range = rangeParam === '7d' || rangeParam === '30d' ? rangeParam : '24h'

  const now = Date.now()
  const cutoff = now - RANGE_MS[range]

  const usage = loadUsage() as Record<string, UsageRecord[]>

  // Flatten and filter by time range
  const records: UsageRecord[] = []
  for (const sessionRecords of Object.values(usage)) {
    for (const r of sessionRecords) {
      if ((r.timestamp || 0) >= cutoff) {
        records.push(r)
      }
    }
  }

  // Compute summaries
  let totalTokens = 0
  let totalCost = 0
  const byAgent: Record<string, { tokens: number; cost: number }> = {}
  const byProvider: Record<string, { tokens: number; cost: number }> = {}
  const bucketMap: Record<string, { tokens: number; cost: number }> = {}

  for (const r of records) {
    const tokens = r.totalTokens || 0
    const cost = r.estimatedCost || 0
    totalTokens += tokens
    totalCost += cost

    // by provider
    const prov = r.provider || 'unknown'
    if (!byProvider[prov]) byProvider[prov] = { tokens: 0, cost: 0 }
    byProvider[prov].tokens += tokens
    byProvider[prov].cost += cost

    // by agent (using sessionId as proxy — agents map to sessions)
    const agentKey = r.sessionId || 'unknown'
    if (!byAgent[agentKey]) byAgent[agentKey] = { tokens: 0, cost: 0 }
    byAgent[agentKey].tokens += tokens
    byAgent[agentKey].cost += cost

    // time series bucketing
    const bk = bucketKey(r.timestamp || now, range)
    if (!bucketMap[bk]) bucketMap[bk] = { tokens: 0, cost: 0 }
    bucketMap[bk].tokens += tokens
    bucketMap[bk].cost += cost
  }

  // Sort time series
  const timeSeries = Object.entries(bucketMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, data]) => ({ bucket, tokens: data.tokens, cost: Math.round(data.cost * 10000) / 10000 }))

  // Provider health stats
  const healthAccum: Record<string, {
    totalRequests: number
    successCount: number
    errorCount: number
    lastUsed: number
    models: Set<string>
  }> = {}

  for (const r of records) {
    const prov = r.provider || 'unknown'
    if (!healthAccum[prov]) {
      healthAccum[prov] = { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: 0, models: new Set() }
    }
    const h = healthAccum[prov]
    h.totalRequests += 1
    // UsageRecord has no error/status field — logged records are successful completions
    h.successCount += 1
    if ((r.timestamp || 0) > h.lastUsed) h.lastUsed = r.timestamp || 0
    if (r.model) h.models.add(r.model)
  }

  const providerHealth: Record<string, {
    totalRequests: number
    successCount: number
    errorCount: number
    errorRate: number
    avgLatencyMs: number
    lastUsed: number
    models: string[]
  }> = {}

  for (const [prov, h] of Object.entries(healthAccum)) {
    providerHealth[prov] = {
      totalRequests: h.totalRequests,
      successCount: h.successCount,
      errorCount: h.errorCount,
      errorRate: h.totalRequests > 0 ? h.errorCount / h.totalRequests : 0,
      avgLatencyMs: 0, // UsageRecord does not track latency
      lastUsed: h.lastUsed,
      models: Array.from(h.models),
    }
  }

  return NextResponse.json({
    records,
    totalTokens,
    totalCost: Math.round(totalCost * 10000) / 10000,
    byAgent,
    byProvider,
    timeSeries,
    providerHealth,
  })
}
