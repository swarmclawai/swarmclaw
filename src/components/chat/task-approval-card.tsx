'use client'

import { useState } from 'react'
import type { BoardTask } from '@/types'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { toast } from 'sonner'

interface Props {
  task: BoardTask
}

export function TaskApprovalCard({ task }: Props) {
  const [resolving, setResolving] = useState(false)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const loadSessions = useAppStore((s) => s.loadSessions)

  const handleResolve = async (approved: boolean) => {
    setResolving(true)
    try {
      await api('POST', `/tasks/${task.id}/approve`, { approved })
      toast.success(approved ? 'Tool execution approved' : 'Tool execution rejected')
      await loadTasks()
      await loadSessions()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit decision')
    } finally {
      setResolving(false)
    }
  }

  if (!task.pendingApproval) return null

  const { toolName, args } = task.pendingApproval

  return (
    <div className="my-2 rounded-[12px] border border-amber-500/20 bg-amber-500/[0.04] p-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-amber-400">
            <path d="M12 9v2m0 4h.01" />
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
        </div>
        <span className="text-[12px] font-700 text-amber-400 uppercase tracking-wider">Orchestration Intervention Required</span>
      </div>

      <p className="text-[13px] text-text-2 mb-3 font-500">
        Agent requested to use <span className="text-amber-400 font-600 font-mono">{toolName}</span>:
      </p>

      <div className="bg-black/30 rounded-[10px] border border-white/[0.04] p-3 mb-4 overflow-x-auto max-h-[200px] overflow-y-auto">
        <pre className="text-[11px] font-mono text-text-2/80 leading-relaxed whitespace-pre-wrap break-all">
          {JSON.stringify(args, null, 2)}
        </pre>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => handleResolve(true)}
          disabled={resolving}
          className="flex-1 px-4 py-2 rounded-[10px] bg-emerald-500 text-[#000] text-[12px] font-700 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50"
          style={{ fontFamily: 'inherit' }}
        >
          {resolving ? 'Applying...' : 'Approve'}
        </button>
        <button
          onClick={() => handleResolve(false)}
          disabled={resolving}
          className="px-4 py-2 rounded-[10px] bg-white/[0.04] border border-white/[0.08] text-text-3 text-[12px] font-600 hover:bg-white/[0.08] active:scale-[0.98] transition-all disabled:opacity-50"
          style={{ fontFamily: 'inherit' }}
        >
          Reject
        </button>
      </div>
    </div>
  )
}
