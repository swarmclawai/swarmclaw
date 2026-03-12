'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { SETUP_PROVIDERS } from '@/lib/setup-defaults'
import { SOUL_LIBRARY } from '@/lib/soul-library'
import { randomSoul } from '@/lib/soul-suggestions'
import type { StepAgentsProps, ConfiguredProvider } from './types'
import type { ProviderModelDiscoveryResult } from '@/types'
import { StepShell, SkipLink } from './shared'
import { AVAILABLE_TOOLS, PLATFORM_TOOLS } from '@/lib/tool-definitions'
import { AgentAvatar } from '@/components/agents/agent-avatar'

/* ── Model combobox: search discovered models or type a custom one ── */

function ModelCombobox({
  value,
  provider,
  endpointOverride,
  onChange,
  modelLibraryUrl,
}: {
  value: string
  provider: ConfiguredProvider | null
  endpointOverride?: string | null
  onChange: (model: string) => void
  modelLibraryUrl?: string | null
}) {
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const fetched = useRef<string | null>(null)

  const effectiveEndpoint = endpointOverride || provider?.endpoint || null

  const fetchModels = useCallback(async (force?: boolean) => {
    if (!provider) return
    const cacheKey = `${provider.provider}|${effectiveEndpoint || ''}|${provider.credentialId || ''}`
    if (!force && fetched.current === cacheKey) return
    fetched.current = cacheKey
    setLoading(true)
    setFetchError('')
    try {
      const params = new URLSearchParams()
      if (provider.credentialId) params.set('credentialId', provider.credentialId)
      if (effectiveEndpoint) params.set('endpoint', effectiveEndpoint)
      if (force) params.set('force', '1')
      const result = await api<ProviderModelDiscoveryResult>(
        'GET',
        `/providers/${provider.provider}/discover-models?${params.toString()}`,
      )
      if (result.ok && result.models.length > 0) {
        setModels(result.models)
      } else if (!result.ok && result.message) {
        setFetchError(result.message)
      }
    } catch {
      setFetchError('Failed to fetch models')
    } finally {
      setLoading(false)
    }
  }, [provider, effectiveEndpoint])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = search
    ? models.filter((m) => m.toLowerCase().includes(search.toLowerCase()))
    : models

  return (
    <div ref={wrapperRef} className="relative">
      <input
        type="text"
        value={open ? search : value}
        onFocus={() => { setOpen(true); setSearch(value) }}
        onChange={(e) => {
          setSearch(e.target.value)
          onChange(e.target.value)
          if (!open) setOpen(true)
        }}
        placeholder={loading ? 'Loading models...' : 'Type or select a model'}
        className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
          text-text text-[14px] font-mono outline-none transition-all duration-200
          focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
      />
      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
        {modelLibraryUrl && (
          <a
            href={modelLibraryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-3 hover:text-accent-bright transition-colors"
            title="Browse available models"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5.5 3H3.5C3.22386 3 3 3.22386 3 3.5V10.5C3 10.7761 3.22386 11 3.5 11H10.5C10.7761 11 11 10.7761 11 10.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <path d="M8 2H12V6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 2L7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </a>
        )}
        <button
          type="button"
          onClick={() => {
            if (models.length > 0 && !loading) {
              setOpen(!open)
              if (!open) setSearch(value)
            } else {
              fetchModels(true)
            }
          }}
          disabled={loading}
          className="text-text-3 hover:text-accent-bright transition-colors bg-transparent border-none cursor-pointer disabled:opacity-40"
          title={models.length > 0 ? 'Show models' : 'Fetch available models'}
        >
          {loading ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="animate-spin">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
              <path d="M12.5 7A5.5 5.5 0 0 0 7 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : models.length > 0 ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1.5 7A5.5 5.5 0 1 1 7 12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M1.5 12.5V9.5H4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
      {fetchError && models.length === 0 && (
        <div className="mt-1 text-[11px] text-amber-300/80">{fetchError}</div>
      )}
      {open && filtered.length > 0 && (
        <div className="absolute z-20 top-full mt-1 left-0 right-0 max-h-[200px] overflow-y-auto rounded-[12px] border border-white/[0.08] bg-surface shadow-lg">
          {filtered.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { onChange(m); setOpen(false); setSearch('') }}
              className={`w-full px-4 py-2.5 text-left text-[13px] font-mono transition-colors cursor-pointer border-none ${
                m === value
                  ? 'bg-accent-bright/10 text-accent-bright'
                  : 'bg-transparent text-text hover:bg-white/[0.04]'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Soul picker: inline textarea + quick library select ── */

function SoulPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (soul: string) => void
}) {
  const [showLibrary, setShowLibrary] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result
      if (typeof text === 'string') onChange(text)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <label className="block text-[12px] text-text-3 font-500 ml-1">Soul / Personality</label>
        <button
          type="button"
          onClick={() => onChange(randomSoul())}
          className="text-[11px] text-accent-bright hover:underline bg-transparent border-none cursor-pointer"
        >
          Shuffle
        </button>
        <button
          type="button"
          onClick={() => setShowLibrary(!showLibrary)}
          className="text-[11px] text-accent-bright hover:underline bg-transparent border-none cursor-pointer"
        >
          {showLibrary ? 'Hide Library' : 'Browse Library'}
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-[11px] text-accent-bright hover:underline bg-transparent border-none cursor-pointer"
        >
          Upload .md
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.txt,.markdown"
          onChange={handleFileUpload}
          className="hidden"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-[11px] text-text-3 hover:text-red-300 bg-transparent border-none cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder="e.g. You speak concisely and directly. You have a dry sense of humor."
        className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
          text-text text-[14px] outline-none transition-all duration-200 resize-none
          focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
      />
      {showLibrary && (
        <div className="mt-2 max-h-[180px] overflow-y-auto rounded-[12px] border border-white/[0.08] bg-surface">
          {SOUL_LIBRARY.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => { onChange(tpl.soul); setShowLibrary(false) }}
              className="w-full px-4 py-2.5 text-left border-none bg-transparent cursor-pointer hover:bg-white/[0.04] transition-colors"
            >
              <div className="text-[13px] text-text font-500">{tpl.name}</div>
              <div className="text-[11px] text-text-3">{tpl.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Main step component ── */

export function StepAgents({
  draftAgents,
  configuredProviders,
  saving,
  error,
  onUpdateDraft,
  onUpdateDraftProvider,
  onSaveAndContinue,
  onRemoveAgent,
  onBack,
  onSkip,
}: StepAgentsProps) {
  return (
    <StepShell wide>
      <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
        Set Up Agents
      </h1>
      <p className="text-[15px] text-text-2 mb-2">
        Create the agents you want to start with. You can always add more later.
      </p>
      <p className="text-[13px] text-text-3 mb-7">
        Each agent uses a provider and model. Adjust names, prompts, and personality below.
      </p>

      {draftAgents.length === 0 ? (
        <div className="mb-6 p-6 rounded-[16px] border border-white/[0.08] bg-surface text-left">
          <div className="text-[16px] font-display font-700 text-text mb-2">No agents yet</div>
          <p className="text-[13px] text-text-3 leading-relaxed">
            Add an agent below to get started, or finish setup and create agents later from inside the app.
          </p>
        </div>
      ) : (
        <div className="space-y-4 max-h-[46vh] overflow-y-auto pr-1 text-left mb-6">
          {draftAgents.map((draft) => {
            const matchedProvider = configuredProviders.find((cp) => cp.id === draft.providerConfigId) || null
            return (
              <div key={draft.id} className="rounded-[16px] border border-white/[0.08] bg-surface p-4">
                <div className="flex items-center justify-between gap-4 mb-4">
                  <div>
                    <div className="text-[15px] font-display font-700 text-text">{draft.name}</div>
                    <div className="text-[12px] text-text-3">{draft.description}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-[12px] text-text-2">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => onUpdateDraft(draft.id, { enabled: e.target.checked })}
                      />
                      Enabled
                    </label>
                    <button
                      type="button"
                      onClick={() => onRemoveAgent(draft.id)}
                      className="text-text-3 hover:text-red-300 transition-colors bg-transparent border-none cursor-pointer p-1"
                      title="Remove agent"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-4 mb-3">
                  <div className="shrink-0">
                    <AgentAvatar seed={draft.avatarUrl ? null : (draft.avatarSeed || null)} avatarUrl={draft.avatarUrl} name={draft.name || 'A'} size={48} />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={draft.avatarSeed}
                      onChange={(e) => onUpdateDraft(draft.id, { avatarSeed: e.target.value, avatarUrl: null })}
                      placeholder="Avatar seed"
                      className="w-32 px-3 py-2 rounded-[10px] border border-white/[0.08] bg-bg
                        text-text text-[13px] outline-none transition-all duration-200
                        focus:border-accent-bright/30"
                    />
                    <button
                      type="button"
                      onClick={() => onUpdateDraft(draft.id, { avatarSeed: crypto.randomUUID().slice(0, 8), avatarUrl: null })}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:bg-white/[0.04] hover:text-text-2 active:scale-95 shrink-0"
                      title="Shuffle avatar"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <circle cx="9" cy="9" r="1" fill="currentColor" />
                        <circle cx="15" cy="15" r="1" fill="currentColor" />
                      </svg>
                      Shuffle
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Name</label>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => onUpdateDraft(draft.id, { name: e.target.value })}
                      className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                        text-text text-[14px] outline-none transition-all duration-200
                        focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Provider</label>
                    <div className="relative">
                      <select
                        value={draft.providerConfigId || ''}
                        onChange={(e) => onUpdateDraftProvider(draft.id, e.target.value)}
                        className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                          text-text text-[14px] outline-none transition-all duration-200
                          focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                      >
                        <option value="">Choose provider</option>
                        {configuredProviders.map((cp) => (
                          <option key={cp.id} value={cp.id}>
                            {cp.name}
                          </option>
                        ))}
                      </select>
                      {matchedProvider && (
                        matchedProvider.verified ? (
                          <span className="absolute right-10 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-emerald-400" title="Connected" />
                        ) : (
                          <span className="absolute right-10 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-400/60" title="Not verified" />
                        )
                      )}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Description</label>
                    <input
                      type="text"
                      value={draft.description}
                      onChange={(e) => onUpdateDraft(draft.id, { description: e.target.value })}
                      className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                        text-text text-[14px] outline-none transition-all duration-200
                        focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Endpoint</label>
                    <input
                      type="text"
                      value={draft.apiEndpoint || ''}
                      onChange={(e) => onUpdateDraft(draft.id, { apiEndpoint: e.target.value || null })}
                      placeholder={matchedProvider?.endpoint || 'Inherited from provider'}
                      className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg
                        text-text text-[14px] font-mono outline-none transition-all duration-200
                        focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                    />
                  </div>
                  {matchedProvider?.provider === 'openclaw' ? (
                    <div className="md:col-span-2">
                      <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Model</label>
                      <div className="flex items-center gap-3 px-4 py-3 rounded-[12px] border border-white/[0.08] bg-bg">
                        <span className="text-[13px] text-text-3">Configured on the OpenClaw gateway.</span>
                        {matchedProvider.dashboardUrl && (
                          <a
                            href={matchedProvider.dashboardUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[13px] text-accent-bright hover:underline whitespace-nowrap"
                          >
                            Open Dashboard
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="md:col-span-2">
                      <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Model</label>
                      <ModelCombobox
                        value={draft.model}
                        provider={matchedProvider}
                        endpointOverride={draft.apiEndpoint}
                        onChange={(model) => onUpdateDraft(draft.id, { model })}
                        modelLibraryUrl={matchedProvider ? SETUP_PROVIDERS.find((sp) => sp.id === matchedProvider.provider)?.modelLibraryUrl : null}
                      />
                    </div>
                  )}
                  <div className="md:col-span-2">
                    <SoulPicker
                      value={draft.soul}
                      onChange={(soul) => onUpdateDraft(draft.id, { soul })}
                    />
                    {matchedProvider?.provider === 'openclaw' && (
                      <p className="mt-1.5 ml-1 text-[11px] text-text-3/70">
                        Synced to the gateway as SOUL.md on save.
                      </p>
                    )}
                  </div>
                </div>

                <details className="mt-4 rounded-[12px] border border-white/[0.08] bg-bg px-4 py-3">
                  <summary className="cursor-pointer text-[13px] text-text-2 font-600">
                    Prompt and tools
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">System Prompt</label>
                      <textarea
                        value={draft.systemPrompt}
                        onChange={(e) => onUpdateDraft(draft.id, { systemPrompt: e.target.value })}
                        rows={5}
                        className="w-full px-4 py-3 rounded-[12px] border border-white/[0.08] bg-surface
                          text-text text-[14px] outline-none transition-all duration-200 resize-none
                          focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                      />
                    </div>
                    <div>
                      <div className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Plugins</div>
                      <div className="space-y-2">
                        {AVAILABLE_TOOLS.map((t) => (
                          <label key={t.id} className="flex items-center gap-3 cursor-pointer">
                            <div
                              onClick={() => onUpdateDraft(draft.id, { tools: draft.tools.includes(t.id) ? draft.tools.filter((x) => x !== t.id) : [...draft.tools, t.id] })}
                              className={`w-9 h-5 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                                ${draft.tools.includes(t.id) ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                            >
                              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200
                                ${draft.tools.includes(t.id) ? 'left-[18px]' : 'left-0.5'}`} />
                            </div>
                            <span className="text-[13px] font-500 text-text-2">{t.label}</span>
                            <span className="text-[11px] text-text-3">{t.description}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3">
                      <div className="block text-[12px] text-text-3 font-500 mb-1.5 ml-1">Platform Plugins</div>
                      <div className="space-y-2">
                        {PLATFORM_TOOLS.map((t) => (
                          <label key={t.id} className="flex items-center gap-3 cursor-pointer">
                            <div
                              onClick={() => onUpdateDraft(draft.id, { tools: draft.tools.includes(t.id) ? draft.tools.filter((x) => x !== t.id) : [...draft.tools, t.id] })}
                              className={`w-9 h-5 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                                ${draft.tools.includes(t.id) ? 'bg-accent-bright' : 'bg-white/[0.08]'}`}
                            >
                              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-200
                                ${draft.tools.includes(t.id) ? 'left-[18px]' : 'left-0.5'}`} />
                            </div>
                            <span className="text-[13px] font-500 text-text-2">{t.label}</span>
                            <span className="text-[11px] text-text-3">{t.description}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            )
          })}
        </div>
      )}

      {error && <p className="mb-4 text-[13px] text-red-400">{error}</p>}

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={onBack}
          className="px-6 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px]
            font-display font-500 cursor-pointer hover:bg-white/[0.03] transition-all duration-200"
        >
          Back
        </button>
        <button
          onClick={onSaveAndContinue}
          disabled={saving}
          className="px-8 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-display font-600
            cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
            shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
        >
          {saving ? 'Saving...' : 'Save & Continue'}
        </button>
      </div>

      <SkipLink onClick={onSkip} />
    </StepShell>
  )
}
