'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import type { MarketplacePlugin, PluginMeta } from '@/types'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'

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
    // Find the most recent chat for this agent
    const agentSession = Object.values(sessions)
      .filter((s) => s.agentId === agentId)
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
    if (agentSession) {
      setCurrentSession(agentSession.id)
      setActiveView('agents')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  const [tab, setTab] = useState<'installed' | 'marketplace'>('installed')
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
    if (inSidebar || tab !== 'marketplace') return
    const timer = setTimeout(() => {
      void loadMarketplace()
    }, 0)
    return () => clearTimeout(timer)
  }, [tab, inSidebar, loadMarketplace])

  const pluginList = Object.values(plugins)
  const corePlugins = pluginList.filter((plugin) => plugin.source === 'local')
  const extensionPlugins = pluginList.filter((plugin) => plugin.source !== 'local')

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

  const tabClass = (t: string) =>
    `py-1.5 px-3.5 rounded-[8px] text-[12px] font-600 cursor-pointer transition-all border
    ${tab === t
      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
      : 'bg-transparent border-transparent text-text-3 hover:text-text-2'}`

  const pluginDescription = (plugin: PluginMeta): string => {
    const raw = (plugin.description || '').trim()
    if (raw) return raw
    const sourceLabel = plugin.source === 'local' ? 'core plugin' : 'installed plugin'
    return `No description provided. Click to view metadata and controls for this ${sourceLabel}.`
  }

  const pluginCapabilityBadges = (plugin: PluginMeta): string[] => {
    const badges: string[] = []
    if (plugin.toolCount && plugin.toolCount > 0) badges.push(`${plugin.toolCount} tool${plugin.toolCount === 1 ? '' : 's'}`)
    if (plugin.hookCount && plugin.hookCount > 0) badges.push(`${plugin.hookCount} hook${plugin.hookCount === 1 ? '' : 's'}`)
    if (plugin.hasUI) badges.push('UI')
    if (plugin.providerCount && plugin.providerCount > 0) badges.push(`${plugin.providerCount} provider${plugin.providerCount === 1 ? '' : 's'}`)
    if (plugin.connectorCount && plugin.connectorCount > 0) badges.push(`${plugin.connectorCount} connector${plugin.connectorCount === 1 ? '' : 's'}`)
    return badges
  }

  const renderInstalledPlugin = (plugin: (typeof pluginList)[number], allowDelete: boolean) => (
    <div
      key={plugin.filename}
      role="button"
      tabIndex={0}
      onClick={() => handleEdit(plugin.filename)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleEdit(plugin.filename)
        }
      }}
      className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {plugin.createdByAgentId && agents[plugin.createdByAgentId] && (
            <button
              type="button"
              title={`Created by ${agents[plugin.createdByAgentId].name} — click to open chat`}
              onClick={(e) => { e.stopPropagation(); navigateToAgentChat(plugin.createdByAgentId!) }}
              className="shrink-0 rounded-full hover:ring-2 hover:ring-accent-bright/40 transition-all cursor-pointer bg-transparent border-none p-0"
            >
              <AgentAvatar
                seed={agents[plugin.createdByAgentId].avatarSeed || null}
                avatarUrl={agents[plugin.createdByAgentId].avatarUrl}
                name={agents[plugin.createdByAgentId].name || 'Agent'}
                size={20}
              />
            </button>
          )}
          <span className="font-display text-[14px] font-600 text-text truncate">{plugin.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {!inSidebar ? (
            <>
              <div
                onClick={(e) => handleToggle(e, plugin.filename, plugin.enabled)}
                className={`w-9 h-5 rounded-full transition-all relative cursor-pointer shrink-0
                  ${plugin.enabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
                  ${plugin.enabled ? 'left-[18px]' : 'left-0.5'}`} />
              </div>
              {allowDelete && (
                <button
                  onClick={(e) => handleDeleteClick(e, plugin.filename, plugin.name)}
                  className="text-text-3/40 hover:text-red-400 transition-colors p-0.5"
                  title="Delete"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </>
          ) : (
            <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full ${plugin.enabled ? 'text-emerald-400 bg-emerald-400/10' : 'text-text-3/50 bg-white/[0.04]'}`}>
              {plugin.enabled ? 'Enabled' : 'Disabled'}
            </span>
          )}
        </div>
      </div>
      <div className="text-[11px] font-mono text-text-3/50 mb-1">{plugin.filename}</div>
      <p className="text-[12px] text-text-3/70 leading-relaxed">{pluginDescription(plugin)}</p>
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full ${
          plugin.source === 'local' ? 'text-indigo-300 bg-indigo-500/10' : 'text-emerald-300 bg-emerald-500/10'
        }`}>
          {plugin.source === 'local' ? 'Core' : 'Extension'}
        </span>
        {pluginCapabilityBadges(plugin).map((badge) => (
          <span key={badge} className="text-[10px] font-600 px-1.5 py-0.5 rounded-full text-text-3/80 bg-white/[0.05]">
            {badge}
          </span>
        ))}
      </div>
      {!inSidebar && (
        <p className="text-[10px] text-text-3/50 mt-2">Click for full details and controls</p>
      )}
      {plugin.autoDisabled && (
        <p className="mt-1 text-[11px] text-amber-400/90 line-clamp-2">
          Auto-disabled after {plugin.failureCount ?? 0} failures
          {plugin.lastFailureStage ? ` (${plugin.lastFailureStage})` : ''}.
          {plugin.lastFailureError ? ` ${plugin.lastFailureError}` : ''}
        </p>
      )}
    </div>
  )

  // Marketplace tab content (full-width only)
  const renderMarketplace = () => {
    if (mpLoading) return <p className="text-[12px] text-text-3/70 py-8 text-center">Loading marketplace...</p>
    if (marketplace.length === 0) return <p className="text-[12px] text-text-3/70 py-8 text-center">No plugins available</p>

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
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search plugins..."
          className="w-full px-3 py-2.5 rounded-[10px] bg-surface border border-white/[0.06] text-[12px] text-text placeholder:text-text-3/50 outline-none focus:border-accent-bright/30"
          style={{ fontFamily: 'inherit' }}
        />
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
                      onClick={() => !isInstalled && installFromMarketplace(p)}
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

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
      {/* Tabs — full-width only */}
      {!inSidebar && (
        <div className="flex gap-1 mb-4">
          <button onClick={() => setTab('installed')} className={tabClass('installed')} style={{ fontFamily: 'inherit' }}>
            Installed
          </button>
          <button onClick={() => setTab('marketplace')} className={tabClass('marketplace')} style={{ fontFamily: 'inherit' }}>
            SwarmForge
          </button>
        </div>
      )}

      {(!inSidebar && tab === 'marketplace') ? renderMarketplace() : (
        pluginList.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-[13px] text-text-3/60">No plugins installed</p>
            <button
              onClick={() => { setEditingPluginFilename(null); setPluginSheetOpen(true) }}
              className="mt-3 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[13px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              + Add Plugin
            </button>
          </div>
        ) : (
          inSidebar ? (
            <div className="space-y-2">
              {pluginList.map((plugin) => renderInstalledPlugin(plugin, plugin.source !== 'local'))}
            </div>
          ) : (
            <div className="space-y-6">
              {corePlugins.length > 0 && (
                <section>
                  <div className="mb-3 px-1">
                    <h3 className="text-[13px] font-700 text-text-2">Core Platform</h3>
                    <p className="text-[12px] text-text-3/60 mt-0.5">Official SwarmClaw plugins shipped with the platform.</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {corePlugins.map((plugin) => renderInstalledPlugin(plugin, false))}
                  </div>
                </section>
              )}

              {extensionPlugins.length > 0 && (
                <section>
                  <div className="mb-3 px-1">
                    <h3 className="text-[13px] font-700 text-text-2">Extensions</h3>
                    <p className="text-[12px] text-text-3/60 mt-0.5">Marketplace and custom plugins installed by your team.</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {extensionPlugins.map((plugin) => renderInstalledPlugin(plugin, true))}
                  </div>
                </section>
              )}
            </div>
          )
        )
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
