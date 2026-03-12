'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '@/lib/app/api-client'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { useWs } from '@/hooks/use-ws'
import { WalletApprovalDialog } from './wallet-approval-dialog'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { AgentWallet, WalletTransaction, WalletBalanceSnapshot, WalletAssetBalance, WalletPortfolioSummary, Agent, WalletChain } from '@/types'
import {
  SUPPORTED_WALLET_CHAINS,
  formatWalletAmount,
  getWalletAssetSymbol,
  getWalletAtomicAmount,
  getWalletBalanceAtomic,
  getWalletChainMeta,
  getWalletLimitAtomic,
  parseDisplayAmountToAtomic,
} from '@/lib/wallet/wallet'
import { type WalletTransactionFilter, filterWalletTransactions, getWalletTransactionStatusGroup } from '@/lib/wallet/wallet-transactions'
import { toast } from 'sonner'
import { dedup, errorMessage } from '@/lib/shared-utils'

type SafeWallet = Omit<AgentWallet, 'encryptedPrivateKey'> & {
  balanceAtomic?: string
  balanceLamports?: number
  balanceFormatted?: string
  balanceSymbol?: string
  assets?: WalletAssetBalance[]
  portfolioSummary?: WalletPortfolioSummary
  isActive?: boolean
}

function getAgentWalletIds(agent: Agent | undefined | null): string[] {
  const ids = Array.isArray(agent?.walletIds)
    ? agent.walletIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const legacy = typeof agent?.walletId === 'string' && agent.walletId.trim()
    ? [agent.walletId.trim()]
    : []
  return dedup([...ids, ...legacy])
}

function getAgentActiveWalletId(agent: Agent | undefined | null, fallbackWallets: SafeWallet[] = []): string | null {
  const walletIds = getAgentWalletIds(agent)
  if (typeof agent?.activeWalletId === 'string' && walletIds.includes(agent.activeWalletId)) return agent.activeWalletId
  if (typeof agent?.walletId === 'string' && walletIds.includes(agent.walletId)) return agent.walletId
  const activeWallet = fallbackWallets.find((wallet) => wallet.isActive)
  return activeWallet?.id || fallbackWallets[0]?.id || walletIds[0] || null
}

function SolanaIcon({ size = 12, className = '', shimmer = false }: { size?: number; className?: string; shimmer?: boolean }) {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <svg width={size} height={size} viewBox="0 0 128 128" className="relative z-10">
        <defs>
          <linearGradient id="sol-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00FFA3" />
            <stop offset="100%" stopColor="#DC1FFF" />
          </linearGradient>
        </defs>
        <path d="M25.5 100.5a4.3 4.3 0 0 1 3-1.3h93.2a2.2 2.2 0 0 1 1.5 3.7l-17.7 17.8a4.3 4.3 0 0 1-3 1.3H9.3a2.2 2.2 0 0 1-1.5-3.7l17.7-17.8z" fill="url(#sol-grad)" />
        <path d="M25.5 7.3a4.4 4.4 0 0 1 3-1.3h93.2a2.2 2.2 0 0 1 1.5 3.7L105.5 27.5a4.3 4.3 0 0 1-3 1.3H9.3a2.2 2.2 0 0 1-1.5-3.7L25.5 7.3z" fill="url(#sol-grad)" />
        <path d="M105.5 53.7a4.3 4.3 0 0 0-3-1.3H9.3a2.2 2.2 0 0 0-1.5 3.7l17.7 17.8a4.3 4.3 0 0 0 3 1.3h93.2a2.2 2.2 0 0 0 1.5-3.7L105.5 53.7z" fill="url(#sol-grad)" />
      </svg>
      {shimmer && (
        <div className="absolute inset-0 bg-accent-bright/20 blur-md rounded-full animate-pulse" />
      )}
    </div>
  )
}

function EthereumIcon({ size = 12, className = '', shimmer = false }: { size?: number; className?: string; shimmer?: boolean }) {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <svg width={size} height={size} viewBox="0 0 256 417" className="relative z-10" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M127.6 0L124.8 9.5V279.1L127.6 281.9L255.2 208.3L127.6 0Z" fill="#8A92B2" />
        <path d="M127.6 0L0 208.3L127.6 281.9V151.1V0Z" fill="#62688F" />
        <path d="M127.6 306.1L126 308V416.9L127.6 421.6L255.3 232.6L127.6 306.1Z" fill="#8A92B2" />
        <path d="M127.6 421.6V306.1L0 232.6L127.6 421.6Z" fill="#62688F" />
        <path d="M127.6 281.9L255.2 208.3L127.6 151.1V281.9Z" fill="#454A75" />
        <path d="M0 208.3L127.6 281.9V151.1L0 208.3Z" fill="#8A92B2" />
      </svg>
      {shimmer && (
        <div className="absolute inset-0 bg-sky-400/20 blur-md rounded-full animate-pulse" />
      )}
    </div>
  )
}

function ChainIcon({ chain, size = 12, className = '', shimmer = false }: { chain: WalletChain; size?: number; className?: string; shimmer?: boolean }) {
  if (chain === 'ethereum') return <EthereumIcon size={size} className={className} shimmer={shimmer} />
  return <SolanaIcon size={size} className={className} shimmer={shimmer} />
}

