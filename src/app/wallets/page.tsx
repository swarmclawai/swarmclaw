'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { WalletList } from '@/components/wallets/wallet-list'
import { api } from '@/lib/app/api-client'
import type { SafeWallet } from '@/types'

export default function WalletsPage() {
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadWallets = useAppStore((s) => s.loadWallets)
  const [generating, setGenerating] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadAgents()
    loadWallets()
  }, [loadAgents, loadWallets])

  const agentList = Object.values(agents)

  const handleGenerate = async (agentId?: string) => {
    const targetId = agentId || agentList[0]?.id
    if (!targetId) {
      setError('Create an agent first')
      setTimeout(() => setError(null), 3000)
      return
    }
    setGenerating(true)
    setShowPicker(false)
    setError(null)
    try {
      await api<SafeWallet>('POST', '/wallets/generate', { agentId: targetId })
      loadWallets()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate wallet')
      setTimeout(() => setError(null), 4000)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] capitalize flex-1">
          Wallets
        </h2>
        <div className="relative">
          <button
            onClick={() => {
              if (agentList.length <= 1) {
                handleGenerate()
              } else {
                setShowPicker(!showPicker)
              }
            }}
            disabled={generating}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            {generating ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            )}
            {generating ? 'Generating...' : 'Generate Wallet'}
          </button>

          {/* Agent picker dropdown */}
          {showPicker && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowPicker(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-[12px] bg-surface border border-white/[0.08] shadow-xl overflow-hidden">
                <div className="px-3 py-2 border-b border-white/[0.06]">
                  <span className="text-[11px] font-600 text-text-3">Select Agent</span>
                </div>
                <div className="max-h-48 overflow-y-auto py-1">
                  {agentList.map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => handleGenerate(agent.id)}
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-white/[0.04] transition-colors cursor-pointer"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <span className="text-[14px]">{agent.emoji || '🤖'}</span>
                      <span className="text-[12px] font-600 text-text truncate">{agent.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-6 mb-2 px-3 py-2 rounded-[10px] bg-red-500/10 border border-red-500/20 text-[12px] text-red-400 font-600">
          {error}
        </div>
      )}

      <WalletList />
    </div>
  )
}
