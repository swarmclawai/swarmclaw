'use client'

import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/runtime/heartbeat-defaults'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Agent, MemoryEntry, Session } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { api } from '@/lib/app/api-client'
import { AgentAvatar } from './agent-avatar'
import { AgentFilesEditor } from './agent-files-editor'
import { OpenClawSkillsPanel } from './openclaw-skills-panel'
import { PermissionPresetSelector } from './permission-preset-selector'
import { ExecConfigPanel } from './exec-config-panel'
import { SandboxEnvPanel } from './sandbox-env-panel'
import { CronJobForm } from './cron-job-form'
import { toast } from 'sonner'
import { StatusDot } from '@/components/ui/status-dot'
import { normalizeAgentExecuteConfig } from '@/lib/agent-execute-defaults'
import { normalizeAgentSandboxConfig } from '@/lib/agent-sandbox-defaults'
import { getEnabledToolIds, getEnabledExtensionIds, getEnabledCapabilityIds } from '@/lib/capability-selection'
import { searchMemory } from '@/lib/memory'
import { ConnectorPlatformIcon, getSessionConnector } from '@/components/shared/connector-platform-icon'
import { useNavigate } from '@/lib/app/navigation'
import { formatDurationSec } from '@/lib/format-display'
import { ModelCombobox } from '@/components/shared/model-combobox'
import { buildOpenClawMainSessionKey } from '@/lib/openclaw/openclaw-agent-id'
import { StructuredSessionLauncher } from '@/components/protocols/structured-session-launcher'
import { useWs } from '@/hooks/use-ws'
import { buildAgentSelectableProviders } from '@/lib/agent-provider-options'

interface Props {
  agent: Agent
  session: Session
  onEditAgent?: () => void
  onDuplicateAgent?: () => void
  onClearHistory?: () => void
  onDeleteAgent?: () => void
  onDeleteChat?: () => void
  isMainChat?: boolean
}

type InspectorTab = 'dashboard' | 'config' | 'files'

const TABS: { id: InspectorTab; label: string; openclawOnly?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'config', label: 'Config' },
  { id: 'files', label: 'Files', openclawOnly: true },
]

const PROVIDER_LABELS: Record<string, string> = {
  'claude-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
  'opencode-cli': 'OpenCode CLI',
  'gemini-cli': 'Gemini CLI',
  'copilot-cli': 'Copilot CLI',
  'droid-cli': 'Droid CLI',
  'cursor-cli': 'Cursor CLI',
  'qwen-code-cli': 'Qwen Code CLI',
  goose: 'Goose',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openclaw: 'OpenClaw',
  ollama: 'Ollama',
}

// ─── Model Switcher (inline in header) ───────────────────────────

function ModelSwitcherInline({ session, agent }: { session: Session; agent: Agent }) {
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const providerConfigs = useAppStore((s) => s.providerConfigs)
  const loadProviderConfigs = useAppStore((s) => s.loadProviderConfigs)
  const refreshSession = useAppStore((s) => s.refreshSession)
  const streaming = useChatStore((s) => s.streaming)
  const [expanded, setExpanded] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState(session.provider || agent.provider)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void loadProviders()
    void loadProviderConfigs()
  }, [loadProviderConfigs, loadProviders])
  // Sync selectedProvider when the session's provider changes (e.g. after a successful save)
  useEffect(() => { setSelectedProvider(session.provider || agent.provider) }, [session.provider, agent.provider])

  const agentSelectableProviders = useMemo(
    () => buildAgentSelectableProviders(providers, providerConfigs),
    [providerConfigs, providers],
  )
  const currentProviderInfo = agentSelectableProviders.find((p) => p.id === selectedProvider)
  const activeSessionProvider = agentSelectableProviders.find((p) => p.id === (session.provider || agent.provider))
  const effectiveProvider = session.provider || agent.provider
  const providerLabel = PROVIDER_LABELS[effectiveProvider] || activeSessionProvider?.name || effectiveProvider.replace(/-/g, ' ')

  const handleModelChange = async (model: string) => {
    if (saving) return
    setSaving(true)
    try {
      await api('PUT', `/chats/${session.id}`, { provider: selectedProvider, model })
      await refreshSession(session.id)
      setExpanded(false)
      toast.success(`Switched to ${model}`)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to switch model')
    } finally {
      setSaving(false)
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => !streaming && setExpanded(true)}
        disabled={streaming}
        className="mt-2 flex items-center gap-1.5 w-full text-left bg-transparent border-none cursor-pointer disabled:cursor-default disabled:opacity-50 group"
      >
        <span className="inline-flex items-center rounded-[8px] border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] font-600 text-text-3/70 group-hover:border-white/[0.1] group-hover:text-text-2 transition-colors">
          {providerLabel}
        </span>
        <span className="inline-flex max-w-[180px] items-center rounded-[8px] border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] font-mono text-text-3/70 truncate group-hover:border-white/[0.1] group-hover:text-text-2 transition-colors">
          {session.model || agent.model || 'Default model'}
        </span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-text-3/30 group-hover:text-text-3/60 transition-colors ml-auto shrink-0">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    )
  }

  return (
    <div className="mt-2 rounded-[10px] border border-white/[0.08] bg-black/[0.12] p-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/45">Switch Model</span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[10px] text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer"
        >
          Cancel
        </button>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {agentSelectableProviders.filter((p) => p.models.length > 0).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelectedProvider(p.id)}
            className={`px-2 py-0.5 rounded-[6px] text-[10px] font-600 border cursor-pointer transition-colors ${
              p.id === selectedProvider
                ? 'bg-accent-soft/50 text-accent-bright border-accent-bright/20'
                : 'bg-white/[0.02] text-text-3/60 border-white/[0.04] hover:bg-white/[0.05]'
            }`}
          >
            {PROVIDER_LABELS[p.id] || p.name}
          </button>
        ))}
      </div>
      {currentProviderInfo && (
        <ModelCombobox
          providerId={currentProviderInfo.id}
          value={session.model || agent.model || currentProviderInfo.models[0] || ''}
          onChange={(m) => void handleModelChange(m)}
          models={currentProviderInfo.models}
          defaultModels={currentProviderInfo.defaultModels}
          supportsDiscovery={currentProviderInfo.supportsModelDiscovery}
          className="w-full"
        />
      )}
    </div>
  )
}