function walletBalanceLabel(wallet: SafeWallet): string {
  return wallet.balanceFormatted || formatWalletAmount(wallet.chain, getWalletBalanceAtomic(wallet), { minFractionDigits: 3, maxFractionDigits: 6 })
}

function walletAssetCountLabel(wallet: SafeWallet): string | null {
  const count = wallet.portfolioSummary?.nonZeroAssets
  if (!count) return null
  return `${count} asset${count === 1 ? '' : 's'}`
}

function suggestCreateChain(wallets: SafeWallet[], agentId?: string | null): WalletChain {
  if (!agentId) return 'solana'
  const connectedChains = new Set(wallets.filter((wallet) => wallet.agentId === agentId).map((wallet) => wallet.chain))
  return SUPPORTED_WALLET_CHAINS.find((chain) => !connectedChains.has(chain)) || 'solana'
}

export function WalletPanel() {
  const agents = useAppStore((s) => s.agents)
  const appSettings = useAppStore((s) => s.appSettings)
  const walletPanelAgentId = useAppStore((s) => s.walletPanelAgentId)
  const setWalletPanelAgentId = useAppStore((s) => s.setWalletPanelAgentId)
  const navigateTo = useNavigate()
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)

  const [wallets, setWallets] = useState<Record<string, SafeWallet>>({})
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [balanceHistory, setBalanceHistory] = useState<WalletBalanceSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [transactionsLoading, setTransactionsLoading] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<WalletTransaction | null>(null)
  const [transactionFilter, setTransactionFilter] = useState<WalletTransactionFilter>('all')
  const [transactionQuery, setTransactionQuery] = useState('')
  const detailRequestRef = useRef(0)

  // Settings edit state
  const [editingLimits, setEditingLimits] = useState(false)
  const [perTxLimit, setPerTxLimit] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [requireApproval, setRequireApproval] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [settingDefault, setSettingDefault] = useState(false)
  const [reassigning, setReassigning] = useState(false)
  const [reassignSaving, setReassignSaving] = useState(false)
  const [reassignError, setReassignError] = useState('')

  // Create wallet state
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createAgentId, setCreateAgentId] = useState('')
  const [createChain, setCreateChain] = useState<WalletChain>('solana')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const loadWallets = useCallback(async () => {
    try {
      const data = await api<Record<string, SafeWallet>>('GET', '/wallets')
      setWallets(data)

      if (!walletPanelAgentId && !selectedWalletId && Object.keys(data).length > 0) {
        const defaultWallet = Object.values(data).find((wallet) => wallet.isActive) || Object.values(data)[0]
        if (defaultWallet) setSelectedWalletId(defaultWallet.id)
      }
    } catch { /* ignore */ }
    setLoading(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletPanelAgentId])

  useEffect(() => { loadWallets() }, [loadWallets])

  // Sync wallet selection when agent panel changes
  useEffect(() => {
    if (!walletPanelAgentId) return
    const agentWallets = Object.values(wallets).filter((wallet) => wallet.agentId === walletPanelAgentId)
    const selectedAgentWallet = selectedWalletId
      ? agentWallets.find((wallet) => wallet.id === selectedWalletId) || null
      : null
    if (selectedAgentWallet) {
      setShowCreateForm(false)
      setCreateError('')
      setCreateAgentId(walletPanelAgentId)
      return
    }
    const activeWalletId = getAgentActiveWalletId(agents[walletPanelAgentId] as Agent | undefined, agentWallets)
    const match = agentWallets.find((wallet) => wallet.id === activeWalletId) || agentWallets[0]
    if (match) {
      setSelectedWalletId(match.id)
      setShowCreateForm(false)
      setCreateError('')
      setCreateAgentId(walletPanelAgentId)
      return
    }
    if (!agents[walletPanelAgentId]) return
    setSelectedWalletId(null)
    setShowCreateForm(true)
    setCreateAgentId(walletPanelAgentId)
    setCreateChain(suggestCreateChain(Object.values(wallets), walletPanelAgentId))
    setCreateError('')
  }, [agents, selectedWalletId, walletPanelAgentId, wallets])

  // Load detail when wallet selected
  const selectedWallet = selectedWalletId ? wallets[selectedWalletId] : null

  const loadDetail = useCallback(async (walletId = selectedWalletId) => {
    if (!walletId) return
    const requestId = ++detailRequestRef.current
    setTransactionsLoading(true)
    const [detailResult, txResult, historyResult] = await Promise.allSettled([
      api<SafeWallet>('GET', `/wallets/${walletId}`),
      api<WalletTransaction[]>('GET', `/wallets/${walletId}/transactions`),
      api<WalletBalanceSnapshot[]>('GET', `/wallets/${walletId}/balance-history`),
    ])
    if (detailRequestRef.current !== requestId) return

    if (detailResult.status === 'fulfilled') {
      setWallets((prev) => ({ ...prev, [walletId]: detailResult.value }))
    }
    if (txResult.status === 'fulfilled') {
      setTransactions(txResult.value)
      const pending = txResult.value.find((tx) => tx.status === 'pending_approval')
      setPendingApproval(pending || null)
    }
    if (historyResult.status === 'fulfilled') {
      setBalanceHistory(historyResult.value)
    }
    setTransactionsLoading(false)
  }, [selectedWalletId])

  useEffect(() => { loadDetail() }, [loadDetail])

  const refreshWalletData = useCallback(async () => {
    await loadWallets()
    if (selectedWalletId) {
      await loadDetail(selectedWalletId)
    }
  }, [loadDetail, loadWallets, selectedWalletId])

  useWs('wallets', refreshWalletData, 15000)

  // Initialize limits when wallet selected
  useEffect(() => {
    if (selectedWallet) {
      setPerTxLimit(formatWalletAmount(selectedWallet.chain, getWalletLimitAtomic(selectedWallet, 'perTx'), { maxFractionDigits: 6 }))
      setDailyLimit(formatWalletAmount(selectedWallet.chain, getWalletLimitAtomic(selectedWallet, 'daily'), { maxFractionDigits: 6 }))
      setRequireApproval(selectedWallet.requireApproval)
    }
  }, [selectedWallet])

  const saveLimits = useCallback(async () => {
    if (!selectedWalletId || !selectedWallet) return
    setSaving(true)
    try {
      const spendingLimitAtomic = parseDisplayAmountToAtomic(perTxLimit || '0', getWalletChainMeta(selectedWallet.chain).decimals)
      const dailyLimitAtomic = parseDisplayAmountToAtomic(dailyLimit || '0', getWalletChainMeta(selectedWallet.chain).decimals)
      await api('PATCH', `/wallets/${selectedWalletId}`, {
        spendingLimitAtomic,
        dailyLimitAtomic,
        requireApproval,
      })
      setEditingLimits(false)
      loadDetail()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    }
    setSaving(false)
  }, [selectedWalletId, selectedWallet, perTxLimit, dailyLimit, requireApproval, loadDetail])

  const setDefaultWallet = useCallback(async () => {
    if (!selectedWalletId) return
    setSettingDefault(true)
    try {
      await api('PATCH', `/wallets/${selectedWalletId}`, { makeActive: true })
      toast.success('Default wallet updated')
      loadWallets()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    }
    setSettingDefault(false)
  }, [selectedWalletId, loadWallets])

  const handleDelete = useCallback(async () => {
    if (!selectedWalletId) return
    setDeleting(true)
    try {
      await api('DELETE', `/wallets/${selectedWalletId}`)
      setSelectedWalletId(null)
      setConfirmDelete(false)
      loadWallets()
    } catch { /* ignore */ }
    setDeleting(false)
  }, [selectedWalletId, loadWallets])

  const [copied, setCopied] = useState(false)
  const copyAddress = useCallback(async () => {
    if (!selectedWallet) return
    const copiedValue = await copyTextToClipboard(selectedWallet.publicKey)
    if (!copiedValue) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [selectedWallet])

  const agentsMissingSelectedChain = useMemo(() => {
    return Object.values(agents).filter((agent) => !Object.values(wallets).some((wallet) => wallet.agentId === agent.id && wallet.chain === createChain)) as Agent[]
  }, [agents, createChain, wallets])

  const canCreateMoreWallets = useMemo(() => {
    return Object.values(agents).some((agent) =>
      SUPPORTED_WALLET_CHAINS.some((chain) => !Object.values(wallets).some((wallet) => wallet.agentId === agent.id && wallet.chain === chain)),
    )
  }, [agents, wallets])

  useEffect(() => {
    if (!createAgentId) return
    if (agentsMissingSelectedChain.some((agent) => agent.id === createAgentId)) return
    setCreateAgentId('')
  }, [agentsMissingSelectedChain, createAgentId])

  const createWallet = useCallback(async () => {
    if (!createAgentId) return
    setCreating(true)
    setCreateError('')
    try {
      await api('POST', '/wallets', { agentId: createAgentId, chain: createChain })
      setShowCreateForm(false)
      setCreateAgentId('')
      setCreateChain('solana')
      loadWallets()
    } catch (err: unknown) {
      setCreateError(errorMessage(err))
    }
    setCreating(false)
  }, [createAgentId, createChain, loadWallets])

  const filteredTransactions = useMemo(
    () => filterWalletTransactions(transactions, { filter: transactionFilter, query: transactionQuery }),
    [transactionFilter, transactionQuery, transactions],
  )

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-5 h-5 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    )
  }

  const walletList = Object.values(wallets).sort((a, b) => {
    const aAgent = agents[a.agentId] as Agent | undefined
    const bAgent = agents[b.agentId] as Agent | undefined
    const aActive = a.isActive === true || getAgentActiveWalletId(aAgent, [a]) === a.id
    const bActive = b.isActive === true || getAgentActiveWalletId(bAgent, [b]) === b.id
    if (a.agentId === b.agentId && aActive !== bActive) return aActive ? -1 : 1
    const agentCompare = (aAgent?.name || a.agentId).localeCompare(bAgent?.name || b.agentId)
    if (agentCompare !== 0) return agentCompare
    return a.chain.localeCompare(b.chain)
  })
  const selectedWalletMeta = selectedWallet ? getWalletChainMeta(selectedWallet.chain) : null
  const selectedWalletSymbol = selectedWallet ? getWalletAssetSymbol(selectedWallet.chain) : null
  const walletApprovalsEnabled = appSettings.walletApprovalsEnabled !== false
  const selectedWalletBalance = selectedWallet ? walletBalanceLabel(selectedWallet) : null
  const selectedWalletAssets = (selectedWallet?.assets || []).filter((asset) => BigInt(asset.balanceAtomic) > BigInt(0))
  const selectedAgent = selectedWallet ? agents[selectedWallet.agentId] as Agent | undefined : undefined
  const selectedAgentWallets = selectedWallet
    ? walletList.filter((wallet) => wallet.agentId === selectedWallet.agentId)
    : []
  const selectedAgentActiveWalletId = getAgentActiveWalletId(selectedAgent, selectedAgentWallets)
  const reassignCandidates = selectedWallet
    ? (Object.values(agents).filter((agent) => (
        agent.id !== selectedWallet.agentId
        && !walletList.some((wallet) => wallet.agentId === agent.id && wallet.chain === selectedWallet.chain)
      )) as Agent[])
    : []

  if (walletList.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm" style={{ animation: 'fade-up 0.5s var(--ease-spring)' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-4 text-text-3/30">
            <rect x="2" y="6" width="20" height="14" rx="2" /><path d="M22 10H18a2 2 0 0 0 0 4h4" /><path d="M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
          </svg>
          <h3 className="font-display text-[14px] font-600 text-text-2 mb-2">No wallets yet</h3>
          {agentsMissingSelectedChain.length > 0 ? (
            <div className="mt-4 space-y-3">
              <AgentPickerList
                agents={agentsMissingSelectedChain}
                selected={createAgentId}
                onSelect={(id) => setCreateAgentId(id === createAgentId ? '' : id)}
                maxHeight={180}
              />
              <select
                value={createChain}
                onChange={(e) => setCreateChain(e.target.value as WalletChain)}
                className="w-full px-3 py-2 rounded-[8px] border border-white/[0.08] bg-surface text-[12px] text-text-1 outline-none focus:border-accent/40"
                style={{ fontFamily: 'inherit' }}
              >
                <option value="solana">Solana</option>
                <option value="ethereum">Ethereum (EVM)</option>
              </select>
              <button
                type="button"
                onClick={createWallet}
                disabled={!createAgentId || creating}
                className="w-full px-3 py-2 rounded-[8px] bg-accent text-white text-[12px] font-600 hover:brightness-110 cursor-pointer disabled:opacity-50 transition-colors"
                style={{ fontFamily: 'inherit' }}
              >
                {creating ? 'Creating...' : 'Create Wallet'}
              </button>
              {createError && <p className="text-[11px] text-red-400">{createError}</p>}
            </div>
          ) : (
            <p className="text-[12px] text-text-3/60">
              Every agent already has a {getWalletChainMeta(createChain).label} wallet.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex h-full min-w-0">
      {/* Sidebar — wallet list */}
      <div className="w-[240px] shrink-0 border-r border-white/[0.06] flex flex-col">
        <div className="flex items-center px-4 pt-4 pb-2 shrink-0">
          <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">Wallets</h2>
          <button
            type="button"
            onClick={() => {
              setShowCreateForm(!showCreateForm)
              setCreateAgentId(walletPanelAgentId || '')
              setCreateChain(suggestCreateChain(walletList, walletPanelAgentId))
              setCreateError('')
            }}
            disabled={!canCreateMoreWallets}
            className="w-6 h-6 rounded-[6px] flex items-center justify-center text-text-3/50 hover:text-text-2 hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
            title={canCreateMoreWallets ? 'Create wallet' : 'Every agent already has both wallet types'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {showCreateForm && (
            <div className="mx-1 mb-2 p-2.5 rounded-[8px] border border-accent/20 bg-accent-soft/10 space-y-2"
              style={{ animation: 'spring-in 0.4s var(--ease-spring)' }}>
              <AgentPickerList
                agents={agentsMissingSelectedChain}
                selected={createAgentId}
                onSelect={(id) => setCreateAgentId(id === createAgentId ? '' : id)}
                maxHeight={160}
              />
              <select
                value={createChain}
                onChange={(e) => setCreateChain(e.target.value as WalletChain)}
                className="w-full px-2 py-1.5 rounded-[6px] border border-white/[0.08] bg-surface text-[10px] text-text-1 outline-none focus:border-accent/40"
                style={{ fontFamily: 'inherit' }}
              >
                <option value="solana">Solana</option>
                <option value="ethereum">Ethereum (EVM)</option>
              </select>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={createWallet}
                  disabled={!createAgentId || creating}
                  className="flex-1 px-2 py-1.5 rounded-[6px] bg-accent text-white text-[10px] font-600 hover:brightness-110 cursor-pointer disabled:opacity-50 transition-colors"
                  style={{ fontFamily: 'inherit' }}
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreateForm(false); setCreateError('') }}
                  className="px-2 py-1.5 rounded-[6px] border border-white/[0.08] text-text-3 text-[10px] hover:text-text-2 cursor-pointer transition-colors"
                  style={{ fontFamily: 'inherit' }}
                >
                  Cancel
                </button>
              </div>
              {createError && <p className="text-[10px] text-red-400">{createError}</p>}
            </div>
          )}
          {walletList.map((w, idx) => {
            const a = agents[w.agentId] as Agent | undefined
            const isActive = w.isActive === true || getAgentActiveWalletId(a, walletList.filter((wallet) => wallet.agentId === w.agentId)) === w.id
            return (
              <button
                key={w.id}
                onClick={() => { setSelectedWalletId(w.id); setWalletPanelAgentId(w.agentId) }}
                className={`w-full text-left px-3 py-2.5 rounded-[8px] mb-1 transition-all cursor-pointer flex items-center gap-2.5 hover:scale-[1.02] ${
                  selectedWalletId === w.id ? 'bg-accent-soft/30 text-text-1' : 'text-text-3 hover:bg-white/[0.04]'
                }`}
                style={{
                  animation: 'fade-up 0.4s var(--ease-spring) both',
                  animationDelay: `${idx * 0.03}s`
                }}
              >
                <AgentAvatar seed={a?.avatarSeed || null} avatarUrl={a?.avatarUrl} name={a?.name || '?'} size={28} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className="text-[12px] font-600 truncate">{a?.name || w.agentId}</div>
                    {isActive && (
                      <span className="shrink-0 px-1 py-0.5 rounded-[999px] bg-accent-soft/40 text-accent-bright text-[8px] font-700 uppercase tracking-wide">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-text-3/50 font-mono truncate mt-0.5 flex items-center gap-1">
                    <ChainIcon chain={w.chain} size={9} className="shrink-0 opacity-50" />
                    <span className="truncate">{w.publicKey.slice(0, 8)}...{w.publicKey.slice(-4)}</span>
                    <span className="text-text-3/40">{walletBalanceLabel(w)} {getWalletAssetSymbol(w.chain)}</span>
                    {walletAssetCountLabel(w) && <span className="text-text-3/35">{walletAssetCountLabel(w)}</span>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Main detail area */}
      {selectedWallet ? (
        <div className="flex-1 overflow-y-auto p-6 space-y-6" key={selectedWallet.id}>
          {/* Warning banner */}
          <div className="flex items-start gap-3 p-3 rounded-[10px] bg-amber-500/10 border border-amber-500/20"
            style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 shrink-0 mt-0.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p className="text-[11px] text-amber-300/80 leading-relaxed">
              Agent Wallets is experimental. Crypto transactions are irreversible. Do not store more than you can afford to lose.
            </p>
          </div>

          {selectedAgentWallets.length > 1 && (
            <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface-2/50"
              style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.03s both' }}>
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600">Combined Wallet Stats</div>
                  <p className="text-[12px] text-text-3/70 mt-1">
                    {selectedAgentWallets.length} wallets connected for this agent. Pick a wallet in the sidebar for chain-specific history and controls.
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-[18px] font-600 text-text-1">{selectedAgentWallets.length}</div>
                  <div className="text-[10px] uppercase tracking-wide text-text-3/50">Wallets</div>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {selectedAgentWallets.map((wallet) => (
                  <div key={wallet.id} className="rounded-[10px] border border-white/[0.06] bg-black/10 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-text-3/60 uppercase tracking-wide font-600">
                        {getWalletChainMeta(wallet.chain).label}
                      </span>
                      {(wallet.id === selectedAgentActiveWalletId || wallet.isActive) && (
                        <span className="px-1.5 py-0.5 rounded-[999px] bg-accent-soft/40 text-accent-bright text-[8px] font-700 uppercase tracking-wide">
                          Default
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[14px] font-600 text-text-1">
                      {walletBalanceLabel(wallet)} {getWalletAssetSymbol(wallet.chain)}
                    </div>
                    {wallet.portfolioSummary?.nonZeroAssets ? (
                      <div className="mt-1 text-[10px] text-text-3/55">
                        {wallet.portfolioSummary.nonZeroAssets} detected asset{wallet.portfolioSummary.nonZeroAssets === 1 ? '' : 's'}
                      </div>
                    ) : null}
                    <div className="mt-1 text-[10px] text-text-3/55 font-mono truncate">{wallet.publicKey}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Agent & Address */}
          <div style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.05s both' }}>
            <div className="flex items-center gap-2 mb-2">
              {(() => {
                const a = agents[selectedWallet.agentId] as Agent | undefined
                return a ? (
                  <button
                    type="button"
                    onClick={() => { setEditingAgentId(a.id); navigateTo('agents') }}
                    className="flex items-center gap-2 bg-transparent border-none p-0 cursor-pointer group"
                    style={{ fontFamily: 'inherit' }}
                    title="Open agent settings"
                  >
                    <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={24} />
                    <span className="text-[13px] font-600 text-text-2 group-hover:text-accent-bright transition-colors">{a.name}</span>
                  </button>
                ) : (
                  <span className="text-[13px] font-600 text-text-2">{selectedWallet.agentId}</span>
                )
              })()}
              <span className="inline-flex items-center gap-1 text-[11px] text-text-3/40 uppercase tracking-wide font-600">
                <ChainIcon chain={selectedWallet.chain} size={11} />
                {selectedWallet.chain}
              </span>
              {(selectedWallet.id === selectedAgentActiveWalletId || selectedWallet.isActive) && (
                <span className="px-1.5 py-0.5 rounded-[999px] bg-accent-soft/40 text-accent-bright text-[9px] font-700 uppercase tracking-wide">
                  Default
                </span>
              )}
              <button
                type="button"
                onClick={() => { setReassigning(!reassigning); setReassignError('') }}
                className="text-[10px] text-text-3/40 hover:text-accent-bright transition-colors cursor-pointer bg-transparent border-none px-1.5 py-0.5 rounded-[5px] hover:bg-white/[0.04]"
                style={{ fontFamily: 'inherit' }}
              >
                {reassigning ? 'Cancel' : 'Reassign'}
              </button>
              {selectedWallet.id !== selectedAgentActiveWalletId && !selectedWallet.isActive && (
                <button
                  type="button"
                  onClick={setDefaultWallet}
                  disabled={settingDefault}
                  className="text-[10px] text-accent-bright hover:text-white transition-colors cursor-pointer bg-transparent border border-accent-bright/20 px-1.5 py-0.5 rounded-[5px] hover:bg-accent/20 disabled:opacity-50"
                  style={{ fontFamily: 'inherit' }}
                >
                  {settingDefault ? 'Setting...' : 'Set Default'}
                </button>
              )}
            </div>
            {reassigning && (
              <div className="mb-2 space-y-2" style={{ animation: 'spring-in 0.4s var(--ease-spring)' }}>
                <p className="text-[11px] text-text-3/60">Select a new agent to control this wallet:</p>
                {reassignCandidates.length > 0 ? (
                  <AgentPickerList
                    agents={reassignCandidates}
                    selected=""
                    onSelect={async (agentId) => {
                      setReassignSaving(true)
                      setReassignError('')
                      try {
                        await api('PATCH', `/wallets/${selectedWallet.id}`, { agentId })
                        setReassigning(false)
                        loadWallets()
                      } catch (err: unknown) {
                        setReassignError(errorMessage(err) || 'Reassign failed')
                      }
                      setReassignSaving(false)
                    }}
                    maxHeight={160}
                  />
                ) : (
                  <p className="text-[10px] text-text-3/50">
                    No other agents can take this {selectedWallet.chain} wallet right now.
                  </p>
                )}
                {reassignSaving && <p className="text-[10px] text-text-3/50">Reassigning...</p>}
                {reassignError && <p className="text-[10px] text-red-400">{reassignError}</p>}
              </div>
            )}
            <div className="flex items-center gap-2">
              <code className="text-[13px] text-text-2 font-mono bg-black/20 px-3 py-2 rounded-[8px] flex-1 truncate">
                {selectedWallet.publicKey}
              </code>
              <button
                type="button"
                onClick={copyAddress}
                className="shrink-0 px-3 py-2 rounded-[8px] text-[11px] text-text-3 hover:text-text-2 border border-white/[0.08] bg-surface transition-colors cursor-pointer"
                style={{ fontFamily: 'inherit' }}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Balance card */}
          <div className="p-5 rounded-[14px] border border-white/[0.06] bg-surface-2/50"
            style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.1s both' }}>
            <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600 mb-2">Balance</div>
            <div className="flex items-baseline gap-3">
              <div className="text-[28px] font-600 text-text-1 tracking-tight">
                {selectedWalletBalance} <span className="text-[14px] text-text-3/60 font-mono">{selectedWalletSymbol}</span>
              </div>
              <ChainIcon chain={selectedWallet.chain} size={16} shimmer className="opacity-80" />
            </div>
            <div className="mt-2 text-[11px] text-text-3/60">
              {selectedWallet.portfolioSummary?.nonZeroAssets
                ? `${selectedWallet.portfolioSummary.nonZeroAssets} funded asset${selectedWallet.portfolioSummary.nonZeroAssets === 1 ? '' : 's'} across ${Math.max(selectedWallet.portfolioSummary.networkCount, 1)} network${selectedWallet.portfolioSummary.networkCount === 1 ? '' : 's'}`
                : 'No funded assets detected yet.'}
            </div>
          </div>

          <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface-2/50"
            style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.13s both' }}>
            <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600 mb-3">Detected Assets</div>
            {selectedWalletAssets.length === 0 ? (
              <p className="text-[12px] text-text-3/55">No funded token or native balances detected yet.</p>
            ) : (
              <div className="space-y-2">
                {selectedWalletAssets.map((asset) => (
                  <div key={asset.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-white/[0.06] bg-black/10 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[12px] font-600 text-text-1 truncate">{asset.symbol}</span>
                        <span className="text-[10px] text-text-3/55 uppercase tracking-wide">{asset.networkLabel}</span>
                        {asset.isNative && (
                          <span className="px-1.5 py-0.5 rounded-[999px] bg-accent-soft/30 text-accent-bright text-[8px] font-700 uppercase tracking-wide">
                            Gas
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-text-3/55 truncate">{asset.name || asset.symbol}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[12px] font-600 text-text-1">{asset.balanceDisplay || asset.balanceFormatted || asset.balanceAtomic}</div>
                      {asset.contractAddress && (
                        <div className="text-[10px] text-text-3/45 font-mono">{asset.contractAddress.slice(0, 6)}...{asset.contractAddress.slice(-4)}</div>
                      )}
                      {asset.tokenMint && (
                        <div className="text-[10px] text-text-3/45 font-mono">{asset.tokenMint.slice(0, 6)}...{asset.tokenMint.slice(-4)}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Funding help */}
          <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface-2/50"
            style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.16s both' }}>
            <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600 mb-2">How to Fund This Wallet</div>
            <div className="space-y-2 text-[12px] text-text-3/70 leading-relaxed">
              {selectedWalletMeta?.fundingInstructions.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p className="text-text-3/50 text-[11px]">The private key is AES-256 encrypted in your local database (<code className="text-[10px] bg-black/20 px-1 py-0.5 rounded">data/swarmclaw.db</code>). It is never exposed via the API. To export it, query the <code className="text-[10px] bg-black/20 px-1 py-0.5 rounded">wallets</code> table directly and decrypt using your <code className="text-[10px] bg-black/20 px-1 py-0.5 rounded">CREDENTIAL_SECRET</code>.</p>
            </div>
          </div>

          {/* Balance history chart (simple) */}
          {balanceHistory.length > 1 && (
            <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface-2/50"
              style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.2s both' }}>
              <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600 mb-3">Balance Over Time</div>
              <div className="h-[120px] flex items-end gap-[2px]">
                {(() => {
                  const recentHistory = balanceHistory.slice(-60)
                  const balances = recentHistory.map((snapshot) => Number.parseFloat(formatWalletAmount(selectedWallet.chain, getWalletBalanceAtomic(snapshot), { maxFractionDigits: 6 })) || 0)
                  const max = Math.max(...balances, 1)
                  return recentHistory.map((s, i) => (
                    <div
                      key={s.id || i}
                      className="flex-1 bg-accent/40 rounded-t-[2px] min-w-[3px] transition-all hover:bg-accent hover:scale-y-110"
                      style={{ height: `${Math.max(2, ((balances[i] || 0) / max) * 100)}%`, transitionDelay: `${i * 10}ms` }}
                      title={`${formatWalletAmount(selectedWallet.chain, getWalletBalanceAtomic(s), { minFractionDigits: 4, maxFractionDigits: 6 })} ${selectedWalletSymbol} — ${new Date(s.timestamp).toLocaleString()}`}
                    />
                  ))
                })()}
              </div>
            </div>
          )}

          {/* Spending config */}
          <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface-2/50"
            style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.25s both' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600">Spending Limits</div>
              {!editingLimits && (
                <button
                  type="button"
                  onClick={() => setEditingLimits(true)}
                  className="text-[11px] text-accent-bright hover:underline cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  Edit
                </button>
              )}
            </div>

            {editingLimits ? (
              <div className="space-y-3" style={{ animation: 'fade-in 0.3s ease' }}>
                <div>
                  <label className="block text-[11px] text-text-3/70 mb-1">Per-transaction limit ({selectedWalletSymbol})</label>
                  <input
                    type="number"
                    step="0.01"
                    value={perTxLimit}
                    onChange={(e) => setPerTxLimit(e.target.value)}
                    className="w-full px-3 py-2 rounded-[8px] border border-white/[0.08] bg-surface text-[12px] text-text-1 outline-none focus:border-accent/40"
                    style={{ fontFamily: 'inherit' }}
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-3/70 mb-1">Daily limit ({selectedWalletSymbol})</label>
                  <input
                    type="number"
                    step="0.1"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    className="w-full px-3 py-2 rounded-[8px] border border-white/[0.08] bg-surface text-[12px] text-text-1 outline-none focus:border-accent/40"
                    style={{ fontFamily: 'inherit' }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRequireApproval(!requireApproval)}
                    className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${requireApproval ? 'bg-accent' : 'bg-white/[0.12]'}`}
                  >
                    <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${requireApproval ? 'translate-x-[18px]' : ''}`} />
                  </button>
                  <span className="text-[11px] text-text-3">Require approval for sends</span>
                </div>
                {!walletApprovalsEnabled && (
                  <p className="text-[10px] text-amber-300/80">
                    Global wallet approvals are currently off in Settings, so this per-wallet toggle is ignored until they are turned back on.
                  </p>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={saveLimits}
                    disabled={saving}
                    className="px-3 py-1.5 rounded-[8px] bg-accent text-white text-[11px] font-600 hover:brightness-110 cursor-pointer disabled:opacity-50"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingLimits(false)}
                    className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] text-text-3 text-[11px] hover:text-text-2 cursor-pointer"
                    style={{ fontFamily: 'inherit' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-[12px]">
                <div className="flex justify-between">
                  <span className="text-text-3/70">Per-transaction</span>
                  <span className="text-text-2">{formatWalletAmount(selectedWallet.chain, getWalletLimitAtomic(selectedWallet, 'perTx'), { maxFractionDigits: 6 })} {selectedWalletSymbol}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-3/70">Daily rolling</span>
                  <span className="text-text-2">{formatWalletAmount(selectedWallet.chain, getWalletLimitAtomic(selectedWallet, 'daily'), { maxFractionDigits: 6 })} {selectedWalletSymbol}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-3/70">Approval</span>
                  <span className="text-text-2">
                    {!walletApprovalsEnabled
                      ? 'Disabled globally'
                      : (selectedWallet.requireApproval ? 'Required' : 'Auto-send')}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Transaction history */}
          <div style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.3s both' }}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600">Transactions</div>
              <div className="text-[10px] text-text-3/45">
                {filteredTransactions.length}{filteredTransactions.length !== transactions.length ? ` / ${transactions.length}` : ''} shown
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center mb-3">
              <input
                type="text"
                value={transactionQuery}
                onChange={(e) => setTransactionQuery(e.target.value)}
                placeholder="Search memo, hash, address..."
                className="flex-1 px-3 py-2 rounded-[8px] border border-white/[0.08] bg-surface text-[12px] text-text-1 outline-none focus:border-accent/40"
                style={{ fontFamily: 'inherit' }}
              />
              <select
                value={transactionFilter}
                onChange={(e) => setTransactionFilter(e.target.value as WalletTransactionFilter)}
                className="px-3 py-2 rounded-[8px] border border-white/[0.08] bg-surface text-[12px] text-text-1 outline-none focus:border-accent/40"
                style={{ fontFamily: 'inherit' }}
              >
                <option value="all">All</option>
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
                <option value="send">Sends</option>
                <option value="receive">Receives</option>
                <option value="swap">Swaps</option>
              </select>
            </div>
            {transactionsLoading && transactions.length === 0 ? (
              <p className="text-[12px] text-text-3/50">Loading transactions...</p>
            ) : transactions.length === 0 ? (
              <p className="text-[12px] text-text-3/50">No transactions yet.</p>
            ) : filteredTransactions.length === 0 ? (
              <p className="text-[12px] text-text-3/50">No matching transactions.</p>
            ) : (
              <div className="max-h-[420px] overflow-y-auto pr-1 space-y-2">
                {filteredTransactions.map((tx, idx) => (
                  <div key={tx.id} className="flex items-center gap-3 p-3 rounded-[10px] border border-white/[0.06] bg-surface-2/30 transition-all hover:bg-surface-2/50"
                    style={{ animation: 'fade-up 0.4s var(--ease-spring) both', animationDelay: `${0.35 + idx * 0.03}s` }}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] ${
                      tx.type === 'send' ? 'bg-red-500/15 text-red-400' :
                      tx.type === 'receive' ? 'bg-green-500/15 text-green-400' :
                      'bg-blue-500/15 text-blue-400'
                    }`}>
                      {tx.type === 'send' ? '\u2191' : tx.type === 'receive' ? '\u2193' : '\u21C4'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-600 text-text-1">
                          {tx.type === 'send' ? '-' : '+'}{formatWalletAmount(tx.chain, getWalletAtomicAmount(tx), { minFractionDigits: 4, maxFractionDigits: 6 })} {getWalletAssetSymbol(tx.chain)}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded-[4px] text-[9px] font-600 uppercase ${
                          getWalletTransactionStatusGroup(tx.status) === 'confirmed' ? 'bg-green-500/15 text-green-400' :
                          getWalletTransactionStatusGroup(tx.status) === 'pending' ? 'bg-amber-500/15 text-amber-400 animate-pulse' :
                          'bg-blue-500/15 text-blue-400'
                        }`}>
                          {tx.status.replace('_', ' ')}
                        </span>
                        <span className="px-1.5 py-0.5 rounded-[4px] bg-white/[0.05] text-[9px] font-600 uppercase text-text-3/70">
                          {tx.type}
                        </span>
                      </div>
                      <div className="text-[10px] text-text-3/50 font-mono truncate mt-0.5">
                        {tx.type === 'send' ? `To: ${tx.toAddress.slice(0, 8)}...${tx.toAddress.slice(-4)}` : `From: ${tx.fromAddress.slice(0, 8)}...${tx.fromAddress.slice(-4)}`}
                      </div>
                      {tx.memo && <div className="text-[10px] text-text-3/60 mt-0.5 truncate">{tx.memo}</div>}
                      <div className="text-[10px] text-text-3/40 font-mono truncate mt-0.5">
                        {tx.signature.slice(0, 10)}...{tx.signature.slice(-6)}
                      </div>
                    </div>
                    <div className="text-[10px] text-text-3/40 shrink-0">
                      {new Date(tx.timestamp).toLocaleDateString()}
                    </div>
                    {tx.status === 'pending_approval' && (
                      <button
                        type="button"
                        onClick={() => setPendingApproval(tx)}
                        className="shrink-0 px-2 py-1 rounded-[6px] bg-amber-500/15 text-amber-400 text-[10px] font-600 hover:bg-amber-500/25 cursor-pointer transition-all hover:scale-[1.05]"
                        style={{ fontFamily: 'inherit', animation: 'spring-in 0.4s var(--ease-spring)' }}
                      >
                        Review
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div className="p-4 rounded-[14px] border border-red-500/15 bg-red-500/5"
            style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.4s both' }}>
            <div className="text-[11px] text-red-400/80 uppercase tracking-wide font-600 mb-2">Danger Zone</div>
            {confirmDelete ? (
              <div className="space-y-2" style={{ animation: 'spring-in 0.3s var(--ease-spring)' }}>
                <p className="text-[11px] text-text-3/70">
                  This will permanently delete the wallet and its private key. Any remaining balance will be inaccessible. This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="px-3 py-1.5 rounded-[8px] bg-red-500 text-white text-[11px] font-600 hover:brightness-110 cursor-pointer disabled:opacity-50"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {deleting ? 'Deleting...' : 'Confirm Delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] text-text-3 text-[11px] hover:text-text-2 cursor-pointer"
                    style={{ fontFamily: 'inherit' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="px-3 py-1.5 rounded-[8px] border border-red-500/30 text-red-400 text-[11px] font-600 hover:bg-red-500/10 cursor-pointer transition-colors"
                style={{ fontFamily: 'inherit' }}
              >
                Delete Wallet
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12px] text-text-3/50" style={{ animation: 'fade-in 1s ease' }}>Select a wallet to view details</p>
        </div>
      )}

      {/* Approval dialog */}
      {pendingApproval && selectedWallet && (
        <WalletApprovalDialog
          transaction={pendingApproval}
          walletAddress={selectedWallet.publicKey}
          onClose={() => setPendingApproval(null)}
          onResolved={loadDetail}
        />
      )}
    </div>
  )
}
