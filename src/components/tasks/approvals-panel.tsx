'use client'

import { useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'


export function ApprovalsPanel() {
  const tasks = useAppStore((s) => s.tasks)
  const agents = useAppStore((s) => s.agents)
  const loadTasks = useAppStore((s) => s.loadTasks)

  const pendingApprovals = useMemo(() => {
    return Object.values(tasks)
      .filter((t) => t.pendingApproval)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [tasks])

  const handleDecision = async (taskId: string, approved: boolean) => {
    try {
      await api('POST', `/tasks/${taskId}/approve`, { approved })
      toast.success(approved ? 'Tool execution approved' : 'Tool execution rejected')
      loadTasks()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit decision')
    }
  }

  if (pendingApprovals.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className="w-16 h-16 rounded-[24px] bg-white/[0.02] border border-white/[0.04] flex items-center justify-center mb-6">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40">
            <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
            <path d="m9 12 2 2 4-4"/>
          </svg>
        </div>
        <h2 className="font-display text-[18px] font-600 text-text-2 mb-2">No pending approvals</h2>
        <p className="text-[13px] text-text-3/60 max-w-[280px]">
          Your swarm is operating autonomously. Any actions requiring human oversight will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-1">Approvals</h1>
            <p className="text-[13px] text-text-3">Governance queue for manual tool interventions</p>
          </div>
          <div className="px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] font-600">
            {pendingApprovals.length} Pending
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {pendingApprovals.map((task) => {
            const agent = agents[task.agentId]
            const argsString = JSON.stringify(task.pendingApproval!.args, null, 2)
            
            return (
              <div key={task.id} className="bg-surface rounded-[16px] border border-white/[0.06] overflow-hidden">
                {/* Header */}
                <div className="px-5 py-3 border-b border-white/[0.04] flex items-center justify-between bg-surface-2/50">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-[8px] bg-white/[0.04] flex items-center justify-center">
                      <span className="text-[14px]">{agent?.avatarSeed ? '🤖' : '🦞'}</span>
                    </div>
                    <div>
                      <h3 className="text-[13px] font-600 text-text">{agent?.name || 'Unknown Agent'}</h3>
                      <p className="text-[11px] text-text-3">Task: {task.title}</p>
                    </div>
                  </div>
                  <span className="text-[10px] text-text-3/50 font-mono">
                    {new Date(task.updatedAt).toLocaleString()}
                  </span>
                </div>

                {/* Body */}
                <div className="p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="px-2 py-0.5 rounded-[6px] bg-accent-soft text-accent-bright text-[10px] font-mono font-600">
                      {task.pendingApproval!.toolName}
                    </span>
                    <span className="text-[12px] text-text-3">requested permission to execute.</span>
                  </div>

                  <div className="bg-black/30 rounded-[10px] border border-white/[0.04] p-4 mb-5 overflow-x-auto">
                    <pre className="text-[12px] font-mono text-text-2/80">
                      {argsString}
                    </pre>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/[0.04]">
                    <button
                      onClick={() => handleDecision(task.id, false)}
                      className="px-5 py-2 rounded-[10px] bg-transparent border border-red-500/30 text-red-400 text-[12px] font-600 hover:bg-red-500/10 transition-colors"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleDecision(task.id, true)}
                      className="px-5 py-2 rounded-[10px] bg-emerald-500 border border-emerald-400 text-[#000] text-[12px] font-700 hover:brightness-110 transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                    >
                      Approve Execution
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