// ─── Workspace Path ──────────────────────────────────────────────

function WorkspacePath({ cwd }: { cwd: string }) {
  const display = cwd.replace(/^\/Users\/[^/]+/, '~')
  const handleClick = () => {
    api('POST', '/files/open', { path: cwd }).catch(() => {})
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      className="mt-2 flex items-center gap-1.5 w-full text-left bg-transparent border-none cursor-pointer group"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/40 shrink-0">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <span className="text-[10px] text-text-3/60 font-mono truncate group-hover:text-text-2 transition-colors">{display}</span>
    </button>
  )
}

function panelCardClass(className = '') {
  return `rounded-[16px] border border-white/[0.06] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${className}`.trim()
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <label className="block text-[11px] font-700 uppercase tracking-[0.16em] text-text-3/45 mb-2">{children}</label>
}

function ToggleSwitch({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer border-none disabled:opacity-50 ${on ? 'bg-accent-bright/80' : 'bg-white/[0.08]'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  )
}

// --- Main component ---

export function InspectorPanel({ agent, session, onEditAgent, onDuplicateAgent, onClearHistory, onDeleteAgent, onDeleteChat, isMainChat }: Props) {
  const inspectorTab = useAppStore((s) => s.inspectorTab)
  const setInspectorTab = useAppStore((s) => s.setInspectorTab)
  const setInspectorOpen = useAppStore((s) => s.setInspectorOpen)

  const isOpenClaw = agent.provider === 'openclaw'
  const visibleTabs = TABS.filter((t) => !t.openclawOnly || isOpenClaw)

  // Reset to dashboard if current tab is not visible
  useEffect(() => {
    if (!visibleTabs.find((t) => t.id === inspectorTab)) {
      setInspectorTab('dashboard')
    }
  }, [inspectorTab, setInspectorTab, visibleTabs])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectorOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setInspectorOpen])

  return (
    <div className="w-[420px] shrink-0 border-l border-white/[0.06] bg-bg flex flex-col h-full overflow-hidden fade-up-delay"
      style={{ background: 'radial-gradient(circle at top right, rgba(66, 211, 255, 0.06), transparent 30%), linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))' }}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-white/[0.06] shrink-0 bg-black/[0.12]">
        <div className="flex items-start gap-3">
          <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="font-display text-[16px] font-700 text-text truncate tracking-[-0.02em]">{agent.name}</h3>
              {agent.disabled === true && (
                <span className="inline-flex items-center gap-1 rounded-[7px] border border-amber-400/15 bg-amber-400/[0.1] px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] text-amber-300">
                  <StatusDot status="warning" size="sm" />
                  Disabled
                </span>
              )}
              {agent.heartbeatEnabled && (
                <span className="inline-flex items-center gap-1 rounded-[7px] border border-emerald-400/15 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] text-emerald-300">
                  <StatusDot status="online" size="sm" />
                  Heartbeat
                </span>
              )}
            </div>
          </div>
        <button
          onClick={() => setInspectorOpen(false)}
          className="p-1.5 rounded-[8px] text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer transition-all hover:bg-white/[0.04]"
          aria-label="Close inspector"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        </div>
        <ModelSwitcherInline session={session} agent={agent} />
        {session.cwd && <WorkspacePath cwd={session.cwd} />}
      </div>

      {/* Tab bar */}
      <div className="px-4 py-3 shrink-0">
      <div className="flex gap-1 rounded-[12px] border border-white/[0.06] bg-black/[0.12] p-1 overflow-x-auto" role="tablist">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            onClick={() => setInspectorTab(tab.id)}
            aria-selected={inspectorTab === tab.id}
            className={`px-3 py-1.5 rounded-[9px] text-[11px] font-700 cursor-pointer transition-all whitespace-nowrap focus-visible:ring-1 focus-visible:ring-accent-bright/50
              ${inspectorTab === tab.id
                ? 'bg-white/[0.08] text-text'
                : 'bg-transparent text-text-3/65 hover:text-text-2'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {inspectorTab === 'dashboard' && (
          <DashboardTab agent={agent} session={session} />
        )}
        {inspectorTab === 'config' && (
          <ConfigTab agent={agent} />
        )}
        {inspectorTab === 'files' && isOpenClaw && (
          <AgentFilesEditor agentId={agent.id} />
        )}
      </div>

      {/* Sticky footer */}
      <StickyFooter
        agent={agent}
        isMainChat={isMainChat}
        onEditAgent={onEditAgent}
        onDuplicateAgent={onDuplicateAgent}
        onClearHistory={onClearHistory}
        onDeleteAgent={onDeleteAgent}
        onDeleteChat={onDeleteChat}
      />
    </div>
  )
}

// ─── Dashboard Tab ───────────────────────────────────────────────

function DashboardTab({ agent, session }: { agent: Agent; session: Session }) {
  return (
    <div className="p-4 flex flex-col gap-4">
      <IdentityCard agent={agent} />
      {agent.provider === 'openclaw' && <OpenClawActionsSection agent={agent} />}
      <HeartbeatSection agent={agent} session={session} />
      <ToolsSection agent={agent} session={session} />
      <AudioSection />
      <MemorySection agentId={agent.id} />
      <SessionsSection agent={agent} />
      <QuickActionsSection agent={agent} session={session} />
    </div>
  )
}

// ─── Identity Card ───────────────────────────────────────────────

function IdentityCard({ agent }: { agent: Agent }) {
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(agent.description || '')
  const [saving, setSaving] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const startEdit = () => {
    setDraft(agent.description || '')
    setEditing(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft(agent.description || '')
  }

  const saveDescription = async () => {
    const trimmed = draft.trim()
    if (trimmed === (agent.description || '').trim()) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await api('PUT', `/agents/${agent.id}`, { description: trimmed })
      await loadAgents()
      setEditing(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update description')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={panelCardClass('p-4 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))]')}>
      {editing ? (
        <div>
          <SectionLabel>Description</SectionLabel>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void saveDescription()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelEdit()
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveDescription()
            }}
            disabled={saving}
            placeholder="Add a description..."
            className="w-full min-h-[60px] rounded-[10px] border border-accent-bright/30 bg-black/[0.14] p-3 text-[13px] text-text-2 leading-relaxed outline-none resize-none font-sans"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="group w-full text-left bg-transparent border-none cursor-pointer p-0"
        >
          <p className="text-[13px] text-text-2 leading-relaxed">
            {agent.description || <span className="text-text-3/40 italic">Add a description...</span>}
          </p>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mt-1 text-text-3/30 opacity-0 group-hover:opacity-100 transition-opacity">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      )}

      {agent.systemPrompt && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setPromptExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] font-600 text-text-3/50 hover:text-text-3/70 bg-transparent border-none cursor-pointer transition-colors"
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`transition-transform ${promptExpanded ? 'rotate-90' : ''}`}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
            System prompt
          </button>
          {promptExpanded && (
            <p className="mt-2 text-[12px] text-text-3 bg-black/[0.14] rounded-[12px] p-3 border border-white/[0.04] max-h-[220px] overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
              {agent.systemPrompt}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Heartbeat Section ───────────────────────────────────────────

function HeartbeatSection({ agent, session }: { agent: Agent; session: Session }) {
  const appSettings = useAppStore((s) => s.appSettings)
  const updateAgentInStore = useAppStore((s) => s.updateAgentInStore)
  const updateSessionInStore = useAppStore((s) => s.updateSessionInStore)
  const [heartbeatSaving, setHeartbeatSaving] = useState(false)
  const [hbDropdownOpen, setHbDropdownOpen] = useState(false)
  const hbDropdownRef = useRef<HTMLDivElement>(null)

  const heartbeatSupported = getEnabledCapabilityIds(session).length > 0
  const loopIsOngoing = appSettings.loopMode === 'ongoing'

  const { heartbeatEnabled, heartbeatIntervalSec, heartbeatExplicitOptIn } = useMemo(() => {
    const parseDur = (v: unknown): number | null => {
      if (v === null || v === undefined) return null
      if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.min(86400, Math.trunc(v))) : null
      if (typeof v !== 'string') return null
      const t = v.trim().toLowerCase()
      if (!t) return null
      const n = Number(t)
      if (Number.isFinite(n)) return Math.max(0, Math.min(86400, Math.trunc(n)))
      const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/)
      if (!m || (!m[1] && !m[2] && !m[3])) return null
      const total = (m[1] ? parseInt(m[1]) * 3600 : 0) + (m[2] ? parseInt(m[2]) * 60 : 0) + (m[3] ? parseInt(m[3]) : 0)
      return Math.max(0, Math.min(86400, total))
    }
    const resolveFrom = (obj: { heartbeatInterval?: string | number | null; heartbeatIntervalSec?: number | null }): number | null => {
      const dur = parseDur(obj.heartbeatInterval)
      if (dur !== null) return dur
      const sec = parseDur(obj.heartbeatIntervalSec)
      if (sec !== null) return sec
      return null
    }
    let sec = resolveFrom(appSettings) ?? DEFAULT_HEARTBEAT_INTERVAL_SEC
    let enabled = sec > 0
    let explicitOptIn = false
    if (agent) {
      if (agent.heartbeatEnabled === false) enabled = false
      if (agent.heartbeatEnabled === true) { enabled = true; explicitOptIn = true }
      sec = resolveFrom(agent) ?? sec
    }
    return {
      heartbeatEnabled: enabled && sec > 0,
      heartbeatIntervalSec: sec,
      heartbeatExplicitOptIn: explicitOptIn,
    }
  }, [appSettings, agent])

  const heartbeatWillRun = heartbeatEnabled && (loopIsOngoing || heartbeatExplicitOptIn)

  // Don't render if heartbeat is not relevant
  if (!heartbeatSupported) return null

  const handleToggleHeartbeat = async () => {
    if (heartbeatSaving) return
    setHeartbeatSaving(true)
    try {
      const next = !heartbeatEnabled
      if (session.agentId) {
        const updatedAgent = await api<Agent>('PUT', `/agents/${session.agentId}`, { heartbeatEnabled: next })
        updateAgentInStore(updatedAgent)
        const updatedSession = await api<Session>('PUT', `/chats/${session.id}`, { heartbeatEnabled: null })
        updateSessionInStore(updatedSession)
      } else {
        const updatedSession = await api<Session>('PUT', `/chats/${session.id}`, { heartbeatEnabled: next })
        updateSessionInStore(updatedSession)
      }
      toast.success(`Heartbeat ${next ? 'enabled' : 'disabled'}`)
    } finally {
      setHeartbeatSaving(false)
    }
  }

  const handleSelectInterval = async (sec: number) => {
    if (heartbeatSaving) return
    setHbDropdownOpen(false)
    setHeartbeatSaving(true)
    try {
      if (session.agentId) {
        const updatedAgent = await api<Agent>('PUT', `/agents/${session.agentId}`, {
          heartbeatInterval: formatDurationSec(sec),
          heartbeatIntervalSec: sec,
        })
        updateAgentInStore(updatedAgent)
        const updatedSession = await api<Session>('PUT', `/chats/${session.id}`, { heartbeatIntervalSec: null, heartbeatEnabled: null })
        updateSessionInStore(updatedSession)
      } else {
        const updatedSession = await api<Session>('PUT', `/chats/${session.id}`, { heartbeatIntervalSec: sec })
        updateSessionInStore(updatedSession)
      }
    } finally {
      setHeartbeatSaving(false)
    }
  }

  const intervalOptions = [1800, 3600, 7200, 21600, 43200]

  return (
    <div className={panelCardClass('p-4')}>
      <div className="flex items-center justify-between mb-2">
        <SectionLabel>Heartbeat</SectionLabel>
        <ToggleSwitch on={heartbeatWillRun} onChange={() => void handleToggleHeartbeat()} disabled={heartbeatSaving} />
      </div>
      {heartbeatWillRun && (
        <div className="flex items-center gap-2 text-[12px] text-text-3/70">
          <span>Every</span>
          <div className="relative" ref={hbDropdownRef}>
            <button
              onClick={() => setHbDropdownOpen((o) => !o)}
              disabled={heartbeatSaving}
              className="px-2 py-0.5 rounded-[6px] bg-white/[0.04] hover:bg-white/[0.08] text-text-2 text-[12px] font-600 cursor-pointer border-none transition-colors"
            >
              {formatDurationSec(heartbeatIntervalSec)}
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="inline ml-1 opacity-40">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {hbDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 py-1 rounded-[10px] border border-white/[0.06] bg-bg/95 backdrop-blur-md shadow-lg z-50 min-w-[88px]">
                {intervalOptions.map((sec) => (
                  <button
                    key={sec}
                    onClick={() => void handleSelectInterval(sec)}
                    className={`w-full text-left px-3 py-1.5 text-[11px] font-600 transition-colors cursor-pointer border-none
                      ${sec === heartbeatIntervalSec ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:bg-white/[0.06]'}`}
                  >
                    {formatDurationSec(sec)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {agent.heartbeatModel && (
            <span className="text-text-3/50 text-[11px]">({agent.heartbeatModel})</span>
          )}
        </div>
      )}
      {heartbeatEnabled && !heartbeatWillRun && (
        <p className="text-[11px] text-amber-300/60">Bounded — runs only when loop mode is ongoing</p>
      )}
      {heartbeatWillRun && (
        <button
          type="button"
          onClick={() => {
            useAppStore.getState().setHeartbeatHistoryOpen(true)
            useAppStore.getState().setInspectorOpen(false)
          }}
          className="mt-2 flex items-center gap-1.5 w-full text-[11px] font-600 text-accent-bright/60 hover:text-accent-bright bg-transparent border-none cursor-pointer transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          View History
        </button>
      )}
    </div>
  )
}

