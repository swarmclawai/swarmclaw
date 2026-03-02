'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import type { Session } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { IconButton } from '@/components/shared/icon-button'
import { UsageBadge } from '@/components/shared/usage-badge'
import { ChatToolToggles } from './chat-tool-toggles'
import { api } from '@/lib/api-client'
import {
  ConnectorPlatformIcon,
  CONNECTOR_PLATFORM_META,
  getSessionConnector,
} from '@/components/shared/connector-platform-icon'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ModelCombobox } from '@/components/shared/model-combobox'
import { toast } from 'sonner'
import type { ProviderType } from '@/types'

function shortPath(p: string): string {
  return (p || '').replace(/^\/Users\/\w+/, '~')
}

function formatDuration(sec: number): string {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return m > 0 ? `${h}h${m}m` : `${h}h`
  }
  if (sec >= 60) return `${Math.floor(sec / 60)}m`
  return `${sec}s`
}

const PROVIDER_LABELS: Record<string, string> = {
  'claude-cli': 'CLI',
  openai: 'OpenAI',
  ollama: 'Ollama',
  anthropic: 'Anthropic',
}

interface Props {
  session: Session
  streaming: boolean
  onStop: () => void
  onMenuToggle: () => void
  onBack?: () => void
  mobile?: boolean
  browserActive?: boolean
  onStopBrowser?: () => void
  onVoiceToggle?: () => void
  voiceActive?: boolean
  voiceSupported?: boolean
  heartbeatHistoryOpen?: boolean
  onToggleHeartbeatHistory?: () => void
}

