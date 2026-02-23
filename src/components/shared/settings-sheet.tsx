'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { createCredential, deleteCredential } from '@/lib/sessions'
import { BottomSheet } from './bottom-sheet'
import { api } from '@/lib/api-client'
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
import type { ProviderType, LoopMode, PluginMeta, MarketplacePlugin } from '@/types'

const NON_LANGGRAPH_PROVIDER_IDS = new Set(['claude-cli', 'codex-cli', 'opencode-cli'])

export function SettingsSheet() {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const providers = useAppStore((s) => s.providers)
  const credentials = useAppStore((s) => s.credentials)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const loadCredentials = useAppStore((s) => s.loadCredentials)
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const secrets = useAppStore((s) => s.secrets)
  const loadSecrets = useAppStore((s) => s.loadSecrets)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadSessions = useAppStore((s) => s.loadSessions)

  const [addProvider, setAddProvider] = useState<ProviderType | null>(null)
  const [newName, setNewName] = useState('')
  const [newKey, setNewKey] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)

  // Secrets form state
  const [addingSecret, setAddingSecret] = useState(false)
  const [secretName, setSecretName] = useState('')
  const [secretService, setSecretService] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [secretScope, setSecretScope] = useState<'global' | 'agent'>('global')
  const [secretAgentIds, setSecretAgentIds] = useState<string[]>([])
  const [deletingSecret, setDeletingSecret] = useState<string | null>(null)
  const [disablingHeartbeats, setDisablingHeartbeats] = useState(false)
  const [heartbeatBulkNotice, setHeartbeatBulkNotice] = useState('')

  useEffect(() => {
    if (open) {
      loadProviders()
      loadCredentials()
      loadSettings()
      loadSecrets()
      loadAgents()
      setAddProvider(null)
      setNewName('')
      setNewKey('')
      setDeleting(null)
      setAddingSecret(false)
      setDeletingSecret(null)
    }
  }, [open])

  const credList = Object.values(credentials)

  const handleAdd = async () => {
    if (!addProvider || !newKey.trim()) return
    await createCredential(addProvider, newName || `${addProvider} key`, newKey)
    await loadCredentials()
    setAddProvider(null)
    setNewName('')
    setNewKey('')
  }

  const handleDelete = async (id: string) => {
    await deleteCredential(id)
    await loadCredentials()
    setDeleting(null)
  }

  const handleAddSecret = async () => {
    if (!secretName.trim() || !secretValue.trim()) return
    await api('POST', '/secrets', {
      name: secretName,
      service: secretService || 'custom',
      value: secretValue,
      scope: secretScope,
      agentIds: secretScope === 'agent' ? secretAgentIds : [],
    })
    await loadSecrets()
    setAddingSecret(false)
    setSecretName('')
    setSecretService('')
    setSecretValue('')
    setSecretScope('global')
    setSecretAgentIds([])
  }

  const handleDeleteSecret = async (id: string) => {
    await api('DELETE', `/secrets/${id}`)
    await loadSecrets()
    setDeletingSecret(null)
  }

  const handleDisableAllHeartbeats = async () => {
    if (disablingHeartbeats) return
    setDisablingHeartbeats(true)
    setHeartbeatBulkNotice('')
    try {
      const result = await api<{
        ok: boolean
        updatedSessions: number
        cancelledQueued: number
        abortedRunning: number
      }>('POST', '/sessions/heartbeat', { action: 'disable_all' })
      await loadSessions()
      setHeartbeatBulkNotice(
        `Stopped heartbeat on ${result.updatedSessions} session(s); cancelled ${result.cancelledQueued} queued run(s), aborted ${result.abortedRunning} running run(s).`,
      )
    } catch (err: any) {
      setHeartbeatBulkNotice(err?.message || 'Failed to disable heartbeat for all sessions.')
    } finally {
      setDisablingHeartbeats(false)
    }
  }

  const orchestrators = Object.values(agents).filter((p) => p.isOrchestrator)
  const secretList = Object.entries(secrets).map(([rowId, secret]) => ({ ...secret, rowId }))

  // LangGraph config
  const lgProviders = providers.filter((p) => !NON_LANGGRAPH_PROVIDER_IDS.has(String(p.id)))
  const hasConfiguredLgProvider = !!appSettings.langGraphProvider && lgProviders.some((p) => p.id === appSettings.langGraphProvider)
  const lgProvider = hasConfiguredLgProvider ? appSettings.langGraphProvider! : (lgProviders[0]?.id || 'anthropic')
  const lgProviderInfo = lgProviders.find((p) => p.id === lgProvider) || providers.find((p) => p.id === lgProvider)
  const lgCredentials = credList.filter((c) => c.provider === lgProvider)
  const loopMode: LoopMode = appSettings.loopMode === 'ongoing' ? 'ongoing' : 'bounded'

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-bg text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"

  return (
    <BottomSheet open={open} onClose={() => setOpen(false)} wide>
      {/* Header */}
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">Settings</h2>
        <p className="text-[14px] text-text-3">Manage providers, API keys & orchestrator engine</p>
      </div>

      {/* User Preferences (global system prompt) */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          User Preferences
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Global instructions injected into ALL agent system prompts. Define your style, rules, and preferences.
        </p>
        <textarea
          value={appSettings.userPrompt || ''}
          onChange={(e) => updateSettings({ userPrompt: e.target.value })}
          placeholder="e.g. Always respond concisely. Use TypeScript over JavaScript. Prefer functional patterns. My timezone is PST."
          rows={4}
          className={`${inputClass} resize-y min-h-[100px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {/* LangGraph Orchestrator Engine */}
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
                onClick={() => updateSettings({ langGraphProvider: p.id, langGraphModel: '', langGraphCredentialId: null, langGraphEndpoint: null })}
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
              <select
                value={appSettings.langGraphModel || lgProviderInfo.models[0]}
                onChange={(e) => updateSettings({ langGraphModel: e.target.value })}
                className={`${inputClass} appearance-none cursor-pointer`}
                style={{ fontFamily: 'inherit' }}
              >
                {lgProviderInfo.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}

          {(lgProviderInfo?.requiresEndpoint || !!appSettings.langGraphEndpoint) && (
            <div className="mb-5">
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Endpoint Override</label>
              <input
                type="text"
                value={appSettings.langGraphEndpoint || ''}
                onChange={(e) => updateSettings({ langGraphEndpoint: e.target.value || null })}
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
                onChange={(e) => updateSettings({ langGraphCredentialId: e.target.value || null })}
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

      {/* Runtime & Loop Controls */}
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
                onClick={() => updateSettings({ loopMode: mode.id })}
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
                    updateSettings({ agentLoopRecursionLimit: Number.isFinite(n) ? n : DEFAULT_AGENT_LOOP_RECURSION_LIMIT })
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
                    updateSettings({ orchestratorLoopRecursionLimit: Number.isFinite(n) ? n : DEFAULT_ORCHESTRATOR_LOOP_RECURSION_LIMIT })
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
                    updateSettings({ legacyOrchestratorMaxTurns: Number.isFinite(n) ? n : DEFAULT_LEGACY_ORCHESTRATOR_MAX_TURNS })
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
                    updateSettings({ ongoingLoopMaxIterations: Number.isFinite(n) ? n : DEFAULT_ONGOING_LOOP_MAX_ITERATIONS })
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
                    updateSettings({ ongoingLoopMaxRuntimeMinutes: Number.isFinite(n) ? n : DEFAULT_ONGOING_LOOP_MAX_RUNTIME_MINUTES })
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
                  updateSettings({ shellCommandTimeoutSec: Number.isFinite(n) ? n : DEFAULT_SHELL_COMMAND_TIMEOUT_SEC })
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
                  updateSettings({ claudeCodeTimeoutSec: Number.isFinite(n) ? n : DEFAULT_CLAUDE_CODE_TIMEOUT_SEC })
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
                  updateSettings({ cliProcessTimeoutSec: Number.isFinite(n) ? n : DEFAULT_CLI_PROCESS_TIMEOUT_SEC })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Capability Policy */}
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
                onClick={() => updateSettings({ capabilityPolicyMode: mode.id })}
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
                onChange={(e) => updateSettings({
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
                onChange={(e) => updateSettings({
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
                onChange={(e) => updateSettings({
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

      {/* Voice */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Voice
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Configure voice playback (TTS) and speech-to-text input.
        </p>
        <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">ElevenLabs API Key</label>
              <input
                type="password"
                value={appSettings.elevenLabsApiKey || ''}
                onChange={(e) => updateSettings({ elevenLabsApiKey: e.target.value || null })}
                placeholder="sk_..."
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">ElevenLabs Voice ID</label>
              <input
                type="text"
                value={appSettings.elevenLabsVoiceId || ''}
                onChange={(e) => updateSettings({ elevenLabsVoiceId: e.target.value || null })}
                placeholder="JBFqnCBsd6RMkjVDRZzb"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          </div>
          <div>
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Speech Recognition Language</label>
            <input
              type="text"
              value={appSettings.speechRecognitionLang || ''}
              onChange={(e) => updateSettings({ speechRecognitionLang: e.target.value || null })}
              placeholder="en-US (blank = browser default)"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>
      </div>

      {/* Heartbeat */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Heartbeat
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Configure ongoing heartbeat checks for long-lived sessions.
        </p>
        <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Heartbeat Interval (Seconds)</label>
              <input
                type="number"
                min={0}
                max={3600}
                value={appSettings.heartbeatIntervalSec ?? 120}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  updateSettings({ heartbeatIntervalSec: Number.isFinite(n) ? Math.max(0, n) : 120 })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-2">Set to 0 to disable heartbeat polling.</p>
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Heartbeat Prompt</label>
              <input
                type="text"
                value={appSettings.heartbeatPrompt || ''}
                onChange={(e) => updateSettings({ heartbeatPrompt: e.target.value || null })}
                placeholder="SWARM_HEARTBEAT_CHECK"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </div>
          </div>

          <div>
            <p className="text-[11px] text-text-3/60 mt-2">
              Internal ping text used for ongoing sessions. Leave blank to use the default.
            </p>
            <div className="mt-4 flex items-center gap-2.5">
              <button
                onClick={handleDisableAllHeartbeats}
                disabled={disablingHeartbeats}
                className="px-3.5 py-2 rounded-[10px] border border-rose-400/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/16 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed text-[12px] font-600"
                style={{ fontFamily: 'inherit' }}
              >
                {disablingHeartbeats ? 'Stopping…' : 'Stop All Session Heartbeats'}
              </button>
              <span className="text-[11px] text-text-3/70">
                Disables heartbeat on every session and cancels queued heartbeat runs.
              </span>
            </div>
            {heartbeatBulkNotice && (
              <p className="text-[11px] text-text-3/70 mt-2">{heartbeatBulkNotice}</p>
            )}
          </div>
        </div>
      </div>

      {/* Embedding Config */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Embeddings
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Enable semantic search for agent memory. Requires an embedding model provider.
        </p>
        <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Provider</label>
          <div className="grid grid-cols-4 gap-2 mb-5">
            {[
              { id: null, name: 'Off' },
              { id: 'local' as const, name: 'Local (Free)' },
              { id: 'openai' as const, name: 'OpenAI' },
              { id: 'ollama' as const, name: 'Ollama' },
            ].map((p) => (
              <button
                key={String(p.id)}
                onClick={() => updateSettings({ embeddingProvider: p.id, embeddingModel: null, embeddingCredentialId: null })}
                className={`py-3 px-3 rounded-[12px] text-center cursor-pointer transition-all text-[13px] font-600 border
                  ${(appSettings.embeddingProvider || null) === p.id
                    ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
                    : 'bg-bg border-white/[0.06] text-text-2 hover:bg-surface-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {p.name}
              </button>
            ))}
          </div>

          {appSettings.embeddingProvider === 'local' && (
            <p className="text-[12px] text-text-3/80 mb-5">
              Runs <span className="text-text-2 font-600">all-MiniLM-L6-v2</span> locally in Node.js — no API key, no cost, works offline. Model downloads once (~23MB).
            </p>
          )}

          {appSettings.embeddingProvider === 'openai' && (
            <>
              <div className="mb-5">
                <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
                <select
                  value={appSettings.embeddingModel || 'text-embedding-3-small'}
                  onChange={(e) => updateSettings({ embeddingModel: e.target.value })}
                  className={`${inputClass} appearance-none cursor-pointer`}
                  style={{ fontFamily: 'inherit' }}
                >
                  <option value="text-embedding-3-small">text-embedding-3-small</option>
                  <option value="text-embedding-3-large">text-embedding-3-large</option>
                </select>
              </div>
              <div>
                <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">API Key</label>
                {credList.filter((c) => c.provider === 'openai').length > 0 ? (
                  <select
                    value={appSettings.embeddingCredentialId || ''}
                    onChange={(e) => updateSettings({ embeddingCredentialId: e.target.value || null })}
                    className={`${inputClass} appearance-none cursor-pointer`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <option value="">Select a key...</option>
                    {credList.filter((c) => c.provider === 'openai').map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[12px] text-text-3/60">No OpenAI API keys configured.</p>
                )}
              </div>
            </>
          )}

          {appSettings.embeddingProvider === 'ollama' && (
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-3">Model</label>
              <input
                type="text"
                value={appSettings.embeddingModel || 'nomic-embed-text'}
                onChange={(e) => updateSettings({ embeddingModel: e.target.value })}
                placeholder="nomic-embed-text"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-2">Uses your local Ollama instance for embeddings</p>
            </div>
          )}
        </div>
      </div>

      {/* Memory Retrieval */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Memory Retrieval
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Guardrails for memory graph traversal and lookup fan-out. These limits are enforced server-side.
        </p>
        <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
                Reference Depth
              </label>
              <input
                type="number"
                min={0}
                max={12}
                value={appSettings.memoryReferenceDepth ?? appSettings.memoryMaxDepth ?? 3}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  const depth = Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : 3
                  updateSettings({ memoryReferenceDepth: depth, memoryMaxDepth: depth })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-2">How far linked memory traversal can go.</p>
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
                Max Per Lookup
              </label>
              <input
                type="number"
                min={1}
                max={200}
                value={appSettings.maxMemoriesPerLookup ?? appSettings.memoryMaxPerLookup ?? 20}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  const perLookup = Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 20
                  updateSettings({ maxMemoriesPerLookup: perLookup, memoryMaxPerLookup: perLookup })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-2">Total memories returned in one retrieval call.</p>
            </div>
            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">
                Max Linked Expansion
              </label>
              <input
                type="number"
                min={0}
                max={1000}
                value={appSettings.maxLinkedMemoriesExpanded ?? 60}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  const linked = Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : 60
                  updateSettings({ maxLinkedMemoriesExpanded: linked })
                }}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
              <p className="text-[11px] text-text-3/60 mt-2">Caps how many linked nodes can be expanded per lookup.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Orchestrator Secrets */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Service Credentials
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Credentials for external services (Gmail, APIs, etc.) that orchestrators can use during task execution.
        </p>

        {secretList.length > 0 && (
          <div className="space-y-2.5 mb-4">
            {secretList.map((secret) => (
              <div key={secret.rowId} className="flex items-center gap-3 py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-600 text-text truncate">{secret.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] font-mono text-text-3">{secret.service}</span>
                    <span className={`text-[10px] font-600 px-1.5 py-0.5 rounded-[4px] ${
                      secret.scope === 'global'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-amber-500/10 text-amber-400'
                    }`}>
                      {secret.scope === 'global' ? 'All orchestrators' : `${secret.agentIds.length} orchestrator(s)`}
                    </span>
                  </div>
                </div>
                {deletingSecret === secret.rowId ? (
                  <div className="flex gap-2">
                    <button onClick={() => setDeletingSecret(null)} className="px-3 py-1.5 text-[13px] font-600 bg-transparent border-none text-text-3 cursor-pointer hover:text-text-2 transition-colors" style={{ fontFamily: 'inherit' }}>Keep</button>
                    <button onClick={() => handleDeleteSecret(secret.rowId)} className="px-3 py-1.5 text-[13px] font-600 bg-danger text-white border-none cursor-pointer rounded-[8px] transition-colors hover:brightness-110" style={{ fontFamily: 'inherit' }}>Delete</button>
                  </div>
                ) : (
                  <button onClick={() => setDeletingSecret(secret.rowId)} className="px-3 py-1.5 text-[13px] font-500 bg-transparent border-none text-text-3 cursor-pointer hover:text-danger transition-colors" style={{ fontFamily: 'inherit' }}>Remove</button>
                )}
              </div>
            ))}
          </div>
        )}

        {addingSecret ? (
          <div className="p-6 rounded-[18px] bg-surface border border-white/[0.06] space-y-4">
            <div className="font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em]">New Secret</div>
            <input type="text" value={secretName} onChange={(e) => setSecretName(e.target.value)} placeholder="Name (e.g. My Gmail)" className={inputClass} style={{ fontFamily: 'inherit' }} />
            <input type="text" value={secretService} onChange={(e) => setSecretService(e.target.value)} placeholder="Service (e.g. gmail, ahrefs, custom)" className={inputClass} style={{ fontFamily: 'inherit' }} />
            <input type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} placeholder="Value (API key, password, token...)" className={inputClass} style={{ fontFamily: 'inherit' }} />

            <div>
              <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Scope</label>
              <div className="flex p-1 rounded-[12px] bg-bg border border-white/[0.06]">
                {(['global', 'agent'] as const).map((s) => (
                  <button key={s} onClick={() => setSecretScope(s)} className={`flex-1 py-2.5 rounded-[10px] text-center cursor-pointer transition-all text-[13px] font-600 capitalize ${secretScope === s ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`} style={{ fontFamily: 'inherit' }}>{s === 'global' ? 'All Orchestrators' : 'Specific'}</button>
                ))}
              </div>
            </div>

            {secretScope === 'agent' && orchestrators.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {orchestrators.map((p) => (
                  <button key={p.id} onClick={() => setSecretAgentIds((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])} className={`px-3 py-2 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border ${secretAgentIds.includes(p.id) ? 'bg-accent-soft border-accent-bright/25 text-accent-bright' : 'bg-bg border-white/[0.06] text-text-3 hover:text-text-2'}`} style={{ fontFamily: 'inherit' }}>{p.name}</button>
                ))}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={() => setAddingSecret(false)} className="flex-1 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors" style={{ fontFamily: 'inherit' }}>Cancel</button>
              <button onClick={handleAddSecret} disabled={!secretName.trim() || !secretValue.trim()} className="flex-1 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110" style={{ fontFamily: 'inherit' }}>Save Secret</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAddingSecret(true)} className="w-full py-3 rounded-[12px] border border-dashed border-white/[0.1] bg-transparent text-text-3 text-[13px] font-600 cursor-pointer hover:border-accent-bright/30 hover:text-accent-bright hover:bg-accent-soft transition-all duration-200" style={{ fontFamily: 'inherit' }}>+ Add Service Credential</button>
        )}
      </div>

      {/* Providers */}
      <div className="mb-8">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-5">
          Providers
        </h3>
        <div className="space-y-4">
          {providers.map((p) => {
            const providerCreds = credList.filter((c) => c.provider === p.id)
            return (
              <div key={p.id} className="p-6 rounded-[18px] bg-surface border border-white/[0.06]">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-display text-[17px] font-600 tracking-[-0.01em]">{p.name}</span>
                  <span className={`text-[12px] font-600 px-3 py-1 rounded-[8px]
                    ${p.requiresApiKey
                      ? providerCreds.length > 0 ? 'text-success bg-success/[0.1]' : 'text-text-3 bg-white/[0.04]'
                      : 'text-success bg-success/[0.1]'}`}>
                    {p.requiresApiKey
                      ? providerCreds.length > 0 ? 'Connected' : 'No key'
                      : p.optionalApiKey
                        ? providerCreds.length > 0 ? 'Local + Cloud' : 'Local'
                        : p.requiresEndpoint ? 'Local' : 'Built-in'}
                  </span>
                </div>
                <div className="text-[13px] text-text-2/50 font-mono">
                  {p.models.slice(0, 3).join(', ')}
                  {p.models.length > 3 && ` +${p.models.length - 3} more`}
                </div>

                {(p.requiresApiKey || p.optionalApiKey) && providerCreds.length > 0 && (
                  <div className="mt-5 space-y-2.5">
                    {providerCreds.map((cred) => (
                      <div key={cred.id} className="flex items-center gap-3 py-3 px-4 rounded-[12px] bg-bg border border-white/[0.06]">
                        <span className="text-[14px] font-500 flex-1 truncate">{cred.name}</span>
                        {deleting === cred.id ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => setDeleting(null)}
                              className="px-3 py-1.5 text-[13px] font-600 bg-transparent border-none text-text-3 cursor-pointer hover:text-text-2 transition-colors"
                              style={{ fontFamily: 'inherit' }}
                            >
                              Keep
                            </button>
                            <button
                              onClick={() => handleDelete(cred.id)}
                              className="px-3 py-1.5 text-[13px] font-600 bg-danger text-white border-none cursor-pointer rounded-[8px] transition-colors hover:brightness-110"
                              style={{ fontFamily: 'inherit' }}
                            >
                              Delete
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleting(cred.id)}
                            className="px-3 py-1.5 text-[13px] font-500 bg-transparent border-none text-text-3 cursor-pointer hover:text-danger transition-colors"
                            style={{ fontFamily: 'inherit' }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {(p.requiresApiKey || p.optionalApiKey) && (
                  <button
                    onClick={() => setAddProvider(p.id)}
                    className="mt-5 w-full py-3 rounded-[12px] border border-dashed border-white/[0.1]
                      bg-transparent text-text-3 text-[13px] font-600 cursor-pointer
                      hover:border-accent-bright/30 hover:text-accent-bright hover:bg-accent-soft transition-all duration-200"
                    style={{ fontFamily: 'inherit' }}
                  >
                    + Add API Key{p.optionalApiKey && !p.requiresApiKey ? ' (for cloud)' : ''}
                  </button>
                )}

                {p.requiresEndpoint && (
                  <div className="mt-5 text-[13px] text-text-3/50 font-mono">
                    Endpoint: {(p as any).defaultEndpoint || 'http://localhost:11434'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Add key form */}
      {addProvider && (
        <div className="mb-8 p-6 rounded-[18px] bg-surface border border-white/[0.06]">
          <div className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-4">
            New {providers.find((p) => p.id === addProvider)?.name} API Key
          </div>
          <div className="space-y-4">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Key name (optional)"
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="sk-..."
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setAddProvider(null); setNewName(''); setNewKey('') }}
                className="flex-1 py-3 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-colors"
                style={{ fontFamily: 'inherit' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={!newKey.trim()}
                className="flex-1 py-3 rounded-[14px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110"
                style={{ fontFamily: 'inherit' }}
              >
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Plugins */}
      <div className="mb-10">
        <h3 className="font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Plugins
        </h3>
        <p className="text-[12px] text-text-3 mb-5">
          Extend agent behavior with hooks. Install from the marketplace, a URL, or drop .js files into <code className="text-[11px] font-mono text-text-2">data/plugins/</code>.
          <span className="text-text-3/40 ml-1">OpenClaw plugins are also supported.</span>
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

function PluginManager() {
  const [tab, setTab] = useState<'installed' | 'marketplace' | 'url'>('installed')
  const [plugins, setPlugins] = useState<PluginMeta[]>([])
  const [marketplace, setMarketplace] = useState<MarketplacePlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlFilename, setUrlFilename] = useState('')
  const [urlStatus, setUrlStatus] = useState<{ ok: boolean; message: string } | null>(null)

  const loadPlugins = useCallback(async () => {
    try {
      const data = await api<PluginMeta[]>('GET', '/plugins')
      setPlugins(data)
    } catch { /* ignore */ }
  }, [])

  const loadMarketplace = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<MarketplacePlugin[]>('GET', '/plugins/marketplace')
      if (Array.isArray(data)) setMarketplace(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadPlugins() }, [])
  useEffect(() => { if (tab === 'marketplace') loadMarketplace() }, [tab])

  const togglePlugin = async (filename: string, enabled: boolean) => {
    await api('POST', '/plugins', { filename, enabled })
    loadPlugins()
  }

  const installFromMarketplace = async (p: MarketplacePlugin) => {
    setInstalling(p.id)
    try {
      await api('POST', '/plugins/install', { url: p.url, filename: `${p.id}.js` })
      await loadPlugins()
      setTab('installed')
    } catch { /* ignore */ }
    setInstalling(null)
  }

  const installFromUrl = async () => {
    if (!urlInput || !urlFilename) return
    setUrlStatus(null)
    setInstalling('url')
    try {
      await api('POST', '/plugins/install', { url: urlInput, filename: urlFilename })
      await loadPlugins()
      setUrlStatus({ ok: true, message: 'Installed successfully' })
      setUrlInput('')
      setUrlFilename('')
    } catch (err: any) {
      setUrlStatus({ ok: false, message: err.message || 'Install failed' })
    }
    setInstalling(null)
  }

  const installedFilenames = new Set(plugins.map((p) => p.filename))

  const tabClass = (t: string) =>
    `py-2.5 px-4 rounded-[10px] text-center cursor-pointer transition-all text-[12px] font-600 border
    ${tab === t
      ? 'bg-accent-soft border-accent-bright/25 text-accent-bright'
      : 'bg-bg border-white/[0.06] text-text-3 hover:bg-surface-2'}`

  return (
    <div>
      <div className="flex gap-2 mb-5">
        <button onClick={() => setTab('installed')} className={tabClass('installed')} style={{ fontFamily: 'inherit' }}>
          Installed{plugins.length > 0 && ` (${plugins.length})`}
        </button>
        <button onClick={() => setTab('marketplace')} className={tabClass('marketplace')} style={{ fontFamily: 'inherit' }}>
          Marketplace
        </button>
        <button onClick={() => setTab('url')} className={tabClass('url')} style={{ fontFamily: 'inherit' }}>
          Install from URL
        </button>
      </div>

      {tab === 'installed' && (
        plugins.length === 0
          ? <p className="text-[12px] text-text-3/40">No plugins installed</p>
          : <div className="space-y-2.5">
              {plugins.map((p) => (
                <div key={p.filename} className="flex items-center gap-3 py-3 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-600 text-text truncate">{p.name}</span>
                      {p.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
                    </div>
                    <div className="text-[11px] font-mono text-text-3 truncate">{p.filename}</div>
                    {p.description && <div className="text-[11px] text-text-3/60 mt-0.5">{p.description}</div>}
                  </div>
                  <div
                    onClick={() => togglePlugin(p.filename, !p.enabled)}
                    className={`w-11 h-6 rounded-full transition-all duration-200 relative cursor-pointer shrink-0
                      ${p.enabled ? 'bg-[#6366F1]' : 'bg-white/[0.08]'}`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-200
                      ${p.enabled ? 'left-[22px]' : 'left-0.5'}`} />
                  </div>
                </div>
              ))}
            </div>
      )}

      {tab === 'marketplace' && (
        loading
          ? <p className="text-[12px] text-text-3/40">Loading marketplace...</p>
          : marketplace.length === 0
            ? <p className="text-[12px] text-text-3/40">No plugins available</p>
            : <div className="space-y-2.5">
                {marketplace.map((p) => {
                  const isInstalled = installedFilenames.has(`${p.id}.js`)
                  return (
                    <div key={p.id} className="py-3.5 px-4 rounded-[14px] bg-surface border border-white/[0.06]">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[14px] font-600 text-text">{p.name}</span>
                            <span className="text-[10px] font-mono text-text-3/40">v{p.version}</span>
                            {p.openclaw && <span className="text-[9px] font-600 text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">OpenClaw</span>}
                          </div>
                          <div className="text-[11px] text-text-3/60 mt-1">{p.description}</div>
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-[10px] text-text-3/40">by {p.author}</span>
                            <span className="text-[10px] text-text-3/20">·</span>
                            {p.tags.slice(0, 3).map((t) => (
                              <span key={t} className="text-[9px] font-600 text-text-3/50 bg-white/[0.04] px-1.5 py-0.5 rounded-full">{t}</span>
                            ))}
                          </div>
                        </div>
                        <button
                          onClick={() => !isInstalled && installFromMarketplace(p)}
                          disabled={isInstalled || installing === p.id}
                          className={`shrink-0 py-2 px-4 rounded-[10px] text-[12px] font-600 transition-all cursor-pointer
                            ${isInstalled
                              ? 'bg-white/[0.04] text-text-3/40 cursor-default'
                              : installing === p.id
                                ? 'bg-accent-soft text-accent-bright animate-pulse'
                                : 'bg-accent-soft text-accent-bright hover:bg-accent-soft/80 border border-accent-bright/20'}`}
                          style={{ fontFamily: 'inherit' }}
                        >
                          {isInstalled ? 'Installed' : installing === p.id ? 'Installing...' : 'Install'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
      )}

      {tab === 'url' && (
        <div className="p-5 rounded-[14px] bg-surface border border-white/[0.06]">
          <div className="mb-4">
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Plugin URL</label>
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/my-plugin.js"
              className="w-full py-2.5 px-3 rounded-[10px] text-[13px] bg-bg border border-white/[0.06] text-text placeholder:text-text-3/30 outline-none focus:border-accent-bright/30"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div className="mb-4">
            <label className="block font-display text-[11px] font-600 text-text-3 uppercase tracking-[0.08em] mb-2">Save as filename</label>
            <input
              type="text"
              value={urlFilename}
              onChange={(e) => setUrlFilename(e.target.value)}
              placeholder="my-plugin.js"
              className="w-full py-2.5 px-3 rounded-[10px] text-[13px] bg-bg border border-white/[0.06] text-text placeholder:text-text-3/30 outline-none focus:border-accent-bright/30"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <button
            onClick={installFromUrl}
            disabled={!urlInput || !urlFilename || installing === 'url'}
            className="w-full py-2.5 rounded-[10px] text-[13px] font-600 bg-accent-soft text-accent-bright border border-accent-bright/20
              hover:bg-accent-soft/80 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-default"
            style={{ fontFamily: 'inherit' }}
          >
            {installing === 'url' ? 'Installing...' : 'Install Plugin'}
          </button>
          {urlStatus && (
            <p className={`text-[11px] mt-3 ${urlStatus.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {urlStatus.message}
            </p>
          )}
          <p className="text-[10px] text-text-3/30 mt-3">
            Works with SwarmClaw and OpenClaw plugin formats. URL must be HTTPS.
          </p>
        </div>
      )}
    </div>
  )
}
