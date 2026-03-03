'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api-client'
import type { WalletTransaction } from '@/types'

interface WalletApprovalDialogProps {
  transaction: WalletTransaction
  walletAddress: string
  onClose: () => void
  onResolved: () => void
}

export function WalletApprovalDialog({ transaction, walletAddress, onClose, onResolved }: WalletApprovalDialogProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDecision = useCallback(async (decision: 'approve' | 'deny') => {
    setSubmitting(true)
    setError(null)
    try {
      await api('POST', `/wallets/${transaction.walletId}/approve`, {
        transactionId: transaction.id,
        decision,
      })
      onResolved()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [transaction, onResolved, onClose])

  const amountSol = transaction.amountLamports / 1e9

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-[16px] border border-white/[0.08] bg-surface-1 shadow-2xl p-6 space-y-5">
        <div className="flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <h3 className="font-display text-[15px] font-600 text-text-1">Transaction Approval</h3>
        </div>

        <div className="p-4 rounded-[12px] bg-black/20 border border-white/[0.06] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-3/70 uppercase tracking-wide">Amount</span>
            <span className="text-[16px] font-600 text-text-1">{amountSol.toFixed(4)} SOL</span>
          </div>
          <div>
            <span className="text-[11px] text-text-3/70 uppercase tracking-wide block mb-1">From</span>
            <code className="text-[10px] text-text-3 font-mono break-all">{walletAddress}</code>
          </div>
          <div>
            <span className="text-[11px] text-text-3/70 uppercase tracking-wide block mb-1">To</span>
            <code className="text-[10px] text-text-3 font-mono break-all">{transaction.toAddress}</code>
          </div>
          {transaction.memo && (
            <div>
              <span className="text-[11px] text-text-3/70 uppercase tracking-wide block mb-1">Reason</span>
              <p className="text-[12px] text-text-2">{transaction.memo}</p>
            </div>
          )}
        </div>

        <p className="text-[11px] text-amber-400/80">
          Crypto transactions are irreversible. Verify the recipient address carefully.
        </p>

        {error && <p className="text-[11px] text-red-400">{error}</p>}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => handleDecision('deny')}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-[10px] border border-white/[0.08] bg-surface text-text-3 text-[12px] font-600 hover:text-red-400 hover:border-red-400/30 transition-colors cursor-pointer disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => handleDecision('approve')}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-[10px] bg-accent text-white text-[12px] font-600 hover:brightness-110 transition-all cursor-pointer disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            {submitting ? 'Processing...' : 'Approve & Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
