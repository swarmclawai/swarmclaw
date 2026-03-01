'use client'

import { useEffect, useState } from 'react'
import type { Agent } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

export function TrashList() {
  const trashedAgents = useAppStore((s) => s.trashedAgents)
  const loadTrashedAgents = useAppStore((s) => s.loadTrashedAgents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [confirmPermanent, setConfirmPermanent] = useState<Agent | null>(null)

  useEffect(() => { loadTrashedAgents() }, []) // eslint-disable-next-line react-hooks/exhaustive-deps

  const handleRestore = async (id: string) => {
    await api('POST', '/agents/trash', { id })
    await Promise.all([loadTrashedAgents(), loadAgents()])
  }

  const handlePermanentDelete = async (id: string) => {
    await api('DELETE', '/agents/trash', { id })
    await loadTrashedAgents()
    setConfirmPermanent(null)
  }

  const agents = Object.values(trashedAgents).sort(
    (a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0),
  )

  if (!agents.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-3 p-8 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-white/[0.03] flex items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/50">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3/50">Trash is empty</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex flex-col gap-1 px-2 pb-4 pt-2">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="py-3 px-4 rounded-[14px] border border-white/[0.04] bg-white/[0.02]"
          >
            <div className="flex items-center gap-2.5">
              <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em] text-text-2/70">
                {agent.name}
              </span>
            </div>
            <div className="text-[12px] text-text-3/50 mt-1 truncate">{agent.description}</div>
            {agent.trashedAt && (
              <div className="text-[11px] text-text-3/40 mt-1">
                Trashed {formatRelative(agent.trashedAt)}
              </div>
            )}
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={() => handleRestore(agent.id)}
                className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[12px] font-600
                  text-accent-bright cursor-pointer hover:bg-accent-soft transition-all"
                style={{ fontFamily: 'inherit' }}
              >
                Restore
              </button>
              <button
                onClick={() => setConfirmPermanent(agent)}
                className="px-3 py-1.5 rounded-[8px] border border-white/[0.08] bg-transparent text-[12px] font-600
                  text-red-400 cursor-pointer hover:bg-red-400/10 transition-all"
                style={{ fontFamily: 'inherit' }}
              >
                Delete Forever
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!confirmPermanent}
        title="Permanently Delete"
        message={`Permanently delete "${confirmPermanent?.name}"? This cannot be undone.`}
        confirmLabel="Delete Forever"
        danger
        onConfirm={() => confirmPermanent && handlePermanentDelete(confirmPermanent.id)}
        onCancel={() => setConfirmPermanent(null)}
      />
    </div>
  )
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
