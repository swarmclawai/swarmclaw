'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import type { AppView } from '@/types'

interface SearchResult {
  type: 'task' | 'agent' | 'session' | 'schedule' | 'webhook' | 'skill'
  id: string
  title: string
  description?: string
  status?: string
}

const TYPE_ICONS: Record<SearchResult['type'], string> = {
  agent: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2',
  task: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2',
  session: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  schedule: 'M12 6v6l4 2',
  webhook: 'M22 12h-4l-3 7L9 5l-3 7H2',
  skill: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z',
}

const TYPE_EXTRA_PATHS: Partial<Record<SearchResult['type'], string>> = {
  agent: 'M12 7a4 4 0 1 0 0-0.01',
  schedule: 'M12 12a10 10 0 1 0 0-0.01',
}

const TYPE_VIEW_MAP: Record<SearchResult['type'], AppView> = {
  agent: 'agents',
  task: 'tasks',
  session: 'agents',
  schedule: 'schedules',
  webhook: 'webhooks',
  skill: 'skills',
}

const TYPE_LABELS: Record<SearchResult['type'], string> = {
  agent: 'Agent',
  task: 'Task',
  session: 'Session',
  schedule: 'Schedule',
  webhook: 'Webhook',
  skill: 'Skill',
}

export function SearchDialog() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const setActiveView = useAppStore((s) => s.setActiveView)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const setEditingAgentId = useAppStore((s) => s.setEditingAgentId)
  const setAgentSheetOpen = useAppStore((s) => s.setAgentSheetOpen)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setEditingScheduleId = useAppStore((s) => s.setEditingScheduleId)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const setEditingWebhookId = useAppStore((s) => s.setEditingWebhookId)
  const setWebhookSheetOpen = useAppStore((s) => s.setWebhookSheetOpen)
  const setEditingSkillId = useAppStore((s) => s.setEditingSkillId)
  const setSkillSheetOpen = useAppStore((s) => s.setSkillSheetOpen)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Listen for custom event from sidebar button
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('swarmclaw:open-search', handler)
    return () => window.removeEventListener('swarmclaw:open-search', handler)
  }, [])

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setSelectedIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await api<{ results: SearchResult[] }>('GET', `/search?q=${encodeURIComponent(q)}`)
      setResults(data.results)
      setSelectedIdx(0)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleQueryChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(value), 300)
  }

  // Navigate to a result
  const navigateTo = useCallback((result: SearchResult) => {
    setOpen(false)
    const view = TYPE_VIEW_MAP[result.type]
    setActiveView(view)
    setSidebarOpen(true)

    switch (result.type) {
      case 'agent':
        setEditingAgentId(result.id)
        setAgentSheetOpen(true)
        break
      case 'task':
        setEditingTaskId(result.id)
        setTaskSheetOpen(true)
        break
      case 'session':
        void setCurrentAgent(null)
        setActiveView('agents')
        break
      case 'schedule':
        setEditingScheduleId(result.id)
        setScheduleSheetOpen(true)
        break
      case 'webhook':
        setEditingWebhookId(result.id)
        setWebhookSheetOpen(true)
        break
      case 'skill':
        setEditingSkillId(result.id)
        setSkillSheetOpen(true)
        break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIdx]) {
      e.preventDefault()
      navigateTo(results[selectedIdx])
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
        className="sm:max-w-[520px] p-0 bg-[#1a1a2e]/95 backdrop-blur-xl border-white/[0.08] shadow-[0_24px_80px_rgba(0,0,0,0.6)] rounded-[16px] overflow-hidden gap-0"
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search agents, tasks, schedules..."
            className="flex-1 bg-transparent border-none outline-none text-[14px] text-text placeholder:text-text-3/60 font-[inherit]"
            autoFocus
          />
          <kbd className="px-1.5 py-0.5 rounded-[5px] bg-white/[0.06] border border-white/[0.08] text-[10px] font-mono text-text-3 shrink-0">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1">
          {loading && query.length >= 2 && (
            <div className="px-4 py-8 text-center text-[13px] text-text-3">
              Searching...
            </div>
          )}
          {!loading && query.length >= 2 && results.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-text-3">
              No results found
            </div>
          )}
          {!loading && query.length < 2 && (
            <div className="px-4 py-8 text-center text-[13px] text-text-3/60">
              Type at least 2 characters to search
            </div>
          )}
          {results.map((result, idx) => (
            <button
              key={`${result.type}-${result.id}`}
              onClick={() => navigateTo(result)}
              onMouseEnter={() => setSelectedIdx(idx)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left cursor-pointer transition-colors border-none bg-transparent
                ${idx === selectedIdx ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {/* Type icon */}
              <div className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0
                ${idx === selectedIdx ? 'bg-[#6366F1]/20' : 'bg-white/[0.04]'}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                  className={idx === selectedIdx ? 'text-[#818CF8]' : 'text-text-3'}>
                  <path d={TYPE_ICONS[result.type]} />
                  {TYPE_EXTRA_PATHS[result.type] && <path d={TYPE_EXTRA_PATHS[result.type]} />}
                </svg>
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-500 text-text truncate">{result.title}</span>
                  {result.status && (
                    <span className="px-1.5 py-0.5 rounded-[4px] bg-white/[0.06] text-[10px] font-500 text-text-3 shrink-0">
                      {result.status}
                    </span>
                  )}
                </div>
                {result.description && (
                  <p className="text-[11px] text-text-3 truncate mt-0.5 m-0">{result.description}</p>
                )}
              </div>
              {/* Type label */}
              <span className="text-[10px] text-text-3/60 uppercase tracking-wider shrink-0">
                {TYPE_LABELS[result.type]}
              </span>
            </button>
          ))}
        </div>

        {/* Footer hint */}
        {results.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.06] text-[11px] text-text-3/50">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px] font-mono">↵</kbd>
              open
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
