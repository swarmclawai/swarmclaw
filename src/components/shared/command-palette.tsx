'use client'

import { useTranslation } from 'react-i18next';
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

  // Register keyboard shortcut (always mounted)
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

  // Also listen for custom event
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('swarmclaw:open-search', handler)
    return () => window.removeEventListener('swarmclaw:open-search', handler)
  }, [])

  if (!open) return null

  return <CommandPaletteInner setOpen={setOpen} />
}

/** Inner component — only mounted when palette is open, so store subscriptions are gated. */
function CommandPaletteInner({ setOpen }: { setOpen: (v: boolean) => void }) {
  const { t } = useTranslation()
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
  }, [navigateTo, setOpen])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setOpen])

  // Focus input when mounted
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const items = useMemo<CommandItem[]>(() => {
    const result: CommandItem[] = []

    const views = [
      { id: 'home', label: t('home'), description: t('homeDesc'), keywords: ['dashboard', 'overview', 'activity'] },
      { id: 'agents', label: t('agents'), description: t('agentsDesc'), keywords: ['chat', 'assistant', 'default'] },
      { id: 'tasks', label: t('tasks'), description: t('tasksDesc'), keywords: ['board', 'queue', 'backlog', 'execution'] },
      { id: 'projects', label: t('projects'), description: t('projectsDesc'), keywords: ['workspace', 'scope'] },
      { id: 'chatrooms', label: t('chatrooms'), description: t('chatroomsDesc'), keywords: ['group', 'room', 'mentions'] },
      { id: 'schedules', label: t('schedules'), description: t('schedulesDesc'), keywords: ['cron', 'automation', 'interval'] },
      { id: 'connectors', label: t('connectors'), description: t('connectorsDesc'), keywords: ['discord', 'slack', 'telegram', 'whatsapp', 'file queue'] },
      { id: 'memory', label: t('memory'), description: t('memoryDesc'), keywords: ['knowledge', 'vector', 'retrieval'] },
      { id: 'knowledge', label: t('knowledge'), description: t('knowledgeDesc'), keywords: ['docs', 'entries', 'facts'] },
      { id: 'providers', label: t('providers'), description: t('providersDesc'), keywords: ['openai', 'anthropic', 'ollama', 'endpoint'] },
      { id: 'secrets', label: t('secrets'), description: t('secretsDesc'), keywords: ['api key', 'token', 'credential'] },
      { id: 'autonomy', label: t('autonomy'), description: t('autonomyDesc'), keywords: ['estop', 'incident', 'runtime', 'safety'] },
      { id: 'quality', label: t('quality'), description: t('qualityDesc'), keywords: ['eval', 'approval', 'runs', 'release', 'qa'] },
      { id: 'settings', label: t('settings'), description: t('settingsDesc'), keywords: ['preferences', 'theme', 'heartbeat'] },
    ] as const
    for (const view of views) {
      result.push({
        id: `nav:${view.id}`,
        label: t('goTo', { label: view.label }),
        description: view.description,
        keywords: [...view.keywords],
        category: 'nav',
        onSelect: () => { navigateTo(view.id); setOpen(false) },
      })
    }

    result.push(
      {
        id: 'setting:default-agent',
        label: t('defaultAgentShortcut'),
        description: t('defaultAgentShortcutDesc'),
        keywords: ['main chat', 'default agent', 'shortcut'],
        category: 'setting',
        onSelect: () => openSettingsSection('general', 'user-preferences'),
      },
      {
        id: 'setting:automation',
        label: t('automationLimits'),
        description: t('automationLimitsDesc'),
        keywords: ['loops', 'coordination', 'delegation', 'heartbeat', 'automation'],
        category: 'setting',
        onSelect: () => openSettingsSection('agents', 'runtime-loop'),
      },
      {
        id: 'setting:providers',
        label: t('providerCredentials'),
        description: t('providerCredentialsDesc'),
        keywords: ['openai', 'anthropic', 'api keys', 'credentials', 'providers'],
        category: 'setting',
        onSelect: () => openSettingsSection('integrations', 'providers'),
      },
      {
        id: 'setting:voice',
        label: t('voiceAndSearch'),
        description: t('voiceAndSearchDesc'),
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
          ? t('agentDisabled', { name: agent.name })
          : t('openAgentChat', { name: agent.name }),
        keywords: [agent.provider, agent.model, agent.description || ''].filter(Boolean),
        category: 'agent',
        onSelect: () => {
          if (agent.disabled === true && !agent.threadSessionId) {
            toast.error(t('agentDisabledError', { name: agent.name }))
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
        label: session.name || t('untitledChat'),
        description: sessionAgent ? t('recentChatWith', { name: sessionAgent.name }) : t('directModelChat'),
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
        description: t('taskStatus', { status: task.status.charAt(0).toUpperCase() + task.status.slice(1) }),
        keywords: [task.status, task.agentId || ''].filter(Boolean),
        category: 'task',
        onSelect: () => { setEditingTaskId(task.id); setTaskSheetOpen(true); setOpen(false) },
      })
    }

    return result
  }, [agents, currentUser, navigateTo, openSettingsSection, sessions, setCurrentAgent, setEditingTaskId, setOpen, setTaskSheetOpen, tasks, t])

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

  const categoryLabel = {
    agent: t('agents'),
    chat: t('chats'),
    task: t('tasks'),
    nav: t('navigation'),
    setting: t('settings'),
  } as const
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
              placeholder={t('commandPalettePlaceholder')}
              className="flex-1 bg-transparent border-none outline-none text-[14px] text-text-1 placeholder:text-text-3/50"
            />
          <kbd className="hidden md:inline-flex items-center px-1.5 py-0.5 rounded-[6px] bg-white/[0.06] text-[11px] text-text-3 font-500">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-3/50">{t('noResultsFound')}</div>
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
            <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px]">&uarr;&darr;</kbd> {t('navigateHint')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-white/[0.06] text-[10px]">&crarr;</kbd> {t('selectHint')}
          </span>
        </div>
      </div>
    </div>
  )
}