export function ChatHeader({ session, streaming, onStop, onMenuToggle, onBack, mobile, browserActive, onStopBrowser, onVoiceToggle, voiceActive, voiceSupported, heartbeatHistoryOpen, onToggleHeartbeatHistory }: Props) {
  const ttsEnabled = useChatStore((s) => s.ttsEnabled)
  const toggleTts = useChatStore((s) => s.toggleTts)
  const soundEnabled = useChatStore((s) => s.soundEnabled)
  const toggleSound = useChatStore((s) => s.toggleSound)
  const debugOpen = useChatStore((s) => s.debugOpen)
  const setDebugOpen = useChatStore((s) => s.setDebugOpen)
  const lastUsage = useChatStore((s) => s.lastUsage)
  const agentStatus = useChatStore((s) => s.agentStatus)
  const agents = useAppStore((s) => s.agents)
  const tasks = useAppStore((s) => s.tasks)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setMemoryAgentFilter = useAppStore((s) => s.setMemoryAgentFilter)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const appSettings = useAppStore((s) => s.appSettings)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const inspectorOpen = useAppStore((s) => s.inspectorOpen)
  const setInspectorOpen = useAppStore((s) => s.setInspectorOpen)
  const connectors = useAppStore((s) => s.connectors)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const agent = session.agentId ? agents[session.agentId] : null
  const connector = getSessionConnector(session, connectors)
  const connectorMeta = connector ? CONNECTOR_PLATFORM_META[connector.platform] : null
  const connectorPresence = connector?.presence
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const modelName = session.model || agent?.model || ''
  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false)
  const modelSwitcherRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [heartbeatSaving, setHeartbeatSaving] = useState(false)
  const [hbDropdownOpen, setHbDropdownOpen] = useState(false)
  const hbDropdownRef = useRef<HTMLDivElement>(null)
  const [mainLoopSaving, setMainLoopSaving] = useState(false)
  const [mainLoopError, setMainLoopError] = useState('')
  const [mainLoopNotice, setMainLoopNotice] = useState('')
  const [syncingHistory, setSyncingHistory] = useState(false)
  const [syncResult, setSyncResult] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameContainerRef = useRef<HTMLSpanElement>(null)

  // Find linked task for this session
  const linkedTask = useMemo(() => {
    return Object.values(tasks).find((t) => t.sessionId === session.id)
  }, [tasks, session.id])

  const resumeHandle = useMemo(() => {
    const fromSessionClaude = session.claudeSessionId
      ? { label: 'Claude', id: session.claudeSessionId, command: `claude --resume ${session.claudeSessionId}` }
      : null
    const fromSessionCodex = session.codexThreadId
      ? { label: 'Codex', id: session.codexThreadId, command: `codex exec resume ${session.codexThreadId}` }
      : null
    const fromSessionOpenCode = session.opencodeSessionId
      ? { label: 'OpenCode', id: session.opencodeSessionId, command: `opencode run \"<task>\" --session ${session.opencodeSessionId}` }
      : null
    const fromDelegateClaude = session.delegateResumeIds?.claudeCode
      ? { label: 'Claude', id: session.delegateResumeIds.claudeCode, command: `claude --resume ${session.delegateResumeIds.claudeCode}` }
      : null
    const fromDelegateCodex = session.delegateResumeIds?.codex
      ? { label: 'Codex', id: session.delegateResumeIds.codex, command: `codex exec resume ${session.delegateResumeIds.codex}` }
      : null
    const fromDelegateOpenCode = session.delegateResumeIds?.opencode
      ? { label: 'OpenCode', id: session.delegateResumeIds.opencode, command: `opencode run \"<task>\" --session ${session.delegateResumeIds.opencode}` }
      : null
    return fromSessionClaude
      || fromSessionCodex
      || fromSessionOpenCode
      || fromDelegateClaude
      || fromDelegateCodex
      || fromDelegateOpenCode
      || null
  }, [session.claudeSessionId, session.codexThreadId, session.opencodeSessionId, session.delegateResumeIds])

  const handleCopySessionId = () => {
    if (!resumeHandle) return
    navigator.clipboard.writeText(resumeHandle.command)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDismissResumeHandle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await api('PUT', `/sessions/${session.id}`, {
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null },
      })
      await loadSessions()
    } catch { /* best-effort */ }
  }

  const heartbeatSupported = (session.tools?.length ?? 0) > 0
  const loopIsOngoing = appSettings.loopMode === 'ongoing'
  const { heartbeatEnabled, heartbeatIntervalSec, heartbeatExplicitOptIn } = useMemo(() => {
    // Resolve through the same cascade as the backend: settings → agent → session
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
    // Global defaults
    let sec = resolveFrom(appSettings) ?? 1800
    let enabled = sec > 0
    let explicitOptIn = false
    // Agent layer
    if (agent) {
      if (agent.heartbeatEnabled === false) enabled = false
      if (agent.heartbeatEnabled === true) { enabled = true; explicitOptIn = true }
      sec = resolveFrom(agent) ?? sec
    }
    // Session layer — only applies for non-agent chats (agent chats save directly to agent)
    if (!agent) {
      if (session.heartbeatEnabled === false) enabled = false
      if (session.heartbeatEnabled === true) { enabled = true; explicitOptIn = true }
      sec = resolveFrom(session) ?? sec
    }
    return {
      heartbeatEnabled: enabled && sec > 0,
      heartbeatIntervalSec: sec,
      heartbeatExplicitOptIn: explicitOptIn,
    }
  }, [appSettings, agent, session])
  const heartbeatWillRun = heartbeatEnabled && (loopIsOngoing || heartbeatExplicitOptIn)
  const isMainSession = session.name === '__main__'
  const missionState = session.mainLoopState || {}
  const missionPaused = missionState.paused === true
  const missionMode = missionState.autonomyMode === 'assist' ? 'assist' : 'autonomous'
  const missionStatus = missionState.status || 'idle'
  const missionMomentum = typeof missionState.momentumScore === 'number' ? missionState.momentumScore : null
  const missionEventsCount = missionState.pendingEvents?.length || 0

  const handleToggleHeartbeat = async () => {
    if (!heartbeatSupported || heartbeatSaving) return
    setHeartbeatSaving(true)
    try {
      const next = !heartbeatEnabled
      if (session.agentId) {
        await api('PUT', `/agents/${session.agentId}`, { heartbeatEnabled: next })
        // Clear any stale session-level override so the agent value wins
        await api('PUT', `/sessions/${session.id}`, { heartbeatEnabled: null })
        await Promise.all([loadAgents(), loadSessions()])
      } else {
        await api('PUT', `/sessions/${session.id}`, { heartbeatEnabled: next })
        await loadSessions()
      }
      toast.success(`Heartbeat ${next ? 'enabled' : 'disabled'}`)
    } finally {
      setHeartbeatSaving(false)
    }
  }

  const handleSelectHeartbeatInterval = async (sec: number) => {
    if (!heartbeatSupported || heartbeatSaving) return
    setHbDropdownOpen(false)
    setHeartbeatSaving(true)
    try {
      if (session.agentId) {
        // Save to agent with both formats so the cascade resolves correctly
        await api('PUT', `/agents/${session.agentId}`, {
          heartbeatInterval: formatDuration(sec),
          heartbeatIntervalSec: sec,
          heartbeatEnabled: true,
        })
        // Clear stale session-level overrides
        await api('PUT', `/sessions/${session.id}`, { heartbeatIntervalSec: null, heartbeatEnabled: null })
        await Promise.all([loadAgents(), loadSessions()])
      } else {
        await api('PUT', `/sessions/${session.id}`, { heartbeatIntervalSec: sec, heartbeatEnabled: true })
        await loadSessions()
      }
    } finally {
      setHeartbeatSaving(false)
    }
  }

  const postMainLoopAction = async (action: string, extra?: Record<string, unknown>) => {
    if (!isMainSession || mainLoopSaving) return
    setMainLoopSaving(true)
    try {
      const result = await api<{ runId?: string; deduped?: boolean }>('POST', `/sessions/${session.id}/main-loop`, {
        action,
        ...(extra || {}),
      })
      setMainLoopError('')
      if (action === 'nudge') {
        setMainLoopNotice(result?.deduped ? 'Nudge already queued.' : 'Nudge queued.')
      } else if (action === 'set_mode') {
        setMainLoopNotice(`Mode set to ${extra?.mode === 'assist' ? 'Assist' : 'Auto'}.`)
      } else {
        setMainLoopNotice('')
      }
      await loadSessions()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update mission controls.'
      setMainLoopError(message)
    } finally {
      setMainLoopSaving(false)
    }
  }

  const handleToggleMissionPause = () => {
    void postMainLoopAction(missionPaused ? 'resume' : 'pause')
  }

  const handleToggleMissionMode = () => {
    const nextMode = missionMode === 'autonomous' ? 'assist' : 'autonomous'
    void postMainLoopAction('set_mode', { mode: nextMode })
  }

  const handleNudgeMission = () => {
    void postMainLoopAction('nudge')
  }

  const handleSetMissionGoal = () => {
    if (!isMainSession) return
    const seededGoal = typeof missionState.goal === 'string' ? missionState.goal : ''
    const raw = window.prompt('Set mission goal', seededGoal)
    const goal = (raw || '').trim()
    if (!goal) return
    void postMainLoopAction('set_goal', { goal })
  }

  const handleClearMissionEvents = () => {
    if (!isMainSession || missionEventsCount <= 0) return
    void postMainLoopAction('clear_events')
  }

  const isOpenClawAgent = agent?.provider === 'openclaw'
  // Derive OpenClaw session key: agent sessions use "agent:<name>:main" convention
  const openclawSessionKey = isOpenClawAgent && agent
    ? `agent:${agent.name.toLowerCase().replace(/\s+/g, '-')}:main`
    : null

  const handleSyncHistory = async () => {
    if (!openclawSessionKey || syncingHistory) return
    setSyncingHistory(true)
    setSyncResult('')
    try {
      const preview = await api<{ sessionKey: string; epoch: number; messages: Array<{ role: string; content: string; ts: number }> }>(
        'GET', `/openclaw/history?sessionKey=${encodeURIComponent(openclawSessionKey)}`,
      )
      if (!preview?.messages?.length) {
        setSyncResult('No new messages found.')
        return
      }
      const result = await api<{ ok: boolean; merged: number }>(
        'POST', '/openclaw/history',
        { sessionKey: openclawSessionKey, epoch: preview.epoch, localSessionId: session.id },
      )
      setSyncResult(result.merged > 0 ? `Synced ${result.merged} message${result.merged !== 1 ? 's' : ''}.` : 'Already up to date.')
      if (result.merged > 0) await loadSessions()
    } catch (err: unknown) {
      setSyncResult(err instanceof Error ? err.message : 'Sync failed.')
    } finally {
      setSyncingHistory(false)
    }
  }

  useEffect(() => {
    if (!syncResult) return
    const timer = setTimeout(() => setSyncResult(''), 3000)
    return () => clearTimeout(timer)
  }, [syncResult])

  const startRename = () => {
    if (!agent) return
    setRenameDraft(agent.name)
    setRenameError('')
    setRenaming(true)
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }

  const cancelRename = () => {
    setRenaming(false)
    setRenameDraft('')
    setRenameError('')
  }

  const commitRename = async () => {
    if (!agent || renameSaving) return
    const trimmed = renameDraft.trim()
    if (!trimmed || trimmed === agent.name) {
      cancelRename()
      return
    }
    setRenameSaving(true)
    setRenameError('')
    try {
      await api('PUT', `/agents/${agent.id}`, { name: trimmed })
      await loadAgents()
      setRenaming(false)
    } catch (err: unknown) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setRenameSaving(false)
    }
  }

  useEffect(() => {
    if (!renaming) return
    const handler = (e: PointerEvent) => {
      if (renameContainerRef.current && !renameContainerRef.current.contains(e.target as Node)) {
        cancelRename()
      }
    }
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [renaming])

  useEffect(() => {
    if (!hbDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (hbDropdownRef.current && !hbDropdownRef.current.contains(e.target as Node)) setHbDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [hbDropdownOpen])

  useEffect(() => {
    if (!modelSwitcherOpen) return
    const handler = (e: MouseEvent) => {
      if (modelSwitcherRef.current && !modelSwitcherRef.current.contains(e.target as Node)) setModelSwitcherOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [modelSwitcherOpen])

  const handleModelSwitch = async (nextProvider: ProviderType, nextModel: string) => {
    setModelSwitcherOpen(false)
    try {
      await api('PUT', `/sessions/${session.id}`, { provider: nextProvider, model: nextModel })
      await loadSessions()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to switch model')
    }
  }

  const currentProviderInfo = providers.find((p) => p.id === session.provider)
  const currentModels = currentProviderInfo?.models || []

  useEffect(() => {
    if (session.name.startsWith('connector:')) {
      void loadConnectors()
    }
  }, [session.name, loadConnectors])

  useEffect(() => {
    setMainLoopError('')
    setMainLoopNotice('')
    setModelSwitcherOpen(false)
  }, [session.id])

  useEffect(() => {
    if (!mainLoopNotice) return
    const timer = setTimeout(() => setMainLoopNotice(''), 2500)
    return () => clearTimeout(timer)
  }, [mainLoopNotice])

  // Context bar shows for tools, mission controls, memories, task links, resume handles, browser
  const hasToolToggles = ((agent?.tools?.length ?? 0) > 0) || ((session.tools?.length ?? 0) > 0)
  const hasMemoryLink = !!(agent && session.tools?.includes('memory'))
  const hasContextBar = !!(hasToolToggles || isMainSession || hasMemoryLink || linkedTask || resumeHandle || (isOpenClawAgent && openclawSessionKey) || browserActive)

  return (
    <header
      className="relative z-20 border-b border-white/[0.06] shrink-0"
      style={{
        background: 'linear-gradient(180deg, rgba(var(--rgb-bg, 15,15,26), 0.95) 0%, rgba(var(--rgb-bg, 15,15,26), 0.88) 100%)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        ...(mobile ? { paddingTop: 'max(12px, env(safe-area-inset-top))' } : {}),
      }}
    >
      {/* Main row */}
      <div className="flex items-center gap-2 px-3.5 py-1.5 min-h-[48px]">
        {/* Back button */}
        {onBack && (
          <IconButton onClick={onBack} aria-label="Go back" size="sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </IconButton>
        )}

        {/* Avatar */}
        {agent && (
          <div className="relative shrink-0">
            {streaming && (
              <div
                className="absolute -inset-[3px] rounded-full opacity-40"
                style={{
                  background: 'conic-gradient(from 0deg, var(--color-accent-bright), transparent 120deg, transparent 240deg, var(--color-accent-bright))',
                  animation: 'spin 2.5s linear infinite',
                  filter: 'blur(3px)',
                }}
              />
            )}
            <div
              className="relative rounded-full"
              style={{
                padding: 2,
                background: streaming
                  ? 'conic-gradient(from 0deg, var(--color-accent-bright), transparent 120deg, transparent 240deg, var(--color-accent-bright))'
                  : 'linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03))',
                animation: streaming ? 'spin 2.5s linear infinite' : undefined,
              }}
            >
              <div className="rounded-full bg-bg">
                <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={hasContextBar ? 44 : 34} />
              </div>
            </div>
          </div>
        )}

        {/* Identity + metadata — fills center */}
        <div className="flex-1 min-w-0 flex items-center gap-3">
          {/* Name + inline badges */}
          <div className="flex items-center gap-2 min-w-0 shrink">
            {renaming && agent ? (
              <span ref={renameContainerRef} className="inline-flex items-center gap-2">
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') cancelRename()
                  }}
                  disabled={renameSaving}
                  className="font-display text-[15px] font-700 tracking-[-0.02em] bg-transparent border-b border-accent-bright/40 outline-none text-text px-0 py-0 w-[180px]"
                  style={{ fontFamily: 'inherit' }}
                />
                {renameSaving && <span className="w-3 h-3 rounded-full border-2 border-text-3/30 border-t-accent-bright animate-spin shrink-0" />}
                {renameError && <span className="text-[10px] text-red-400 shrink-0">{renameError}</span>}
              </span>
            ) : (
              <span
                className={`font-display text-[15px] font-700 truncate tracking-[-0.02em] text-text${agent ? ' cursor-pointer hover:text-accent-bright transition-colors duration-200' : ''}`}
                onClick={agent ? startRename : undefined}
                title={agent ? 'Click to rename' : undefined}
              >{
                session.name === '__main__' ? 'Main Chat'
                : session.name.startsWith('agent-thread:') ? (agent?.name || session.name)
                : session.name
              }</span>
            )}
            {connector && connectorMeta && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[5px] border text-[9px] font-700 uppercase tracking-wider shrink-0"
                style={{
                  color: connectorMeta.color,
                  backgroundColor: `${connectorMeta.color}10`,
                  borderColor: `${connectorMeta.color}20`,
                }}
                title={`${connector.name} connector`}
              >
                <ConnectorPlatformIcon platform={connector.platform} size={10} />
                {connectorMeta.label}
              </span>
            )}
            {connector && connectorPresence && (() => {
              const lastAt = connectorPresence.lastMessageAt
              if (!lastAt) return (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-text-3/40">
                  <span className="w-1.5 h-1.5 rounded-full bg-text-3/30" />
                  Idle
                </span>
              )
              const ago = Date.now() - lastAt
              const isActive = ago < 5 * 60_000
              const isRecent = ago < 30 * 60_000
              const label = isActive ? 'Active' : isRecent ? `${Math.floor(ago / 60_000)}m ago` : 'Idle'
              const dotColor = isActive ? 'bg-emerald-400' : isRecent ? 'bg-amber-400' : 'bg-text-3/30'
              const textColor = isActive ? 'text-emerald-400' : isRecent ? 'text-amber-300' : 'text-text-3/40'
              return (
                <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] ${textColor}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                  {label}
                </span>
              )
            })()}
            {agent?.isOrchestrator && (
              <span className="px-1.5 py-0.5 rounded-[5px] bg-amber-500/10 text-amber-500 text-[9px] font-700 uppercase tracking-wider shrink-0">Orch</span>
            )}
            {streaming && (
              <span className="shrink-0 w-2 h-2 rounded-full bg-accent-bright" style={{ animation: 'pulse 1.5s ease infinite' }} />
            )}
          </div>

          {/* Metadata tray: model · usage · path · status */}
          <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
            <span className="text-text-3/10 text-[10px] select-none shrink-0">/</span>
            {modelName && (
              <div className="relative shrink-0" ref={modelSwitcherRef}>
                <button
                  type="button"
                  onClick={() => {
                    if (streaming) return
                    setModelSwitcherOpen((o) => { if (!o) void loadProviders(); return !o })
                  }}
                  disabled={streaming}
                  className="inline-flex items-center gap-1 text-[11px] text-text-3/45 font-mono shrink-0 cursor-pointer bg-transparent border-none px-1 py-0.5 rounded-[5px] hover:bg-white/[0.04] hover:text-text-3/70 transition-colors disabled:cursor-default disabled:hover:text-text-3/45"
                  title="Switch model"
                >
                  {modelName}
                  <svg width="7" height="7" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-30">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                {modelSwitcherOpen && (
                  <div className="absolute z-50 top-full left-0 mt-2 w-[280px] rounded-[12px] border border-white/[0.08] bg-surface backdrop-blur-md shadow-xl p-3">
                    <div className="text-[10px] font-600 text-text-3/50 uppercase tracking-wider mb-2">Provider</div>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {providers.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => { if (p.id !== session.provider) void handleModelSwitch(p.id, p.models[0] || '') }}
                          className={`px-2.5 py-1 rounded-[7px] text-[11px] font-600 border-none cursor-pointer transition-colors
                            ${p.id === session.provider ? 'bg-accent-bright/15 text-accent-bright' : 'bg-white/[0.04] text-text-3 hover:bg-white/[0.08]'}`}
                        >
                          {PROVIDER_LABELS[p.id] || p.id}
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] font-600 text-text-3/50 uppercase tracking-wider mb-2">Model</div>
                    <ModelCombobox
                      providerId={session.provider}
                      value={modelName}
                      onChange={(m) => void handleModelSwitch(session.provider, m)}
                      models={currentModels}
                      defaultModels={currentProviderInfo?.defaultModels}
                      className="px-2.5 py-1.5 rounded-[7px] text-[12px] font-mono bg-white/[0.04] hover:bg-white/[0.06] transition-colors"
                    />
                  </div>
                )}
              </div>
            )}
            {lastUsage && !streaming && (
              <>
                <span className="text-text-3/10 text-[10px] select-none shrink-0">·</span>
                <UsageBadge {...lastUsage} />
              </>
            )}
            <button
              type="button"
              onClick={() => { api('POST', '/files/open', { path: session.cwd }).catch(() => {}) }}
              className="inline-flex items-center shrink-0 bg-transparent border-none p-0.5 rounded-[4px] cursor-pointer text-text-3/20 hover:text-text-3/50 hover:bg-white/[0.04] transition-colors"
              title={shortPath(session.cwd)}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            {/* Live agent status */}
            {(() => {
              const liveStatus = agentStatus || (missionState.status ? {
                goal: missionState.goal ?? undefined,
                status: missionState.status ?? undefined,
                summary: missionState.summary ?? undefined,
                nextAction: missionState.nextAction ?? undefined,
              } : null)
              if (!liveStatus) return null
              const statusColors: Record<string, string> = {
                idle: 'bg-text-3/40', progress: 'bg-blue-500', blocked: 'bg-amber-400', ok: 'bg-emerald-400',
              }
              const dotColor = statusColors[liveStatus.status || ''] || 'bg-text-3/40'
              return (
                <>
                  <span className="text-text-3/10 text-[10px] select-none shrink-0">·</span>
                  {liveStatus.status && (
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[9px] font-700 uppercase tracking-wider ${
                      liveStatus.status === 'blocked' ? 'bg-amber-400/12 text-amber-300'
                      : liveStatus.status === 'ok' ? 'bg-emerald-400/12 text-emerald-400'
                      : liveStatus.status === 'progress' ? 'bg-blue-500/12 text-blue-400'
                      : 'bg-white/[0.03] text-text-3/50'
                    }`}>
                      <span className={`w-1 h-1 rounded-full ${dotColor}`} />
                      {liveStatus.status}
                    </span>
                  )}
                  {liveStatus.goal && (
                    <span className="text-[10px] text-text-3/40 font-mono truncate max-w-[180px]" title={liveStatus.goal}>
                      {liveStatus.goal}
                    </span>
                  )}
                  {liveStatus.nextAction && (
                    <>
                      <span className="text-[9px] text-text-3/20 shrink-0">→</span>
                      <span className="text-[10px] text-text-3/35 font-mono truncate max-w-[140px]" title={liveStatus.nextAction}>
                        {liveStatus.nextAction}
                      </span>
                    </>
                  )}
                </>
              )
            })()}
          </div>
        </div>

        {/* Heartbeat compound control */}
        {heartbeatSupported && (
          <div className="flex items-center rounded-[8px] shrink-0" style={{ background: 'rgba(255,255,255,0.025)' }}>
            <button
              onClick={handleToggleHeartbeat}
              disabled={heartbeatSaving}
              className={`flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 transition-colors cursor-pointer border-none text-[11px] font-600
                ${heartbeatWillRun ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-text-3/60 hover:bg-white/[0.04]'}`}
              title={heartbeatWillRun ? 'Disable heartbeat' : 'Enable heartbeat'}
            >
              <span className={`w-1.5 h-1.5 rounded-full transition-colors ${heartbeatWillRun ? 'bg-emerald-400' : 'bg-text-3/30'}`} />
              HB
              {heartbeatEnabled && !loopIsOngoing && !heartbeatExplicitOptIn && (
                <span className="text-[9px] text-text-3/40">(bounded)</span>
              )}
            </button>
            <div className="relative" ref={hbDropdownRef}>
              <button
                onClick={() => setHbDropdownOpen((o) => !o)}
                disabled={heartbeatSaving}
                className="flex items-center gap-0.5 pl-1 pr-2 py-1 text-text-3/50 hover:text-text-3/70 hover:bg-white/[0.04] transition-colors cursor-pointer border-none"
                title="Set heartbeat interval"
              >
                <span className="text-[11px] font-600">{formatDuration(heartbeatIntervalSec)}</span>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="opacity-40">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {hbDropdownOpen && (
                <div className="absolute top-full right-0 mt-1 py-1 rounded-[10px] border border-white/[0.06] bg-bg/95 backdrop-blur-md shadow-lg z-50 min-w-[80px]">
                  {[1800, 3600, 7200, 21600, 43200].map((sec) => (
                    <button
                      key={sec}
                      onClick={() => handleSelectHeartbeatInterval(sec)}
                      className={`w-full text-left px-3 py-1.5 text-[11px] font-600 transition-colors cursor-pointer border-none
                        ${sec === heartbeatIntervalSec ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:bg-white/[0.06]'}`}
                    >
                      {formatDuration(sec)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center shrink-0">
          {streaming && (
            <>
              <IconButton onClick={onStop} variant="danger" tooltip="Stop" aria-label="Stop generation" size="sm">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </IconButton>
              <div className="w-px h-3.5 bg-white/[0.06] mx-0.5" />
            </>
          )}
          <IconButton onClick={toggleSound} active={soundEnabled} tooltip="Notifications" aria-label="Toggle sound" size="sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
          </IconButton>
          <IconButton onClick={toggleTts} active={ttsEnabled} tooltip="Read aloud" aria-label="Toggle TTS" size="sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          </IconButton>
          {voiceSupported && onVoiceToggle && (
            <IconButton onClick={onVoiceToggle} active={voiceActive} tooltip="Voice mode" aria-label="Toggle voice" size="sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </IconButton>
          )}
          {agent?.heartbeatEnabled && onToggleHeartbeatHistory && (
            <IconButton onClick={onToggleHeartbeatHistory} active={heartbeatHistoryOpen} tooltip="Heartbeat history" aria-label="Toggle heartbeat history" size="sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill={heartbeatHistoryOpen ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </IconButton>
          )}
          <div className="w-px h-3.5 bg-white/[0.06] mx-0.5" />
          <IconButton onClick={() => setDebugOpen(!debugOpen)} active={debugOpen} tooltip="Debug" aria-label="Toggle debug panel" size="sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" />
            </svg>
          </IconButton>
          {(!agent || mobile) && (
            <IconButton onClick={(e) => { e.stopPropagation(); onMenuToggle() }} tooltip="Menu" aria-label="Chat menu" size="sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="12" cy="6" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="18" r="1" />
              </svg>
            </IconButton>
          )}
          {agent && (
            <IconButton onClick={() => setInspectorOpen(!inspectorOpen)} active={inspectorOpen} tooltip="Settings" aria-label="Toggle inspector" size="sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </IconButton>
          )}
        </div>
      </div>

      {/* Context bar: tools, mission controls, links */}
      {hasContextBar && (
        <div className="flex items-center gap-1.5 px-3.5 pb-1.5 overflow-x-auto scrollbar-none">
          {hasToolToggles && <ChatToolToggles session={session} />}
          {hasToolToggles && (hasMemoryLink || isMainSession || linkedTask || resumeHandle || isOpenClawAgent || browserActive) && (
            <div className="w-px h-4 bg-white/[0.05] shrink-0" />
          )}
          {isMainSession && (
            <>
              <button
                onClick={handleToggleMissionPause}
                disabled={mainLoopSaving}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-[7px] transition-colors cursor-pointer border-none text-[10px] font-600
                  ${missionPaused ? 'bg-amber-500/10 hover:bg-amber-500/18 text-amber-300' : 'bg-emerald-500/8 hover:bg-emerald-500/12 text-emerald-400'}`}
                title={missionPaused ? 'Resume mission' : 'Pause mission'}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${missionPaused ? 'bg-amber-300' : 'bg-emerald-400'}`} />
                {missionPaused ? 'Paused' : 'Live'}
              </button>
              <button
                onClick={handleToggleMissionMode}
                disabled={mainLoopSaving}
                className={`flex items-center gap-1 px-2 py-1 rounded-[7px] transition-colors cursor-pointer border-none text-[10px] font-600
                  ${missionMode === 'autonomous' ? 'bg-indigo-500/12 hover:bg-indigo-500/20 text-indigo-300' : 'bg-white/[0.03] hover:bg-white/[0.06] text-text-3/60'}`}
                title="Toggle autonomy mode"
              >
                {missionMode === 'autonomous' ? 'Auto' : 'Assist'}
              </button>
              <button
                onClick={handleNudgeMission}
                disabled={mainLoopSaving || missionPaused}
                className="px-2 py-1 rounded-[7px] bg-blue-500/8 hover:bg-blue-500/15 text-blue-400 transition-colors cursor-pointer border-none disabled:opacity-50 text-[10px] font-600"
                title="Run one tick"
              >
                Nudge
              </button>
              <button
                onClick={handleSetMissionGoal}
                disabled={mainLoopSaving}
                className="px-2 py-1 rounded-[7px] bg-fuchsia-500/8 hover:bg-fuchsia-500/15 text-fuchsia-300 transition-colors cursor-pointer border-none text-[10px] font-600"
                title="Set mission goal"
              >
                Goal
              </button>
              {missionEventsCount > 0 && (
                <button
                  onClick={handleClearMissionEvents}
                  disabled={mainLoopSaving}
                  className="px-2 py-1 rounded-[7px] bg-white/[0.03] hover:bg-white/[0.06] text-text-3/60 transition-colors cursor-pointer border-none text-[10px] font-600"
                  title="Clear pending events"
                >
                  Events {missionEventsCount}
                </button>
              )}
              <span className="text-[9px] text-text-3/40 uppercase tracking-wider shrink-0">
                {missionStatus}{missionMomentum !== null ? ` · ${missionMomentum}` : ''}
              </span>
              {mainLoopError && <span className="text-[9px] text-red-300/80 truncate max-w-[240px]" title={mainLoopError}>{mainLoopError}</span>}
              {mainLoopNotice && <span className="text-[9px] text-emerald-300/80 truncate max-w-[200px]" title={mainLoopNotice}>{mainLoopNotice}</span>}
            </>
          )}
          {hasMemoryLink && (
            <button
              onClick={() => { setMemoryAgentFilter(session.agentId!); setActiveView('memory'); setSidebarOpen(true) }}
              className="flex items-center gap-1 px-2 py-1 rounded-[7px] bg-accent-soft/40 hover:bg-accent-soft/70 transition-colors cursor-pointer text-[10px] font-600 text-accent-bright/55 hover:text-accent-bright/80 shrink-0"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              Memories
            </button>
          )}
          {isOpenClawAgent && openclawSessionKey && (
            <>
              <button
                onClick={handleSyncHistory}
                disabled={syncingHistory}
                className="flex items-center gap-1 px-2 py-1 rounded-[7px] bg-indigo-500/8 hover:bg-indigo-500/12 transition-colors cursor-pointer border-none disabled:opacity-50 text-[10px] font-600 text-indigo-400 shrink-0"
                title="Sync from gateway"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" />
                </svg>
                {syncingHistory ? 'Syncing...' : 'Sync'}
              </button>
              {syncResult && <span className="text-[9px] text-emerald-300/80 shrink-0">{syncResult}</span>}
            </>
          )}
          {linkedTask && (
            <button
              onClick={() => setActiveView('tasks')}
              className="flex items-center gap-1 px-2 py-1 rounded-[7px] bg-amber-500/8 hover:bg-amber-500/12 transition-colors cursor-pointer text-[10px] font-600 text-amber-500 shrink-0"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <span className="truncate max-w-[160px]">{linkedTask.title}</span>
            </button>
          )}
          {resumeHandle && (
            <div className="flex items-center rounded-[7px] bg-white/[0.03] group/resume shrink-0">
              <button
                onClick={handleCopySessionId}
                className="flex items-center gap-1 px-2 py-1 rounded-l-[7px] hover:bg-white/[0.06] transition-colors cursor-pointer"
                title="Copy resume command"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/40 shrink-0">
                  <path d="M4 17l6 0l0 -6" /><path d="M20 7l-6 0l0 6" /><path d="M4 17l10 -10" />
                </svg>
                <span className="text-[10px] font-mono text-text-3/40 group-hover/resume:text-text-3/60 truncate max-w-[180px]">
                  {copied ? 'Copied!' : `${resumeHandle.label}: ${resumeHandle.id}`}
                </span>
              </button>
              <button
                onClick={handleDismissResumeHandle}
                className="px-1 py-1 rounded-r-[7px] hover:bg-white/[0.06] transition-colors cursor-pointer opacity-0 group-hover/resume:opacity-100"
                title="Dismiss"
              >
                <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40 hover:text-text-3">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          )}
          {browserActive && (
            <button
              onClick={onStopBrowser}
              className="flex items-center gap-1 px-2 py-1 rounded-[7px] bg-accent-bright/8 hover:bg-red-500/12 transition-colors cursor-pointer group text-[10px] font-600 shrink-0"
              title="Stop browser"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-accent-bright group-hover:text-red-400">
                <rect x="3" y="3" width="18" height="14" rx="2" /><path d="M3 9h18" />
              </svg>
              <span className="text-accent-bright group-hover:text-red-400">Browser</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-text-3/40 group-hover:text-red-400">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      )}
    </header>
  )
}
