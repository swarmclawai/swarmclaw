'use client'

import {
  DEFAULT_AGENT_LOOP_RECURSION_LIMIT,
  DEFAULT_CLAUDE_CODE_TIMEOUT_SEC,
  DEFAULT_CLI_PROCESS_TIMEOUT_SEC,
  DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS,
  DEFAULT_ONGOING_LOOP_MAX_ITERATIONS,
  DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES,
  DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT,
  DEFAULT_SHELL_COMMAND_TIMEOUT_SEC,
} from '@/lib/runtime-loop'
import type { LoopMode } from '@/types'
import type { SettingsSectionProps } from './types'

export function RuntimeLoopSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const loopMode: LoopMode = appSettings.loopMode === 'ongoing' ? 'ongoing' : 'bounded'

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Runtime &amp; Loop Controls
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Choose bounded or ongoing agent loops and set safety guards for task execution.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Loop Mode</label>
        <div className="grid grid-cols-2 gap-2 mb-5">
          {([
            { id: 'bounded' as const, name: 'Bounded' },
            { id: 'ongoing' as const, name: 'Ongoing' },
          ]).map((mode) => (
            <button
              key={mode.id}
              onClick={() => patchSettings({ loopMode: mode.id })}
              className={`py-3 px-3 rounded-[12px] text-center cursor-pointer transition-all text-[13px] font-600 border
                ${loopMode === mode.id
                  ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                  : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {mode.name}
            </button>
          ))}
        </div>

        {loopMode === 'bounded' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Agent Steps</label>
              <input
                type="number"
                min={1}
                max={200}
                value={appSettings.agentLoopRecursionLimit ?? DEFAULT_AGENT_LOOP_RECURSION_LIMIT}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  patchSettings({ agentLoopRecursionLimit: Number.isFinite(n) ? n : DEFAULT_AGENT_LOOP_RECURSION_LIMIT })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Orchestrator Steps</label>
              <input
                type="number"
                min={1}
                max={300}
                value={appSettings.orchestratorLoopRecursionLimit ?? DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  patchSettings({ orchestratorLoopRecursionLimit: Number.isFinite(n) ? n : DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Legacy Turns</label>
              <input
                type="number"
                min={1}
                max={300}
                value={appSettings.legacyOrchestratorMaxTurns ?? DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  patchSettings({ legacyOrchestratorMaxTurns: Number.isFinite(n) ? n : DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Max Steps (Safety Cap)</label>
              <input
                type="number"
                min={10}
                max={5000}
                value={appSettings.ongoingLoopMaxIterations ?? DEFAULT_ONGOING_LOOP_MAX_ITERATIONS}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  patchSettings({ ongoingLoopMaxIterations: Number.isFinite(n) ? n : DEFAULT_ONGOING_LOOP_MAX_ITERATIONS })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Max Runtime (Minutes)</label>
              <input
                type="number"
                min={0}
                max={1440}
                value={appSettings.ongoingLoopMaxRuntimeMinutes ?? DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  patchSettings({ ongoingLoopMaxRuntimeMinutes: Number.isFinite(n) ? n : DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-2">Set to 0 to disable the runtime guard.</p>
            </div>
          </div>
        )}

        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Execution Timeouts (Seconds)</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] text-text-3 mb-2">Shell</label>
            <input
              type="number"
              min={1}
              max={600}
              value={appSettings.shellCommandTimeoutSec ?? DEFAULT_SHELL_COMMAND_TIMEOUT_SEC}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ shellCommandTimeoutSec: Number.isFinite(n) ? n : DEFAULT_SHELL_COMMAND_TIMEOUT_SEC })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-3 mb-2">Claude Code Tool</label>
            <input
              type="number"
              min={5}
              max={7200}
              value={appSettings.claudeCodeTimeoutSec ?? DEFAULT_CLAUDE_CODE_TIMEOUT_SEC}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ claudeCodeTimeoutSec: Number.isFinite(n) ? n : DEFAULT_CLAUDE_CODE_TIMEOUT_SEC })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-3 mb-2">CLI Provider Process</label>
            <input
              type="number"
              min={10}
              max={7200}
              value={appSettings.cliProcessTimeoutSec ?? DEFAULT_CLI_PROCESS_TIMEOUT_SEC}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ cliProcessTimeoutSec: Number.isFinite(n) ? n : DEFAULT_CLI_PROCESS_TIMEOUT_SEC })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
