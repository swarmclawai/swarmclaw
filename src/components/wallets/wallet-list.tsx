'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/app/api-client'

export function WalletList() {
  const wallets = useAppStore((s) => s.wallets)
  const loadWallets = useAppStore((s) => s.loadWallets)
  const agents = useAppStore((s) => s.agents)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    loadWallets()
  }, [loadWallets])

  const handleCopy = async (e: React.MouseEvent, address: string, walletId: string) => {
    e.stopPropagation()
    await navigator.clipboard.writeText(address)
    setCopiedId(walletId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (deletingId === id) {
      await api('DELETE', `/wallets/${id}`)
      setDeletingId(null)
      loadWallets()
    } else {
      setDeletingId(id)
      setTimeout(() => setDeletingId(null), 3000)
    }
  }

  const truncateAddress = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr

  const walletList = Object.values(wallets)

  if (!walletList.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
            <rect x="2" y="6" width="20" height="14" rx="2" /><path d="M22 10H18a2 2 0 0 0 0 4h4" /><path d="M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3 mb-1 font-600">No wallets yet</p>
        <p className="text-[12px] text-text-3/60">Generate a wallet for your agents to transact on Base L2</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {walletList.map((wallet, idx) => {
          const agent = agents[wallet.agentId]
          return (
            <div
              key={wallet.id}
              className="w-full text-left p-4 rounded-[14px] bg-surface border border-white/[0.06]
                hover:border-white/[0.12] hover:bg-white/[0.02] transition-all group"
              style={{
                fontFamily: 'inherit',
                animation: 'spring-in 0.5s var(--ease-spring) both',
                animationDelay: `${idx * 0.05}s`,
              }}
            >
              {/* Header: agent + delete */}
              <div className="flex items-center gap-2.5 mb-2">
                {agent ? (
                  <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={20} />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-white/[0.06]" />
                )}
                <span className="text-[13px] font-600 text-text truncate flex-1">
                  {agent?.name || 'Unknown Agent'}
                </span>
                <button
                  onClick={(e) => handleDelete(e, wallet.id)}
                  className={`text-[10px] font-600 px-1.5 py-0.5 rounded-[6px] transition-colors cursor-pointer ${
                    deletingId === wallet.id
                      ? 'text-red-400 bg-red-400/10'
                      : 'text-text-3/40 hover:text-red-400'
                  }`}
                  title={deletingId === wallet.id ? 'Click again to confirm' : 'Delete wallet'}
                >
                  {deletingId === wallet.id ? 'Confirm?' : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Address row */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[12px] font-mono text-text-3 truncate">{truncateAddress(wallet.walletAddress)}</span>
                <button
                  onClick={(e) => handleCopy(e, wallet.walletAddress, wallet.id)}
                  className="text-text-3/40 hover:text-text-2 transition-colors shrink-0 cursor-pointer"
                  title="Copy address"
                >
                  {copiedId === wallet.id ? (
                    <span className="text-[10px] font-600 text-emerald-400">Copied!</span>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Badges row */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-600 px-1.5 py-0.5 rounded-[6px] bg-blue-500/10 text-blue-400">
                  Base L2
                </span>
                {wallet.requireApproval && (
                  <span className="text-[10px] font-600 px-1.5 py-0.5 rounded-[6px] bg-amber-500/10 text-amber-400">
                    Approval Required
                  </span>
                )}
                {wallet.spendingLimitUsdc && (
                  <span className="text-[10px] font-600 text-text-3/60">
                    Limit: ${wallet.spendingLimitUsdc} USDC
                  </span>
                )}
                {wallet.dailyLimitUsdc && (
                  <span className="text-[10px] font-600 text-text-3/60">
                    Daily: ${wallet.dailyLimitUsdc} USDC
                  </span>
                )}
              </div>

              {/* Label */}
              {wallet.label && (
                <div className="mt-2 text-[11px] text-text-3/60 truncate">{wallet.label}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
