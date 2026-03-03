'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { getMemoryCounts } from '@/lib/memory'

export function MemoryAgentList() {
  const agents = useAppStore((s) => s.agents)
  const memoryAgentFilter = useAppStore((s) => s.memoryAgentFilter)
  const setMemoryAgentFilter = useAppStore((s) => s.setMemoryAgentFilter)
  const setSelectedMemoryId = useAppStore((s) => s.setSelectedMemoryId)
  const refreshKey = useAppStore((s) => s.memoryRefreshKey)

  const [counts, setCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    getMemoryCounts()
      .then((data) => setCounts(data))
      .catch(() => {/* ignore */})
  }, [refreshKey])

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0)
  const globalCount = counts['_global'] || 0

  const agentList = Object.values(agents).sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  const handleSelect = (agentId: string | null) => {
    setMemoryAgentFilter(agentId)
    setSelectedMemoryId(null)
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em]">Memory</h2>
      </div>

      {/* All Memories row */}
      <div className="px-2 flex flex-col gap-0.5">
        <button
          onClick={() => handleSelect(null)}
          className={`relative flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer transition-all w-full text-left border-none
            ${!memoryAgentFilter
              ? 'bg-accent-soft'
              : 'bg-transparent hover:bg-white/[0.02]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          {!memoryAgentFilter && (
            <div className="absolute left-0 top-2.5 bottom-2.5 w-[2.5px] rounded-full bg-accent-bright" />
          )}
          <div className="w-[28px] h-[28px] rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={!memoryAgentFilter ? 'text-accent-bright' : 'text-text-3'}>
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          </div>
          <span className={`text-[13px] font-600 flex-1 ${!memoryAgentFilter ? 'text-accent-bright' : 'text-text-2'}`}>
            All Memories
          </span>
          {totalCount > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-text-3/60 bg-white/[0.04] px-1.5 py-0.5 rounded-[5px]">
              {totalCount}
            </span>
          )}
        </button>

        {/* Global row */}
        <button
          onClick={() => handleSelect('_global')}
          className={`relative flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer transition-all w-full text-left border-none
            ${memoryAgentFilter === '_global'
              ? 'bg-accent-soft'
              : 'bg-transparent hover:bg-white/[0.02]'}`}
          style={{ fontFamily: 'inherit' }}
        >
          {memoryAgentFilter === '_global' && (
            <div className="absolute left-0 top-2.5 bottom-2.5 w-[2.5px] rounded-full bg-accent-bright" />
          )}
          <div className="w-[28px] h-[28px] rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={memoryAgentFilter === '_global' ? 'text-accent-bright' : 'text-text-3'}>
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>
          <span className={`text-[13px] font-600 flex-1 ${memoryAgentFilter === '_global' ? 'text-accent-bright' : 'text-text-2'}`}>
            Global
          </span>
          {globalCount > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-text-3/60 bg-white/[0.04] px-1.5 py-0.5 rounded-[5px]">
              {globalCount}
            </span>
          )}
        </button>
      </div>

      {/* Divider */}
      <div className="mx-4 my-2 border-t border-white/[0.04]" />

      {/* Agent list */}
      <div className="px-2 flex flex-col gap-0.5 pb-4">
        {agentList.map((agent) => {
          const count = counts[agent.id] || 0
          const isActive = memoryAgentFilter === agent.id
          return (
            <button
              key={agent.id}
              onClick={() => handleSelect(agent.id)}
              className={`relative flex items-center gap-3 px-3 py-2 rounded-[10px] cursor-pointer transition-all w-full text-left border-none
                ${isActive
                  ? 'bg-accent-soft'
                  : 'bg-transparent hover:bg-white/[0.02]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {isActive && (
                <div className="absolute left-0 top-2 bottom-2 w-[2.5px] rounded-full bg-accent-bright" />
              )}
              <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={28} />
              <span className={`text-[13px] font-600 flex-1 truncate ${isActive ? 'text-accent-bright' : 'text-text-2'}`}>
                {agent.name}
              </span>
              {count > 0 && (
                <span className="text-[10px] font-mono tabular-nums text-text-3/60 bg-white/[0.04] px-1.5 py-0.5 rounded-[5px]">
                  {count}
                </span>
              )}
            </button>
          )
        })}
        {agentList.length === 0 && (
          <div className="text-[12px] text-text-3/50 px-3 py-4 text-center">
            No agents yet
          </div>
        )}
      </div>
    </div>
  )
}
