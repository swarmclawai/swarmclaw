'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'
import type { BoardTask } from '@/types'

type Range = '24h' | '7d' | '30d'

interface TimePoint {
  bucket: string
  tokens: number
  cost: number
}

interface ProviderHealthEntry {
  totalRequests: number
  successCount: number
  errorCount: number
  errorRate: number
  avgLatencyMs: number
  lastUsed: number
  models: string[]
}

interface UsageResponse {
  records: unknown[]
  totalTokens: number
  totalCost: number
  byAgent: Record<string, { tokens: number; cost: number }>
  byProvider: Record<string, { tokens: number; cost: number }>
  timeSeries: TimePoint[]
  providerHealth?: Record<string, ProviderHealthEntry>
}

const RANGES: Range[] = ['24h', '7d', '30d']
const RANGE_LABELS: Record<Range, string> = { '24h': '24 Hours', '7d': '7 Days', '30d': '30 Days' }

const CHART_COLORS = [
  '#818CF8', '#34D399', '#F59E0B', '#F87171',
  '#A78BFA', '#2DD4BF', '#FB923C', '#E879F9',
  '#60A5FA', '#4ADE80',
]

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function formatBucketLabel(bucket: string, range: Range): string {
  if (range === '24h') {
    // "2026-03-01T14" → "14:00"
    const hour = bucket.split('T')[1]
    return hour ? `${hour}:00` : bucket
  }
  // "2026-03-01" → "Mar 1"
  const parts = bucket.split('-')
  if (parts.length === 3) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const monthIdx = parseInt(parts[1], 10) - 1
    return `${months[monthIdx]} ${parseInt(parts[2], 10)}`
  }
  return bucket
}

