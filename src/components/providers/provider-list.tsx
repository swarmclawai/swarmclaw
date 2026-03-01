'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'

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

  useEffect(() => { void refresh() }, [refresh])
  useWs('providers', loadProviders, 20_000)

  const handleEdit = (id: string) => {
    setEditingProviderId(id)
    setProviderSheetOpen(true)
  }

  const handleToggle = async (e: React.MouseEvent, id: string, currentEnabled: boolean) => {
    e.stopPropagation()
    await api('PUT', `/providers/${id}`, { isEnabled: !currentEnabled })
    await loadProviderConfigs()
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('DELETE', `/providers/${id}`)
    await loadProviderConfigs()
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
      <div className={`flex-1 flex items-center justify-center ${inSidebar ? 'px-3 pb-4' : 'px-5'}`}>
        <p className="text-[13px] text-text-3">Loading providers...</p>
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
      <div className={inSidebar ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
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
                {!inSidebar && item.type === 'custom' && (
                  <>
                    <div
                      onClick={(e) => handleToggle(e, item.id, item.isEnabled)}
                      className={`w-9 h-5 rounded-full transition-all relative cursor-pointer shrink-0
                        ${item.isEnabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
                    >
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
                        ${item.isEnabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </div>
                    <button
                      onClick={(e) => handleDelete(e, item.id)}
                      className="text-text-3/40 hover:text-red-400 transition-colors p-0.5"
                      title="Delete provider"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </>
                )}
                <span className={`w-2 h-2 rounded-full ${item.isConnected ? 'bg-emerald-400' : 'bg-white/10'}`} />
              </div>
            </div>
            <div className="text-[12px] text-text-3/60 font-mono truncate">
              {!inSidebar ? item.models.join(', ') : (
                <>
                  {item.models.slice(0, 3).join(', ')}
                  {item.models.length > 3 && ` +${item.models.length - 3}`}
                </>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
