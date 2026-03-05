'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import type { Agent, MarketplacePlugin, PluginMeta } from '@/types'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

type InstalledTab = 'core' | 'extensions'
type TopTab = InstalledTab | 'swarmforge'

export function PluginList({ inSidebar }: { inSidebar?: boolean }) {
  const plugins = useAppStore((s) => s.plugins)
  const loadPlugins = useAppStore((s) => s.loadPlugins)
  const setPluginSheetOpen = useAppStore((s) => s.setPluginSheetOpen)
  const setEditingPluginFilename = useAppStore((s) => s.setEditingPluginFilename)
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setActiveView = useAppStore((s) => s.setActiveView)

  const navigateToAgentChat = useCallback((agentId: string) => {
    const agentSession = Object.values(sessions)
      .filter((s) => s.agentId === agentId)
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
    if (agentSession) {
      setCurrentSession(agentSession.id)
      setActiveView('agents')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  const [tab, setTab] = useState<TopTab>('core')
  const [marketplace, setMarketplace] = useState<MarketplacePlugin[]>([])
  const [mpLoading, setMpLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{ filename: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'downloads'>('downloads')

  useEffect(() => {
    void loadPlugins()
  }, [loadPlugins])

  const loadMarketplace = useCallback(async () => {
    setMpLoading(true)
    try {
      const data = await api<MarketplacePlugin[]>('GET', '/plugins/marketplace')
      if (Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    setMpLoading(false)
  }, [])

  useEffect(() => {
    if (inSidebar || tab !== 'swarmforge') return
    const timer = setTimeout(() => { void loadMarketplace() }, 0)
    return () => clearTimeout(timer)
  }, [tab, inSidebar, loadMarketplace])

  const pluginList = Object.values(plugins)
  const corePlugins = useMemo(() => pluginList.filter((p) => p.source === 'local'), [pluginList])
  const extensionPlugins = useMemo(() => pluginList.filter((p) => p.source !== 'local'), [pluginList])

  // Search filtering for installed plugins
  const filterInstalled = useCallback((list: PluginMeta[]) => {
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      p.filename.toLowerCase().includes(q)
    )
  }, [search])

  const filteredCore = useMemo(() => filterInstalled(corePlugins), [filterInstalled, corePlugins])
  const filteredExtensions = useMemo(() => filterInstalled(extensionPlugins), [filterInstalled, extensionPlugins])

  const handleEdit = (filename: string) => {
    setEditingPluginFilename(filename)
    setPluginSheetOpen(true)
  }

  const handleToggle = async (e: React.MouseEvent, filename: string, enabled: boolean) => {
    e.stopPropagation()
    try {
      await api('POST', '/plugins', { filename, enabled: !enabled })
      toast.success(!enabled ? 'Plugin enabled' : 'Plugin disabled')
      loadPlugins()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle plugin')
    }
  }

  const handleDeleteClick = (e: React.MouseEvent, filename: string, name: string) => {
    e.stopPropagation()
    setConfirmDelete({ filename, name })
  }

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await api('DELETE', `/plugins?filename=${encodeURIComponent(confirmDelete.filename)}`)
      toast.success('Plugin deleted')
      await loadPlugins()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
      setConfirmDelete(null)
    }
  }

  const installFromMarketplace = async (p: MarketplacePlugin) => {
    setInstalling(p.id)
    const toastId = toast.loading(`Installing ${p.name}...`)
    try {
      const safeFilename = `${p.id.replace(/[^a-zA-Z0-9.-]/g, '_')}.js`
      await api('POST', '/plugins/install', { url: p.url, filename: safeFilename })
      await loadPlugins()
      toast.success(`Installed ${p.name}`, { id: toastId })
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Install failed', { id: toastId })
    }
    setInstalling(null)
  }

  const installedFilenames = new Set(Object.keys(plugins))

  // --- Sidebar mode ---
  if (inSidebar) {
    return (
      <div className="px-3 pb-4 flex-1 overflow-y-auto">
        <div className="space-y-2">
          {pluginList.map((plugin) => (
            <SidebarPluginCard key={plugin.filename} plugin={plugin} onEdit={handleEdit} />
          ))}
        </div>
      </div>
    )
  }

  // --- Full page mode ---
  const enabledCount = pluginList.filter((p) => p.enabled).length
  const totalTools = pluginList.reduce((acc, p) => acc + (p.toolCount ?? 0), 0)
  const totalHooks = pluginList.reduce((acc, p) => acc + (p.hookCount ?? 0), 0)

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      {/* Stats bar */}
      <div className="flex items-center gap-3 mb-4">
        <Stat label="Installed" value={pluginList.length} />
        <Stat label="Enabled" value={enabledCount} accent />
        <Stat label="Tools" value={totalTools} />
        <Stat label="Hooks" value={totalHooks} />
        <div className="flex-1" />
        {/* Search */}
        <div className="relative w-[260px]">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3/40" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins..."
            className="w-full pl-8 pr-3 py-2 rounded-[10px] bg-surface border border-white/[0.06] text-[12px] text-text placeholder:text-text-3/40 outline-none focus:border-accent-bright/30 transition-colors"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-white/[0.06] pb-px">
        <TabButton active={tab === 'core'} onClick={() => setTab('core')} count={corePlugins.length}>
          Core
        </TabButton>
        <TabButton active={tab === 'extensions'} onClick={() => setTab('extensions')} count={extensionPlugins.length}>
          Extensions
        </TabButton>
        <TabButton active={tab === 'swarmforge'} onClick={() => setTab('swarmforge')}>
          SwarmForge
        </TabButton>
      </div>

      {/* Tab content */}
      {tab === 'core' && (
        <InstalledGrid
          plugins={filteredCore}
          allowDelete={false}
          search={search}
          agents={agents}
          onEdit={handleEdit}
          onToggle={handleToggle}
          onDelete={handleDeleteClick}
          onNavigateToAgent={navigateToAgentChat}
          emptyMessage="No core plugins found"
        />
      )}

      {tab === 'extensions' && (
        <InstalledGrid
          plugins={filteredExtensions}
          allowDelete
          search={search}
          agents={agents}
          onEdit={handleEdit}
          onToggle={handleToggle}
          onDelete={handleDeleteClick}
          onNavigateToAgent={navigateToAgentChat}
          emptyMessage={search ? 'No extensions match your search' : 'No extensions installed'}
          emptyAction={!search ? (
            <button
              onClick={() => setTab('swarmforge')}
              className="mt-3 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[12px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              Browse SwarmForge
            </button>
          ) : undefined}
        />
      )}

      {tab === 'swarmforge' && (
        <MarketplaceTab
          marketplace={marketplace}
          loading={mpLoading}
          installing={installing}
          installedFilenames={installedFilenames}
          search={search}
          activeTag={activeTag}
          setActiveTag={setActiveTag}
          sort={sort}
          setSort={setSort}
          onInstall={installFromMarketplace}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Plugin"
        message={confirmDelete ? `Delete "${confirmDelete.name}"? This cannot be undone.` : ''}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        danger
        onConfirm={() => { void handleDeleteConfirm() }}
        onCancel={() => { if (!deleting) setConfirmDelete(null) }}
      />
    </div>
  )
}

// --- Sub-components ---

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-[18px] font-700 tabular-nums ${accent ? 'text-accent-bright' : 'text-text'}`}>
        {value}
      </span>
      <span className="text-[11px] text-text-3/60 font-500">{label}</span>
    </div>
  )
}

function TabButton({ active, onClick, count, children }: {
  active: boolean; onClick: () => void; count?: number; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2 text-[12px] font-600 cursor-pointer transition-all border-none bg-transparent
        ${active ? 'text-accent-bright' : 'text-text-3/60 hover:text-text-2'}`}
      style={{ fontFamily: 'inherit' }}
    >
      <span className="flex items-center gap-1.5">
        {children}
        {count !== undefined && (
          <span className={`text-[10px] tabular-nums px-1.5 py-px rounded-full ${
            active ? 'bg-accent-soft text-accent-bright' : 'bg-white/[0.04] text-text-3/50'
          }`}>
            {count}
          </span>
        )}
      </span>
      {active && <div className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-accent-bright" />}
    </button>
  )
}

function pluginDescription(plugin: PluginMeta): string {
  const raw = (plugin.description || '').trim()
  if (raw) return raw
  const sourceLabel = plugin.source === 'local' ? 'core plugin' : 'installed plugin'
  return `No description provided. Click to view metadata and controls for this ${sourceLabel}.`
}

function pluginCapabilityBadges(plugin: PluginMeta): string[] {
  const badges: string[] = []
  if (plugin.toolCount && plugin.toolCount > 0) badges.push(`${plugin.toolCount} tool${plugin.toolCount === 1 ? '' : 's'}`)
  if (plugin.hookCount && plugin.hookCount > 0) badges.push(`${plugin.hookCount} hook${plugin.hookCount === 1 ? '' : 's'}`)
  if (plugin.hasUI) badges.push('UI')
  if (plugin.providerCount && plugin.providerCount > 0) badges.push(`${plugin.providerCount} provider${plugin.providerCount === 1 ? '' : 's'}`)
  if (plugin.connectorCount && plugin.connectorCount > 0) badges.push(`${plugin.connectorCount} connector${plugin.connectorCount === 1 ? '' : 's'}`)
  return badges
}

// --- Installed plugins grid ---

function InstalledGrid({ plugins, allowDelete, search, agents, onEdit, onToggle, onDelete, onNavigateToAgent, emptyMessage, emptyAction }: {
  plugins: PluginMeta[]
  allowDelete: boolean
  search: string
  agents: Record<string, Agent>
  onEdit: (filename: string) => void
  onToggle: (e: React.MouseEvent, filename: string, enabled: boolean) => void
  onDelete: (e: React.MouseEvent, filename: string, name: string) => void
  onNavigateToAgent: (agentId: string) => void
  emptyMessage: string
  emptyAction?: React.ReactNode
}) {
  if (plugins.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/[0.03] mb-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-3/30">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3/50">{emptyMessage}</p>
        {emptyAction}
      </div>
    )
  }

  // Group enabled first, then disabled
  const enabled = plugins.filter((p) => p.enabled)
  const disabled = plugins.filter((p) => !p.enabled)
  const sorted = [...enabled, ...disabled]

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {sorted.map((plugin) => (
        <PluginCard
          key={plugin.filename}
          plugin={plugin}
          allowDelete={allowDelete}
          agents={agents}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          onNavigateToAgent={onNavigateToAgent}
          highlight={search}
        />
      ))}
    </div>
  )
}

// --- Plugin card ---

function PluginCard({ plugin, allowDelete, agents, onEdit, onToggle, onDelete, onNavigateToAgent, highlight }: {
  plugin: PluginMeta
  allowDelete: boolean
  agents: Record<string, Agent>
  onEdit: (filename: string) => void
  onToggle: (e: React.MouseEvent, filename: string, enabled: boolean) => void
  onDelete: (e: React.MouseEvent, filename: string, name: string) => void
  onNavigateToAgent: (agentId: string) => void
  highlight: string
}) {
  const badges = pluginCapabilityBadges(plugin)
  const agent = plugin.createdByAgentId ? agents[plugin.createdByAgentId] : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(plugin.filename)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(plugin.filename) } }}
      className={`group relative text-left p-4 rounded-[14px] border transition-all cursor-pointer
        ${plugin.enabled
          ? 'border-white/[0.06] bg-surface hover:bg-surface-2 hover:border-white/[0.1]'
          : 'border-white/[0.03] bg-surface/50 hover:bg-surface hover:border-white/[0.06] opacity-70 hover:opacity-100'
        }`}
    >
      {/* Top row: name + toggle */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {agent && (
            <button
              type="button"
              title={`Created by ${agent.name}`}
              onClick={(e) => { e.stopPropagation(); onNavigateToAgent(plugin.createdByAgentId!) }}
              className="shrink-0 rounded-full hover:ring-2 hover:ring-accent-bright/40 transition-all cursor-pointer bg-transparent border-none p-0"
            >
              <AgentAvatar
                seed={agent.avatarSeed || null}
                avatarUrl={agent.avatarUrl}
                name={agent.name || 'Agent'}
                size={20}
              />
            </button>
          )}
          <span className="font-display text-[14px] font-600 text-text truncate">
            <HighlightText text={plugin.name} highlight={highlight} />
          </span>
          {plugin.version && (
            <span className="text-[10px] font-mono text-text-3/40 shrink-0">v{plugin.version}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div
            onClick={(e) => onToggle(e, plugin.filename, plugin.enabled)}
            className={`w-9 h-5 rounded-full transition-all relative cursor-pointer shrink-0
              ${plugin.enabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
              ${plugin.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </div>
          {allowDelete && (
            <button
              onClick={(e) => onDelete(e, plugin.filename, plugin.name)}
              className="text-text-3/30 hover:text-red-400 transition-colors p-0.5 opacity-0 group-hover:opacity-100"
              title="Delete"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-[12px] text-text-3/60 leading-relaxed line-clamp-2 mb-2.5">
        {pluginDescription(plugin)}
      </p>

      {/* Badges */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {badges.map((badge) => (
          <span key={badge} className="text-[10px] font-600 px-1.5 py-0.5 rounded-full text-text-3/70 bg-white/[0.04]">
            {badge}
          </span>
        ))}
        {plugin.author && (
          <span className="text-[10px] text-text-3/40 ml-auto">
            {plugin.author}
          </span>
        )}
      </div>

      {/* Failure warning */}
      {plugin.autoDisabled && (
        <p className="mt-2 text-[11px] text-amber-400/90 line-clamp-2">
          Auto-disabled after {plugin.failureCount ?? 0} failures
          {plugin.lastFailureStage ? ` (${plugin.lastFailureStage})` : ''}.
          {plugin.lastFailureError ? ` ${plugin.lastFailureError}` : ''}
        </p>
      )}
    </div>
  )
}

// --- Sidebar card (compact) ---

function SidebarPluginCard({ plugin, onEdit }: { plugin: PluginMeta; onEdit: (filename: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(plugin.filename)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(plugin.filename) } }}
      className="w-full text-left p-3 rounded-[12px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-display text-[13px] font-600 text-text truncate">{plugin.name}</span>
        <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full ${
          plugin.enabled ? 'text-emerald-400 bg-emerald-400/10' : 'text-text-3/50 bg-white/[0.04]'
        }`}>
          {plugin.enabled ? 'On' : 'Off'}
        </span>
      </div>
      <p className="text-[11px] text-text-3/50 line-clamp-1">{pluginDescription(plugin)}</p>
    </div>
  )
}

// --- Highlight text helper ---

function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight.trim()) return <>{text}</>
  const idx = text.toLowerCase().indexOf(highlight.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-accent-bright">{text.slice(idx, idx + highlight.length)}</span>
      {text.slice(idx + highlight.length)}
    </>
  )
}

