'use client'

import type { SettingsSectionProps } from './types'

export function CapabilityPolicySection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Capability Policy
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Centralized guardrails for agent tool families. Applies to direct tool calls and forced auto-routing.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Policy Mode</label>
        <div className="grid grid-cols-3 gap-2 mb-5">
          {([
            { id: 'permissive', name: 'Permissive' },
            { id: 'balanced', name: 'Balanced' },
            { id: 'strict', name: 'Strict' },
          ] as const).map((mode) => (
            <button
              key={mode.id}
              onClick={() => patchSettings({ capabilityPolicyMode: mode.id })}
              className={`py-3 px-3 rounded-[12px] text-center cursor-pointer transition-all text-[13px] font-600 border
                ${(appSettings.capabilityPolicyMode || 'permissive') === mode.id
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {mode.name}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Blocked Categories</label>
            <input
              type="text"
              value={(appSettings.capabilityBlockedCategories || []).join(', ')}
              onChange={(e) => patchSettings({
                capabilityBlockedCategories: e.target.value
                  .split(',')
                  .map((part) => part.trim())
                  .filter(Boolean),
              })}
              placeholder="execution, filesystem, platform, outbound"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Supported categories: filesystem, execution, network, browser, memory, delegation, platform, outbound.</p>
          </div>

          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Blocked Tools</label>
            <input
              type="text"
              value={(appSettings.capabilityBlockedTools || []).join(', ')}
              onChange={(e) => patchSettings({
                capabilityBlockedTools: e.target.value
                  .split(',')
                  .map((part) => part.trim())
                  .filter(Boolean),
              })}
              placeholder="delete_file, manage_connectors, delegate_to_codex_cli"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>

          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Allowed Tools (Override)</label>
            <input
              type="text"
              value={(appSettings.capabilityAllowedTools || []).join(', ')}
              onChange={(e) => patchSettings({
                capabilityAllowedTools: e.target.value
                  .split(',')
                  .map((part) => part.trim())
                  .filter(Boolean),
              })}
              placeholder="shell, web_fetch, browser"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Use this to re-allow specific tool families when running in strict mode.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
