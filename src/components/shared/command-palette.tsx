'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'

interface CommandItem {
  id: string
  label: string
  category: 'agent' | 'chat' | 'task' | 'nav'
  onSelect: () => void
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const tasks = useAppStore((s) => s.tasks)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)

  // Register keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const items = useMemo<CommandItem[]>(() => {
    const result: CommandItem[] = []

    // Navigation items
    const views = ['agents', 'tasks', 'chatrooms', 'schedules', 'connectors', 'providers', 'secrets', 'settings', 'memory', 'skills'] as const
    for (const v of views) {
      result.push({
        id: `nav:${v}`,
        label: `Go to ${v}`,
        category: 'nav',
        onSelect: () => { setActiveView(v); setOpen(false) },
      })
    }

    // Agents
    for (const agent of Object.values(agents)) {
      result.push({
        id: `agent:${agent.id}`,
        label: agent.name,
        category: 'agent',
        onSelect: () => { setEditingAgentId(agent.id); setAgentSheetOpen(true); setOpen(false) },
      })
    }

    // Chats (sessions)
    for (const session of Object.values(sessions)) {
      result.push({
        id: `chat:${session.id}`,
        label: session.name || 'Untitled chat',
        category: 'chat',
        onSelect: () => { setCurrentSession(session.id); setActiveView('agents'); setOpen(false) },
      })
    }

    // Tasks
    for (const task of Object.values(tasks)) {
      if (task.status === 'archived') continue
      result.push({
        id: `task:${task.id}`,
        label: task.title,
        category: 'task',
        onSelect: () => { setEditingTaskId(task.id); setTaskSheetOpen(true); setOpen(false) },
      })
    }

    return result
  }, [agents, sessions, tasks, setActiveView, setCurrentSession, setEditingAgentId, setAgentSheetOpen, setEditingTaskId, setTaskSheetOpen])

  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 20)
    const q = query.toLowerCase()
    return items
      .filter((item) => item.label.toLowerCase().includes(q))
      .slice(0, 20)
  }, [items, query])

  // Reset selection when results change
  useEffect(() => { setSelectedIndex(0) }, [filtered])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      e.preventDefault()
      filtered[selectedIndex].onSelect()
    }
  }, [filtered, selectedIndex])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!open) return null

  const categoryLabel = { agent: 'Agents', chat: 'Chats', task: 'Tasks', nav: 'Navigation' } as const
  const categoryIcon = {
    agent: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
      </svg>
    ),
    chat: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    task: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
    nav: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  }

  // Group by category
  const grouped = new Map<string, CommandItem[]>()
  for (const item of filtered) {
    const group = grouped.get(item.category) || []
    group.push(item)
    grouped.set(item.category, group)
  }

  let flatIndex = 0

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div
        className="relative w-full max-w-[520px] mx-4 bg-raised rounded-[16px] border border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.6)] overflow-hidden"
        style={{ animation: 'modal-in 0.3s var(--ease-spring)' }}
      >
        {/* Breathing glow effect */}
        <div className="absolute inset-0 pointer-events-none opacity-20" style={{ animation: 'glow-pulse 4s ease-in-out infinite' }}>
          <div className="absolute inset-0 bg-gradient-to-b from-accent-bright/20 to-transparent" />
        </div>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] relative overflow-hidden">
          <div className="absolute bottom-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-accent-bright/40 to-transparent" style={{ animation: 'glow-line 3s linear infinite' }} />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0 relative z-10">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search agents, chats, tasks..."
            className="flex-1 bg-transparent border-none outline-none text-[14px] text-text-1 placeholder:text-text-3/50"
          />
          <kbd className="hidden md:inline-flex items-center px-1.5 py-0.5 rounded-[6px] bg-white/[0.06] text-[11px] text-text-3 font-500">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-3/50">No results found</div>
          ) : (
            Array.from(grouped.entries()).map(([category, groupItems]) => (
              <div key={category}>
                <div className="px-4 py-1.5 text-[11px] font-600 text-text-3/50 uppercase tracking-wider">
                  {categoryLabel[category as keyof typeof categoryLabel]}
                </div>
                {groupItems.map((item) => {
                  const idx = flatIndex++
                  return (
                    <button
                      key={item.id}
                      onClick={item.onSelect}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left border-none cursor-pointer transition-all relative z-10
                        ${idx === selectedIndex ? 'bg-accent-soft text-accent-bright pl-6 scale-[1.01]' : 'bg-transparent text-text-2 hover:bg-white/[0.04]'}`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      {idx === selectedIndex && (
                        <div className="absolute left-0 top-1 bottom-1 w-1 rounded-r-full bg-accent-bright" style={{ animation: 'spring-in 0.3s var(--ease-spring)' }} />
                      )}
                      <span className="shrink-0 text-text-3">{categoryIcon[item.category as keyof typeof categoryIcon]}</span>
                      <span className="text-[13px] font-500 truncate">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-white/[0.06] flex items-center gap-4 text-[11px] text-text-3/40">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px]">&uarr;&darr;</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px]">&crarr;</kbd> select
          </span>
        </div>
      </div>
    </div>
  )
}