// ─── Tools Section ───────────────────────────────────────────────

function ToolsSection({ agent, session }: { agent: Agent; session: Session }) {
  const refreshSession = useAppStore((s) => s.refreshSession)
  const agentToolIds = getEnabledToolIds(agent)
  const sessionToolIds = getEnabledToolIds(session)
  const sessionExtensions = getEnabledExtensionIds(session)
  const [collapsed, setCollapsed] = useState(agentToolIds.length >= 10)

  if (agentToolIds.length === 0) return null

  const displayTools = collapsed ? agentToolIds.slice(0, 8) : agentToolIds

  const toggleTool = async (toolId: string) => {
    const updated = sessionToolIds.includes(toolId)
      ? sessionToolIds.filter((t) => t !== toolId)
      : [...sessionToolIds, toolId]
    await api('PUT', `/chats/${session.id}`, {
      tools: updated,
      extensions: sessionExtensions,
    })
    await refreshSession(session.id)
  }

  return (
    <div className={panelCardClass('p-4')}>
      <SectionLabel>Tools ({sessionToolIds.length}/{agentToolIds.length})</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {displayTools.map((toolId) => {
          const enabled = sessionToolIds.includes(toolId)
          return (
            <button
              key={toolId}
              type="button"
              onClick={() => void toggleTool(toolId)}
              className={`px-2.5 py-1 rounded-[8px] text-[11px] font-700 border cursor-pointer transition-all ${
                enabled
                  ? 'bg-sky-400/[0.08] text-sky-300 border-sky-400/[0.08] hover:bg-sky-400/[0.15]'
                  : 'bg-white/[0.02] text-text-3/35 border-white/[0.04] hover:bg-white/[0.05] hover:text-text-3/55'
              }`}
            >
              {toolId}
            </button>
          )
        })}
      </div>
      {agentToolIds.length >= 10 && (
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="mt-2 text-[10px] font-600 text-text-3/50 hover:text-text-3/70 bg-transparent border-none cursor-pointer transition-colors"
        >
          {collapsed ? `Show all ${agentToolIds.length} tools` : 'Show fewer'}
        </button>
      )}
    </div>
  )
}

