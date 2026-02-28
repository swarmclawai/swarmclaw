'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api-client'

interface UsageData {
  totalTokens: number
  totalCost: number
  byProvider: Record<string, { cost: number; tokens: number; requests: number }>
  bySession: Record<string, { cost: number; tokens: number; requests: number }>
  raw: unknown[]
}

export function UsageList() {
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<UsageData>('GET', '/usage')
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-3 text-[13px]">
        Loading usage...
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-3 text-[13px]">
        Failed to load usage data
      </div>
    )
  }

  const providers = Object.entries(data.byProvider || {}).sort(
    ([, a], [, b]) => b.cost - a.cost
  )

  const formatCost = (cost: number) =>
    cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`

  const formatTokens = (tokens: number) => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
    return String(tokens)
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 pb-20">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 mb-4 mt-1">
        <div className="p-3 rounded-[12px] bg-white/[0.03] border border-white/[0.06]">
          <div className="text-[10px] font-600 text-text-3 uppercase tracking-wider mb-1">Total Cost</div>
          <div className="text-[18px] font-700 text-text tracking-tight">{formatCost(data.totalCost)}</div>
        </div>
        <div className="p-3 rounded-[12px] bg-white/[0.03] border border-white/[0.06]">
          <div className="text-[10px] font-600 text-text-3 uppercase tracking-wider mb-1">Total Tokens</div>
          <div className="text-[18px] font-700 text-text tracking-tight">{formatTokens(data.totalTokens)}</div>
        </div>
      </div>

      {/* Provider breakdown */}
      <div className="mb-2">
        <h3 className="text-[11px] font-600 text-text-3 uppercase tracking-wider px-1 mb-2">By Provider</h3>
        {providers.length === 0 ? (
          <div className="text-center py-6 text-[12px] text-text-3/60">No usage data yet</div>
        ) : (
          <div className="space-y-1.5">
            {providers.map(([provider, stats]) => {
              const pct = data.totalCost > 0 ? (stats.cost / data.totalCost) * 100 : 0
              return (
                <div
                  key={provider}
                  className="p-3 rounded-[10px] bg-surface border border-white/[0.06] hover:bg-surface-2 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[13px] font-600 text-text capitalize">{provider}</span>
                    <span className="text-[13px] font-700 text-text tabular-nums">{formatCost(stats.cost)}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-text-3">
                    <span>{formatTokens(stats.tokens)} tokens</span>
                    <span>{stats.requests} requests</span>
                    <span className="ml-auto">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="mt-2 h-1 rounded-full bg-white/[0.04] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#6366F1]/60"
                      style={{ width: `${Math.max(pct, 1)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
