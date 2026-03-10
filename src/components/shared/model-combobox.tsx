'use client'

import { useState, useRef, useEffect, useCallback, useEffectEvent } from 'react'
import { api } from '@/lib/app/api-client'
import { useAppStore } from '@/stores/use-app-store'
import { fetchProviderModelDiscovery } from '@/lib/provider-model-discovery-client'

interface ModelComboboxProps {
  providerId: string
  value: string
  onChange: (model: string) => void
  models: string[]
  defaultModels?: string[]
  credentialId?: string | null
  apiEndpoint?: string | null
  supportsDiscovery?: boolean
  className?: string
}

export function ModelCombobox({
  providerId,
  value,
  onChange,
  models,
  defaultModels = [],
  credentialId,
  apiEndpoint,
  supportsDiscovery = true,
  className,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])
  const [discoveryState, setDiscoveryState] = useState<'idle' | 'loading' | 'ready' | 'notice'>('idle')
  const [discoveryMessage, setDiscoveryMessage] = useState('')
  const [discoveryCached, setDiscoveryCached] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastDiscoveryKeyRef = useRef<string | null>(null)
  const loadProviders = useAppStore((s) => s.loadProviders)

  const availableModels = [...models, ...discoveredModels].filter((model, index, source) => source.indexOf(model) === index)
  const trimmedQuery = query.trim()
  const filtered = trimmedQuery
    ? availableModels.filter((m) => m.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : availableModels

  const isCustom = (m: string) => models.includes(m) && defaultModels.length > 0 && !defaultModels.includes(m)
  const showAdd = trimmedQuery && !availableModels.some((m) => m.toLowerCase() === trimmedQuery.toLowerCase())
  const discoveryKey = `${providerId}::${credentialId || ''}::${apiEndpoint?.trim() || ''}`

  const persistModels = useCallback(async (next: string[]) => {
    await api('PUT', `/providers/${providerId}/models`, { models: next })
    await loadProviders()
  }, [providerId, loadProviders])

  const addModel = useCallback(async (name: string) => {
    const next = [...models, name]
    await persistModels(next)
    onChange(name)
    setQuery('')
    setOpen(false)
  }, [models, persistModels, onChange])

  const removeModel = useCallback(async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const next = models.filter((m) => m !== name)
    if (value === name) onChange(next[0] || '')
    if (next.length === defaultModels.length && next.every((m) => defaultModels.includes(m))) {
      await api('DELETE', `/providers/${providerId}/models`)
    } else {
      await persistModels(next)
    }
    await loadProviders()
  }, [models, defaultModels, value, onChange, providerId, persistModels, loadProviders])

  const selectModel = useCallback((m: string) => {
    onChange(m)
    setQuery('')
    setOpen(false)
  }, [onChange])

  const loadDiscoveredModels = useCallback(async (force = false) => {
    if (!supportsDiscovery) return
    if (!force && lastDiscoveryKeyRef.current === discoveryKey) return
    setDiscoveryState('loading')
    setDiscoveryMessage('')
    try {
      const result = await fetchProviderModelDiscovery({
        providerId,
        credentialId,
        endpoint: apiEndpoint,
        force,
      })
      lastDiscoveryKeyRef.current = discoveryKey
      setDiscoveryCached(result.cached)
      setDiscoveredModels(result.models)
      setDiscoveryState(result.ok ? 'ready' : 'notice')
      setDiscoveryMessage(result.message || '')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load live models.'
      setDiscoveryState('notice')
      setDiscoveryMessage(message)
    }
  }, [apiEndpoint, credentialId, discoveryKey, providerId, supportsDiscovery])

  const resetDiscoveryState = useEffectEvent(() => {
    lastDiscoveryKeyRef.current = null
    setDiscoveredModels([])
    setDiscoveryState('idle')
    setDiscoveryMessage('')
    setDiscoveryCached(false)
  })

  const syncDiscoveryOnOpen = useEffectEvent(() => {
    if (!open || !supportsDiscovery) return
    void loadDiscoveredModels()
  })

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    resetDiscoveryState()
  }, [providerId, credentialId, apiEndpoint])

  useEffect(() => {
    syncDiscoveryOnOpen()
  }, [open, supportsDiscovery, loadDiscoveredModels])

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`flex items-center ${className || ''}`}
        onClick={() => {
          setOpen(true)
          setTimeout(() => inputRef.current?.focus(), 0)
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={open ? query : value}
          onChange={(e) => {
            setQuery(e.target.value)
            if (!open) setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder={value || 'Select model…'}
          className="w-full bg-transparent outline-none text-inherit placeholder:text-text-3/50"
          style={{ fontFamily: 'inherit' }}
        />
        <svg className="w-4 h-4 text-text-3 shrink-0 ml-2" viewBox="0 0 16 16" fill="none">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-[240px] overflow-y-auto rounded-[12px] border border-white/[0.08] bg-surface-2 shadow-xl">
          {supportsDiscovery && (
            <div className="sticky top-0 z-[1] flex items-center justify-between gap-3 border-b border-white/[0.06] bg-surface-2/95 px-3 py-2 backdrop-blur">
              <div className={`min-w-0 text-[11px] ${discoveryState === 'notice' ? 'text-text-3/80' : 'text-text-3/60'}`}>
                {discoveryState === 'loading'
                  ? 'Checking live model catalog...'
                  : discoveryMessage || 'Type any model name or load the live catalog.'}
                {discoveryCached && discoveryState === 'ready' ? ' Cached.' : ''}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void loadDiscoveredModels(true)
                }}
                disabled={discoveryState === 'loading'}
                className="shrink-0 rounded-[7px] border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] font-600 text-text-3/80 transition-colors hover:bg-white/[0.06] hover:text-text disabled:cursor-default disabled:opacity-60"
              >
                {discoveryState === 'loading' ? 'Loading...' : discoveredModels.length > 0 ? 'Refresh' : 'Fetch live'}
              </button>
            </div>
          )}

          {filtered.map((m) => (
            <div
              key={m}
              onClick={() => selectModel(m)}
              className={`flex items-center justify-between px-3 py-2 text-[14px] cursor-pointer transition-colors hover:bg-white/[0.04] ${m === value ? 'text-accent-bright' : 'text-text'}`}
            >
              <span className="truncate">{m}</span>
              {isCustom(m) && (
                <button
                  onClick={(e) => removeModel(m, e)}
                  className="ml-2 p-0.5 rounded hover:bg-white/[0.08] text-text-3 hover:text-red-400 transition-colors shrink-0"
                  title="Remove custom model"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          ))}

          {showAdd && (
            <div
              onClick={() => addModel(trimmedQuery)}
              className="flex items-center gap-2 px-3 py-2 text-[14px] cursor-pointer transition-colors hover:bg-white/[0.04] text-accent-bright border-t border-white/[0.06]"
            >
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="truncate">Add &ldquo;{trimmedQuery}&rdquo;</span>
            </div>
          )}

          {filtered.length === 0 && !showAdd && (
            <div className="px-3 py-2 text-[14px] text-text-3">No models found</div>
          )}
        </div>
      )}
    </div>
  )
}
