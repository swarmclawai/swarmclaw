'use client'

import { useState } from 'react'
import type { Agent } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useWs } from '@/hooks/use-ws'
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
import { useApprovalStore } from '@/stores/use-approval-store'
import { AgentAvatar } from './agent-avatar'
import { toast } from 'sonner'

interface Props {
  agent: Agent
  isDefault?: boolean
  isRunning?: boolean
  isOnline?: boolean
  isSelected?: boolean
  onSetDefault?: (id: string) => void
}

export function AgentCard({ agent, isDefault, isRunning, isOnline, isSelected, onSetDefault }: Props) {
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setMessages = useChatStore((s) => s.setMessages)
  const togglePinAgent = useAppStore((s) => s.togglePinAgent)
  const [running, setRunning] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [taskInput, setTaskInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const approvals = useApprovalStore((s) => s.approvals)
  const pendingApprovalCount = Object.values(approvals).filter((a) => a.agentId === agent.id).length
  const [heartbeatPulse, setHeartbeatPulse] = useState(false)
  useWs(`heartbeat:agent:${agent.id}`, () => {
    setHeartbeatPulse(true)
    setTimeout(() => setHeartbeatPulse(false), 1500)
  })

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
        setActiveView('agents')
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
    toast.success('Agent duplicated')
  }

  const handleDelete = async () => {
    await deleteAgent(agent.id)
    await loadAgents()
    toast.success('Agent moved to trash')
    setConfirmDelete(false)
  }

  return (
    <>
      <div
        onClick={handleClick}
        className={`group relative py-3.5 px-4 cursor-pointer rounded-[14px]
          transition-all duration-200 active:scale-[0.98]
          ${isSelected
            ? 'bg-white/[0.04] border border-white/[0.08]'
            : 'bg-transparent border border-transparent hover:bg-white/[0.05] hover:border-white/[0.08]'}`}
      >
        {isSelected && <div className="card-select-indicator" />}
        {/* Pin/star button */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            togglePinAgent(agent.id)
            toast.success(agent.pinned ? 'Agent unpinned' : 'Agent pinned')
          }}
          aria-label={agent.pinned ? 'Unpin agent' : 'Pin agent'}
          className={`absolute top-3 right-10 p-1 rounded-[6px] transition-all bg-transparent border-none cursor-pointer hover:bg-white/[0.06]
            ${agent.pinned ? 'opacity-100 text-amber-400' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100 text-text-3'}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill={agent.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
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
            <DropdownMenuItem onClick={() => { togglePinAgent(agent.id); toast.success(agent.pinned ? 'Agent unpinned' : 'Agent pinned') }}>
              {agent.pinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDuplicate}>Duplicate</DropdownMenuItem>
            {!isDefault && onSetDefault && (
              <DropdownMenuItem onClick={() => { onSetDefault(agent.id); toast.success(`${agent.name} set as default`) }}>Set Default</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setConfirmDelete(true)}
              className="text-red-400 focus:text-red-400"
            >
              Move to Trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2.5">
          <AgentAvatar
            seed={agent.avatarSeed}
            name={agent.name}
            size={28}
            status={isRunning ? 'busy' : isOnline ? 'online' : undefined}
            heartbeatPulse={heartbeatPulse}
          />
          <span className="font-display text-[14px] font-600 truncate flex-1 tracking-[-0.01em]">{agent.name}</span>
          {pendingApprovalCount > 0 && (
            <span className="shrink-0 text-[9px] font-600 uppercase tracking-wider px-2 py-0.5 rounded-[6px] text-amber-400 bg-amber-400/[0.08] border border-amber-400/15">
              {pendingApprovalCount} {pendingApprovalCount === 1 ? 'approval' : 'approvals'}
            </span>
          )}
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
                transition-all border-none bg-accent-bright/20 text-accent-bright hover:bg-accent-bright/30 disabled:opacity-40"
              style={{ fontFamily: 'inherit' }}
            >
              {running ? '...' : 'Run'}
            </button>
          )}
          {agent.isOrchestrator && (
            <span className="shrink-0 text-[10px] font-600 uppercase tracking-wider text-amber-400/80 bg-amber-400/[0.08] px-2 py-0.5 rounded-[6px] flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg>
              delegates
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
          {agent.lastUsedAt ? (
            <span>Last used: {(() => {
              const days = Math.floor((Date.now() - agent.lastUsedAt) / 86400000)
              return days === 0 ? 'today' : `${days}d ago`
            })()}</span>
          ) : agent.updatedAt ? (
            <span>Updated: {(() => {
              const days = Math.floor((Date.now() - agent.updatedAt) / 86400000)
              return days === 0 ? 'today' : `${days}d ago`
            })()}</span>
          ) : null}
          {agent.totalCost != null && agent.totalCost > 0 && (
            <span>Cost: ${agent.totalCost.toFixed(2)}</span>
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
              className="px-4 py-2 rounded-[10px] border-none bg-accent-bright text-white text-[13px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
              style={{ fontFamily: 'inherit' }}
            >
              Run
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        title="Move to Trash"
        message={`Move "${agent.name}" to trash? You can restore it later from the trash.`}
        confirmLabel="Move to Trash"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