// ─── Audio Section ───────────────────────────────────────────────

function AudioSection() {
  const ttsEnabled = useChatStore((s) => s.ttsEnabled)
  const toggleTts = useChatStore((s) => s.toggleTts)
  const soundEnabled = useChatStore((s) => s.soundEnabled)
  const toggleSound = useChatStore((s) => s.toggleSound)

  return (
    <div className={panelCardClass('p-4')}>
      <SectionLabel>Audio</SectionLabel>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-2">Read aloud (TTS)</span>
          <ToggleSwitch on={ttsEnabled} onChange={toggleTts} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-text-2">Notification sounds</span>
          <ToggleSwitch on={soundEnabled} onChange={toggleSound} />
        </div>
      </div>
    </div>
  )
}

// ─── Memory Section ──────────────────────────────────────────────

function MemorySection({ agentId }: { agentId: string }) {
  const setMemoryAgentFilter = useAppStore((s) => s.setMemoryAgentFilter)
  const memoryRefreshKey = useAppStore((s) => s.memoryRefreshKey)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const navigateTo = useNavigate()
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    searchMemory({ agentId, limit: 5 })
      .then((data) => { if (!cancelled) { setEntries(Array.isArray(data) ? data : []); setLoading(false) } })
      .catch(() => { if (!cancelled) { setEntries([]); setLoading(false) } })
    return () => { cancelled = true }
  }, [agentId, memoryRefreshKey])

  const handleViewAll = () => {
    setMemoryAgentFilter(agentId)
    navigateTo('memory')
    setSidebarOpen(true)
  }

  const tierColor = (category: string) => {
    if (category.includes('working') || category === 'working') return 'text-amber-300 bg-amber-400/10 border-amber-400/15'
    if (category.includes('durable') || category === 'durable') return 'text-emerald-300 bg-emerald-400/10 border-emerald-400/15'
    if (category.includes('archive') || category === 'archive') return 'text-blue-300 bg-blue-400/10 border-blue-400/15'
    return 'text-text-3/60 bg-white/[0.04] border-white/[0.06]'
  }

  return (
    <div className={panelCardClass('p-4')}>
      <div className="flex items-center justify-between mb-2">
        <SectionLabel>Memory</SectionLabel>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={handleViewAll}
            className="text-[10px] font-600 text-accent-bright/60 hover:text-accent-bright bg-transparent border-none cursor-pointer transition-colors"
          >
            View all &raquo;
          </button>
        )}
      </div>
      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-6 rounded-[8px] bg-white/[0.04] animate-pulse" />)}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-[12px] text-text-3/40 italic">No memories yet</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2">
              <span className={`shrink-0 px-1.5 py-0.5 rounded-[5px] text-[9px] font-700 uppercase tracking-wider border ${tierColor(entry.category)}`}>
                {entry.category}
              </span>
              <span className="text-[11px] text-text-3/70 truncate flex-1">{entry.title || entry.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── OpenClaw Actions Section ────────────────────────────────────

function OpenClawActionsSection({ agent }: { agent: Agent }) {
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api<{ url?: string }>('GET', `/openclaw/dashboard-url?agentId=${encodeURIComponent(agent.id)}`)
      .then((data) => { if (!cancelled && data.url) setDashboardUrl(data.url) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [agent.id])

  const handleSync = async () => {
    if (syncing) return
    const sessionKey = buildOpenClawMainSessionKey(agent.name)
    if (!sessionKey) return
    setSyncing(true)
    setSyncStatus(null)
    try {
      const history = await api<unknown>('GET', `/openclaw/history?sessionKey=${encodeURIComponent(sessionKey)}`)
      await api('POST', '/openclaw/history', history)
      setSyncStatus('Synced')
    } catch {
      setSyncStatus('Sync failed')
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncStatus(null), 3000)
    }
  }

  return (
    <div className={panelCardClass('p-4')}>
      <SectionLabel>OpenClaw</SectionLabel>
      <div className="flex flex-col gap-2">
        {dashboardUrl && (
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[12px] text-accent-bright/70 hover:text-accent-bright transition-colors no-underline"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Dashboard
          </a>
        )}
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={syncing}
          className="flex items-center gap-2 text-[12px] font-600 text-text-2 hover:text-text bg-transparent border-none cursor-pointer transition-colors disabled:opacity-50 text-left"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`shrink-0 ${syncing ? 'animate-spin' : ''}`}>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {syncStatus || 'Sync History'}
        </button>
      </div>
    </div>
  )
}

