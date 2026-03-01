'use client'

import type { PendingExecApproval, ExecApprovalDecision } from '@/types'
import { useApprovalStore } from '@/stores/use-approval-store'

interface Props {
  approval: PendingExecApproval
}

export function ExecApprovalCard({ approval }: Props) {
  const resolveApproval = useApprovalStore((s) => s.resolveApproval)

  const handleResolve = (decision: ExecApprovalDecision) => {
    resolveApproval(approval.id, decision)
  }

  const expired = approval.expiresAtMs < Date.now()
  const disabled = !!approval.resolving || expired

  return (
    <div className="my-2 rounded-[12px] border border-amber-500/20 bg-amber-500/[0.04] p-3.5">
      <div className="flex items-center gap-2 mb-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400 shrink-0">
          <path d="M12 9v2m0 4h.01" />
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
        <span className="text-[12px] font-600 text-amber-400">Execution Approval Required</span>
      </div>

      {approval.ask && (
        <p className="text-[13px] text-text-2 mb-2">{approval.ask}</p>
      )}

      <div className="rounded-[8px] bg-black/20 px-3 py-2 mb-2 overflow-x-auto">
        <code className="text-[12px] text-text font-mono whitespace-pre-wrap break-all">
          {approval.command}
        </code>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-3/60 mb-3">
        {approval.cwd && <span>cwd: {approval.cwd}</span>}
        {approval.host && <span>host: {approval.host}</span>}
        {approval.security && (
          <span className={approval.security === 'high' ? 'text-red-400' : ''}>
            security: {approval.security}
          </span>
        )}
      </div>

      {approval.error && (
        <p className="text-[12px] text-red-400 mb-2">{approval.error}</p>
      )}

      {expired ? (
        <p className="text-[12px] text-text-3/50 italic">Approval expired</p>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleResolve('allow-once')}
            disabled={disabled}
            className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-emerald-500/10 text-[12px] font-600
              text-emerald-400 cursor-pointer hover:bg-emerald-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ fontFamily: 'inherit' }}
          >
            {approval.resolving ? '...' : 'Allow Once'}
          </button>
          <button
            onClick={() => handleResolve('allow-always')}
            disabled={disabled}
            className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[12px] font-600
              text-text-3 cursor-pointer hover:bg-white/[0.04] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ fontFamily: 'inherit' }}
          >
            Always Allow
          </button>
          <button
            onClick={() => handleResolve('deny')}
            disabled={disabled}
            className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[12px] font-600
              text-red-400 cursor-pointer hover:bg-red-400/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ fontFamily: 'inherit' }}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  )
}