function formatRelativeTime(ts: number): string {
  if (!ts) return 'Never'
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function errorRateColor(rate: number): string {
  if (rate < 0.05) return 'text-emerald-400'
  if (rate < 0.2) return 'text-amber-400'
  return 'text-red-400'
}

function computeCompletionRate(tasks: Record<string, BoardTask>): number {
  const all = Object.values(tasks)
  const eligible = all.filter((t) => t.status !== 'backlog' && t.status !== 'archived')
  if (eligible.length === 0) return 0
  const completed = eligible.filter((t) => t.status === 'completed').length
  return Math.round((completed / eligible.length) * 100)
}

export function MetricsDashboard() {
  const [range, setRange] = useState<Range>('24h')
  const [data, setData] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const tasks = useAppStore((s) => s.tasks)
  const loadTasks = useAppStore((s) => s.loadTasks)

  const loadData = useCallback(async () => {
    try {
      const res = await api<UsageResponse>('GET', `/usage?range=${range}`)
      setData(res)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => {
    setLoading(true)
    loadData()
  }, [loadData])

  useEffect(() => {
    loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useWs('usage', loadData, 30_000)

  const completionRate = computeCompletionRate(tasks)

  // Prepare chart data
  const timeSeriesFormatted = (data?.timeSeries ?? []).map((pt) => ({
    ...pt,
    label: formatBucketLabel(pt.bucket, range),
  }))

  const providerData = Object.entries(data?.byProvider ?? {}).map(([name, v]) => ({
    name,
    cost: Math.round(v.cost * 10000) / 10000,
    tokens: v.tokens,
  }))

  const agentData = Object.entries(data?.byAgent ?? {})
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 10)
    .map(([name, v]) => ({
      name: name.length > 12 ? name.slice(0, 12) + '…' : name,
      cost: Math.round(v.cost * 10000) / 10000,
    }))

  const tooltipStyle = {
    contentStyle: {
      background: '#1a1a2e',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8,
      fontSize: 12,
      color: '#e0e0e0',
    },
    itemStyle: { color: '#e0e0e0' },
    labelStyle: { color: '#a0a0b0' },
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto">
      <div className="px-8 pt-6 pb-4 shrink-0">
        <h1 className="font-display text-[28px] font-800 tracking-[-0.03em]">Usage</h1>
        <p className="text-[13px] text-text-3 mt-1">Token usage, cost tracking &amp; agent performance</p>
      </div>

      {/* Range tabs */}
      <div className="px-8 pb-4 shrink-0">
        <div className="flex gap-1 bg-surface-2 rounded-[10px] p-1 w-fit">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3.5 py-1.5 rounded-[8px] text-[12px] font-600 transition-all cursor-pointer ${
                range === r
                  ? 'bg-accent-soft text-accent-bright'
                  : 'text-text-3 hover:text-text-2'
              }`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-text-3 text-[13px]">Loading metrics…</p>
        </div>
      ) : (
        <div className="px-8 pb-8 space-y-6">
          {/* Stats cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total Tokens" value={formatTokens(data?.totalTokens ?? 0)} />
            <StatCard label="Total Cost" value={formatCost(data?.totalCost ?? 0)} />
            <StatCard label="Requests" value={String(data?.records.length ?? 0)} />
            <StatCard label="Completion Rate" value={`${completionRate}%`} />
          </div>

          {/* Token usage over time */}
          <ChartCard title="Token Usage Over Time">
            {timeSeriesFormatted.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={timeSeriesFormatted} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="label" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatTokens} />
                  <Tooltip {...tooltipStyle} formatter={(value: number | undefined) => [formatTokens(value ?? 0), 'Tokens']} />
                  <Line type="monotone" dataKey="tokens" stroke="#818CF8" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#818CF8' }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </ChartCard>

          {/* Cost by provider + cost by agent */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ChartCard title="Cost by Provider">
              {providerData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={providerData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="name" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v}`} />
                    <Tooltip {...tooltipStyle} formatter={(value: number | undefined) => [formatCost(value ?? 0), 'Cost']} />
                    <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                      {providerData.map((_entry, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </ChartCard>

            <ChartCard title="Cost by Session">
              {agentData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={agentData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={2}
                      dataKey="cost"
                      nameKey="name"
                    >
                      {agentData.map((_entry, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip {...tooltipStyle} formatter={(value: number | undefined) => [formatCost(value ?? 0), 'Cost']} />
                    <Legend
                      verticalAlign="bottom"
                      iconType="circle"
                      iconSize={8}
                      formatter={(value: string) => <span style={{ color: '#a0a0b0', fontSize: 11 }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </ChartCard>
          </div>

          {/* Provider Health */}
          {data?.providerHealth && Object.keys(data.providerHealth).length > 0 && (
            <div>
              <h3 className="font-display text-[14px] font-600 text-text-2 mb-3">Provider Health</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Object.entries(data.providerHealth)
                  .sort(([, a], [, b]) => b.totalRequests - a.totalRequests)
                  .map(([name, h]) => (
                    <div
                      key={name}
                      className="bg-surface-2 rounded-[12px] p-4 border border-white/[0.04] flex flex-col gap-3"
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-[14px] font-600 text-text">{name}</p>
                        <span className="text-[11px] text-text-3">{formatRelativeTime(h.lastUsed)}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                        <span className="text-text-3">Requests</span>
                        <span className="text-text font-500 text-right">{h.totalRequests}</span>
                        <span className="text-text-3">Error Rate</span>
                        <span className={`font-500 text-right ${errorRateColor(h.errorRate)}`}>
                          {(h.errorRate * 100).toFixed(1)}%
                        </span>
                        {h.avgLatencyMs > 0 && (
                          <>
                            <span className="text-text-3">Avg Latency</span>
                            <span className="text-text font-500 text-right">{Math.round(h.avgLatencyMs)}ms</span>
                          </>
                        )}
                      </div>
                      {h.models.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {h.models.map((m) => (
                            <span
                              key={m}
                              className="px-2 py-0.5 rounded-[6px] bg-white/[0.06] text-[11px] text-text-3 font-500"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-2 rounded-[12px] p-4 border border-white/[0.04]">
      <p className="text-[11px] font-500 text-text-3 uppercase tracking-[0.05em] mb-1">{label}</p>
      <p className="text-[22px] font-display font-700 tracking-[-0.02em] text-text">{value}</p>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-2 rounded-[12px] p-5 border border-white/[0.04]">
      <h3 className="font-display text-[14px] font-600 text-text-2 mb-4">{title}</h3>
      {children}
    </div>
  )
}

function EmptyChart() {
  return (
    <div className="h-[280px] flex items-center justify-center">
      <p className="text-text-3 text-[13px]">No data for this time range</p>
    </div>
  )
}
