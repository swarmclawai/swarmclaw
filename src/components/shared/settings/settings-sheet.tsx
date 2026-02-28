'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '../bottom-sheet'
import { inputClass } from './utils'
import { UserPreferencesSection } from './section-user-preferences'
import { OrchestratorSection } from './section-orchestrator'
import { RuntimeLoopSection } from './section-runtime-loop'
import { CapabilityPolicySection } from './section-capability-policy'
import { VoiceSection } from './section-voice'
import { HeartbeatSection } from './section-heartbeat'
import { EmbeddingSection } from './section-embedding'
import { MemorySection } from './section-memory'
import { SecretsSection } from './section-secrets'
import { ProvidersSection } from './section-providers'
import { PluginManager } from './plugin-manager'

export function SettingsSheet() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const loadSecrets = useAppStore((s) => s.loadSecrets)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const credentials = useAppStore((s) => s.credentials)

  useEffect(() => {
    if (open) {
      loadProviders()
      loadCredentials()
      loadSettings()
      loadSecrets()
      loadAgents()
    }
  }, [open])

  const credList = Object.values(credentials)
  const patchSettings = updateSettings

  return (
    <BottomSheet open={open} onClose={() => setOpen(false)} wide>
      {/* Header */}
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">Settings</h2>
        <p className="text-[14px] text-text-3">Manage providers, API keys & orchestrator engine</p>
      </div>

      <UserPreferencesSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <OrchestratorSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <RuntimeLoopSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <CapabilityPolicySection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <VoiceSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <HeartbeatSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <EmbeddingSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} credList={credList} />
      <MemorySection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <SecretsSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />
      <ProvidersSection appSettings={appSettings} patchSettings={patchSettings} inputClass={inputClass} />

      {/* Plugins */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Plugins
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Extend agent behavior with hooks. Install from the marketplace, a URL, or drop .js files into <code className="text-[11px] font-mono text-text-2">data/plugins/</code>.
          <span className="text-text-3/70 ml-1">OpenClaw plugins are also supported.</span>
        </p>
        <PluginManager />
      </div>

      {/* Done */}
      <div className="pt-2 border-t border-white/[0.04]">
        <button
          onClick={() => setOpen(false)}
          className="w-full py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer
            hover:bg-surface-2 transition-all duration-200"
          style={{ fontFamily: 'inherit' }}
        >
          Done
        </button>
      </div>
    </BottomSheet>
  )
}
