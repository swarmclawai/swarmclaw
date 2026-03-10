'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { isLocalhostBrowser, isVisibleSessionForViewer } from '@/lib/observability/local-observability'
import { useNavigate } from '@/lib/app/navigation'
import { toast } from 'sonner'

interface CommandItem {
  id: string
  label: string
  description?: string
  keywords?: string[]
  category: 'agent' | 'chat' | 'task' | 'nav' | 'setting'
  onSelect: () => void | Promise<void>
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const currentUser = useAppStore((s) => s.currentUser)
  const tasks = useAppStore((s) => s.tasks)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const navigateTo = useNavigate()
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)

  const openSettingsSection = useCallback((tabId?: string, sectionId?: string) => {
    navigateTo('settings')
    setOpen(false)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('swarmclaw:settings-focus', {
        detail: { tabId, sectionId },
      }))
    }, 80)
  }, [navigateTo])

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

    const views = [
      { id: 'home', label: 'Home', description: 'Overview and triage', keywords: ['dashboard', 'overview', 'activity'] },
      { id: 'agents', label: 'Agents', description: 'Agent chats and configuration', keywords: ['chat', 'assistant', 'default'] },
      { id: 'tasks', label: 'Tasks', description: 'Task board and execution queues', keywords: ['board', 'queue', 'backlog', 'execution'] },
      { id: 'projects', label: 'Projects', description: 'Scoped workspaces for agents and tasks', keywords: ['workspace', 'scope'] },
      { id: 'chatrooms', label: 'Chatrooms', description: 'Shared multi-agent conversations', keywords: ['group', 'room', 'mentions'] },
      { id: 'schedules', label: 'Schedules', description: 'Recurring and timed automations', keywords: ['cron', 'automation', 'interval'] },
      { id: 'connectors', label: 'Connectors', description: 'Bridges to Slack, Discord, Telegram, and more', keywords: ['discord', 'slack', 'telegram', 'whatsapp'] },
      { id: 'memory', label: 'Memory', description: 'Stored agent memory and retrieval', keywords: ['knowledge', 'vector', 'retrieval'] },
      { id: 'knowledge', label: 'Knowledge', description: 'Shared knowledge base', keywords: ['docs', 'entries', 'facts'] },
      { id: 'providers', label: 'Providers', description: 'Model providers and endpoints', keywords: ['openai', 'anthropic', 'ollama', 'endpoint'] },
      { id: 'secrets', label: 'Secrets', description: 'Credentials and encrypted secrets', keywords: ['api key', 'token', 'credential'] },
      { id: 'settings', label: 'Settings', description: 'General app configuration', keywords: ['preferences', 'theme', 'heartbeat'] },
    ] as const
    for (const view of views) {
      result.push({
        id: `nav:${view.id}`,
        label: `Go to ${view.label}`,
        description: view.description,
        keywords: [...view.keywords],
        category: 'nav',
        onSelect: () => { navigateTo(view.id); setOpen(false) },
      })
    }

    result.push(
      {
        id: 'setting:default-agent',
        label: 'Default Agent Shortcut',
        description: 'Choose which agent the sidebar shortcut opens',
        keywords: ['main chat', 'default agent', 'shortcut'],
        category: 'setting',
        onSelect: () => openSettingsSection('general', 'user-preferences'),
      },
      {
        id: 'setting:automation',
        label: 'Automation Limits',
        description: 'Heartbeat, autonomy, and delegation controls',
        keywords: ['loops', 'coordination', 'delegation', 'heartbeat', 'automation'],
        category: 'setting',
        onSelect: () => openSettingsSection('agents', 'runtime-loop'),
      },
      {
        id: 'setting:providers',
        label: 'Provider Credentials',
        description: 'Manage providers, endpoints, and secrets',
        keywords: ['openai', 'anthropic', 'api keys', 'credentials', 'providers'],
        category: 'setting',
        onSelect: () => openSettingsSection('integrations', 'providers'),
      },
      {
        id: 'setting:voice',
        label: 'Voice & Search',
        description: 'Voice output and web search defaults',
        keywords: ['voice', 'tts', 'web search', 'search'],
        category: 'setting',
        onSelect: () => openSettingsSection('memory', 'voice'),
      },
    )

    for (const agent of Object.values(agents)) {
      result.push({
        id: `agent:${agent.id}`,
        label: agent.name,
        description: agent.disabled === true
          ? `${agent.name} is disabled`
          : `Open ${agent.name}'s chat`,
        keywords: [agent.provider, agent.model, agent.description || ''].filter(Boolean),
        category: 'agent',
        onSelect: () => {
          if (agent.disabled === true && !agent.threadSessionId) {
            toast.error(`${agent.name} is disabled. Re-enable it to start a new chat.`)
            return
          }
          navigateTo('agents', agent.id)
          setOpen(false)
        },
      })
    }

    // Chats (sessions)
    for (const session of Object.values(sessions)) {
      if (!isVisibleSessionForViewer(session, currentUser, { localhost: isLocalhostBrowser() })) continue
      const sessionAgent = session.agentId ? agents[session.agentId] : null
      result.push({
        id: `chat:${session.id}`,
        label: session.name || 'Untitled chat',
        description: sessionAgent ? `Recent chat with ${sessionAgent.name}` : 'Direct model chat',
        keywords: [session.provider, session.model, sessionAgent?.name || ''].filter(Boolean),
        category: 'chat',
        onSelect: () => { if (session.agentId) void setCurrentAgent(session.agentId); navigateTo('agents'); setOpen(false) },
      })
    }

    // Tasks
    for (const task of Object.values(tasks)) {
      if (task.status === 'archived') continue
      result.push({
        id: `task:${task.id}`,
        label: task.title,
        description: `${task.status.charAt(0).toUpperCase() + task.status.slice(1)} task`,
        keywords: [task.status, task.agentId || ''].filter(Boolean),
        category: 'task',
        onSelect: () => { setEditingTaskId(task.id); setTaskSheetOpen(true); setOpen(false) },
      })
    }

    return result
  }, [agents, currentUser, navigateTo, openSettingsSection, sessions, setCurrentAgent, setEditingTaskId, setTaskSheetOpen, tasks])

  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 20)
    const q = query.toLowerCase()
    return items
      .filter((item) =>
        item.label.toLowerCase().includes(q)
        || item.description?.toLowerCase().includes(q)
        || item.keywords?.some((keyword) => keyword.toLowerCase().includes(q)),
      )
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

  const categoryLabel = { agent: 'Agents', chat: 'Chats', task: 'Tasks', nav: 'Navigation', setting: 'Settings' } as const
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
    setting: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
              placeholder="Search chats, agents, tasks, settings..."
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
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-500 truncate">{item.label}</div>
                        {item.description && (
                          <div className={`text-[11px] truncate ${idx === selectedIndex ? 'text-accent-bright/75' : 'text-text-3/55'}`}>
                            {item.description}
                          </div>
                        )}
                      </div>
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
