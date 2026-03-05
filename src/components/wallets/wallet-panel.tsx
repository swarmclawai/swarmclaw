'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/lib/api-client'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { WalletApprovalDialog } from './wallet-approval-dialog'
import { AgentPickerList } from '@/components/shared/agent-picker-list'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { AgentWallet, WalletTransaction, WalletBalanceSnapshot, Agent } from '@/types'

type SafeWallet = Omit<AgentWallet, 'encryptedPrivateKey'> & { balanceLamports?: number; balanceSol?: number }

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

export function WalletPanel() {
  const agents = useAppStore((s) => s.agents)
  const walletPanelAgentId = useAppStore((s) => s.walletPanelAgentId)
  const setWalletPanelAgentId = useAppStore((s) => s.setWalletPanelAgentId)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)

  const [wallets, setWallets] = useState<Record<string, SafeWallet>>({})
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [balanceHistory, setBalanceHistory] = useState<WalletBalanceSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingApproval, setPendingApproval] = useState<WalletTransaction | null>(null)

  // Settings edit state
  const [editingLimits, setEditingLimits] = useState(false)
  const [perTxLimit, setPerTxLimit] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [requireApproval, setRequireApproval] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reassigning, setReassigning] = useState(false)
  const [reassignSaving, setReassignSaving] = useState(false)
  const [reassignError, setReassignError] = useState('')

  // Create wallet state
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createAgentId, setCreateAgentId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const loadWallets = useCallback(async () => {
    try {
      const data = await api<Record<string, SafeWallet>>('GET', '/wallets')
      setWallets(data)

      // Auto-select wallet for target agent
      if (walletPanelAgentId) {
        const match = Object.values(data).find((w) => w.agentId === walletPanelAgentId)
        if (match) setSelectedWalletId(match.id)
      } else if (!selectedWalletId && Object.keys(data).length > 0) {
        setSelectedWalletId(Object.keys(data)[0])
      }
    } catch { /* ignore */ }
    setLoading(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletPanelAgentId])

  useEffect(() => { loadWallets() }, [loadWallets])
  useWs('wallets', loadWallets, 15000)

  // Load detail when wallet selected
  const selectedWallet = selectedWalletId ? wallets[selectedWalletId] : null

  const loadDetail = useCallback(async () => {
    if (!selectedWalletId) return
    try {
      const [detail, txs, history] = await Promise.all([
        api<SafeWallet>('GET', `/wallets/${selectedWalletId}`),
        api<WalletTransaction[]>('GET', `/wallets/${selectedWalletId}/transactions`),
        api<WalletBalanceSnapshot[]>('GET', `/wallets/${selectedWalletId}/balance-history`),
      ])
      setWallets((prev) => ({ ...prev, [selectedWalletId]: detail }))
      setTransactions(txs)
      setBalanceHistory(history)

      // Check for pending approvals
      const pending = txs.find((tx) => tx.status === 'pending_approval')
      if (pending) setPendingApproval(pending)
    } catch { /* ignore */ }
  }, [selectedWalletId])

  useEffect(() => { loadDetail() }, [loadDetail])

  // Initialize limits when wallet selected
  useEffect(() => {
    if (selectedWallet) {
      setPerTxLimit(String((selectedWallet.spendingLimitLamports ?? 100_000_000) / 1e9))
      setDailyLimit(String((selectedWallet.dailyLimitLamports ?? 1_000_000_000) / 1e9))
      setRequireApproval(selectedWallet.requireApproval)
    }
  }, [selectedWallet])

  const saveLimits = useCallback(async () => {
    if (!selectedWalletId) return
    setSaving(true)
    try {
      await api('PATCH', `/wallets/${selectedWalletId}`, {
        spendingLimitLamports: Math.round(parseFloat(perTxLimit || '0.1') * 1e9),
        dailyLimitLamports: Math.round(parseFloat(dailyLimit || '1') * 1e9),
        requireApproval,
      })
      setEditingLimits(false)
      loadDetail()
    } catch { /* ignore */ }
    setSaving(false)
  }, [selectedWalletId, perTxLimit, dailyLimit, requireApproval, loadDetail])

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

  const agentsWithoutWallets = useMemo(() => {
    const walletAgentIds = new Set(Object.values(wallets).map((w) => w.agentId))
    return Object.values(agents).filter((a) => !walletAgentIds.has(a.id)) as Agent[]
  }, [agents, wallets])

  const createWallet = useCallback(async () => {
    if (!createAgentId) return
    setCreating(true)
    setCreateError('')
    try {
      await api('POST', '/wallets', { agentId: createAgentId })
      setShowCreateForm(false)
      setCreateAgentId('')
      loadWallets()
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : String(err))
    }
    setCreating(false)
  }, [createAgentId, loadWallets])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-5 h-5 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    )
  }

  const walletList = Object.values(wallets)

  if (walletList.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm" style={{ animation: 'fade-up 0.5s var(--ease-spring)' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-4 text-text-3/30">
            <rect x="2" y="6" width="20" height="14" rx="2" /><path d="M22 10H18a2 2 0 0 0 0 4h4" /><path d="M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
          </svg>
          <h3 className="font-display text-[14px] font-600 text-text-2 mb-2">No wallets yet</h3>
          {agentsWithoutWallets.length > 0 ? (
            <div className="mt-4 space-y-3">
              <AgentPickerList
                agents={agentsWithoutWallets}
                selected={createAgentId}
                onSelect={(id) => setCreateAgentId(id === createAgentId ? '' : id)}
                maxHeight={180}
              />
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
              All agents already have wallets.
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
            onClick={() => { setShowCreateForm(!showCreateForm); setCreateAgentId(''); setCreateError('') }}
            disabled={agentsWithoutWallets.length === 0}
            className="w-6 h-6 rounded-[6px] flex items-center justify-center text-text-3/50 hover:text-text-2 hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
            title={agentsWithoutWallets.length === 0 ? 'All agents have wallets' : 'Create wallet'}
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
                agents={agentsWithoutWallets}
                selected={createAgentId}
                onSelect={(id) => setCreateAgentId(id === createAgentId ? '' : id)}
                maxHeight={160}
              />
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
                  <div className="text-[12px] font-600 truncate">{a?.name || w.agentId}</div>
                  <div className="text-[10px] text-text-3/50 font-mono truncate mt-0.5 flex items-center gap-1">
                    {w.chain === 'solana' && <SolanaIcon size={9} className="shrink-0 opacity-50" />}
                    <span className="truncate">{w.publicKey.slice(0, 8)}...{w.publicKey.slice(-4)}</span>
                    {typeof w.balanceSol === 'number' && (
                      <span className="text-text-3/40">{w.balanceSol.toFixed(3)} SOL</span>
                    )}
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

          {/* Agent & Address */}
          <div style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.05s both' }}>
            <div className="flex items-center gap-2 mb-2">
              {(() => {
                const a = agents[selectedWallet.agentId] as Agent | undefined
                return a ? (
                  <button
                    type="button"
                    onClick={() => { setEditingAgentId(a.id); setActiveView('agents') }}
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
                {selectedWallet.chain === 'solana' && <SolanaIcon size={11} />}
                {selectedWallet.chain}
              </span>
              <button
                type="button"
                onClick={() => { setReassigning(!reassigning); setReassignError('') }}
                className="text-[10px] text-text-3/40 hover:text-accent-bright transition-colors cursor-pointer bg-transparent border-none px-1.5 py-0.5 rounded-[5px] hover:bg-white/[0.04]"
                style={{ fontFamily: 'inherit' }}
              >
                {reassigning ? 'Cancel' : 'Reassign'}
              </button>
            </div>
            {reassigning && (
              <div className="mb-2 space-y-2" style={{ animation: 'spring-in 0.4s var(--ease-spring)' }}>
                <p className="text-[11px] text-text-3/60">Select a new agent to control this wallet:</p>
                <AgentPickerList
                  agents={agentsWithoutWallets}
                  selected=""
                  onSelect={async (agentId) => {
                    setReassignSaving(true)
                    setReassignError('')
                    try {
                      await api('PATCH', `/wallets/${selectedWallet.id}`, { agentId })
                      setReassigning(false)
                      loadWallets()
                    } catch (err: unknown) {
                      setReassignError(err instanceof Error ? err.message : String(err) || 'Reassign failed')
                    }
                    setReassignSaving(false)
                  }}
                  maxHeight={160}
                />
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
                {(selectedWallet.balanceSol ?? 0).toFixed(4)} <span className="text-[14px] text-text-3/60 font-mono">SOL</span>
              </div>
              {selectedWallet.chain === 'solana' && (
                <SolanaIcon size={16} shimmer className="opacity-80" />
              )}
            </div>
          </div>

          {/* Funding help */}
          <div className="p-4 rounded-[14px] border border-white/[0.06] bg-surface-2/50"
            style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.15s both' }}>
            <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600 mb-2">How to Fund This Wallet</div>
            <div className="space-y-2 text-[12px] text-text-3/70 leading-relaxed">
              <p>Send SOL to the wallet address above from any Solana wallet (Phantom, Solflare, an exchange, etc.). Copy the address and use it as the recipient.</p>
              <p>This wallet is on <strong className="text-text-2 font-600">Solana mainnet</strong>. Make sure you&apos;re sending real SOL on the Solana mainnet network.</p>
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
                  const max = Math.max(...balanceHistory.map((s) => s.balanceLamports), 1)
                  return balanceHistory.slice(-60).map((s, i) => (
                    <div
                      key={s.id || i}
                      className="flex-1 bg-accent/40 rounded-t-[2px] min-w-[3px] transition-all hover:bg-accent hover:scale-y-110"
                      style={{ height: `${Math.max(2, (s.balanceLamports / max) * 100)}%`, transitionDelay: `${i * 10}ms` }}
                      title={`${(s.balanceLamports / 1e9).toFixed(4)} SOL — ${new Date(s.timestamp).toLocaleString()}`}
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
                  <label className="block text-[11px] text-text-3/70 mb-1">Per-transaction limit (SOL)</label>
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
                  <label className="block text-[11px] text-text-3/70 mb-1">Daily limit (SOL)</label>
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
                  <span className="text-text-2">{((selectedWallet.spendingLimitLamports ?? 100_000_000) / 1e9).toFixed(2)} SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-3/70">Daily rolling</span>
                  <span className="text-text-2">{((selectedWallet.dailyLimitLamports ?? 1_000_000_000) / 1e9).toFixed(1)} SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-3/70">Approval</span>
                  <span className="text-text-2">{selectedWallet.requireApproval ? 'Required' : 'Auto-send'}</span>
                </div>
              </div>
            )}
          </div>

          {/* Transaction history */}
          <div style={{ animation: 'fade-up 0.4s var(--ease-spring) 0.3s both' }}>
            <div className="text-[11px] text-text-3/60 uppercase tracking-wide font-600 mb-3">Transactions</div>
            {transactions.length === 0 ? (
              <p className="text-[12px] text-text-3/50">No transactions yet.</p>
            ) : (
              <div className="space-y-2">
                {transactions.map((tx, idx) => (
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
                          {tx.type === 'send' ? '-' : '+'}{(tx.amountLamports / 1e9).toFixed(4)} SOL
                        </span>
                        <span className={`px-1.5 py-0.5 rounded-[4px] text-[9px] font-600 uppercase ${
                          tx.status === 'confirmed' ? 'bg-green-500/15 text-green-400' :
                          tx.status === 'pending_approval' ? 'bg-amber-500/15 text-amber-400 animate-pulse' :
                          tx.status === 'failed' ? 'bg-red-500/15 text-red-400' :
                          tx.status === 'denied' ? 'bg-red-500/15 text-red-400' :
                          'bg-blue-500/15 text-blue-400'
                        }`}>
                          {tx.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="text-[10px] text-text-3/50 font-mono truncate mt-0.5">
                        {tx.type === 'send' ? `To: ${tx.toAddress.slice(0, 8)}...${tx.toAddress.slice(-4)}` : `From: ${tx.fromAddress.slice(0, 8)}...${tx.fromAddress.slice(-4)}`}
                      </div>
                      {tx.memo && <div className="text-[10px] text-text-3/60 mt-0.5 truncate">{tx.memo}</div>}
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
