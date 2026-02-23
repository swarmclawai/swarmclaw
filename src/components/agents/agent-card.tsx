'use client'

import { useState } from 'react'
import type { Agent } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { api } from '@/lib/api-client'

interface Props {
  agent: Agent
  isDefault?: boolean
  onSetDefault?: (id: string) => void
}

export function AgentCard({ agent, isDefault, onSetDefault }: Props) {
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setMessages = useChatStore((s) => s.setMessages)
  const [running, setRunning] = useState(false)

  const handleClick = () => {
    setEditingAgentId(agent.id)
    setAgentSheetOpen(true)
  }

  const handleRun = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const task = prompt('Enter task for this orchestrator:')
    if (!task) return
    setRunning(true)
    try {
      const result = await api<{ ok: boolean; sessionId: string }>('POST', '/orchestrator/run', { agentId: agent.id, task })
      if (result.sessionId) {
        await loadSessions()
        setMessages([])
        setCurrentSession(result.sessionId)
        setActiveView('sessions')
      }
    } catch (err) {
      console.error('Orchestrator run failed:', err)
    }
    setRunning(false)
  }

  return (
    <div
      onClick={handleClick}
      className="relative py-3.5 px-4 cursor-pointer rounded-[14px]
        transition-all duration-200 active:scale-[0.98]
        bg-transparent border border-transparent hover:bg-white/[0.02] hover:border-white/[0.03]"
    >
      <div className="flex items-center gap-2.5">
        <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em]">{agent.name}</span>
        {isDefault ? (
          <span className="shrink-0 text-[10px] font-600 uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-[6px]">
            default
          </span>
        ) : onSetDefault && (
          <button
            onClick={(e) => { e.stopPropagation(); onSetDefault(agent.id) }}
            className="shrink-0 text-[10px] font-600 uppercase tracking-wider px-2 py-0.5 rounded-[6px] cursor-pointer
              transition-all border-none bg-transparent text-text-3/30 hover:text-primary hover:bg-primary/10"
            style={{ fontFamily: 'inherit' }}
            title="Set as default agent for Main Chat"
          >
            set default
          </button>
        )}
        {agent.isOrchestrator && (
          <button
            onClick={handleRun}
            disabled={running}
            className="shrink-0 text-[10px] font-600 uppercase tracking-wider px-2.5 py-1 rounded-[6px] cursor-pointer
              transition-all border-none bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40"
            style={{ fontFamily: 'inherit' }}
          >
            {running ? '...' : 'Run'}
          </button>
        )}
        {agent.isOrchestrator && (
          <span className="shrink-0 text-[10px] font-600 uppercase tracking-wider text-amber-400/80 bg-amber-400/[0.08] px-2 py-0.5 rounded-[6px]">
            orch
          </span>
        )}
      </div>
      <div className="text-[12px] text-text-3/40 mt-1.5 truncate">{agent.description}</div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-[11px] text-text-3/30 font-mono">{agent.model || agent.provider}</span>
        {agent.tools?.includes('browser') && (
          <span className="text-[10px] font-600 uppercase tracking-wider text-sky-400/70 bg-sky-400/[0.08] px-1.5 py-0.5 rounded-[5px]">
            browser
          </span>
        )}
      </div>
    </div>
  )
}
