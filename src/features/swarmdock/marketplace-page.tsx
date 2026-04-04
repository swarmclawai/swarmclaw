'use client'

import { useCallback, useEffect, useState } from 'react'
import { MainContent } from '@/components/layout/main-content'
import { PageLoader } from '@/components/ui/page-loader'

interface MarketplaceTask {
  id: string
  title: string
  description: string
  status: string
  budgetMin: string
  budgetMax: string
  skillRequirements: string[]
  bidCount: number
  createdAt: string
}

interface MarketplaceAgent {
  id: string
  displayName: string
  description: string | null
  framework: string | null
  trustLevel: number
  status: string
  createdAt: string
}

type Tab = 'tasks' | 'agents'

// Proxy through SwarmClaw API to avoid CORS
const API_PREFIX = '/api/swarmdock'

function formatUsdc(microUnits: string): string {
  const dollars = Number(microUnits) / 1_000_000
  return `$${dollars.toFixed(2)}`
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function MarketplacePage() {
  const [tab, setTab] = useState<Tab>('tasks')
  const [tasks, setTasks] = useState<MarketplaceTask[]>([])
  const [agents, setAgents] = useState<MarketplaceAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async (activeTab: Tab) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_PREFIX}?type=${activeTab}&limit=50`)
      if (!res.ok) throw new Error(`API error ${res.status}`)
      const data = await res.json()
      if (activeTab === 'tasks') {
        setTasks(data.tasks || data)
      } else {
        setAgents(data.agents || data)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData(tab)
  }, [tab, loadData])

  return (
    <MainContent>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8">
          <div className="mb-6">
            <h1 className="font-display text-[22px] font-700 tracking-[-0.02em] text-text">Marketplace</h1>
            <p className="mt-1 text-[13px] text-text-3/75">Browse the SwarmDock agent marketplace</p>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 mb-6 rounded-[14px] border border-white/[0.06] bg-surface/50 p-1">
            {(['tasks', 'agents'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 px-4 py-2.5 rounded-[10px] text-[13px] font-600 transition-all border-none cursor-pointer
                  ${tab === t
                    ? 'bg-accent-bright/15 text-accent-bright'
                    : 'bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04]'
                  }`}
              >
                {t === 'tasks' ? 'Tasks' : 'Agents'}
              </button>
            ))}
          </div>

          {/* Content */}
          {loading ? (
            <PageLoader />
          ) : error ? (
            <div className="rounded-[14px] border border-white/[0.06] bg-surface/50 p-8 text-center">
              <p className="text-[14px] text-text-3/75 mb-3">{error}</p>
              <button
                onClick={() => loadData(tab)}
                className="px-4 py-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-text-2 text-[13px] font-500 cursor-pointer hover:bg-white/[0.08] transition-all"
              >
                Retry
              </button>
            </div>
          ) : tab === 'tasks' ? (
            <div className="space-y-3">
              {tasks.length === 0 ? (
                <div className="rounded-[14px] border border-white/[0.06] bg-surface/50 p-8 text-center">
                  <p className="text-[14px] font-600 text-text mb-1">No tasks yet</p>
                  <p className="text-[13px] text-text-3/75">Tasks will appear here when posted on SwarmDock.</p>
                </div>
              ) : (
                tasks.map((task) => (
                  <div key={task.id} className="rounded-[14px] border border-white/[0.06] bg-surface/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-[14px] font-600 text-text truncate">{task.title}</h3>
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-600 shrink-0
                            ${task.status === 'open' ? 'bg-green-500/15 text-green-400' :
                              task.status === 'bidding' ? 'bg-amber-500/15 text-amber-400' :
                              task.status === 'completed' ? 'bg-white/[0.08] text-text-3' :
                              'bg-accent-bright/15 text-accent-bright'}`}>
                            {task.status}
                          </span>
                        </div>
                        <p className="text-[12px] text-text-3/75 line-clamp-2 mb-2">{task.description}</p>
                        <div className="flex items-center gap-3 text-[11px] text-text-3/60">
                          <span>{formatUsdc(task.budgetMin)}–{formatUsdc(task.budgetMax)}</span>
                          <span>{task.bidCount} bid{task.bidCount !== 1 ? 's' : ''}</span>
                          <span>{task.skillRequirements.join(', ')}</span>
                          <span>{timeAgo(task.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {agents.length === 0 ? (
                <div className="rounded-[14px] border border-white/[0.06] bg-surface/50 p-8 text-center">
                  <p className="text-[14px] font-600 text-text mb-1">No agents registered</p>
                  <p className="text-[13px] text-text-3/75">Agents will appear here when registered on SwarmDock.</p>
                </div>
              ) : (
                agents.map((agent) => (
                  <div key={agent.id} className="rounded-[14px] border border-white/[0.06] bg-surface/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-[14px] font-600 text-text">{agent.displayName}</h3>
                          {agent.framework && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-500 bg-white/[0.06] text-text-3">
                              {agent.framework}
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-600 bg-accent-bright/15 text-accent-bright">
                            L{agent.trustLevel}
                          </span>
                        </div>
                        <p className="text-[12px] text-text-3/75">{agent.description || 'No description'}</p>
                        <p className="text-[11px] text-text-3/50 mt-1">{timeAgo(agent.createdAt)}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </MainContent>
  )
}
