'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/app/api-client'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { WalletTransaction } from '@/types'
import { formatWalletAmount, getWalletAssetSymbol, getWalletAtomicAmount } from '@/lib/wallet/wallet'
import { errorMessage } from '@/lib/shared-utils'

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
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [transaction, onResolved, onClose])

  const amountFormatted = formatWalletAmount(transaction.chain, getWalletAtomicAmount(transaction), { minFractionDigits: 4, maxFractionDigits: 6 })
  const symbol = getWalletAssetSymbol(transaction.chain)

  return (
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="sm:max-w-[460px] rounded-[20px] border-white/[0.08] bg-surface/95 p-0 shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
        <div className="p-6 space-y-5">
          <DialogHeader className="text-left">
            <div className="flex items-center gap-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <DialogTitle className="font-display text-[16px] font-700 tracking-[-0.02em] text-text-1">
                Transaction Approval
              </DialogTitle>
            </div>
            <DialogDescription className="text-[12px] leading-relaxed text-text-3">
              Crypto transactions are irreversible. Verify the recipient address carefully before approving.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-[14px] border border-white/[0.06] bg-black/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-text-3/70">Amount</span>
              <span className="text-[16px] font-600 text-text-1">{amountFormatted} {symbol}</span>
            </div>
            <div>
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-3/70">From</span>
              <code className="text-[10px] text-text-3 font-mono break-all">{walletAddress}</code>
            </div>
            <div>
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-3/70">To</span>
              <code className="text-[10px] text-text-3 font-mono break-all">{transaction.toAddress}</code>
            </div>
            {transaction.memo && (
              <div>
                <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-3/70">Reason</span>
                <p className="text-[12px] text-text-2">{transaction.memo}</p>
              </div>
            )}
          </div>

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          <DialogFooter>
            <button
              type="button"
              onClick={() => handleDecision('deny')}
              disabled={submitting}
              className="flex-1 rounded-[12px] border border-white/[0.08] bg-surface px-4 py-2.5 text-[12px] font-600 text-text-3 transition-colors hover:border-red-400/30 hover:text-red-400 disabled:opacity-50"
              style={{ fontFamily: 'inherit' }}
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => handleDecision('approve')}
              disabled={submitting}
              className="flex-1 rounded-[12px] bg-accent px-4 py-2.5 text-[12px] font-600 text-white transition-all hover:brightness-110 disabled:opacity-50"
              style={{ fontFamily: 'inherit' }}
            >
              {submitting ? 'Processing...' : 'Approve & Send'}
            </button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
