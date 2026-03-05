'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { inputClass } from './utils'
import { UserPreferencesSection } from './section-user-preferences'
import { ThemeSection } from './section-theme'
import { OrchestratorSection } from './section-orchestrator'
import { RuntimeLoopSection } from './section-runtime-loop'
import { CapabilityPolicySection } from './section-capability-policy'
import { StorageSection } from './section-storage'
import { VoiceSection } from './section-voice'
import { WebSearchSection } from './section-web-search'
import { HeartbeatSection } from './section-heartbeat'
import { EmbeddingSection } from './section-embedding'
import { MemorySection } from './section-memory'
import { SecretsSection } from './section-secrets'
import { ProvidersSection } from './section-providers'

interface Tab {
  id: string
  label: string
  icon: React.ReactNode
  keywords: string[]
}

const TABS: Tab[] = [
  {
    id: 'general',
    label: 'General',
    keywords: ['preferences', 'user', 'language', 'default', 'capability', 'policy', 'permissions', 'tools', 'storage', 'uploads', 'disk', 'files', 'cleanup'],
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    keywords: ['theme', 'color', 'hue', 'palette', 'dark', 'light', 'style', 'swatch'],
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>,
  },
  {
    id: 'agents',
    label: 'Agents & Loops',
    keywords: ['orchestrator', 'runtime', 'loop', 'heartbeat', 'delegation', 'agent', 'swarm', 'turns'],
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  },
  {
    id: 'memory',
    label: 'Memory & AI',
    keywords: ['embedding', 'vector', 'voice', 'web search', 'memory', 'consolidation', 'tts', 'ai'],
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10A10 10 0 0 1 2 12 10 10 0 0 1 12 2z" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    keywords: ['provider', 'secret', 'api', 'key', 'openai', 'anthropic', 'ollama', 'credential'],
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2v4m0 12v4M2 12h4m12 0h4" /><circle cx="12" cy="12" r="4" /><path d="M8 8L5.5 5.5M16 8l2.5-2.5M8 16l-2.5 2.5M16 16l2.5 2.5" /></svg>,
  },
]

export function SettingsPage() {
  const loadProviders = useAppStore((s) => s.loadProviders)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const loadSecrets = useAppStore((s) => s.loadSecrets)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const credentials = useAppStore((s) => s.credentials)
  const validTabIds = TABS.map((t) => t.id)
  const [activeTab, setActiveTabRaw] = useState(() => {
    if (typeof window === 'undefined') return 'general'
    const params = new URLSearchParams(window.location.search)
    const tab = params.get('tab')
    return tab && validTabIds.includes(tab) ? tab : 'general'
  })
  const contentRef = useRef<HTMLDivElement>(null)

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabRaw(tab)
    const url = new URL(window.location.href)
    if (tab === 'general') url.searchParams.delete('tab')
    else url.searchParams.set('tab', tab)
    window.history.replaceState(null, '', url.toString())
  }, [])

  useEffect(() => {
    loadProviders()
    loadCredentials()
    loadSettings()
    loadSecrets()
    loadAgents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scroll to top when switching tabs
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [activeTab])

  const [searchQuery, setSearchQuery] = useState('')
  const credList = Object.values(credentials)
  const patchSettings = updateSettings
  const sectionProps = { appSettings, patchSettings, inputClass }

  const matchingTabIds = searchQuery
    ? new Set(TABS.filter((t) => {
        const q = searchQuery.toLowerCase()
        return t.label.toLowerCase().includes(q) || t.keywords.some((k) => k.includes(q))
      }).map((t) => t.id))
    : null

  // Auto-switch to first matching tab when searching
  useEffect(() => {
    if (matchingTabIds && matchingTabIds.size > 0 && !matchingTabIds.has(activeTab)) {
      const first = TABS.find((t) => matchingTabIds.has(t.id))
      if (first) setActiveTab(first.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  return (
    <div className="flex-1 flex h-full min-w-0">
      {/* Tab sidebar */}
      <div className="w-[200px] shrink-0 border-r border-white/[0.04] py-6 px-3 flex flex-col gap-1">
        <h2 className="font-display text-[14px] font-700 text-text px-3 mb-3 tracking-[-0.01em]">Settings</h2>
        <div className="px-2 mb-3">
          <div className="relative">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3/50">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search settings..."
              className="w-full pl-8 pr-2 py-1.5 text-[12px] bg-white/[0.04] rounded-[8px] border border-white/[0.06] text-text placeholder:text-text-3/40 outline-none focus:border-white/[0.12] transition-colors"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>
        {TABS.map((tab) => {
          const dimmed = matchingTabIds && !matchingTabIds.has(tab.id)
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] font-500 cursor-pointer transition-all border-none text-left
                ${dimmed ? 'opacity-30' : ''}
                ${activeTab === tab.id
                  ? 'bg-accent-soft text-accent-bright'
                  : 'bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04]'}`}
              style={{ fontFamily: 'inherit' }}
            >
              <span className="shrink-0">{tab.icon}</span>
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        <div className="max-w-2xl px-8 py-8">
          {/* Tab header */}
          <div className="mb-8">
            <h3 className="font-display text-[22px] font-700 tracking-[-0.02em] text-text">
              {TABS.find((t) => t.id === activeTab)?.label}
            </h3>
            <p className="text-[13px] text-text-3 mt-1">
              {activeTab === 'general' && 'User preferences and global behavior settings.'}
              {activeTab === 'appearance' && 'Customize the look and feel of the interface.'}
              {activeTab === 'agents' && 'Orchestrator, runtime loops, capabilities and heartbeat.'}
              {activeTab === 'memory' && 'Embedding, memory governance, voice and web search.'}
              {activeTab === 'integrations' && 'Providers, secrets and plugins.'}
            </p>
          </div>

          {activeTab === 'general' && (
            <>
              <UserPreferencesSection {...sectionProps} />
              <CapabilityPolicySection {...sectionProps} />
              <StorageSection {...sectionProps} />
            </>
          )}

          {activeTab === 'appearance' && (
            <ThemeSection {...sectionProps} />
          )}

          {activeTab === 'agents' && (
            <>
              <OrchestratorSection {...sectionProps} />
              <RuntimeLoopSection {...sectionProps} />
              <HeartbeatSection {...sectionProps} />
            </>
          )}

          {activeTab === 'memory' && (
            <>
              <EmbeddingSection {...sectionProps} credList={credList} />
              <MemorySection {...sectionProps} />
              <VoiceSection {...sectionProps} />
              <WebSearchSection {...sectionProps} />
            </>
          )}

          {activeTab === 'integrations' && (
            <>
              <ProvidersSection {...sectionProps} />
              <SecretsSection {...sectionProps} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
