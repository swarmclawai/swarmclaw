'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { toast } from 'sonner'

export function AgentSwitchDialog() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const agents = useAppStore((s) => s.agents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)

  // Global Cmd+Shift+A / Ctrl+Shift+A listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const filtered = useMemo(() => {
    const all = Object.values(agents).filter((a) => !a.trashedAt)
    if (!query.trim()) return all
    const q = query.toLowerCase()
    return all.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    )
  }, [agents, query])

  const handleSelect = useCallback((agentId: string) => {
    const agent = agents[agentId]
    if (agent?.disabled === true && !agent.threadSessionId) {
      toast.error(`${agent.name} is disabled. Re-enable it to start a new chat.`)
      return
    }
    setOpen(false)
    void setCurrentAgent(agentId)
     
  }, [agents, setCurrentAgent])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered[selectedIdx]) {
      e.preventDefault()
      handleSelect(filtered[selectedIdx].id)
    }
  }

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[440px] p-0 bg-surface/95 backdrop-blur-xl border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.6)] rounded-[16px] overflow-hidden gap-0"
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">Switch Agent</DialogTitle>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0) }}
            placeholder="Switch agent..."
            className="flex-1 bg-transparent border-none outline-none text-[14px] text-text placeholder:text-text-3/60 font-[inherit]"
            autoFocus
          />
          <kbd className="px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] border border-white/[0.08] text-[10px] font-mono text-text-3 shrink-0">
            ESC
          </kbd>
        </div>

        {/* Agent list */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-text-3/60">
              No agents found
            </div>
          )}
          {filtered.map((agent, idx) => (
            <button
              key={agent.id}
              onClick={() => handleSelect(agent.id)}
              onMouseEnter={() => setSelectedIdx(idx)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left cursor-pointer transition-colors border-none bg-transparent
                ${idx === selectedIdx ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={28} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-500 text-text truncate">{agent.name}</span>
                  {agent.disabled === true && (
                    <span className="px-1.5 py-0.5 rounded-[4px] bg-amber-400/[0.08] text-[10px] font-500 text-amber-300 shrink-0">
                      disabled
                    </span>
                  )}
                  {agent.id === currentAgentId && (
                    <span className="px-1.5 py-0.5 rounded-[4px] bg-accent-bright/15 text-[10px] font-500 text-accent-bright shrink-0">
                      current
                    </span>
                  )}
                </div>
                {agent.description && (
                  <p className="text-[11px] text-text-3 truncate mt-0.5 m-0">{agent.description}</p>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Footer hint */}
        {filtered.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.06] text-[11px] text-text-3/50">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono">↵</kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono">esc</kbd>
              close
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
