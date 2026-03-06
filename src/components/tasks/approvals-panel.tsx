'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useApprovalStore } from '@/stores/use-approval-store'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import { useWs } from '@/hooks/use-ws'
import { ExecApprovalCard } from '@/components/chat/exec-approval-card'
import { getApprovalPayload, getApprovalTitle } from '@/lib/approval-display'
import type { ApprovalRequest } from '@/types'

const CATEGORY_LABELS: Record<string, string> = {
  tool_access: 'Plugin Access',
  wallet_transfer: 'Wallet Transfer',
  plugin_scaffold: 'Plugin Creation',
  plugin_install: 'Plugin Install',
  task_tool: 'Task Plugin Call',
}

const CATEGORY_ICONS: Record<string, string> = {
  tool_access: '🔑',
  wallet_transfer: '💰',
  plugin_scaffold: '🔌',
  plugin_install: '📦',
  task_tool: '🤖',
}

type ApprovalScope = 'all' | 'execution' | 'workflow' | 'task'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function ApprovalsPanel() {
  const tasks = useAppStore((s) => s.tasks)
  const agents = useAppStore((s) => s.agents)
  const serverApprovals = useAppStore((s) => s.approvals)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const loadServerApprovals = useAppStore((s) => s.loadApprovals)

  const execApprovals = useApprovalStore((s) => s.approvals)
  const loadExecApprovals = useApprovalStore((s) => s.loadApprovals)
  const pruneExecApprovals = useApprovalStore((s) => s.pruneExpired)

  const refreshServerApprovals = useCallback(() => {
    void loadServerApprovals()
  }, [loadServerApprovals])

  const refreshExecApprovals = useCallback(() => {
    void loadExecApprovals()
    pruneExecApprovals()
  }, [loadExecApprovals, pruneExecApprovals])

  useEffect(() => {
    refreshServerApprovals()
    refreshExecApprovals()
    const interval = setInterval(() => {
      refreshServerApprovals()
      refreshExecApprovals()
    }, 5000)
    return () => clearInterval(interval)
  }, [refreshServerApprovals, refreshExecApprovals])

  useWs('approvals', refreshServerApprovals, 5000)
  useWs('openclaw:approvals', refreshExecApprovals, 5000)

  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<ApprovalScope>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const taskApprovals = useMemo(() => {
    return Object.values(tasks)
      .filter((t) => t.pendingApproval)
      .map((t) => ({
        id: t.id,
        category: 'task_tool' as const,
        agentId: t.agentId,
        sessionId: null,
        taskId: t.id,
        title: `Task Plugin Call: ${t.pendingApproval?.toolName || 'unknown'}`,
        description: t.title,
        data: t.pendingApproval?.args ?? {},
        createdAt: t.updatedAt,
        updatedAt: t.updatedAt,
        status: 'pending' as const,
      }))
  }, [tasks])

  const sessionApprovals = useMemo(() => {
    return Object.values(serverApprovals)
      .filter((a) => a.status === 'pending')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [serverApprovals])

  const workflowApprovals = useMemo(() => {
    return [...sessionApprovals, ...taskApprovals].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessionApprovals, taskApprovals])

  const sortedExecApprovals = useMemo(() => {
    return Object.values(execApprovals).sort((a, b) => b.createdAtMs - a.createdAtMs)
  }, [execApprovals])

  const pendingCount = sortedExecApprovals.length + workflowApprovals.length
  const searchTerm = search.trim().toLowerCase()

  const workflowCategories = useMemo(() => (
    Array.from(new Set(workflowApprovals.map((req) => req.category))).sort()
  ), [workflowApprovals])

  const filteredExecApprovals = useMemo(() => {
    if (scope === 'workflow' || scope === 'task') return []
    return sortedExecApprovals.filter((approval) => {
      if (!searchTerm) return true
      return [
        approval.ask,
        approval.command,
        approval.cwd,
        approval.host,
        approval.security,
      ].some((value) => value?.toLowerCase().includes(searchTerm))
    })
  }, [scope, sortedExecApprovals, searchTerm])

  const filteredWorkflowApprovals = useMemo(() => {
    return workflowApprovals.filter((req) => {
      if (scope === 'execution') return false
      if (scope === 'workflow' && req.category === 'task_tool') return false
      if (scope === 'task' && req.category !== 'task_tool') return false
      if (categoryFilter !== 'all' && req.category !== categoryFilter) return false
      if (!searchTerm) return true
      const agentName = req.agentId ? agents[req.agentId]?.name : 'system'
      const payloadText = JSON.stringify(getApprovalPayload(req))
      return [
        getApprovalTitle(req),
        req.description,
        req.category,
        agentName,
        payloadText,
      ].some((value) => value?.toLowerCase().includes(searchTerm))
    })
  }, [agents, categoryFilter, scope, searchTerm, workflowApprovals])

  const visibleCount = filteredExecApprovals.length + filteredWorkflowApprovals.length

  const summaryCards = [
    {
      label: 'Execution',
      value: sortedExecApprovals.length,
      tone: 'text-amber-400',
      hint: 'Command approvals from OpenClaw',
    },
    {
      label: 'Workflow',
      value: sessionApprovals.length,
      tone: 'text-sky-400',
      hint: 'Agent and plugin governance requests',
    },
    {
      label: 'Task Calls',
      value: taskApprovals.length,
      tone: 'text-violet-400',
      hint: 'Tasks waiting on tool approval',
    },
    {
      label: 'Recently Active',
      value: workflowApprovals.filter((req) => now - req.updatedAt < 60 * 60 * 1000).length,
      tone: 'text-emerald-400',
      hint: 'Updated in the last hour',
    },
  ]

  const handleDecision = async (req: ApprovalRequest, approved: boolean) => {
    try {
      if (req.category === 'task_tool') {
        await api('POST', `/tasks/${req.id}/approve`, { approved })
        void loadTasks()
      } else {
        await api('POST', '/approvals', { id: req.id, approved })
        refreshServerApprovals()
      }
      toast.success(approved ? 'Action approved' : 'Action rejected')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit decision')
    }
  }

  if (pendingCount === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className="w-16 h-16 rounded-[24px] bg-white/[0.02] border border-white/[0.04] flex items-center justify-center mb-6">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40">
            <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <h2 className="font-display text-[18px] font-600 text-text-2 mb-2">No pending approvals</h2>
        <p className="text-[13px] text-text-3/60 max-w-[320px]">
          Your swarm is operating autonomously. Actions requiring oversight will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-1">Approvals</h1>
            <p className="text-[13px] text-text-3">Execution, task, and governance requests queued for review</p>
          </div>
          <div className="px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] font-600">
            {pendingCount} Pending
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {summaryCards.map((card) => (
            <div key={card.label} className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
              <div className={`text-[22px] font-display font-700 tracking-[-0.03em] ${card.tone}`}>
                {card.value}
              </div>
              <div className="text-[11px] font-600 text-text-2 mt-0.5">{card.label}</div>
              <p className="text-[10px] text-text-3/50 mt-1 leading-relaxed">{card.hint}</p>
            </div>
          ))}
        </div>

        <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4 mb-6">
          <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {([
                ['all', `All (${pendingCount})`],
                ['execution', `Execution (${sortedExecApprovals.length})`],
                ['workflow', `Workflow (${sessionApprovals.length})`],
                ['task', `Tasks (${taskApprovals.length})`],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setScope(value)}
                  className={`px-3 py-1.5 rounded-[9px] text-[11px] font-600 transition-all cursor-pointer border-none ${
                    scope === value
                      ? 'bg-accent-soft text-accent-bright'
                      : 'bg-white/[0.04] text-text-3 hover:bg-white/[0.08] hover:text-text-2'
                  }`}
                  style={{ fontFamily: 'inherit' }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <div className="text-[11px] text-text-3/60 font-600">
                Showing {visibleCount} of {pendingCount}
              </div>
              {workflowCategories.length > 1 && scope !== 'execution' && (
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="px-3 py-2 rounded-[10px] bg-white/[0.04] border border-white/[0.06] text-[12px] text-text-2 outline-none"
                  style={{ fontFamily: 'inherit' }}
                >
                  <option value="all">All categories</option>
                  {workflowCategories.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category] || category}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="mt-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search approvals by agent, tool, command, or payload"
              className="w-full px-4 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-[13px] text-text placeholder:text-text-3/50 outline-none focus:border-white/[0.12]"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>

        {filteredExecApprovals.length > 0 && (
          <div className="mb-6">
            <h2 className="text-[12px] font-700 uppercase tracking-[0.1em] text-amber-400/90 mb-2">Execution Approvals</h2>
            <div className="grid grid-cols-1 gap-3">
              {filteredExecApprovals.map((approval) => (
                <ExecApprovalCard key={approval.id} approval={approval} />
              ))}
            </div>
          </div>
        )}

        {filteredWorkflowApprovals.length > 0 && (
          <div>
            <h2 className="text-[12px] font-700 uppercase tracking-[0.1em] text-amber-400/90 mb-2">Workflow Approvals</h2>
            <div className="grid grid-cols-1 gap-4">
              {filteredWorkflowApprovals.map((req) => {
                const agent = req.agentId ? agents[req.agentId] : null
                const icon = CATEGORY_ICONS[req.category] || '⚠️'
                const categoryLabel = CATEGORY_LABELS[req.category] || req.category
                const payload = getApprovalPayload(req)
                const payloadText = JSON.stringify(payload, null, 2)

                return (
                  <div key={req.id} className="bg-surface rounded-[16px] border border-white/[0.06] overflow-hidden">
                    <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between bg-surface-2/50">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-[8px] bg-white/[0.04] flex items-center justify-center">
                          <span className="text-[14px]">{icon}</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-[13px] font-600 text-text">{getApprovalTitle(req)}</h3>
                            <span className="px-1.5 py-0.5 rounded-[4px] bg-white/[0.04] text-[9px] font-600 text-text-3/60 uppercase tracking-wider">
                              {categoryLabel}
                            </span>
                            {req.taskId && (
                              <span className="px-1.5 py-0.5 rounded-[4px] bg-violet-500/10 text-[9px] font-700 text-violet-300 uppercase tracking-wider">
                                Task
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-text-3">
                            <span>{agent?.name || 'System'}</span>
                            <span className="text-text-3/35">•</span>
                            <span>{relativeTime(req.updatedAt)}</span>
                            {req.description && (
                              <>
                                <span className="text-text-3/35">•</span>
                                <span className="truncate max-w-[280px]">{req.description}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] text-text-3/50 font-mono">
                        {new Date(req.updatedAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="p-5">
                      <div className="flex flex-wrap gap-2 mb-4">
                        {req.sessionId && (
                          <span className="px-2 py-1 rounded-[7px] bg-white/[0.04] text-[10px] font-600 text-text-3">
                            Session {req.sessionId.slice(0, 8)}
                          </span>
                        )}
                        {req.taskId && (
                          <span className="px-2 py-1 rounded-[7px] bg-violet-500/10 text-[10px] font-600 text-violet-300">
                            Task {req.taskId.slice(0, 8)}
                          </span>
                        )}
                      </div>

                      <details className="mb-5 rounded-[10px] border border-white/[0.04] bg-black/20 overflow-hidden group">
                        <summary className="list-none cursor-pointer px-4 py-3 flex items-center justify-between text-[12px] font-600 text-text-2">
                          <span>Payload details</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-3 transition-transform group-open:rotate-180">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </summary>
                        <div className="px-4 pb-4 overflow-x-auto max-h-[260px] overflow-y-auto">
                          <pre className="text-[12px] font-mono text-text-2/80 whitespace-pre-wrap break-all leading-relaxed">
                            {payloadText === '{}' ? 'No structured payload provided.' : payloadText}
                          </pre>
                        </div>
                      </details>

                      <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/[0.04]">
                        <button
                          onClick={() => handleDecision(req, false)}
                          className="px-5 py-2 rounded-[10px] bg-transparent border border-red-500/30 text-red-400 text-[12px] font-600 hover:bg-red-500/10 transition-colors cursor-pointer"
                          style={{ fontFamily: 'inherit' }}
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => handleDecision(req, true)}
                          className="px-5 py-2 rounded-[10px] bg-emerald-500 border border-emerald-400 text-[#000] text-[12px] font-700 hover:brightness-110 transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] cursor-pointer"
                          style={{ fontFamily: 'inherit' }}
                        >
                          Approve
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {visibleCount === 0 && pendingCount > 0 && (
          <div className="rounded-[16px] border border-dashed border-white/[0.08] px-6 py-10 text-center">
            <p className="text-[13px] font-600 text-text-2 mb-1">No approvals match the current filters</p>
            <p className="text-[12px] text-text-3/60">Try clearing the search or switching the queue scope.</p>
          </div>
        )}
      </div>
    </div>
  )
}
