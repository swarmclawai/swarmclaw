'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'

export function ProviderList({ inSidebar }: { inSidebar?: boolean }) {
  const providers = useAppStore((s) => s.providers)
  const providerConfigs = useAppStore((s) => s.providerConfigs)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const loadProviderConfigs = useAppStore((s) => s.loadProviderConfigs)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const setProviderSheetOpen = useAppStore((s) => s.setProviderSheetOpen)
  const setEditingProviderId = useAppStore((s) => s.setEditingProviderId)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    await Promise.all([loadProviders(), loadProviderConfigs(), loadCredentials()])
    setLoaded(true)
  }, [loadProviders, loadProviderConfigs, loadCredentials])

  useEffect(() => {
    const bootstrap = setTimeout(() => { void refresh() }, 0)
    const poll = setInterval(() => { void loadProviders() }, 20_000)
    return () => {
      clearTimeout(bootstrap)
      clearInterval(poll)
    }
  }, [refresh, loadProviders])

  const handleEdit = (id: string) => {
    setEditingProviderId(id)
    setProviderSheetOpen(true)
  }

  // Merge built-in providers with custom configs
  const builtinItems = providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: 'builtin' as const,
    models: p.models,
    requiresApiKey: p.requiresApiKey,
    isEnabled: true,
    isConnected: !p.requiresApiKey || Object.values(credentials).some((c) => c.provider === p.id),
  }))

  const customItems = providerConfigs.map((c) => ({
    id: c.id,
    name: c.name,
    type: 'custom' as const,
    models: c.models,
    requiresApiKey: c.requiresApiKey,
    isEnabled: c.isEnabled,
    isConnected: !c.requiresApiKey || !!c.credentialId,
  }))

  const allItems = [...builtinItems, ...customItems]

  if (!loaded) {
    return (
      <div className={`flex-1 flex items-center justify-center ${inSidebar ? 'px-3 pb-4' : 'px-4'}`}>
        <p className="text-[13px] text-text-3">Loading providers...</p>
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-4'}`}>
      <div className="space-y-2">
        {allItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleEdit(item.id)}
            className="w-full text-left p-4 rounded-[14px] border transition-all duration-200
              cursor-pointer hover:bg-surface-2 bg-surface border-white/[0.06]"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-display text-[14px] font-600 text-text truncate">{item.name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[10px] font-600 px-2 py-0.5 rounded-[5px] uppercase tracking-wider
                  ${item.type === 'builtin' ? 'bg-white/[0.04] text-text-3' : 'bg-[#6366F1]/10 text-[#6366F1]'}`}>
                  {item.type === 'builtin' ? 'Built-in' : 'Custom'}
                </span>
                <span className={`w-2 h-2 rounded-full ${item.isConnected ? 'bg-emerald-400' : 'bg-white/10'}`} />
              </div>
            </div>
            <div className="text-[12px] text-text-3/60 font-mono truncate">
              {item.models.slice(0, 3).join(', ')}
              {item.models.length > 3 && ` +${item.models.length - 3}`}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
