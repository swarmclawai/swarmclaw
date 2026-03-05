'use client'

import { useCallback, useEffect, useMemo } from 'react'
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
            <p className="text-[13px] text-text-3">Execution and plugin governance requests pending review</p>
          </div>
          <div className="px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] font-600">
            {pendingCount} Pending
          </div>
        </div>

        {sortedExecApprovals.length > 0 && (
          <div className="mb-6">
            <h2 className="text-[12px] font-700 uppercase tracking-[0.1em] text-amber-400/90 mb-2">Execution Approvals</h2>
            <div className="grid grid-cols-1 gap-3">
              {sortedExecApprovals.map((approval) => (
                <ExecApprovalCard key={approval.id} approval={approval} />
              ))}
            </div>
          </div>
        )}

        {workflowApprovals.length > 0 && (
          <div>
            <h2 className="text-[12px] font-700 uppercase tracking-[0.1em] text-amber-400/90 mb-2">Plugin Workflow Approvals</h2>
            <div className="grid grid-cols-1 gap-4">
              {workflowApprovals.map((req) => {
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
                          </div>
                          <p className="text-[11px] text-text-3">
                            {agent?.name || 'System'}
                          </p>
                        </div>
                      </div>
                      <span className="text-[10px] text-text-3/50 font-mono">
                        {new Date(req.updatedAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="p-5">
                      {req.description && (
                        <p className="text-[13px] text-text-2/90 mb-4">{req.description}</p>
                      )}

                      <div className="bg-black/30 rounded-[10px] border border-white/[0.04] p-4 mb-5 overflow-x-auto max-h-[250px] overflow-y-auto">
                        <pre className="text-[12px] font-mono text-text-2/80 whitespace-pre-wrap break-all leading-relaxed">
                          {payloadText === '{}' ? 'No structured payload provided.' : payloadText}
                        </pre>
                      </div>

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
      </div>
    </div>
  )
}
