'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { api } from '@/lib/api-client'
import { toast } from 'sonner'
import type { PluginMeta, PluginSettingsField, MarketplacePlugin } from '@/types'

function pluginDescription(plugin: PluginMeta): string {
  const raw = (plugin.description || '').trim()
  if (raw) return raw
  const sourceLabel = plugin.source === 'local' ? 'core plugin' : 'installed plugin'
  return `No description provided. This ${sourceLabel} is available and can be configured from this panel.`
}

function pluginCapabilityBadges(plugin: PluginMeta): string[] {
  const badges: string[] = []
  if (plugin.toolCount && plugin.toolCount > 0) badges.push(`${plugin.toolCount} tool${plugin.toolCount === 1 ? '' : 's'}`)
  if (plugin.hookCount && plugin.hookCount > 0) badges.push(`${plugin.hookCount} hook${plugin.hookCount === 1 ? '' : 's'}`)
  if (plugin.hasUI) badges.push('UI extension')
  if (plugin.providerCount && plugin.providerCount > 0) badges.push(`${plugin.providerCount} provider${plugin.providerCount === 1 ? '' : 's'}`)
  if (plugin.connectorCount && plugin.connectorCount > 0) badges.push(`${plugin.connectorCount} connector${plugin.connectorCount === 1 ? '' : 's'}`)
  return badges
}

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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [sort, setSort] = useState<'name' | 'downloads'>('downloads')
  const [pluginSettingsValues, setPluginSettingsValues] = useState<Record<string, unknown>>({})
  const [pluginSettingsLoading, setPluginSettingsLoading] = useState(false)
  const [pluginSettingsSaving, setPluginSettingsSaving] = useState(false)

  const editing = editingFilename ? plugins[editingFilename] : null

  // Load per-plugin settings when editing a plugin that has settingsFields
  useEffect(() => {
    if (!editing?.settingsFields?.length) {
      setPluginSettingsValues({})
      return
    }
    setPluginSettingsLoading(true)
    api<Record<string, unknown>>('GET', `/plugins/settings?pluginId=${encodeURIComponent(editing.filename)}`)
      .then((data) => setPluginSettingsValues(data ?? {}))
      .catch(() => setPluginSettingsValues({}))
      .finally(() => setPluginSettingsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingFilename])

  const savePluginSettings = useCallback(async () => {
    if (!editing) return
    setPluginSettingsSaving(true)
    try {
      await api('PUT', `/plugins/settings?pluginId=${encodeURIComponent(editing.filename)}`, pluginSettingsValues)
      toast.success('Plugin settings saved')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings')
    }
    setPluginSettingsSaving(false)
  }, [editing, pluginSettingsValues])

  const loadMarketplace = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<MarketplacePlugin[]>('GET', '/plugins/marketplace')
      if (Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!open || !!editingFilename || tab !== 'marketplace') return
    const timer = setTimeout(() => {
      void loadMarketplace()
    }, 0)
    return () => clearTimeout(timer)
  }, [open, editingFilename, tab, loadMarketplace])

  const handleClose = () => {
    setOpen(false)
    setEditingFilename(null)
    setUrlInput('')
    setUrlFilename('')
    setUrlStatus(null)
    setConfirmDelete(false)
  }

  const togglePlugin = async (filename: string, enabled: boolean) => {
    try {
      await api('POST', '/plugins', { filename, enabled })
      toast.success(enabled ? 'Plugin enabled' : 'Plugin disabled')
      loadPlugins()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle plugin')
    }
  }

  const deletePlugin = async (filename: string) => {
    setDeleting(true)
    try {
      await api('DELETE', `/plugins?filename=${encodeURIComponent(filename)}`)
      toast.success('Plugin deleted')
      await loadPlugins()
      handleClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
    setDeleting(false)
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

  const installFromUrl = async () => {
    if (!urlInput || !urlFilename) return
    setUrlStatus(null)
    setInstalling('url')
    try {
      await api('POST', '/plugins/install', { url: urlInput, filename: urlFilename })
      await loadPlugins()
      setUrlStatus({ ok: true, message: 'Installed successfully' })
      toast.success('Plugin installed from URL')
      setUrlInput('')
      setUrlFilename('')
    } catch (err: unknown) {
      setUrlStatus({ ok: false, message: err instanceof Error ? err.message : 'Install failed' })
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
          <div className="py-4 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[15px] font-700 text-text truncate">{editing.name}</span>
                  <span className="text-[10px] font-mono text-text-3/70">v{editing.version || '1.0.0'}</span>
                  {editing.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
                </div>
                <p className="text-[12px] text-text-3/80 leading-relaxed">{pluginDescription(editing)}</p>
              </div>
              <span className={`shrink-0 text-[10px] font-600 px-2 py-1 rounded-full ${
                editing.enabled ? 'text-emerald-300 bg-emerald-500/10' : 'text-text-3/80 bg-white/[0.05]'
              }`}>
                {editing.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-3">
              <div className="rounded-[10px] bg-bg/50 border border-white/[0.05] px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60 mb-0.5">Source</div>
                <div className="text-[11px] text-text-2">{editing.source === 'local' ? 'Core Platform' : 'Extension'}</div>
              </div>
              <div className="rounded-[10px] bg-bg/50 border border-white/[0.05] px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-3/60 mb-0.5">Author</div>
                <div className="text-[11px] text-text-2">{editing.author || 'Unknown'}</div>
              </div>
            </div>

            <div className="text-[11px] font-mono text-text-3/60 mt-3 break-all">{editing.filename}</div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {pluginCapabilityBadges(editing).length > 0 ? (
                pluginCapabilityBadges(editing).map((badge) => (
                  <span key={badge} className="text-[10px] font-600 px-1.5 py-0.5 rounded-full text-text-3/80 bg-white/[0.05]">
                    {badge}
                  </span>
                ))
              ) : (
                <span className="text-[10px] text-text-3/50">No declared tools/hooks metadata</span>
              )}
            </div>

            {editing.autoDisabled && (
              <div className="mt-3 p-2.5 rounded-[10px] bg-amber-500/[0.06] border border-amber-500/20 text-[11px] text-amber-300/90">
                Auto-disabled after {editing.failureCount ?? 0} failures
                {editing.lastFailureStage ? ` at ${editing.lastFailureStage}` : ''}.
                {editing.lastFailureError ? ` ${editing.lastFailureError}` : ''}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
            <div>
              <span className="text-[13px] font-600 text-text block">Enabled</span>
              <span className="text-[11px] text-text-3/60">Disable to keep the plugin installed but inactive.</span>
            </div>
            <div
              onClick={() => togglePlugin(editing.filename, !editing.enabled)}
              className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                ${editing.enabled ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                ${editing.enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </div>
          </div>

          {editing.settingsFields && editing.settingsFields.length > 0 && (
            <div className="py-4 px-4 rounded-[14px] bg-surface border border-white/[0.06] space-y-3">
              <div className="text-[13px] font-600 text-text">Settings</div>
              {pluginSettingsLoading ? (
                <p className="text-[11px] text-text-3/60">Loading...</p>
              ) : (
                <>
                  {editing.settingsFields.map((field: PluginSettingsField) => (
                    <PluginSettingRow
                      key={field.key}
                      field={field}
                      value={pluginSettingsValues[field.key]}
                      onChange={(v) => setPluginSettingsValues((prev) => ({ ...prev, [field.key]: v }))}
                    />
                  ))}
                  <button
                    onClick={savePluginSettings}
                    disabled={pluginSettingsSaving}
                    className="w-full py-2 rounded-[10px] text-[12px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20
                      hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default mt-1"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {pluginSettingsSaving ? 'Saving...' : 'Save Settings'}
                  </button>
                </>
              )}
            </div>
          )}

          {editing.source !== 'local' && (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              className="w-full py-2.5 rounded-[10px] text-[13px] font-600 bg-red-500/10 text-red-400 border border-red-500/20
                hover:bg-red-500/20 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default"
              style={{ fontFamily: 'inherit' }}
            >
              {deleting ? 'Deleting...' : 'Delete Plugin'}
            </button>
          )}
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
                : (() => {
                    const allTags = Array.from(new Set(marketplace.flatMap((p) => (p.tags ?? [])))).sort()
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
                        {/* Search */}
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Search plugins..."
                          className="w-full px-3 py-2.5 rounded-[10px] bg-bg border border-white/[0.06] text-[12px] text-text placeholder:text-text-3/50 outline-none focus:border-accent-bright/30"
                          style={{ fontFamily: 'inherit' }}
                        />

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
                            className="px-2 py-1 rounded-[6px] bg-bg border border-white/[0.06] text-[10px] text-text-3 outline-none cursor-pointer appearance-none"
                            style={{ fontFamily: 'inherit' }}
                          >
                            <option value="downloads">Popular</option>
                            <option value="name">A-Z</option>
                          </select>
                        </div>

                        {/* Results */}
                        {filtered.length === 0 ? (
                          <p className="text-[12px] text-text-3/50 text-center py-4">No plugins match your search</p>
                        ) : (
                          <div className="space-y-2.5">
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
                                      <div className="text-[11px] text-text-3/60 mt-1">{p.description}</div>
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
                  })()
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
      <ConfirmDialog
        open={!!editing && confirmDelete}
        title="Delete Plugin"
        message={editing ? `Delete "${editing.name}"? This cannot be undone.` : ''}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        danger
        onConfirm={() => {
          if (!editing) return
          setConfirmDelete(false)
          void deletePlugin(editing.filename)
        }}
        onCancel={() => { if (!deleting) setConfirmDelete(false) }}
      />
    </BottomSheet>
  )
}

function PluginSettingRow({ field, value, onChange }: { field: PluginSettingsField; value: unknown; onChange: (v: unknown) => void }) {
  const inputCls = 'w-full py-2 px-3 rounded-[8px] text-[12px] bg-bg border border-white/[0.06] text-text placeholder:text-text-3/50 outline-none focus:border-accent-bright/30'

  return (
    <div>
      <label className="block text-[11px] font-600 text-text-2 mb-1">
        {field.label}
        {field.required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {field.type === 'boolean' ? (
        <div
          onClick={() => onChange(!(value ?? field.defaultValue ?? false))}
          className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
            ${(value ?? field.defaultValue ?? false) ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
        >
          <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
            ${(value ?? field.defaultValue ?? false) ? 'left-[22px]' : 'left-0.5'}`} />
        </div>
      ) : field.type === 'select' ? (
        <select
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} cursor-pointer appearance-none`}
          style={{ fontFamily: 'inherit' }}
        >
          <option value="">Select...</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : field.type === 'number' ? (
        <input
          type="number"
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          placeholder={field.placeholder}
          className={inputCls}
          style={{ fontFamily: 'inherit' }}
        />
      ) : (
        <input
          type={field.type === 'secret' ? 'password' : 'text'}
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={field.placeholder}
          className={inputCls}
          style={{ fontFamily: 'inherit' }}
        />
      )}
      {field.help && <p className="text-[10px] text-text-3/60 mt-1">{field.help}</p>}
    </div>
  )
}
