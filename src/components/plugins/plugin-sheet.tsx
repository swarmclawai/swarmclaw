'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { api } from '@/lib/api-client'
import type { PluginMeta, MarketplacePlugin } from '@/types'

export function PluginSheet() {
  const open = useAppStore((s) => s.pluginSheetOpen)
  const setOpen = useAppStore((s) => s.setPluginSheetOpen)
  const editingFilename = useAppStore((s) => s.editingPluginFilename)
  const setEditingFilename = useAppStore((s) => s.setEditingPluginFilename)
  const plugins = useAppStore((s) => s.plugins)
  const loadPlugins = useAppStore((s) => s.loadPlugins)

  const [tab, setTab] = useState<'marketplace' | 'url'>('marketplace')
  const [marketplace, setMarketplace] = useState<MarketplacePlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlFilename, setUrlFilename] = useState('')
  const [urlStatus, setUrlStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const editing = editingFilename ? plugins[editingFilename] : null

  const loadMarketplace = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<MarketplacePlugin[]>('GET', '/plugins/marketplace')
      if (Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (open && !editingFilename && tab === 'marketplace') loadMarketplace()
  }, [open, editingFilename, tab])

  const handleClose = () => {
    setOpen(false)
    setEditingFilename(null)
    setUrlInput('')
    setUrlFilename('')
    setUrlStatus(null)
  }

  const togglePlugin = async (filename: string, enabled: boolean) => {
    await api('POST', '/plugins', { filename, enabled })
    loadPlugins()
  }

  const deletePlugin = async (filename: string) => {
    setDeleting(true)
    try {
      await api('DELETE', `/plugins/${encodeURIComponent(filename)}`)
      await loadPlugins()
      handleClose()
    } catch { /* ignore */ }
    setDeleting(false)
  }

  const installFromMarketplace = async (p: MarketplacePlugin) => {
    setInstalling(p.id)
    try {
      await api('POST', '/plugins/install', { url: p.url, filename: `${p.id}.js` })
      await loadPlugins()
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

  const installedFilenames = new Set(Object.keys(plugins))

  const tabClass = (t: string) =>
    `py-2.5 px-4 rounded-[10px] text-center cursor-pointer transition-all text-[12px] font-600 border
    ${tab === t
      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
      : 'bg-bg border-white/[0.06] text-text-3 hover:bg-surface-2'}`

  return (
    <BottomSheet open={open} onClose={handleClose}>
      {editing ? (
        <div className="space-y-5">
          <div className="py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[14px] font-600 text-text">{editing.name}</span>
              {editing.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
            </div>
            <div className="text-[11px] font-mono text-text-3">{editing.filename}</div>
            {editing.description && <div className="text-[11px] text-text-3/60 mt-1">{editing.description}</div>}
            {editing.author && <div className="text-[10px] text-text-3/70 mt-1">by {editing.author}</div>}
          </div>

          <div className="flex items-center justify-between py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
            <span className="text-[13px] font-600 text-text">Enabled</span>
            <div
              onClick={() => togglePlugin(editing.filename, !editing.enabled)}
              className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                ${editing.enabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                ${editing.enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </div>
          </div>

          <button
            onClick={() => deletePlugin(editing.filename)}
            disabled={deleting}
            className="w-full py-2.5 rounded-[10px] text-[13px] font-600 bg-red-500/10 text-red-400 border border-red-500/20
              hover:bg-red-500/20 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default"
            style={{ fontFamily: 'inherit' }}
          >
            {deleting ? 'Deleting...' : 'Delete Plugin'}
          </button>
        </div>
      ) : (
        <div>
          <div className="flex gap-2 mb-5">
            <button onClick={() => setTab('marketplace')} className={tabClass('marketplace')} style={{ fontFamily: 'inherit' }}>
              Marketplace
            </button>
            <button onClick={() => setTab('url')} className={tabClass('url')} style={{ fontFamily: 'inherit' }}>
              Install from URL
            </button>
          </div>

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
                                <span className="text-[10px] text-text-3/50">&middot;</span>
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
      )}
    </BottomSheet>
  )
}
