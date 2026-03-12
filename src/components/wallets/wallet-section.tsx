'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useAppStore } from '@/stores/use-app-store'
import type { AgentWallet, WalletAssetBalance, WalletPortfolioSummary, WalletChain } from '@/types'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/shared-utils'
import {
  SUPPORTED_WALLET_CHAINS,
  formatWalletAmount,
  getWalletBalanceAtomic,
  getWalletChainMeta,
  getWalletLimitAtomic,
} from '@/lib/wallet/wallet'

type SafeWallet = Omit<AgentWallet, 'encryptedPrivateKey'> & {
  balanceAtomic?: string
  balanceLamports?: number
  balanceFormatted?: string
  balanceSymbol?: string
  assets?: WalletAssetBalance[]
  portfolioSummary?: WalletPortfolioSummary
  isActive?: boolean
}

interface WalletSectionProps {
  agentId: string
  wallets: SafeWallet[]
  activeWalletId: string | null
  onWalletCreated: () => void
}

export function WalletSection({ agentId, wallets, activeWalletId, onWalletCreated }: WalletSectionProps) {
  const appSettings = useAppStore((s) => s.appSettings)
  const [creating, setCreating] = useState(false)
  const [activatingWalletId, setActivatingWalletId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiedWalletId, setCopiedWalletId] = useState<string | null>(null)

  const connectedChains = useMemo(() => new Set(wallets.map((wallet) => wallet.chain)), [wallets])
  const availableChains = useMemo(
    () => SUPPORTED_WALLET_CHAINS.filter((chain) => !connectedChains.has(chain)),
    [connectedChains],
  )
  const sortedWallets = useMemo(
    () => [...wallets].sort((a, b) => {
      const aActive = a.id === activeWalletId || a.isActive === true
      const bActive = b.id === activeWalletId || b.isActive === true
      if (aActive !== bActive) return aActive ? -1 : 1
      return a.chain.localeCompare(b.chain)
    }),
    [activeWalletId, wallets],
  )

  const [chain, setChain] = useState<WalletChain>(availableChains[0] || 'solana')
  const walletApprovalsEnabled = appSettings.walletApprovalsEnabled !== false

  useEffect(() => {
    if (availableChains.length === 0) return
    if (!availableChains.includes(chain)) setChain(availableChains[0])
  }, [availableChains, chain])

  const createWallet = useCallback(async () => {
    if (!availableChains.includes(chain)) return
    setCreating(true)
    setError(null)
    try {
      await api('POST', '/wallets', { agentId, chain })
      toast.success('Agent wallet created successfully')
      await onWalletCreated()
    } catch (err: unknown) {
      const msg = errorMessage(err)
      setError(msg)
      toast.error(msg)
    } finally {
      setCreating(false)
    }
  }, [agentId, availableChains, chain, onWalletCreated])

  const copyAddress = useCallback(async (wallet: SafeWallet) => {
    const copiedValue = await copyTextToClipboard(wallet.publicKey)
    if (!copiedValue) return
    setCopiedWalletId(wallet.id)
    setTimeout(() => {
      setCopiedWalletId((current) => current === wallet.id ? null : current)
    }, 2000)
  }, [])

  const setActiveWallet = useCallback(async (walletId: string) => {
    setActivatingWalletId(walletId)
    setError(null)
    try {
      await api('PATCH', `/wallets/${walletId}`, { makeActive: true })
      toast.success('Default wallet updated')
      await onWalletCreated()
    } catch (err: unknown) {
      const msg = errorMessage(err)
      setError(msg)
      toast.error(msg)
    } finally {
      setActivatingWalletId(null)
    }
  }, [onWalletCreated])

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <label className="block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em]">
          Wallets
        </label>
        <span className="px-1.5 py-0.5 rounded-[4px] bg-amber-500/15 text-amber-400 text-[9px] font-600 uppercase tracking-wide">
          Experimental
        </span>
      </div>

      {sortedWallets.length > 0 ? (
        <div className="space-y-3">
          <div className="p-4 rounded-[12px] border border-white/[0.06] bg-surface-2/50">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div>
                <div className="text-[12px] font-600 text-text-1">Combined Wallet Summary</div>
                <p className="text-[11px] text-text-3/70 mt-1">
                  {sortedWallets.length} wallet{sortedWallets.length === 1 ? '' : 's'} connected. The active wallet is used by default when the agent does not specify a chain explicitly.
                </p>
              </div>
              <div className="text-right">
                <div className="text-[18px] font-600 text-text-1">{sortedWallets.length}</div>
                <div className="text-[10px] uppercase tracking-wide text-text-3/50">Connected</div>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {sortedWallets.map((wallet) => {
                const walletMeta = getWalletChainMeta(wallet.chain)
                const balanceFormatted = wallet.balanceFormatted || formatWalletAmount(wallet.chain, getWalletBalanceAtomic(wallet), { minFractionDigits: 4, maxFractionDigits: 6 })
                const isActive = wallet.id === activeWalletId || wallet.isActive === true
                return (
                  <div key={wallet.id} className="rounded-[10px] border border-white/[0.06] bg-black/10 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-text-3/60 uppercase tracking-wide font-600">{walletMeta.label}</span>
                      {isActive && (
                        <span className="px-1.5 py-0.5 rounded-[999px] bg-accent-soft text-accent-bright text-[9px] font-600 uppercase tracking-wide">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[14px] font-600 text-text-1">{balanceFormatted} {walletMeta.symbol}</div>
                    {wallet.portfolioSummary?.nonZeroAssets ? (
                      <div className="mt-1 text-[10px] text-text-3/55">
                        {wallet.portfolioSummary.nonZeroAssets} asset{wallet.portfolioSummary.nonZeroAssets === 1 ? '' : 's'} tracked
                      </div>
                    ) : null}
                    <div className="mt-1 text-[10px] text-text-3/55 font-mono truncate">{wallet.publicKey}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {sortedWallets.map((wallet) => {
            const walletMeta = getWalletChainMeta(wallet.chain)
            const balanceFormatted = wallet.balanceFormatted || formatWalletAmount(wallet.chain, getWalletBalanceAtomic(wallet), { minFractionDigits: 4, maxFractionDigits: 6 })
            const perTxLimit = formatWalletAmount(wallet.chain, getWalletLimitAtomic(wallet, 'perTx'), { maxFractionDigits: 6 })
            const dailyLimit = formatWalletAmount(wallet.chain, getWalletLimitAtomic(wallet, 'daily'), { maxFractionDigits: 6 })
            const isActive = wallet.id === activeWalletId || wallet.isActive === true
            return (
              <div key={wallet.id} className="p-4 rounded-[12px] border border-white/[0.06] bg-surface-2/50 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-3/60 uppercase tracking-wide font-600">
                    {walletMeta.label}
                  </span>
                  {isActive && (
                    <span className="px-1.5 py-0.5 rounded-[999px] bg-accent-soft text-accent-bright text-[9px] font-600 uppercase tracking-wide">
                      Default
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="text-[13px] font-600 text-text-1">
                    {balanceFormatted} {walletMeta.symbol}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-[11px] text-text-3 bg-black/20 px-2 py-1 rounded-[6px] font-mono truncate flex-1">
                    {wallet.publicKey}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyAddress(wallet)}
                    className="shrink-0 px-2 py-1 rounded-[6px] text-[10px] text-text-3 hover:text-text-2 border border-white/[0.08] bg-surface transition-colors cursor-pointer"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {copiedWalletId === wallet.id ? 'Copied!' : 'Copy'}
                  </button>
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => setActiveWallet(wallet.id)}
                      disabled={activatingWalletId === wallet.id}
                      className="shrink-0 px-2 py-1 rounded-[6px] text-[10px] font-600 text-accent-bright border border-accent-bright/20 bg-accent-soft/10 hover:bg-accent-soft/20 transition-colors cursor-pointer disabled:opacity-50"
                      style={{ fontFamily: 'inherit' }}
                    >
                      {activatingWalletId === wallet.id ? 'Setting...' : 'Set Default'}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[10px] text-text-3/60">
                  <span>Limit: {perTxLimit} {walletMeta.symbol}/tx</span>
                  <span>Daily: {dailyLimit} {walletMeta.symbol}</span>
                  <span>{!walletApprovalsEnabled ? 'Approvals off globally' : (wallet.requireApproval ? 'Approval required' : 'Auto-send')}</span>
                  {wallet.portfolioSummary?.nonZeroAssets ? (
                    <span>{wallet.portfolioSummary.nonZeroAssets} asset{wallet.portfolioSummary.nonZeroAssets === 1 ? '' : 's'} detected</span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {availableChains.length > 0 ? (
        <div className="mt-3 p-4 rounded-[12px] border border-white/[0.06] bg-surface-2/50">
          <p className="text-[12px] text-text-3/70 mb-3">
            {getWalletChainMeta(chain).createDescription}
          </p>
          <label className="block text-[11px] text-text-3/70 mb-1">Wallet Type</label>
          <select
            value={chain}
            onChange={(event) => setChain(event.target.value as WalletChain)}
            className="w-full mb-3 px-3 py-2 rounded-[8px] border border-white/[0.08] bg-surface text-[12px] text-text-1 outline-none focus:border-accent/40"
            style={{ fontFamily: 'inherit' }}
          >
            {availableChains.map((availableChain) => (
              <option key={availableChain} value={availableChain}>
                {getWalletChainMeta(availableChain).label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={createWallet}
            disabled={creating}
            className="px-3 py-1.5 rounded-[8px] bg-accent-soft text-accent-bright text-[11px] font-600 hover:bg-accent-bright/15 transition-all cursor-pointer disabled:opacity-50 border border-accent-bright/20"
            style={{ fontFamily: 'inherit' }}
          >
            {creating ? 'Creating...' : `Create ${getWalletChainMeta(chain).label} Wallet`}
          </button>
          {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
        </div>
      ) : (
        <div className="mt-3 p-4 rounded-[12px] border border-white/[0.06] bg-surface-2/50">
          <p className="text-[12px] text-text-3/70">
            This agent already has both supported wallet types connected. Use the default toggle above to choose which wallet autonomous actions use when no chain is specified.
          </p>
          {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
        </div>
      )}
    </div>
  )
}