// ─── Quick Actions Section ───────────────────────────────────────

function QuickActionsSection({ agent, session }: { agent: Agent; session: Session }) {
  const messages = useChatStore((s) => s.messages)
  const [draftingSkill, setDraftingSkill] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [activeRuns, setActiveRuns] = useState<Array<{ id: string; title?: string; status: string }>>([])

  const loadRuns = useCallback(() => {
    api<Array<{ id: string; title?: string; status: string }>>('GET', `/protocols/runs?sessionId=${encodeURIComponent(session.id)}&limit=6`)
      .then((runs) => { if (Array.isArray(runs)) setActiveRuns(runs.filter((r) => r.status === 'running' || r.status === 'paused')) })
      .catch(() => {})
  }, [session.id])

  useEffect(() => { loadRuns() }, [loadRuns])
  useWs('protocol_runs', loadRuns)

  const handleDraftSkill = async () => {
    if (draftingSkill) return
    setDraftingSkill(true)
    try {
      await api('POST', '/skill-suggestions', { sessionId: session.id })
      toast.success('Skill draft created')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to draft skill')
    } finally {
      setDraftingSkill(false)
    }
  }

  return (
    <div className={panelCardClass('p-4')}>
      <SectionLabel>Quick Actions</SectionLabel>
      <div className="flex flex-col gap-2">
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => void handleDraftSkill()}
            disabled={draftingSkill}
            className="flex items-center gap-2 text-[12px] font-600 text-text-2 hover:text-text bg-transparent border-none cursor-pointer transition-colors disabled:opacity-50 text-left"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`shrink-0 ${draftingSkill ? 'animate-pulse' : ''}`}>
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            {draftingSkill ? 'Drafting...' : 'Draft Skill'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setLauncherOpen(true)}
          className="flex items-center gap-2 text-[12px] font-600 text-text-2 hover:text-text bg-transparent border-none cursor-pointer transition-colors text-left"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <path d="M9 21V9" />
          </svg>
          Start Structured Session
        </button>
        {activeRuns.map((run) => (
          <span key={run.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[7px] border border-emerald-400/15 bg-emerald-400/10 text-[10px] font-600 text-emerald-300">
            <StatusDot status="online" size="sm" />
            {run.title || 'Active session'}
          </span>
        ))}
      </div>
      <StructuredSessionLauncher
        open={launcherOpen}
        onClose={() => setLauncherOpen(false)}
        initialContext={{ sessionId: session.id, participantAgentIds: [agent.id] }}
      />
    </div>
  )
}

// ─── Sessions Section ────────────────────────────────────────────

