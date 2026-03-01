'use client'

import { useAppStore } from '@/stores/use-app-store'
import { ModelCombobox } from '@/components/shared/model-combobox'
import type { SettingsSectionProps } from './types'

const NON_LANGGRAPH_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli'])

export function OrchestratorSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const providers = useAppStore((s) => s.providers)
  const credentials = useAppStore((s) => s.credentials)
  const credList = Object.values(credentials)

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
          {lgCredentials.length > 0 ? (
            <select
              value={appSettings.langGraphCredentialId || ''}
              onChange={(e) => patchSettings({ langGraphCredentialId: e.target.value || null })}
              className={`${inputClass} appearance-none cursor-pointer`}
              style={{ fontFamily: 'inherit' }}
            >
              <option value="">Select a key...</option>
              {lgCredentials.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          ) : (
            <p className="text-[12px] text-text-3/60">
              No {lgProvider} API keys configured. Add one below in the Providers section.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
