'use client'

import {
  DEFAULT_AGENT_LOOP_RECURSION_LIMIT,
  DEFAULT_CLAUDE_CODE_TIMEOUT_SEC,
  DEFAULT_CLI_PROCESS_TIMEOUT_SEC,
  DEFAULT_DELEGATION_MAX_DEPTH,
  DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS,
  DEFAULT_ONGOING_LOOP_MAX_ITERATIONS,
  DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES,
  DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT,
  DEFAULT_SHELL_COMMAND_TIMEOUT_SEC,
  DEFAULT_STREAM_IDLE_STALL_SEC,
  DEFAULT_REQUIRED_TOOL_KICKOFF_SEC,
} from '@/lib/runtime/runtime-loop'
import type { LoopMode } from '@/types'
import type { SettingsSectionProps } from './types'
import { HintTip } from '@/components/shared/hint-tip'

export function RuntimeLoopSection({ appSettings, patchSettings, inputClass }: SettingsSectionProps) {
  const loopMode: LoopMode = appSettings.loopMode === 'ongoing' ? 'ongoing' : 'bounded'

  return (
    <div className="mb-10">
      <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
        Runtime &amp; Loop Controls
      </h3>
      <p className="text-[12px] text-text-3 mb-5">
        Control how far agents can run on their own and set safety guards for delegation and tool execution.
      </p>
      <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Background Daemon</label>
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => patchSettings({ daemonAutostartEnabled: !(appSettings.daemonAutostartEnabled ?? true) })}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.daemonAutostartEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.daemonAutostartEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
          </button>
          <div>
            <div className="text-[12px] text-text-2">Start the daemon automatically when the app boots</div>
            <div className="text-[11px] text-text-3/60 mt-1">Enabled by default. This controls scheduler, queue processing, connector recovery, and other background runtime work.</div>
          </div>
        </div>

        <label className="flex items-center gap-1.5 font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Loop Mode <HintTip text="Bounded = fixed max steps. Ongoing = runs until the task completes (with a safety cap)" /></label>
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
              <label className="flex items-center gap-1.5 font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Agent Steps <HintTip text="Maximum actions an agent can take before stopping — prevents infinite loops" /></label>
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
            <label className="flex items-center gap-1.5 font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Coordination Steps <HintTip text="Maximum tool calls an agent can make while coordinating multiple delegated agents" /></label>
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
            <label className="flex items-center gap-1.5 font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Legacy Turns <HintTip text="Compatibility limit for older coordination flows that still rely on turn-based execution" /></label>
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <div>
            <label className="flex items-center gap-1.5 font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Delegation Depth <HintTip text="Maximum delegation chain depth for delegate_to_agent and spawn_subagent to prevent runaway fan-out" /></label>
            <input
              type="number"
              min={1}
              max={12}
              value={appSettings.delegationMaxDepth ?? DEFAULT_DELEGATION_MAX_DEPTH}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ delegationMaxDepth: Number.isFinite(n) ? n : DEFAULT_DELEGATION_MAX_DEPTH })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>

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

        <label className="flex items-center gap-1.5 font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mt-5 mb-3">Stream &amp; Kickoff Timeouts (Seconds) <HintTip text="Controls how long to wait for model output and required tool usage before aborting a turn" /></label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-text-3 mb-2">Idle Stall Timeout</label>
            <input
              type="number"
              min={30}
              max={600}
              value={appSettings.streamIdleStallSec ?? DEFAULT_STREAM_IDLE_STALL_SEC}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ streamIdleStallSec: Number.isFinite(n) ? n : DEFAULT_STREAM_IDLE_STALL_SEC })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Aborts a turn if no tokens arrive for this long. Raise for slow local models.</p>
          </div>
          <div>
            <label className="block text-[11px] text-text-3 mb-2">Required Tool Kickoff</label>
            <input
              type="number"
              min={10}
              max={120}
              value={appSettings.requiredToolKickoffSec ?? DEFAULT_REQUIRED_TOOL_KICKOFF_SEC}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ requiredToolKickoffSec: Number.isFinite(n) ? n : DEFAULT_REQUIRED_TOOL_KICKOFF_SEC })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <p className="text-[11px] text-text-3/60 mt-2">Max wait for a required tool call before forcing a continuation.</p>
          </div>
        </div>

        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mt-6 mb-3">LLM Response Cache</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <div className="md:col-span-3 flex items-center gap-3">
            <button
              onClick={() => patchSettings({ responseCacheEnabled: !(appSettings.responseCacheEnabled ?? true) })}
              className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.responseCacheEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
            >
              <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.responseCacheEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
            </button>
            <span className="text-[12px] text-text-2">Enable deterministic cache (TTL + LRU) for non-tool model responses</span>
          </div>
          <div>
            <label className="block text-[11px] text-text-3 mb-2">TTL (seconds)</label>
            <input
              type="number"
              min={5}
              max={604800}
              value={appSettings.responseCacheTtlSec ?? 900}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ responseCacheTtlSec: Number.isFinite(n) ? n : 900 })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-3 mb-2">Max Entries</label>
            <input
              type="number"
              min={1}
              max={20000}
              value={appSettings.responseCacheMaxEntries ?? 500}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ responseCacheMaxEntries: Number.isFinite(n) ? n : 500 })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>

        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Task Quality Gate Defaults</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <div className="md:col-span-3 flex items-center gap-3">
            <button
              onClick={() => patchSettings({ taskQualityGateEnabled: !(appSettings.taskQualityGateEnabled ?? true) })}
              className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.taskQualityGateEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
            >
              <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.taskQualityGateEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
            </button>
            <span className="text-[12px] text-text-2">Enable quality gate checks before tasks can be marked complete</span>
          </div>
          <div>
            <label className="block text-[11px] text-text-3 mb-2">Min Result Chars</label>
            <input
              type="number"
              min={10}
              max={2000}
              value={appSettings.taskQualityGateMinResultChars ?? 80}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ taskQualityGateMinResultChars: Number.isFinite(n) ? n : 80 })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-3 mb-2">Min Evidence Signals</label>
            <input
              type="number"
              min={0}
              max={8}
              value={appSettings.taskQualityGateMinEvidenceItems ?? 2}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                patchSettings({ taskQualityGateMinEvidenceItems: Number.isFinite(n) ? n : 2 })
              }}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-2">
            <label className="flex items-center gap-2 text-[12px] text-text-2">
              <input
                type="checkbox"
                checked={appSettings.taskQualityGateRequireVerification ?? false}
                onChange={(e) => patchSettings({ taskQualityGateRequireVerification: e.target.checked })}
              />
              Require verification evidence
            </label>
            <label className="flex items-center gap-2 text-[12px] text-text-2">
              <input
                type="checkbox"
                checked={appSettings.taskQualityGateRequireArtifact ?? false}
                onChange={(e) => patchSettings({ taskQualityGateRequireArtifact: e.target.checked })}
              />
              Require artifact evidence
            </label>
            <label className="flex items-center gap-2 text-[12px] text-text-2">
              <input
                type="checkbox"
                checked={appSettings.taskQualityGateRequireReport ?? false}
                onChange={(e) => patchSettings({ taskQualityGateRequireReport: e.target.checked })}
              />
              Require task report
            </label>
          </div>
        </div>

        <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Integrity Monitor</label>
        <div className="flex items-center gap-3">
          <button
            onClick={() => patchSettings({ integrityMonitorEnabled: !(appSettings.integrityMonitorEnabled ?? true) })}
            className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 cursor-pointer ${(appSettings.integrityMonitorEnabled ?? true) ? 'bg-accent' : 'bg-white/[0.12]'}`}
          >
            <span className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${(appSettings.integrityMonitorEnabled ?? true) ? 'translate-x-[18px]' : ''}`} />
          </button>
          <span className="text-[12px] text-text-2">
            Watch critical identity/config files for drift and raise alerts.
          </span>
        </div>
      </div>
    </div>
  )
}
