'use client'

import type { SettingsSectionProps } from './types'

export function CapabilityPolicySection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Capability Policy
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Centralized guardrails for agent plugin families and platform features. SwarmClaw now relies on direct capability policy and explicit feature gates rather than a workflow approval queue.
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[12px] font-600 text-text-2">Task Management</div>
                  <p className="text-[11px] text-text-3/60 mt-1 leading-relaxed">
                    Controls the task board and agent access to durable backlog tracking. Internal queue execution still works underneath.
                  </p>
                </div>
                <button
                  onClick={() => patchSettings({ taskManagementEnabled: !(appSettings.taskManagementEnabled ?? true) })}
                  className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.taskManagementEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
                  aria-label="Toggle task management"
                >
                  <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.taskManagementEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
                </button>
              </div>
            </div>

            <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[12px] font-600 text-text-2">Project Management</div>
                  <p className="text-[11px] text-text-3/60 mt-1 leading-relaxed">
                    Controls the project operating-system UI and agent access to durable project context for objectives, credentials, and heartbeat plans.
                  </p>
                </div>
                <button
                  onClick={() => patchSettings({ projectManagementEnabled: !(appSettings.projectManagementEnabled ?? true) })}
                  className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.projectManagementEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
                  aria-label="Toggle project management"
                >
                  <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.projectManagementEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[12px] font-600 text-text-2">Outbound Connector Confirmation</div>
                <p className="text-[11px] text-text-3/60 mt-1 leading-relaxed">
                  Require connector sends to pass an explicit `approved=true` confirmation boundary. This is a direct feature gate, not an approvals queue.
                </p>
              </div>
              <button
                onClick={() => patchSettings({ safetyRequireApprovalForOutbound: !(appSettings.safetyRequireApprovalForOutbound ?? false) })}
                className={`inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border border-white/[0.08] p-[3px] transition-colors duration-200 cursor-pointer ${
                  (appSettings.safetyRequireApprovalForOutbound ?? false) ? 'justify-end bg-accent' : 'justify-start bg-white/[0.16]'
                }`}
                aria-label="Toggle outbound connector confirmation"
              >
                <span className="h-4 w-4 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.35)]" />
              </button>
            </div>
          </div>

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
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Blocked Plugins</label>
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
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Allowed Plugins (Override)</label>
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
