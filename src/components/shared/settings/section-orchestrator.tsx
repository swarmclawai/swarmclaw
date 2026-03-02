'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'
import toast from 'react-hot-toast'
import { ModelCombobox } from '@/components/shared/model-combobox'
import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
import type { SettingsSectionProps } from './types'

export function OrchestratorSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const providers = useAppStore((s) => s.providers)
  const credentials = useAppStore((s) => s.credentials)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const credList = Object.values(credentials)
  const [addingKey, setAddingKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  const lgProviders = providers.filter((p) => !NON_LANGGRAPH_PROVIDER_IDS.has(String(p.id)))
  const hasConfiguredLgProvider = !!appSettings.langGraphProvider && lgProviders.some((p) => p.id === appSettings.langGraphProvider)
  const lgProvider = hasConfiguredLgProvider ? appSettings.langGraphProvider! : (lgProviders[0]?.id || 'anthropic')
  const lgProviderInfo = lgProviders.find((p) => p.id === lgProvider) || providers.find((p) => p.id === lgProvider)
  const lgCredentials = credList.filter((c) => c.provider === lgProvider)

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Orchestrator Engine
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        The LLM provider used by orchestrators for tool calling, agent generation, and task delegation.
      </p>

      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        {/* Provider picker */}
        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Provider</label>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-5">
          {lgProviders.map((p) => (
            <button
              key={p.id}
              onClick={() => patchSettings({ langGraphProvider: p.id, langGraphModel: '', langGraphCredentialId: null, langGraphEndpoint: null })}
              className={`py-3 px-3 rounded-[12px] text-center cursor-pointer transition-all text-[13px] font-600 border
                ${lgProvider === p.id
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {p.name}
            </button>
          ))}
        </div>
        {lgProviders.length === 0 && (
          <p className="text-[12px] text-text-3/60 mb-5">
            No orchestration-compatible providers available. Add an API provider in Providers.
          </p>
        )}

        {/* Model picker */}
        {lgProviderInfo && lgProviderInfo.models.length > 0 && (
          <div className="mb-5">
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
            <ModelCombobox
              providerId={lgProviderInfo.id}
              value={appSettings.langGraphModel || lgProviderInfo.models[0]}
              onChange={(m) => patchSettings({ langGraphModel: m })}
              models={lgProviderInfo.models}
              defaultModels={lgProviderInfo.defaultModels}
              className={`${inputClass} cursor-pointer`}
            />
          </div>
        )}

        {(lgProviderInfo?.requiresEndpoint || !!appSettings.langGraphEndpoint) && (
          <div className="mb-5">
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Endpoint Override</label>
            <input
              type="text"
              value={appSettings.langGraphEndpoint || ''}
              onChange={(e) => patchSettings({ langGraphEndpoint: e.target.value || null })}
              placeholder={lgProviderInfo?.defaultEndpoint || 'https://api.example.com/v1'}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Leave empty to use the provider default endpoint.</p>
          </div>
        )}

        {/* API Key picker */}
        <div>
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">API Key</label>
          {lgCredentials.length > 0 && !addingKey ? (
            <div className="flex gap-2 items-center">
              <select
                value={appSettings.langGraphCredentialId || ''}
                onChange={(e) => patchSettings({ langGraphCredentialId: e.target.value || null })}
                className={`${inputClass} appearance-none cursor-pointer flex-1`}
                style={{ fontFamily: 'inherit' }}
              >
                <option value="">Select a key...</option>
                {lgCredentials.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button type="button" onClick={() => setAddingKey(true)} className="text-accent-bright text-[11px] font-600 cursor-pointer bg-transparent border-none hover:brightness-110 transition-all" style={{ fontFamily: 'inherit' }}>+ New</button>
            </div>
          ) : (
            <div className="space-y-2">
              <input type="text" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="Key name (optional)" className={inputClass} style={{ fontFamily: 'inherit' }} />
              <input type="password" value={newKeyValue} onChange={e => setNewKeyValue(e.target.value)} placeholder="sk-..." className={inputClass} style={{ fontFamily: 'inherit' }} />
              <div className="flex gap-2">
                <button type="button" disabled={savingKey || !newKeyValue.trim()} onClick={async () => {
                  setSavingKey(true)
                  try {
                    const cred = await api<{ id: string }>('POST', '/credentials', { provider: lgProvider, name: newKeyName.trim() || `${lgProvider} key`, apiKey: newKeyValue.trim() })
                    await loadCredentials()
                    patchSettings({ langGraphCredentialId: cred.id })
                    setAddingKey(false)
                    setNewKeyName('')
                    setNewKeyValue('')
                  } catch (err: unknown) { toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`) }
                  finally { setSavingKey(false) }
                }} className="px-4 py-1.5 rounded-[8px] bg-accent-bright text-white text-[12px] font-600 cursor-pointer border-none hover:brightness-110 transition-all disabled:opacity-40" style={{ fontFamily: 'inherit' }}>
                  {savingKey ? 'Saving...' : 'Save Key'}
                </button>
                {lgCredentials.length > 0 && (
                  <button type="button" onClick={() => { setAddingKey(false); setNewKeyName(''); setNewKeyValue('') }} className="px-4 py-1.5 rounded-[8px] bg-surface-2 text-text-2 text-[12px] font-600 cursor-pointer border-none hover:bg-surface-3 transition-all" style={{ fontFamily: 'inherit' }}>Cancel</button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
