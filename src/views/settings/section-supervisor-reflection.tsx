import {
  DEFAULT_REFLECTION_AUTO_WRITE_MEMORY,
  DEFAULT_REFLECTION_ENABLED,
  DEFAULT_SUPERVISOR_ENABLED,
  DEFAULT_SUPERVISOR_NO_PROGRESS_LIMIT,
  DEFAULT_SUPERVISOR_REPEATED_TOOL_LIMIT,
  DEFAULT_SUPERVISOR_RUNTIME_SCOPE,
  SUPERVISOR_NO_PROGRESS_LIMIT_MAX,
  SUPERVISOR_NO_PROGRESS_LIMIT_MIN,
  SUPERVISOR_REPEATED_TOOL_LIMIT_MAX,
  SUPERVISOR_REPEATED_TOOL_LIMIT_MIN,
  type AutonomyRuntimeScope,
} from '@/lib/autonomy/supervisor-settings'
import type { SettingsSectionProps } from './types'

const SCOPE_OPTIONS: Array<{ id: AutonomyRuntimeScope; label: string; help: string }> = [
  { id: 'both', label: 'Chats + Tasks', help: 'Watch direct chat runs and task executions.' },
  { id: 'chat', label: 'Chats Only', help: 'Apply supervisor recovery and reflections to chat runs only.' },
  { id: 'task', label: 'Tasks Only', help: 'Apply supervisor recovery and reflections to task runs only.' },
]

function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function SupervisorReflectionSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const supervisorEnabled = appSettings.supervisorEnabled ?? DEFAULT_SUPERVISOR_ENABLED
  const reflectionEnabled = appSettings.reflectionEnabled ?? DEFAULT_REFLECTION_ENABLED
  const reflectionAutoWriteMemory = appSettings.reflectionAutoWriteMemory ?? DEFAULT_REFLECTION_AUTO_WRITE_MEMORY
  const runtimeScope = appSettings.supervisorRuntimeScope ?? DEFAULT_SUPERVISOR_RUNTIME_SCOPE
  const noProgressLimit = appSettings.supervisorNoProgressLimit ?? DEFAULT_SUPERVISOR_NO_PROGRESS_LIMIT
  const repeatedToolLimit = appSettings.supervisorRepeatedToolLimit ?? DEFAULT_SUPERVISOR_REPEATED_TOOL_LIMIT

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Supervisor &amp; Reflection
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Let SwarmClaw recover from bad loops automatically and write reflection memory after meaningful runs.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Automatic Recovery</label>
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={() => patchSettings({ supervisorEnabled: !supervisorEnabled })}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${supervisorEnabled ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${supervisorEnabled ? 'translate-x-[18px]' : ''}`} />
          </button>
          <div>
            <div className="text-[12px] text-text-2">Enable the supervisor loop</div>
            <div className="text-[11px] text-text-3/60 mt-1">Detect repeated tool use, no-progress loops, context pressure, and hard budget pressure.</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-5">
          {SCOPE_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => patchSettings({ supervisorRuntimeScope: option.id })}
              className={`rounded-[12px] border px-3 py-3 text-left transition-colors ${
                runtimeScope === option.id
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'
              }`}
            >
              <div className="text-[13px] font-600">{option.label}</div>
              <div className="text-[11px] text-text-3/70 mt-1">{option.help}</div>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">No-Progress Limit</label>
            <input
              type="number"
              min={SUPERVISOR_NO_PROGRESS_LIMIT_MIN}
              max={SUPERVISOR_NO_PROGRESS_LIMIT_MAX}
              value={noProgressLimit}
              onChange={(e) => patchSettings({
                supervisorNoProgressLimit: clampNumber(
                  e.target.value,
                  DEFAULT_SUPERVISOR_NO_PROGRESS_LIMIT,
                  SUPERVISOR_NO_PROGRESS_LIMIT_MIN,
                  SUPERVISOR_NO_PROGRESS_LIMIT_MAX,
                ),
              })}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">How many autonomous follow-ups can stall before the supervisor forces a recovery step.</p>
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Repeated Tool Limit</label>
            <input
              type="number"
              min={SUPERVISOR_REPEATED_TOOL_LIMIT_MIN}
              max={SUPERVISOR_REPEATED_TOOL_LIMIT_MAX}
              value={repeatedToolLimit}
              onChange={(e) => patchSettings({
                supervisorRepeatedToolLimit: clampNumber(
                  e.target.value,
                  DEFAULT_SUPERVISOR_REPEATED_TOOL_LIMIT,
                  SUPERVISOR_REPEATED_TOOL_LIMIT_MIN,
                  SUPERVISOR_REPEATED_TOOL_LIMIT_MAX,
                ),
              })}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">How many times the same tool can fire in one run before the supervisor intervenes.</p>
          </div>
        </div>

        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Automatic Learning</label>
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => patchSettings({ reflectionEnabled: !reflectionEnabled })}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${reflectionEnabled ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${reflectionEnabled ? 'translate-x-[18px]' : ''}`} />
          </button>
          <div>
            <div className="text-[12px] text-text-2">Generate reflections after meaningful runs</div>
            <div className="text-[11px] text-text-3/60 mt-1">Distill stable invariants, short-lived heuristics, failures, and reusable lessons.</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => patchSettings({ reflectionAutoWriteMemory: !reflectionAutoWriteMemory })}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${reflectionAutoWriteMemory ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${reflectionAutoWriteMemory ? 'translate-x-[18px]' : ''}`} />
          </button>
          <div>
            <div className="text-[12px] text-text-2">Auto-write reflection memory</div>
            <div className="text-[11px] text-text-3/60 mt-1">Write low-risk reflection memory automatically so later runs can retrieve it without review.</div>
          </div>
        </div>
      </div>
    </div>
  )
}
