import { NextResponse } from 'next/server'
import { loadUsage } from '@/lib/server/storage'

export async function GET() {
  const usage = loadUsage()
  // Compute summary
  let totalTokens = 0
  let totalCost = 0
  const bySession: Record<string, { tokens: number; cost: number; count: number }> = {}
  const byProvider: Record<string, { tokens: number; cost: number; count: number }> = {}

  for (const [sessionId, records] of Object.entries(usage)) {
    for (const r of records) {
      totalTokens += r.totalTokens || 0
      totalCost += r.estimatedCost || 0
      if (!bySession[sessionId]) bySession[sessionId] = { tokens: 0, cost: 0, count: 0 }
      bySession[sessionId].tokens += r.totalTokens || 0
      bySession[sessionId].cost += r.estimatedCost || 0
      bySession[sessionId].count++
      const prov = r.provider || 'unknown'
      if (!byProvider[prov]) byProvider[prov] = { tokens: 0, cost: 0, count: 0 }
      byProvider[prov].tokens += r.totalTokens || 0
      byProvider[prov].cost += r.estimatedCost || 0
      byProvider[prov].count++
    }
  }

  return NextResponse.json({
    totalTokens,
    totalCost: Math.round(totalCost * 10000) / 10000,
    bySession,
    byProvider,
    raw: usage,
  })
}
