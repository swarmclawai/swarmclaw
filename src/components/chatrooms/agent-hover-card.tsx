'use client'

import { useState } from 'react'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { AVAILABLE_TOOLS, PLATFORM_TOOLS, TOOL_LABELS } from '@/lib/tool-definitions'
import type { Agent } from '@/types'

interface Props {
  agent: Agent
  children: React.ReactNode
  status?: 'idle' | 'busy' | 'online'
}

const ALL_TOOL_IDS = [...AVAILABLE_TOOLS, ...PLATFORM_TOOLS].map((t) => t.id)

export function AgentHoverCard({ agent, children, status }: Props) {
  const [showAll, setShowAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const tools = agent.plugins ?? []

  const displayTools = showAll ? ALL_TOOL_IDS : tools

  const toggleTool = async (toolId: string) => {
    if (busy) return
    setBusy(true)
    try {
      const current = agent.plugins || []
      const updated = current.includes(toolId)
        ? current.filter((t) => t !== toolId)
        : [...current, toolId]
      await api('PUT', `/agents/${agent.id}`, { plugins: updated })
      useAppStore.getState().loadAgents()
    } finally {
      setBusy(false)
    }
  }

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-[280px]">
        {/* Header: avatar + name + model */}
        <div className="flex items-center gap-2">
          <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={28} status={status} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-600 text-text truncate">{agent.name}</div>
            <div className="label-mono truncate">{agent.model}</div>
          </div>
        </div>

        {/* Description */}
        {agent.description && (
          <p className="text-[12px] text-text-3 mt-1.5 line-clamp-1">{agent.description}</p>
        )}

        {/* Tools toggles */}
        <div className="mt-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-600 text-text-3/60 uppercase tracking-wider">Tools</span>
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-[10px] text-accent-bright/70 hover:text-accent-bright font-500 bg-transparent border-none cursor-pointer"
            >
              {showAll ? 'Show enabled' : 'Show all'}
            </button>
          </div>
          <div className="max-h-[200px] overflow-y-auto -mx-1 px-1">
            {displayTools.length === 0 && (
              <p className="text-[11px] text-text-3/50 py-1">No tools enabled</p>
            )}
            {displayTools.map((toolId) => {
              const enabled = tools.includes(toolId)
              return (
                <label key={toolId} className="flex items-center gap-2 py-1 cursor-pointer">
                  <div
                    onClick={(e) => { e.preventDefault(); toggleTool(toolId) }}
                    className={`w-7 h-[16px] rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                      ${enabled ? 'bg-accent-bright' : 'bg-white/[0.12]'}`}
                  >
                    <div className={`absolute top-[2px] w-[12px] h-[12px] rounded-full bg-white transition-all duration-200
                      ${enabled ? 'left-[13px]' : 'left-[2px]'}`} />
                  </div>
                  <span className={`text-[11px] ${enabled ? 'text-text-2' : 'text-text-3/70'}`}>
                    {TOOL_LABELS[toolId] || toolId}
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-white/[0.06] my-2" />

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={() => {
              useAppStore.getState().setActiveView('agents')
              useAppStore.getState().setCurrentAgent(agent.id)
            }}
            className="flex-1 text-[12px] font-500 text-text-2 hover:text-text py-1 rounded-[6px] bg-white/[0.04] hover:bg-white/[0.08] transition-colors cursor-pointer"
          >
            Chat
          </button>
          <button
            onClick={() => {
              useAppStore.getState().setEditingAgentId(agent.id)
              useAppStore.getState().setAgentSheetOpen(true)
            }}
            className="flex-1 text-[12px] font-500 text-text-2 hover:text-text py-1 rounded-[6px] bg-white/[0.04] hover:bg-white/[0.08] transition-colors cursor-pointer"
          >
            Edit
          </button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
