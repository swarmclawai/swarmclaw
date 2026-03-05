'use client'

import { useState, useCallback } from 'react'
import { api } from '@/lib/api-client'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { AgentWallet, WalletChain } from '@/types'
import { toast } from 'sonner'

interface WalletSectionProps {
  agentId: string
  wallet: (Omit<AgentWallet, 'encryptedPrivateKey'> & { balanceLamports?: number; balanceSol?: number }) | null
  onWalletCreated: () => void
}

export function WalletSection({ agentId, wallet, onWalletCreated }: WalletSectionProps) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const createWallet = useCallback(async () => {
    setCreating(true)
    setError(null)
    try {
      await api('POST', '/wallets', { agentId, chain: 'solana' as WalletChain })
      toast.success('Agent wallet created successfully')
      onWalletCreated()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(msg)
    } finally {
      setCreating(false)
    }
  }, [agentId, onWalletCreated])

  const copyAddress = useCallback(async () => {
    if (!wallet) return
    const copiedValue = await copyTextToClipboard(wallet.publicKey)
    if (!copiedValue) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [wallet])

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">
          Wallet
        </label>
        <span className="px-1.5 py-0.5 rounded-[4px] bg-amber-500/15 text-amber-400 text-[9px] font-600 uppercase tracking-wide">
          Experimental
        </span>
      </div>

      {!wallet ? (
        <div className="p-4 rounded-[12px] border border-white/[0.06] bg-surface-2/50">
          <p className="text-[12px] text-text-3/70 mb-3">
            Create a Solana wallet for this agent to hold funds, pay for services, and trade autonomously.
          </p>
          <button
            type="button"
            onClick={createWallet}
            disabled={creating}
            className="px-3 py-1.5 rounded-[8px] bg-accent-soft text-accent-bright text-[11px] font-600 hover:bg-accent-bright/15 transition-all cursor-pointer disabled:opacity-50 border border-accent-bright/20"
            style={{ fontFamily: 'inherit' }}
          >
            {creating ? 'Creating...' : 'Create Wallet'}
          </button>
          {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
        </div>
      ) : (
        <div className="p-4 rounded-[12px] border border-white/[0.06] bg-surface-2/50 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-3/60 uppercase tracking-wide font-600">
              {wallet.chain}
            </span>
            <span className="flex-1" />
            {typeof wallet.balanceSol === 'number' && (
              <span className="text-[13px] font-600 text-text-1">
                {wallet.balanceSol.toFixed(4)} SOL
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <code className="text-[11px] text-text-3 bg-black/20 px-2 py-1 rounded-[6px] font-mono truncate flex-1">
              {wallet.publicKey}
            </code>
            <button
              type="button"
              onClick={copyAddress}
              className="shrink-0 px-2 py-1 rounded-[6px] text-[10px] text-text-3 hover:text-text-2 border border-white/[0.08] bg-surface transition-colors cursor-pointer"
              style={{ fontFamily: 'inherit' }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-text-3/60">
            <span>Limit: {((wallet.spendingLimitLamports ?? 100_000_000) / 1e9).toFixed(2)} SOL/tx</span>
            <span>Daily: {((wallet.dailyLimitLamports ?? 1_000_000_000) / 1e9).toFixed(1)} SOL</span>
            <span>{wallet.requireApproval ? 'Approval required' : 'Auto-send'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