function SessionsSection({ agent }: { agent: Agent }) {
  const sessions = useAppStore((s) => s.sessions)
  const connectors = useAppStore((s) => s.connectors)
  const agents = useAppStore((s) => s.agents)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)

  const agentSessions = useMemo(() => {
    return Object.values(sessions).filter((s) => s.agentId === agent.id)
  }, [sessions, agent.id])

  if (agentSessions.length === 0) return null

  return (
    <div className={panelCardClass('p-4')}>
      <SectionLabel>Sessions ({agentSessions.length})</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {agentSessions.map((s) => {
          const connector = getSessionConnector(s, connectors)
          const delegatedByAgentId = (s as unknown as Record<string, unknown>).delegatedByAgentId as string | undefined
          const delegatedBy = delegatedByAgentId ? agents[delegatedByAgentId] : null
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => void setCurrentAgent(agent.id)}
              className="flex items-center gap-2 w-full py-1.5 px-2 rounded-[8px] bg-transparent border-none cursor-pointer hover:bg-white/[0.04] transition-colors text-left"
            >
              {connector ? (
                <ConnectorPlatformIcon platform={connector.platform} size={14} />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/40 shrink-0">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
                </svg>
              )}
              <span className="text-[12px] text-text-2 truncate flex-1">{s.name}</span>
              {delegatedBy && (
                <span className="text-[9px] text-amber-300/60 font-600 shrink-0">from {delegatedBy.name}</span>
              )}
              <StatusDot status={s.active ? 'online' : 'idle'} size="sm" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Sticky Footer ───────────────────────────────────────────────

function StickyFooter({ agent, isMainChat, onEditAgent, onDuplicateAgent, onClearHistory, onDeleteAgent, onDeleteChat }: {
  agent: Agent
  isMainChat?: boolean
  onEditAgent?: () => void
  onDuplicateAgent?: () => void
  onClearHistory?: () => void
  onDeleteAgent?: () => void
  onDeleteChat?: () => void
}) {
  const loadAgents = useAppStore((s) => s.loadAgents)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const [menuOpen, setMenuOpen] = useState(false)
  const [availabilitySaving, setAvailabilitySaving] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handleToggleAvailability = async () => {
    if (availabilitySaving) return
    setAvailabilitySaving(true)
    try {
      const nextDisabled = agent.disabled !== true
      await api('PUT', `/agents/${agent.id}`, { disabled: nextDisabled })
      await Promise.all([loadAgents(), loadSessions()])
      toast.success(nextDisabled ? `${agent.name} disabled` : `${agent.name} enabled`)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update agent availability')
    } finally {
      setAvailabilitySaving(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-white/[0.06] px-4 py-3 bg-black/[0.08]">
      <div className="flex items-center gap-2">
        {onEditAgent && (
          <button
            onClick={onEditAgent}
            className="flex-1 px-3 py-2 rounded-[10px] text-[12px] font-700 text-accent-bright bg-accent-soft/50 border border-accent-bright/10 cursor-pointer transition-all hover:bg-accent-soft text-center"
            style={{ fontFamily: 'inherit' }}
          >
            Edit Agent
          </button>
        )}
        {onDuplicateAgent && (
          <button
            onClick={onDuplicateAgent}
            className="flex-1 px-3 py-2 rounded-[10px] text-[12px] font-700 text-sky-300 bg-sky-400/[0.06] border border-sky-400/[0.1] cursor-pointer transition-all hover:bg-sky-400/[0.1] text-center"
            style={{ fontFamily: 'inherit' }}
          >
            Duplicate
          </button>
        )}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="p-2 rounded-[10px] border border-white/[0.06] bg-white/[0.03] text-text-3/60 hover:text-text-2 hover:bg-white/[0.06] cursor-pointer transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="6" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="18" r="1" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute bottom-full right-0 mb-1.5 py-1 rounded-[10px] border border-white/[0.08] bg-bg/95 backdrop-blur-md shadow-xl z-50 min-w-[160px]"
              style={{ animation: 'fade-in 0.15s ease' }}>
              <button
                onClick={() => { setMenuOpen(false); void handleToggleAvailability() }}
                disabled={availabilitySaving}
                className="w-full text-left px-3 py-2 text-[12px] font-600 text-text-2 hover:bg-white/[0.06] cursor-pointer border-none transition-colors disabled:opacity-50"
              >
                {agent.disabled === true ? 'Enable Agent' : 'Disable Agent'}
              </button>
              {onClearHistory && (
                <button
                  onClick={() => { setMenuOpen(false); onClearHistory() }}
                  className="w-full text-left px-3 py-2 text-[12px] font-600 text-red-400/80 hover:bg-red-400/[0.06] hover:text-red-400 cursor-pointer border-none transition-colors"
                >
                  Clear History
                </button>
              )}
              {onDeleteAgent && !isMainChat && (
                <button
                  onClick={() => { setMenuOpen(false); onDeleteAgent() }}
                  className="w-full text-left px-3 py-2 text-[12px] font-600 text-red-400/80 hover:bg-red-400/[0.06] hover:text-red-400 cursor-pointer border-none transition-colors"
                >
                  Delete Agent
                </button>
              )}
              {onDeleteChat && !isMainChat && (
                <button
                  onClick={() => { setMenuOpen(false); onDeleteChat() }}
                  className="w-full text-left px-3 py-2 text-[12px] font-600 text-red-400/80 hover:bg-red-400/[0.06] hover:text-red-400 cursor-pointer border-none transition-colors"
                >
                  Delete Chat
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Config Tab ──────────────────────────────────────────────────

function ConfigTab({ agent }: { agent: Agent }) {
  const isOpenClaw = agent.provider === 'openclaw'
  const schedules = useAppStore((s) => s.schedules)
  const agentSchedules = Object.values(schedules).filter((s) => s.agentId === agent.id)
  const [executeOpen, setExecuteOpen] = useState(false)
  const [browserSandboxOpen, setBrowserSandboxOpen] = useState(false)
  const [openclawOpen, setOpenclawOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Skills section */}
      <div className={panelCardClass('p-4')}>
        <SectionLabel>Skills</SectionLabel>
        {isOpenClaw ? (
          <OpenClawSkillsPanel
            agentId={agent.id}
            initialMode={agent.openclawSkillMode}
            initialAllowed={agent.openclawAllowedSkills}
          />
        ) : (
          <p className="text-[12px] text-text-3/50">Skills are configured in the agent editor.</p>
        )}
      </div>

      {/* Automations section */}
      <AutomationsSection schedules={agentSchedules} agent={agent} />

      {/* Execute (collapsible) */}
      <CollapsibleSection title="Execute" open={executeOpen} onToggle={() => setExecuteOpen((v) => !v)}>
        <ExecuteToolConfigSection agent={agent} />
      </CollapsibleSection>

      {/* Browser sandbox (collapsible) */}
      <CollapsibleSection title="Browser Sandbox" open={browserSandboxOpen} onToggle={() => setBrowserSandboxOpen((v) => !v)}>
        <BrowserSandboxSection agent={agent} />
      </CollapsibleSection>

      {/* OpenClaw settings (collapsible, OpenClaw only) */}
      {isOpenClaw && (
        <CollapsibleSection title="OpenClaw Settings" open={openclawOpen} onToggle={() => setOpenclawOpen((v) => !v)}>
          <div className="flex flex-col gap-4">
            <PermissionPresetSelector agentId={agent.id} />
            <div className="border-t border-white/[0.06] pt-4">
              <ExecConfigPanel agentId={agent.id} />
            </div>
            <div className="border-t border-white/[0.06] pt-4">
              <SandboxEnvPanel />
            </div>
          </div>
        </CollapsibleSection>
      )}

      {/* Details (collapsible) */}
      <CollapsibleSection title="Details" open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)}>
        <div className="flex flex-col gap-3">
          {agent.thinkingLevel && (
            <div>
              <label className="text-[10px] text-text-3/50 block mb-1">Thinking Level</label>
              <p className="text-[12px] text-text-2 capitalize">{agent.thinkingLevel}</p>
            </div>
          )}
          <div>
            <label className="text-[10px] text-text-3/50 block mb-1">Agent ID</label>
            <p className="text-[12px] text-text-3 font-mono select-all break-all">{agent.id}</p>
          </div>
          <div>
            <label className="text-[10px] text-text-3/50 block mb-1">Created</label>
            <p className="text-[12px] text-text-3">{new Date(agent.createdAt).toLocaleString()}</p>
          </div>
          <div>
            <label className="text-[10px] text-text-3/50 block mb-1">Updated</label>
            <p className="text-[12px] text-text-3">{new Date(agent.updatedAt).toLocaleString()}</p>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  )
}

// ─── Collapsible Section ─────────────────────────────────────────

function CollapsibleSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className={panelCardClass('')}>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-between w-full px-4 py-3 bg-transparent border-none cursor-pointer text-left"
      >
        <span className="text-[11px] font-700 uppercase tracking-[0.16em] text-text-3/45">{title}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`text-text-3/40 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-white/[0.04]">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Automations Section ─────────────────────────────────────────

function AutomationsSection({ schedules, agent }: { schedules: Array<{ id: string; name: string; status: string; cron?: string; scheduleType: string }>; agent: Agent }) {
  const isOpenClaw = agent.provider === 'openclaw'
  const [gatewayCrons, setGatewayCrons] = useState<Array<{ id: string; name: string; enabled: boolean; schedule?: { kind: string; value: string }; state?: { nextRun?: string; lastRun?: string } }>>([])
  const [cronLoading, setCronLoading] = useState(false)
  const [showCronForm, setShowCronForm] = useState(false)

  const loadCrons = useCallback(async () => {
    if (!isOpenClaw) return
    setCronLoading(true)
    try {
      const crons = await api<Array<{ id: string; name: string; enabled: boolean; schedule?: { kind: string; value: string }; state?: { nextRun?: string; lastRun?: string } }>>('GET', '/openclaw/cron')
      setGatewayCrons(crons.filter((c) => (c as Record<string, unknown>).agentId === agent.id))
    } catch { /* ignore */ }
    finally { setCronLoading(false) }
  }, [isOpenClaw, agent.id])

  useEffect(() => { loadCrons() }, [loadCrons])

  const handleRunCron = async (id: string) => {
    try { await api('POST', '/openclaw/cron', { action: 'run', id }) } catch { /* ignore */ }
  }

  const handleRemoveCron = async (id: string) => {
    try {
      await api('POST', '/openclaw/cron', { action: 'remove', id })
      setGatewayCrons((prev) => prev.filter((c) => c.id !== id))
    } catch { /* ignore */ }
  }

  return (
    <div className={panelCardClass('p-4')}>
      <SectionLabel>Automations</SectionLabel>
      <div className="flex flex-col gap-3">
        {schedules.map((s) => (
          <div key={s.id} className="rounded-[10px] border border-white/[0.04] bg-black/[0.08] py-2 px-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-600 text-text truncate flex-1">{s.name}</span>
              <span className={`text-[10px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px]
                ${s.status === 'active' ? 'text-emerald-400 bg-emerald-400/[0.08]' : 'text-text-3/50 bg-white/[0.02]'}`}>
                {s.status}
              </span>
            </div>
            <div className="text-[11px] text-text-3/50 mt-1">
              {s.scheduleType}{s.cron ? ` (${s.cron})` : ''}
            </div>
          </div>
        ))}

        {isOpenClaw && (
          <>
            {cronLoading && <div className="text-[12px] text-text-3/50">Loading gateway crons...</div>}
            {gatewayCrons.map((c) => (
              <div key={c.id} className="rounded-[10px] border border-white/[0.04] bg-black/[0.08] py-2 px-3">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-600 text-text truncate flex-1">{c.name}</span>
                  <span className={`text-[10px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px]
                    ${c.enabled ? 'text-emerald-400 bg-emerald-400/[0.08]' : 'text-text-3/50 bg-white/[0.02]'}`}>
                    {c.enabled ? 'active' : 'disabled'}
                  </span>
                </div>
                <div className="text-[11px] text-text-3/50 mt-1">
                  {c.schedule?.kind} {c.schedule?.value}
                  {c.state?.nextRun && ` — next: ${c.state.nextRun}`}
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={() => void handleRunCron(c.id)} className="text-[10px] text-accent-bright bg-transparent border-none cursor-pointer hover:underline">Run Now</button>
                  <button onClick={() => void handleRemoveCron(c.id)} className="text-[10px] text-red-400/70 bg-transparent border-none cursor-pointer hover:underline">Delete</button>
                </div>
              </div>
            ))}
            {showCronForm ? (
              <CronJobForm agentId={agent.id} onSaved={() => { setShowCronForm(false); void loadCrons() }} onCancel={() => setShowCronForm(false)} />
            ) : (
              <button
                onClick={() => setShowCronForm(true)}
                className="self-start px-3 py-1.5 rounded-[8px] border border-dashed border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:border-white/[0.15] hover:text-text-2"
                style={{ fontFamily: 'inherit' }}
              >
                + Add Cron Job
              </button>
            )}
          </>
        )}

        {!schedules.length && !gatewayCrons.length && !cronLoading && !showCronForm && (
          <p className="text-[12px] text-text-3/50">No automations linked to this agent.</p>
        )}
      </div>
    </div>
  )
}

// ─── Execute Config Section ──────────────────────────────────────

function ExecuteToolConfigSection({ agent }: { agent: Agent }) {
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [saving, setSaving] = useState(false)
  const config = normalizeAgentExecuteConfig(agent.executeConfig)

  const update = useCallback(async (patch: Partial<NonNullable<typeof agent.executeConfig>>) => {
    setSaving(true)
    try {
      const next = {
        ...config,
        ...patch,
        network: {
          ...(config.network || {}),
          ...((patch.network as Record<string, unknown> | undefined) || {}),
        },
      }
      await api('PUT', `/agents/${agent.id}`, { executeConfig: next })
      await loadAgents()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update execute config')
    } finally {
      setSaving(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, config])

  return (
    <div className="pt-3 flex flex-col gap-3">
      <div className="text-[11px] text-text-3/60">
        `execute` uses just-bash in sandbox mode by default. Host mode is explicit and required for persistent writes.
      </div>
      <div>
        <label className="text-[10px] text-text-3/50 block mb-1">Backend</label>
        <select
          value={config.backend || 'sandbox'}
          onChange={(e) => void update({ backend: e.target.value as 'sandbox' | 'host' })}
          disabled={saving}
          className="w-full rounded-[8px] border border-white/[0.06] bg-black/[0.14] px-2.5 py-1.5 text-[12px] text-text outline-none cursor-pointer focus:border-accent-bright/30"
        >
          <option value="sandbox">sandbox (just-bash)</option>
          <option value="host">host (real bash)</option>
        </select>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-3/60">Allow network in sandbox mode</span>
        <ToggleSwitch
          on={config.network?.enabled !== false}
          onChange={() => void update({ network: { ...(config.network || {}), enabled: config.network?.enabled === false } })}
          disabled={saving}
        />
      </div>
      <div>
        <label className="text-[10px] text-text-3/50 block mb-1">Timeout (seconds)</label>
        <input
          type="number"
          defaultValue={config.timeout || 30}
          min={1}
          max={300}
          onBlur={(e) => void update({ timeout: Math.max(1, Math.min(300, Number(e.target.value) || 30)) })}
          className="w-full rounded-[8px] border border-white/[0.06] bg-black/[0.14] px-2.5 py-1.5 text-[12px] text-text font-mono outline-none focus:border-accent-bright/30"
        />
      </div>
      <div className="text-[11px] text-text-3/50">
        `shell` remains the host command/process tool. Use `execute` for sandboxed one-shot scripts.
      </div>
    </div>
  )
}

// ─── Browser Sandbox Section ─────────────────────────────────────

function BrowserSandboxSection({ agent }: { agent: Agent }) {
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [saving, setSaving] = useState(false)
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null)
  const config = normalizeAgentSandboxConfig(agent.sandboxConfig)
  const browserEnabled = config.enabled && config.browser?.enabled !== false

  useEffect(() => {
    api<{ docker?: { available: boolean; version?: string | null } }>('GET', '/setup/doctor')
      .then((data) => setDockerAvailable(data?.docker?.available ?? false))
      .catch(() => setDockerAvailable(false))
  }, [])

  const update = useCallback(async (patch: Partial<NonNullable<typeof agent.sandboxConfig>>) => {
    setSaving(true)
    try {
      const next = {
        ...config,
        ...patch,
        browser: patch.browser === null
          ? null
          : {
              ...(config.browser || {}),
              ...((patch.browser as Record<string, unknown> | undefined) || {}),
            },
      }
      await api('PUT', `/agents/${agent.id}`, { sandboxConfig: next })
      await loadAgents()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update sandbox config')
    } finally {
      setSaving(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, config])

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] text-text-2">Use Docker browser sandbox</span>
        <ToggleSwitch
          on={browserEnabled}
          onChange={() => void update({
            enabled: !browserEnabled,
            browser: {
              ...(config.browser || {}),
              enabled: !browserEnabled,
            },
          })}
          disabled={saving}
        />
      </div>
      {dockerAvailable === false && (
        <div className="text-[11px] text-amber-400/80 bg-amber-400/[0.06] rounded-[8px] px-2.5 py-2 mb-3 border border-amber-400/10">
          Docker is not detected. Browser automation will use the host Playwright runtime.
        </div>
      )}
      {dockerAvailable === true && (
        <div className="text-[11px] text-emerald-400/70 mb-3 flex items-center gap-1.5">
          <StatusDot status="online" size="sm" /> Docker available for browser sandboxing
        </div>
      )}
      {browserEnabled && (
        <div className="flex flex-col gap-2.5 mt-1">
          <div>
            <label className="text-[10px] text-text-3/50 block mb-1">Scope</label>
            <select
              defaultValue={config.scope || 'session'}
              onChange={(e) => void update({ scope: e.target.value as 'session' | 'agent' })}
              className="w-full rounded-[8px] border border-white/[0.06] bg-black/[0.14] px-2.5 py-1.5 text-[12px] text-text outline-none cursor-pointer focus:border-accent-bright/30"
            >
              <option value="session">session</option>
              <option value="agent">agent</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-text-3/50 block mb-1">Mode</label>
            <select
              defaultValue={config.mode === 'non-main' ? 'non-main' : 'all'}
              onChange={(e) => void update({ mode: e.target.value as 'all' | 'non-main' })}
              className="w-full rounded-[8px] border border-white/[0.06] bg-black/[0.14] px-2.5 py-1.5 text-[12px] text-text outline-none cursor-pointer focus:border-accent-bright/30"
            >
              <option value="all">all sessions</option>
              <option value="non-main">non-main sessions only</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-text-3/50 block mb-1">Workspace access</label>
            <select
              defaultValue={config.workspaceAccess || 'rw'}
              onChange={(e) => void update({ workspaceAccess: e.target.value as 'ro' | 'rw' })}
              className="w-full rounded-[8px] border border-white/[0.06] bg-black/[0.14] px-2.5 py-1.5 text-[12px] text-text outline-none cursor-pointer focus:border-accent-bright/30"
            >
              <option value="rw">read/write</option>
              <option value="ro">read-only</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-text-3/50 block mb-1">Browser network</label>
            <select
              defaultValue={config.browser?.network || 'bridge'}
              onChange={(e) => void update({ browser: { ...(config.browser || {}), network: e.target.value as 'none' | 'bridge' } })}
              className="w-full rounded-[8px] border border-white/[0.06] bg-black/[0.14] px-2.5 py-1.5 text-[12px] text-text outline-none cursor-pointer focus:border-accent-bright/30"
            >
              <option value="none">none (isolated)</option>
              <option value="bridge">bridge (internet access)</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-3/60">Headless browser</span>
            <ToggleSwitch
              on={config.browser?.headless !== false}
              onChange={() => void update({ browser: { ...(config.browser || {}), headless: config.browser?.headless === false } })}
              disabled={saving}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-3/60">Enable noVNC observer</span>
            <ToggleSwitch
              on={config.browser?.enableNoVnc !== false}
              onChange={() => void update({ browser: { ...(config.browser || {}), enableNoVnc: config.browser?.enableNoVnc === false } })}
              disabled={saving}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-3/60">Mount uploads into sandbox browser</span>
            <ToggleSwitch
              on={config.browser?.mountUploads !== false}
              onChange={() => void update({ browser: { ...(config.browser || {}), mountUploads: config.browser?.mountUploads === false } })}
              disabled={saving}
            />
          </div>
        </div>
      )}
    </div>
  )
}
