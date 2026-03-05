import { NextResponse } from 'next/server'
import { loadUsage, loadSessions, loadAgents } from '@/lib/server/storage'
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

  // Build session→agent lookup
  const sessions = loadSessions() as Record<string, { agentId?: string }>
  const agents = loadAgents() as Record<string, { name?: string }>

  // Compute summaries
  let totalTokens = 0
  let totalCost = 0
  const byAgent: Record<string, { name: string; cost: number; tokens: number; count: number }> = {}
  const byProvider: Record<string, { tokens: number; cost: number }> = {}
  const byPlugin: Record<string, { definitionTokens: number; invocationTokens: number; invocations: number; estimatedCost: number }> = {}
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

    // by agent — resolve sessionId → agentId → agent name
    const session = r.sessionId ? sessions[r.sessionId] : undefined
    const agentId = session?.agentId || 'unknown'
    const agentName = agentId !== 'unknown' && agents[agentId]?.name
      ? agents[agentId].name
      : agentId
    if (!byAgent[agentId]) byAgent[agentId] = { name: agentName, cost: 0, tokens: 0, count: 0 }
    byAgent[agentId].cost += cost
    byAgent[agentId].tokens += tokens
    byAgent[agentId].count += 1

    // by plugin — definition costs (context overhead per LLM call)
    if (Array.isArray(r.pluginDefinitionCosts)) {
      for (const dc of r.pluginDefinitionCosts) {
        if (!dc.pluginId) continue
        if (!byPlugin[dc.pluginId]) byPlugin[dc.pluginId] = { definitionTokens: 0, invocationTokens: 0, invocations: 0, estimatedCost: 0 }
        byPlugin[dc.pluginId].definitionTokens += dc.estimatedTokens || 0
      }
    }

    // by plugin — invocation costs (actual tool calls)
    if (Array.isArray(r.pluginInvocations)) {
      for (const inv of r.pluginInvocations) {
        if (!inv.pluginId) continue
        if (!byPlugin[inv.pluginId]) byPlugin[inv.pluginId] = { definitionTokens: 0, invocationTokens: 0, invocations: 0, estimatedCost: 0 }
        const p = byPlugin[inv.pluginId]
        p.invocationTokens += (inv.inputTokens || 0) + (inv.outputTokens || 0)
        p.invocations += 1
      }
    }

    // time series bucketing
    const bk = bucketKey(r.timestamp || now, range)
    if (!bucketMap[bk]) bucketMap[bk] = { tokens: 0, cost: 0 }
    bucketMap[bk].tokens += tokens
    bucketMap[bk].cost += cost
  }

  // Estimate per-plugin cost using the average input token rate from total usage
  if (totalTokens > 0 && totalCost > 0) {
    const avgCostPerToken = totalCost / totalTokens
    for (const p of Object.values(byPlugin)) {
      p.estimatedCost = Math.round((p.definitionTokens + p.invocationTokens) * avgCostPerToken * 10000) / 10000
    }
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
    totalDurationMs: number
    latencyCount: number
  }> = {}

  for (const r of records) {
    const prov = r.provider || 'unknown'
    if (!healthAccum[prov]) {
      healthAccum[prov] = { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: 0, models: new Set(), totalDurationMs: 0, latencyCount: 0 }
    }
    const h = healthAccum[prov]
    h.totalRequests += 1
    // UsageRecord has no error/status field — logged records are successful completions
    h.successCount += 1
    if ((r.timestamp || 0) > h.lastUsed) h.lastUsed = r.timestamp || 0
    if (r.model) h.models.add(r.model)
    
    if (typeof r.durationMs === 'number' && r.durationMs > 0) {
      h.totalDurationMs += r.durationMs
      h.latencyCount += 1
    }
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
      avgLatencyMs: h.latencyCount > 0 ? h.totalDurationMs / h.latencyCount : 0,
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
    byPlugin,
    timeSeries,
    providerHealth,
  })
}
