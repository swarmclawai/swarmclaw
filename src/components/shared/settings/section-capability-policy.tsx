'use client'

import type { ApprovalCategory } from '@/types'
import type { SettingsSectionProps } from './types'

const APPROVAL_CATEGORY_OPTIONS: Array<{ id: ApprovalCategory; label: string; description: string }> = [
  { id: 'tool_access', label: 'Plugin Access', description: 'Auto-enable requested plugins for a chat.' },
  { id: 'plugin_scaffold', label: 'Plugin Scaffold', description: 'Auto-create plugin files requested by agents.' },
  { id: 'plugin_install', label: 'Plugin Install', description: 'Auto-install plugins from approved URLs.' },
  { id: 'human_loop', label: 'Human Approval Requests', description: 'Auto-approve ask-human approval prompts.' },
  { id: 'wallet_transfer', label: 'Wallet Transfers', description: 'Auto-approve wallet send requests. High risk.' },
  { id: 'task_tool', label: 'Task Tool Calls', description: 'Reserved for task-level approval flows.' },
]

export function CapabilityPolicySection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const autoApproved = new Set(appSettings.approvalAutoApproveCategories || [])

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Capability Policy
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Centralized guardrails for agent plugin families. Applies to direct plugin calls and forced auto-routing.
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
                <div className="text-[12px] font-600 text-text-2">Platform Approvals</div>
                <p className="text-[11px] text-text-3/60 mt-1 leading-relaxed">
                  Turn this off to auto-approve every approval request across the platform for maximum autonomy. Audit records are still kept.
                </p>
              </div>
              <button
                onClick={() => patchSettings({ approvalsEnabled: !(appSettings.approvalsEnabled ?? true) })}
                className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.approvalsEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
                aria-label="Toggle platform approvals"
              >
                <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.approvalsEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
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

          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Auto-Approve Workflow Requests</label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {APPROVAL_CATEGORY_OPTIONS.map((option) => {
                const checked = autoApproved.has(option.id)
                return (
                  <label
                    key={option.id}
                    className={`rounded-[12px] border px-3 py-3 cursor-pointer transition-all ${
                      checked
                        ? 'border-accent-bright/30 bg-accent-soft/60'
                        : 'border-white/[0.06] bg-bg hover:bg-surface-2'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = new Set(appSettings.approvalAutoApproveCategories || [])
                          if (e.target.checked) next.add(option.id)
                          else next.delete(option.id)
                          patchSettings({ approvalAutoApproveCategories: [...next] })
                        }}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-[12px] font-600 text-text-2">{option.label}</div>
                        <p className="text-[11px] text-text-3/60 mt-1 leading-relaxed">{option.description}</p>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
            <p className="text-[11px] text-text-3/60 mt-2">
              Auto-approved categories execute immediately instead of waiting in the Approvals queue. Leave high-risk categories off unless the user explicitly wants fully autonomous execution.
            </p>
          </div>

          <div className="rounded-[12px] border border-white/[0.06] bg-bg px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[12px] font-600 text-text-2">Connector Approval Reminders</div>
                <p className="text-[11px] text-text-3/60 mt-1 leading-relaxed">
                  If an approval sits too long, let the agent send a one-time reminder over an active connector conversation it already has access to.
                </p>
              </div>
              <button
                onClick={() => patchSettings({ approvalConnectorNotifyEnabled: !(appSettings.approvalConnectorNotifyEnabled ?? true) })}
                className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.approvalConnectorNotifyEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
                aria-label="Toggle connector approval reminders"
              >
                <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.approvalConnectorNotifyEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
              </button>
            </div>
            <div className="mt-4 max-w-[220px]">
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Reminder Delay (Sec)</label>
              <input
                type="number"
                min={30}
                max={86400}
                value={appSettings.approvalConnectorNotifyDelaySec ?? 300}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value, 10)
                  patchSettings({
                    approvalConnectorNotifyDelaySec: Number.isFinite(next) ? Math.max(30, Math.min(86400, next)) : 300,
                  })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
