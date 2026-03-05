'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'
import type { BoardTask } from '@/types'
import { HintTip } from '@/components/shared/hint-tip'

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

interface PluginUsageEntry {
  definitionTokens: number
  invocationTokens: number
  invocations: number
  estimatedCost: number
}

interface UsageResponse {
  records: unknown[]
  totalTokens: number
  totalCost: number
  byAgent: Record<string, { name: string; cost: number; tokens: number; count: number }>
  byProvider: Record<string, { tokens: number; cost: number }>
  byPlugin?: Record<string, PluginUsageEntry>
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

function formatDuration(ms: number): string {
  if (!ms) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3600_000).toFixed(1)}h`
}

function formatBucketLabel(bucket: string, range: Range): string {
  if (range === '24h') {
    const hour = bucket.split('T')[1]
    return hour ? `${hour}:00` : bucket
  }
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
    } catch { /* ignore */ }
    setLoading(false)
  }, [range])

  useEffect(() => {
    setLoading(true)
    loadData()
  }, [loadData])

  useEffect(() => {
    loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [taskMetrics, setTaskMetrics] = useState<{
    wip: number; completedCount: number; avgCycleMs: number
    velocity: { bucket: string; count: number }[]
    byAgent: { agentName: string; completed: number; failed: number }[]
  } | null>(null)

  const loadTaskMetrics = useCallback(async () => {
    try {
      const res = await api<typeof taskMetrics>('GET', `/tasks/metrics?range=${range}`)
      setTaskMetrics(res)
    } catch { /* ignore */ }
  }, [range])

  useEffect(() => { loadTaskMetrics() }, [loadTaskMetrics])

  useWs('usage', loadData, 30_000)
  useWs('tasks', loadTaskMetrics, 15_000)

  const completionRate = computeCompletionRate(tasks)

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
    .map(([_id, v]) => ({
      name: v.name.length > 16 ? v.name.slice(0, 16) + '…' : v.name,
      cost: Math.round(v.cost * 10000) / 10000,
    }))

  const pluginData = Object.entries(data?.byPlugin ?? {})
    .filter(([id]) => id !== '_system' && id !== '_unknown')
    .sort((a, b) => (b[1].definitionTokens + b[1].invocationTokens) - (a[1].definitionTokens + a[1].invocationTokens))
    .slice(0, 12)
    .map(([id, v]) => ({
      name: id.length > 18 ? id.slice(0, 18) + '…' : id,
      definitionTokens: v.definitionTokens,
      invocationTokens: v.invocationTokens,
      invocations: v.invocations,
      estimatedCost: v.estimatedCost,
    }))

  const tooltipStyle = {
    contentStyle: {
      background: 'var(--color-surface)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8,
      fontSize: 12,
      color: 'var(--color-text)',
    },
    itemStyle: { color: 'var(--color-text)' },
    labelStyle: { color: 'var(--color-text-2)' },
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto">
      <div className="px-8 pt-6 pb-4 shrink-0" style={{ animation: 'fade-up 0.5s var(--ease-spring)' }}>
        <h1 className="font-display text-[28px] font-700 tracking-[-0.03em]">Usage</h1>
        <p className="text-[13px] text-text-3 mt-1">Token usage, cost tracking &amp; agent performance</p>
      </div>

      {/* Range tabs */}
      <div className="px-8 pb-4 shrink-0" style={{ animation: 'fade-up 0.5s var(--ease-spring) 0.05s both' }}>
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
              style={range === r ? { animation: 'spring-in 0.3s var(--ease-spring)' } : undefined}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-3">
            <span className="w-5 h-5 rounded-full border-2 border-text-3/20 border-t-accent-bright animate-spin" />
            <span className="text-[14px] text-text-3">Loading metrics...</span>
          </div>
        </div>
      ) : (
        <div className="px-8 pb-8 space-y-6">
          {/* Stats cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total Tokens" value={formatTokens(data?.totalTokens ?? 0)} index={0} />
            <StatCard label="Total Cost" value={formatCost(data?.totalCost ?? 0)} index={1} />
            <StatCard label="Requests" value={String(data?.records.length ?? 0)} index={2} />
            <StatCard label="Completion Rate" value={`${completionRate}%`} index={3} />
          </div>

          {/* Token usage over time */}
          <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.2s both' }}>
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
          </div>

          {/* Cost by provider + cost by agent */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.25s both' }}>
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

            <ChartCard title="Agent Breakdown">
              {agentData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={agentData} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `$${v}`} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} width={100} />
                    <Tooltip {...tooltipStyle} formatter={(value: number | undefined) => [formatCost(value ?? 0), 'Cost']} />
                    <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                      {agentData.map((_entry, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </ChartCard>
          </div>

          {/* Plugin Usage */}
          {pluginData.length > 0 && (
            <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.28s both' }}>
              <ChartCard title="Plugin Token Usage">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={pluginData} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatTokens} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} width={120} />
                    <Tooltip
                      {...tooltipStyle}
                      formatter={(value: number | undefined, name?: string) => [
                        formatTokens(value ?? 0),
                        name === 'definitionTokens' ? 'Context (definitions)' : 'Invocations',
                      ]}
                    />
                    <Bar dataKey="definitionTokens" fill="#818CF8" radius={[0, 0, 0, 0]} stackId="a" name="definitionTokens" />
                    <Bar dataKey="invocationTokens" fill="#34D399" radius={[0, 4, 4, 0]} stackId="a" name="invocationTokens" />
                    <Legend
                      verticalAlign="bottom"
                      iconType="circle"
                      iconSize={8}
                      formatter={(value: string) => (
                        <span style={{ color: '#a0a0b0', fontSize: 11 }}>
                          {value === 'definitionTokens' ? 'Context (definitions)' : 'Invocations'}
                        </span>
                      )}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mt-4">
                {pluginData.filter((p) => p.invocations > 0).map((p, idx) => (
                  <div
                    key={p.name}
                    className="bg-surface-2 rounded-[10px] p-3 border border-white/[0.04] hover:bg-surface transition-all"
                    style={{ animation: 'spring-in 0.5s var(--ease-spring) both', animationDelay: `${0.3 + idx * 0.03}s` }}
                  >
                    <p className="text-[12px] font-600 text-text truncate">{p.name}</p>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className="text-[18px] font-display font-700 text-text">{p.invocations}</span>
                      <span className="text-[11px] text-text-3">calls</span>
                    </div>
                    <p className="text-[11px] text-text-3 mt-0.5">
                      {formatTokens(p.invocationTokens)} invocation tokens &middot; {formatCost(p.estimatedCost)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Task KPIs */}
          {taskMetrics && (
            <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
              <h3 className="font-display text-[16px] font-700 text-text mt-2">Task Performance</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
                <StatCard label="Tasks Completed" value={String(taskMetrics.completedCount)} index={0} />
                <StatCard label="Avg Cycle Time" value={formatDuration(taskMetrics.avgCycleMs)} index={1} />
                <StatCard label="WIP" value={String(taskMetrics.wip)} index={2} />
                <StatCard label="Completion Rate" value={`${completionRate}%`} index={3} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                <ChartCard title="Task Velocity">
                  {taskMetrics.velocity.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={taskMetrics.velocity.map((v) => ({ ...v, label: formatBucketLabel(v.bucket, range) }))} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="label" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip {...tooltipStyle} formatter={(value: number | undefined) => [value ?? 0, 'Completed']} />
                        <Bar dataKey="count" fill="#34D399" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyChart />
                  )}
                </ChartCard>

                <ChartCard title="Tasks by Agent">
                  {taskMetrics.byAgent.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart
                        data={taskMetrics.byAgent.slice(0, 8).map((a) => ({
                          name: a.agentName.length > 12 ? a.agentName.slice(0, 12) + '…' : a.agentName,
                          completed: a.completed,
                          failed: a.failed,
                        }))}
                        margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="name" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip {...tooltipStyle} />
                        <Bar dataKey="completed" fill="#34D399" radius={[4, 4, 0, 0]} stackId="a" name="Completed" />
                        <Bar dataKey="failed" fill="#F87171" radius={[4, 4, 0, 0]} stackId="a" name="Failed" />
                        <Legend verticalAlign="bottom" iconType="circle" iconSize={8}
                          formatter={(value: string) => <span style={{ color: '#a0a0b0', fontSize: 11 }}>{value}</span>} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyChart />
                  )}
                </ChartCard>
              </div>
            </div>
          )}

          {/* Latency by Provider */}
          <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.35s both' }}>
            <ChartCard title="Average Latency by Provider (ms)">
              {providerData.some(p => (data?.providerHealth?.[p.name]?.avgLatencyMs ?? 0) > 0) ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={providerData.map(p => ({ ...p, latency: Math.round(data?.providerHealth?.[p.name]?.avgLatencyMs || 0) }))} layout="vertical" margin={{ top: 5, right: 30, bottom: 5, left: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="name" type="category" tick={{ fill: '#888', fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                    <Tooltip {...tooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="latency" radius={[0, 4, 4, 0]}>
                      {providerData.map((_entry, index) => (
                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </ChartCard>
          </div>

          {/* Provider Health */}
          {data?.providerHealth && Object.keys(data.providerHealth).length > 0 && (
            <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.4s both' }}>
              <h3 className="font-display text-[14px] font-600 text-text-2 mb-3 flex items-center gap-2">Provider Health <HintTip text="API reliability and performance across your configured providers" /></h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Object.entries(data.providerHealth)
                  .sort(([, a], [, b]) => b.totalRequests - a.totalRequests)
                  .map(([name, h], idx) => (
                    <div
                      key={name}
                      className="bg-surface-2 rounded-[12px] p-4 border border-white/[0.04] flex flex-col gap-3 hover:bg-surface transition-all hover:scale-[1.02]"
                      style={{ animation: 'spring-in 0.5s var(--ease-spring) both', animationDelay: `${0.45 + idx * 0.03}s` }}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-[14px] font-600 text-text">{name}</p>
                        <span className="text-[11px] text-text-3">{formatRelativeTime(h.lastUsed)}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                        <span className="text-text-3">Requests</span>
                        <span className="text-text font-500 text-right">{h.totalRequests}</span>
                        <span className="text-text-3 flex items-center gap-1">Error Rate <HintTip text="Percentage of API calls that failed" /></span>
                        <span className={`font-500 text-right ${errorRateColor(h.errorRate)}`}>
                          {(h.errorRate * 100).toFixed(1)}%
                        </span>
                        {h.avgLatencyMs > 0 && (
                          <>
                            <span className="text-text-3 flex items-center gap-1">Avg Latency <HintTip text="Average response time from the provider" /></span>
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

function StatCard({ label, value, index = 0 }: { label: string; value: string; index?: number }) {
  return (
    <div
      className="bg-surface-2 rounded-[12px] p-4 border border-white/[0.04] hover:bg-surface transition-all hover:scale-[1.02]"
      style={{ animation: 'spring-in 0.6s var(--ease-spring) both', animationDelay: `${0.1 + index * 0.05}s` }}
    >
      <p className="text-[11px] font-500 text-text-3 uppercase tracking-[0.05em] mb-1">{label}</p>
      <p className="text-[22px] font-display font-700 tracking-[-0.02em] text-text">{value}</p>
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-2 rounded-[12px] p-5 border border-white/[0.04] hover:border-white/[0.1] transition-colors">
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
