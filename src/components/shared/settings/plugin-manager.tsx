'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api-client'
import type { PluginMeta, MarketplacePlugin } from '@/types'

export function PluginManager() {
  const [tab, setTab] = useState<'installed' | 'marketplace' | 'url'>('installed')
  const [plugins, setPlugins] = useState<PluginMeta[]>([])
  const [marketplace, setMarketplace] = useState<MarketplacePlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlFilename, setUrlFilename] = useState('')
  const [urlStatus, setUrlStatus] = useState<{ ok: boolean; message: string } | null>(null)

  const loadPlugins = useCallback(async () => {
    try {
      const data = await api<PluginMeta[]>('GET', '/plugins')
      setPlugins(data)
    } catch { /* ignore */ }
  }, [])

  const loadMarketplace = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<MarketplacePlugin[]>('GET', '/plugins/marketplace')
      if (Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadPlugins() }, [])
  useEffect(() => { if (tab === 'marketplace') loadMarketplace() }, [tab])

  const togglePlugin = async (filename: string, enabled: boolean) => {
    await api('POST', '/plugins', { filename, enabled })
    loadPlugins()
  }

  const installFromMarketplace = async (p: MarketplacePlugin) => {
    setInstalling(p.id)
    try {
      await api('POST', '/plugins/install', { url: p.url, filename: `${p.id}.js` })
      await loadPlugins()
      setTab('installed')
    } catch { /* ignore */ }
    setInstalling(null)
  }

  const installFromUrl = async () => {
    if (!urlInput || !urlFilename) return
    setUrlStatus(null)
    setInstalling('url')
    try {
      await api('POST', '/plugins/install', { url: urlInput, filename: urlFilename })
      await loadPlugins()
      setUrlStatus({ ok: true, message: 'Installed successfully' })
      setUrlInput('')
      setUrlFilename('')
    } catch (err: any) {
      setUrlStatus({ ok: false, message: err.message || 'Install failed' })
    }
    setInstalling(null)
  }

  const installedFilenames = new Set(plugins.map((p) => p.filename))

  const tabClass = (t: string) =>
    `py-2.5 px-4 rounded-[10px] text-center cursor-pointer transition-all text-[12px] font-600 border
    ${tab === t
      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
      : 'bg-bg border-white/[0.06] text-text-3 hover:bg-surface-2'}`

  return (
    <div>
      <div className="flex gap-2 mb-5">
        <button onClick={() => setTab('installed')} className={tabClass('installed')} style={{ fontFamily: 'inherit' }}>
          Installed{plugins.length > 0 && ` (${plugins.length})`}
        </button>
        <button onClick={() => setTab('marketplace')} className={tabClass('marketplace')} style={{ fontFamily: 'inherit' }}>
          Marketplace
        </button>
        <button onClick={() => setTab('url')} className={tabClass('url')} style={{ fontFamily: 'inherit' }}>
          Install from URL
        </button>
      </div>

      {tab === 'installed' && (
        plugins.length === 0
          ? <p className="text-[12px] text-text-3/70">No plugins installed</p>
          : <div className="space-y-2.5">
              {plugins.map((p) => (
                <div key={p.filename} className="flex items-center gap-3 py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-600 text-text truncate">{p.name}</span>
                      {p.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
                    </div>
                    <div className="text-[11px] font-mono text-text-3 truncate">{p.filename}</div>
                    {p.description && <div className="text-[11px] text-text-3/60 mt-0.5">{p.description}</div>}
                  </div>
                  <div
                    onClick={() => togglePlugin(p.filename, !p.enabled)}
                    className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                      ${p.enabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                      ${p.enabled ? 'left-[22px]' : 'left-0.5'}`} />
                  </div>
                </div>
              ))}
            </div>
      )}

      {tab === 'marketplace' && (
        loading
          ? <p className="text-[12px] text-text-3/70">Loading marketplace...</p>
          : marketplace.length === 0
            ? <p className="text-[12px] text-text-3/70">No plugins available</p>
            : <div className="space-y-2.5">
                {marketplace.map((p) => {
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
                          <div className="text-[11px] text-text-3/60 mt-1">{p.description}</div>
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[10px] text-text-3/70">by {p.author}</span>
                            <span className="text-[10px] text-text-3/50">·</span>
                            {p.tags.slice(0, 3).map((t) => (
                              <span key={t} className="text-[9px] font-600 text-text-3/50 bg-white/[0.04] px-1.5 py-0.5 rounded-full">{t}</span>
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

      {tab === 'url' && (
        <div className="p-5 rounded-[14px] bg-surface border border-white/[0.06]">
          <div className="mb-4">
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Plugin URL</label>
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/my-plugin.js"
              className="w-full py-2.5 px-3 rounded-[10px] text-[13px] bg-bg border border-white/[0.06] text-text placeholder:text-text-3/60 outline-none focus:border-accent-bright/30"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div className="mb-4">
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Save as filename</label>
            <input
              type="text"
              value={urlFilename}
              onChange={(e) => setUrlFilename(e.target.value)}
              placeholder="my-plugin.js"
              className="w-full py-2.5 px-3 rounded-[10px] text-[13px] bg-bg border border-white/[0.06] text-text placeholder:text-text-3/60 outline-none focus:border-accent-bright/30"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <button
            onClick={installFromUrl}
            disabled={!urlInput || !urlFilename || installing === 'url'}
            className="w-full py-2.5 rounded-[10px] text-[13px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20
              hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default"
            style={{ fontFamily: 'inherit' }}
          >
            {installing === 'url' ? 'Installing...' : 'Install Plugin'}
          </button>
          {urlStatus && (
            <p className={`text-[11px] mt-3 ${urlStatus.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {urlStatus.message}
            </p>
          )}
          <p className="text-[10px] text-text-3/60 mt-3">
            Works with SwarmClaw and OpenClaw plugin formats. URL must be HTTPS.
          </p>
        </div>
      )}
    </div>
  )
}
