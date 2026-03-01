'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import type { MarketplacePlugin } from '@/types'

export function PluginList({ inSidebar }: { inSidebar?: boolean }) {
  const plugins = useAppStore((s) => s.plugins)
  const loadPlugins = useAppStore((s) => s.loadPlugins)
  const setPluginSheetOpen = useAppStore((s) => s.setPluginSheetOpen)
  const setEditingPluginFilename = useAppStore((s) => s.setEditingPluginFilename)

  const [tab, setTab] = useState<'installed' | 'marketplace'>('installed')
  const [marketplace, setMarketplace] = useState<MarketplacePlugin[]>([])
  const [mpLoading, setMpLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'downloads'>('downloads')

  useEffect(() => {
    loadPlugins()
  }, [])

  const loadMarketplace = useCallback(async () => {
    setMpLoading(true)
    try {
      const data = await api<MarketplacePlugin[]>('GET', '/plugins/marketplace')
      if (Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    setMpLoading(false)
  }, [])

  useEffect(() => {
    if (!inSidebar && tab === 'marketplace') loadMarketplace()
  }, [tab, inSidebar, loadMarketplace])

  const pluginList = Object.values(plugins)

  const handleEdit = (filename: string) => {
    setEditingPluginFilename(filename)
    setPluginSheetOpen(true)
  }

  const handleToggle = async (e: React.MouseEvent, filename: string, enabled: boolean) => {
    e.stopPropagation()
    await api('POST', '/plugins', { filename, enabled: !enabled })
    loadPlugins()
  }

  const handleDelete = async (e: React.MouseEvent, filename: string) => {
    e.stopPropagation()
    await api('DELETE', `/plugins/${encodeURIComponent(filename)}`)
    loadPlugins()
  }

  const installFromMarketplace = async (p: MarketplacePlugin) => {
    setInstalling(p.id)
    try {
      await api('POST', '/plugins/install', { url: p.url, filename: `${p.id}.js` })
      await loadPlugins()
    } catch { /* ignore */ }
    setInstalling(null)
  }

  const installedFilenames = new Set(Object.keys(plugins))

  const tabClass = (t: string) =>
    `py-1.5 px-3.5 rounded-[8px] text-[12px] font-600 cursor-pointer transition-all border
    ${tab === t
      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
      : 'bg-transparent border-transparent text-text-3 hover:text-text-2'}`

  // Marketplace tab content (full-width only)
  const renderMarketplace = () => {
    if (mpLoading) return <p className="text-[12px] text-text-3/70 py-8 text-center">Loading marketplace...</p>
    if (marketplace.length === 0) return <p className="text-[12px] text-text-3/70 py-8 text-center">No plugins available</p>

    const allTags = Array.from(new Set(marketplace.flatMap((p) => p.tags))).sort()
    const q = search.toLowerCase()
    const filtered = marketplace
      .filter((p) => {
        if (q && !p.name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q) && !p.tags.some((t) => t.toLowerCase().includes(q))) return false
        if (activeTag && !p.tags.includes(activeTag)) return false
        return true
      })
      .sort((a, b) => sort === 'downloads' ? b.downloads - a.downloads : a.name.localeCompare(b.name))

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
                        {p.tags.slice(0, 3).map((t) => (
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
            Marketplace
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
          <div className={inSidebar ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
            {pluginList.map((plugin) => (
              <button
                key={plugin.filename}
                onClick={() => handleEdit(plugin.filename)}
                className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-display text-[14px] font-600 text-text truncate">{plugin.name}</span>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {!inSidebar ? (
                      <>
                        <div
                          onClick={(e) => handleToggle(e, plugin.filename, plugin.enabled)}
                          className={`w-9 h-5 rounded-full transition-all relative cursor-pointer shrink-0
                            ${plugin.enabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
                        >
                          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
                            ${plugin.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                        </div>
                        <button
                          onClick={(e) => handleDelete(e, plugin.filename)}
                          className="text-text-3/40 hover:text-red-400 transition-colors p-0.5"
                          title="Delete"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </>
                    ) : (
                      <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-full ${plugin.enabled ? 'text-emerald-400 bg-emerald-400/10' : 'text-text-3/50 bg-white/[0.04]'}`}>
                        {plugin.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-[11px] font-mono text-text-3/50 mb-1">{plugin.filename}</div>
                {plugin.description && (
                  <p className="text-[12px] text-text-3/60 line-clamp-2">{plugin.description}</p>
                )}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  )
}
