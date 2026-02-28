'use client'

import { useState } from 'react'
import type { Agent } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { api } from '@/lib/api-client'
import { createAgent, deleteAgent } from '@/lib/agents'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

interface Props {
  agent: Agent
  isDefault?: boolean
  onSetDefault?: (id: string) => void
}

export function AgentCard({ agent, isDefault, onSetDefault }: Props) {
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setMessages = useChatStore((s) => s.setMessages)
  const [running, setRunning] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [taskInput, setTaskInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handleClick = () => {
    setEditingAgentId(agent.id)
    setAgentSheetOpen(true)
  }

  const handleRunClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setTaskInput('')
    setDialogOpen(true)
  }

  const handleConfirmRun = async () => {
    if (!taskInput.trim()) return
    setDialogOpen(false)
    setRunning(true)
    try {
      const result = await api<{ ok: boolean; sessionId: string }>('POST', '/orchestrator/run', { agentId: agent.id, task: taskInput })
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

  const handleDuplicate = async () => {
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...rest } = agent
    await createAgent({ ...rest, name: agent.name + ' (Copy)' })
    await loadAgents()
  }

  const handleDelete = async () => {
    await deleteAgent(agent.id)
    await loadAgents()
    setConfirmDelete(false)
  }

  return (
    <>
      <div
        onClick={handleClick}
        className="group relative py-3.5 px-4 cursor-pointer rounded-[14px]
          transition-all duration-200 active:scale-[0.98]
          bg-transparent border border-transparent hover:bg-white/[0.05] hover:border-white/[0.08]"
      >
        {/* Three-dot dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              aria-label="Agent options"
              className="absolute top-3 right-3 p-0.5 rounded-[6px] opacity-0 group-hover:opacity-60 hover:!opacity-100
                transition-opacity bg-transparent border-none cursor-pointer text-text-3 hover:bg-white/[0.06]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem onClick={handleClick}>Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={handleDuplicate}>Duplicate</DropdownMenuItem>
            {!isDefault && onSetDefault && (
              <DropdownMenuItem onClick={() => onSetDefault(agent.id)}>Set Default</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setConfirmDelete(true)}
              className="text-red-400 focus:text-red-400"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2.5">
          <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em]">{agent.name}</span>
          {isDefault && (
            <span className="shrink-0 text-[10px] font-600 uppercase tracking-wider text-accent-bright bg-accent-soft px-2 py-0.5 rounded-[6px]">
              default
            </span>
          )}
          {agent.isOrchestrator && (
            <button
              onClick={handleRunClick}
              disabled={running}
              className="shrink-0 text-[10px] font-600 uppercase tracking-wider px-2.5 py-1 rounded-[6px] cursor-pointer
                transition-all border-none bg-[#6366F1]/20 text-[#818CF8] hover:bg-[#6366F1]/30 disabled:opacity-40"
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
        <div className="text-[12px] text-text-3/70 mt-1.5 truncate">{agent.description}</div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[11px] text-text-3/60 font-mono">{agent.model || agent.provider}</span>
          {agent.tools?.includes('browser') && (
            <span className="text-[10px] font-600 uppercase tracking-wider text-sky-400/70 bg-sky-400/[0.08] px-1.5 py-0.5 rounded-[5px]">
              browser
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-text-3/50">
          {(agent as any).lastUsedAt ? (
            <span>Last used: {(() => {
              const days = Math.floor((Date.now() - (agent as any).lastUsedAt) / 86400000)
              return days === 0 ? 'today' : `${days}d ago`
            })()}</span>
          ) : (agent as any).updatedAt ? (
            <span>Updated: {(() => {
              const days = Math.floor((Date.now() - agent.updatedAt) / 86400000)
              return days === 0 ? 'today' : `${days}d ago`
            })()}</span>
          ) : null}
          {(agent as any).totalCost != null && (agent as any).totalCost > 0 && (
            <span>Cost: ${((agent as any).totalCost as number).toFixed(2)}</span>
          )}
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Run Orchestrator</DialogTitle>
          </DialogHeader>
          <div className="py-3">
            <label className="block text-[12px] font-600 text-text-3 mb-2">Task for {agent.name}</label>
            <input
              type="text"
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmRun() }}
              placeholder="Describe the task..."
              autoFocus
              className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none transition-all placeholder:text-text-3/50 focus:border-white/[0.15]"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <DialogFooter>
            <button
              onClick={() => setDialogOpen(false)}
              className="px-4 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-2 text-[13px] font-600 cursor-pointer hover:bg-surface-2 transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmRun}
              disabled={!taskInput.trim()}
              className="px-4 py-2 rounded-[10px] border-none bg-[#6366F1] text-white text-[13px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
              style={{ fontFamily: 'inherit' }}
            >
              Run
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Agent"
        message={`Are you sure you want to delete "${agent.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
