'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/app/api-client'

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

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('DELETE', `/secrets/${id}`)
    loadSecrets()
  }

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
        <p className="text-[12px] text-text-3/60">Add API keys & credentials for your agents</p>
        <button
          onClick={() => { setEditingSecretId(null); setSecretSheetOpen(true) }}
          className="mt-3 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[13px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
          style={{ fontFamily: 'inherit' }}
        >
          + Add Secret
        </button>
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
      <div className={inSidebar ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
        {secretList.map((secret, idx) => {
          const scopeLabel = secret.scope === 'global'
            ? 'Global'
            : `${secret.agentIds.length} agent(s)`
          const scopedAgents = secret.scope === 'agent'
            ? secret.agentIds.map((id) => agents[id]).filter(Boolean)
            : []
          return (
            <div
              key={secret.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                setEditingSecretId(secret.id)
                setSecretSheetOpen(true)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setEditingSecretId(secret.id)
                  setSecretSheetOpen(true)
                }
              }}
              className="w-full text-left p-4 rounded-[14px] bg-surface border border-white/[0.06]
                hover:border-white/[0.12] hover:bg-white/[0.02] hover:scale-[1.01] cursor-pointer transition-all group"
              style={{
                fontFamily: 'inherit',
                animation: 'spring-in 0.5s var(--ease-spring) both',
                animationDelay: `${idx * 0.05}s`
              }}
            >
              <div className="flex items-center gap-2.5 mb-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span className="text-[14px] font-600 text-text truncate flex-1">{secret.name}</span>
                {!inSidebar && (
                  <button
                    onClick={(e) => handleDelete(e, secret.id)}
                    className="text-text-3/40 hover:text-red-400 transition-colors p-0.5 shrink-0"
                    title="Delete"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                )}
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
              {scopedAgents.length > 0 && (
                <div className="flex items-center gap-1.5 mt-1.5 pl-[22px]">
                  <div className="flex items-center -space-x-1.5">
                    {scopedAgents.slice(0, 5).map((agent) => (
                      <AgentAvatar key={agent.id} seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={16} className="ring-1 ring-surface" />
                    ))}
                  </div>
                  {scopedAgents.length > 5 && (
                    <span className="text-[10px] font-600 text-text-3/60 ml-0.5">+{scopedAgents.length - 5}</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