// --- Marketplace tab ---

function MarketplaceTab({ marketplace, loading, installing, installedFilenames, search, activeTag, setActiveTag, sort, setSort, onInstall }: {
  marketplace: MarketplacePlugin[]
  loading: boolean
  installing: string | null
  installedFilenames: Set<string>
  search: string
  activeTag: string | null
  setActiveTag: (v: string | null) => void
  sort: 'name' | 'downloads'
  setSort: (v: 'name' | 'downloads') => void
  onInstall: (p: MarketplacePlugin) => void
}) {
  if (loading) return <p className="text-[12px] text-text-3/70 py-8 text-center">Loading marketplace...</p>

  if (marketplace.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/[0.03] mb-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-3/30">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="9,22 9,12 15,12 15,22" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3/50">No plugins available in the marketplace</p>
      </div>
    )
  }

  const allTags = Array.from(new Set(marketplace.flatMap((p) => p.tags ?? []))).sort()
  const q = search.toLowerCase()
  const filtered = marketplace
    .filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q) && !(p.tags ?? []).some((t) => t.toLowerCase().includes(q))) return false
      if (activeTag && !(p.tags ?? []).includes(activeTag)) return false
      return true
    })
    .sort((a, b) => sort === 'downloads' ? (b.downloads ?? 0) - (a.downloads ?? 0) : a.name.localeCompare(b.name))

  return (
    <div className="space-y-3">
      {/* Tags + Sort */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setActiveTag(null)}
          className={`px-2 py-1 rounded-[6px] text-[10px] font-600 cursor-pointer transition-all border-none ${
            !activeTag ? 'bg-accent-soft text-accent-bright' : 'bg-white/[0.03] text-text-3/60 hover:text-text-3'
          }`}
        >
          All
        </button>
        {allTags.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTag(activeTag === t ? null : t)}
            className={`px-2 py-1 rounded-[6px] text-[10px] font-600 cursor-pointer transition-all border-none ${
              activeTag === t ? 'bg-accent-soft text-accent-bright' : 'bg-white/[0.03] text-text-3/60 hover:text-text-3'
            }`}
          >
            {t}
          </button>
        ))}
        <div className="flex-1" />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as 'name' | 'downloads')}
          className="px-2 py-1 rounded-[6px] bg-surface border border-white/[0.06] text-[10px] text-text-3 outline-none cursor-pointer appearance-none"
          style={{ fontFamily: 'inherit' }}
        >
          <option value="downloads">Popular</option>
          <option value="name">A-Z</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="text-[12px] text-text-3/50 text-center py-4">No plugins match your search</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((p) => {
            const isInstalled = installedFilenames.has(`${p.id}.js`)
            return (
              <div key={p.id} className="py-3.5 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-600 text-text">{p.name}</span>
                      <span className="text-[10px] font-mono text-text-3/70">v{p.version}</span>
                      {p.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
                    </div>
                    <div className="text-[11px] text-text-3/60 mt-1 line-clamp-2">{p.description}</div>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10px] text-text-3/70">by {p.author}</span>
                      <span className="text-[10px] text-text-3/50">&middot;</span>
                      {(p.tags ?? []).slice(0, 3).map((t) => (
                        <button
                          key={t}
                          onClick={() => setActiveTag(activeTag === t ? null : t)}
                          className={`text-[9px] font-600 px-1.5 py-0.5 rounded-full cursor-pointer transition-all border-none ${
                            activeTag === t ? 'text-accent-bright bg-accent-soft' : 'text-text-3/50 bg-white/[0.04] hover:text-text-3'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => !isInstalled && onInstall(p)}
                    disabled={isInstalled || installing === p.id}
                    className={`shrink-0 py-2 px-4 rounded-[10px] text-[12px] font-600 transition-all cursor-pointer
                      ${isInstalled
                        ? 'bg-white/[0.04] text-text-3/70 cursor-default'
                        : installing === p.id
                          ? 'bg-accent-soft text-accent-bright animate-pulse'
                          : 'bg-accent-soft text-accent-bright hover:bg-accent-soft/80 border border-accent-bright/20'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    {isInstalled ? 'Installed' : installing === p.id ? 'Installing...' : 'Install'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
