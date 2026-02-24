'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'

interface Props {
  inSidebar?: boolean
}

export function SecretsList({ inSidebar }: Props) {
  const secrets = useAppStore((s) => s.secrets)
  const loadSecrets = useAppStore((s) => s.loadSecrets)
  const agents = useAppStore((s) => s.agents)
  const setSecretSheetOpen = useAppStore((s) => s.setSecretSheetOpen)
  const setEditingSecretId = useAppStore((s) => s.setEditingSecretId)

  useEffect(() => {
    loadSecrets()
  }, [])

  const secretList = Object.values(secrets)

  if (!secretList.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3 mb-1 font-600">No secrets yet</p>
        <p className="text-[12px] text-text-3/60">Add API keys & credentials for orchestrators</p>
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
      <div className="space-y-2">
        {secretList.map((secret) => {
          const scopeLabel = secret.scope === 'global'
            ? 'All orchestrators'
            : `${secret.agentIds.length} orchestrator(s)`
          const scopedNames = secret.scope === 'agent'
            ? secret.agentIds.map((id) => agents[id]?.name).filter(Boolean).join(', ')
            : null
          return (
            <button
              key={secret.id}
              onClick={() => {
                setEditingSecretId(secret.id)
                setSecretSheetOpen(true)
              }}
              className="w-full text-left p-4 rounded-[14px] bg-surface border border-white/[0.06]
                hover:border-white/[0.1] cursor-pointer transition-all group"
              style={{ fontFamily: 'inherit' }}
            >
              <div className="flex items-center gap-2.5 mb-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span className="text-[14px] font-600 text-text truncate">{secret.name}</span>
              </div>
              <div className="flex items-center gap-2 pl-[22px]">
                <span className="text-[11px] font-mono text-text-3">{secret.service}</span>
                <span className="text-[11px] text-text-3/60">·</span>
                <span className={`text-[10px] font-600 ${
                  secret.scope === 'global' ? 'text-emerald-400' : 'text-amber-400'
                }`}>
                  {scopeLabel}
                </span>
              </div>
              {scopedNames && (
                <div className="text-[10px] text-text-3/50 mt-1 pl-[22px] truncate">{scopedNames}</div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
