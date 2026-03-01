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
}

export function ChatHeader({ session, streaming, onStop, onMenuToggle, onBack, mobile, browserActive, onStopBrowser, onVoiceToggle, voiceActive, voiceSupported }: Props) {
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
  const providerLabel = PROVIDER_LABELS[session.provider] || session.provider
  const agent = session.agentId ? agents[session.agentId] : null
  const connector = getSessionConnector(session, connectors)
  const connectorMeta = connector ? CONNECTOR_PLATFORM_META[connector.platform] : null
  const connectorPresence = connector?.presence
  const modelName = session.model || agent?.model || ''
  const [copied, setCopied] = useState(false)
  const [heartbeatSaving, setHeartbeatSaving] = useState(false)
  const [hbDropdownOpen, setHbDropdownOpen] = useState(false)
  const hbDropdownRef = useRef<HTMLDivElement>(null)
  const [mainLoopSaving, setMainLoopSaving] = useState(false)
  const [mainLoopError, setMainLoopError] = useState('')
  const [mainLoopNotice, setMainLoopNotice] = useState('')
  const [syncingHistory, setSyncingHistory] = useState(false)
  const [syncResult, setSyncResult] = useState('')

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

  useEffect(() => {
    if (!hbDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (hbDropdownRef.current && !hbDropdownRef.current.contains(e.target as Node)) setHbDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [hbDropdownOpen])

  useEffect(() => {
    if (session.name.startsWith('connector:')) {
      void loadConnectors()
    }
  }, [session.name, loadConnectors])

  useEffect(() => {
    setMainLoopError('')
    setMainLoopNotice('')
  }, [session.id])

  useEffect(() => {
    if (!mainLoopNotice) return
    const timer = setTimeout(() => setMainLoopNotice(''), 2500)
    return () => clearTimeout(timer)
  }, [mainLoopNotice])

  return (
    <header className="relative z-20 flex flex-col border-b border-white/[0.04] bg-bg/80 backdrop-blur-md shrink-0"
      style={mobile ? { paddingTop: 'max(12px, env(safe-area-inset-top))' } : undefined}>
      <div className="flex items-center gap-3 px-5 py-3 min-h-[56px]">
        {onBack && (
          <IconButton onClick={onBack} aria-label="Go back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </IconButton>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            {agent && <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={24} />}
            <span className="font-display text-[16px] font-600 block truncate tracking-[-0.02em]">{
              session.name === '__main__' ? 'Main Chat'
              : session.name.startsWith('agent-thread:') ? (agent?.name || session.name)
              : session.name
            }</span>
            {connector && connectorMeta && (
              <span
                className="shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[7px] border text-[10px] font-700 uppercase tracking-wider"
                style={{
                  color: connectorMeta.color,
                  backgroundColor: `${connectorMeta.color}1A`,
                  borderColor: `${connectorMeta.color}33`,
                }}
                title={`${connector.name} connector`}
              >
                <ConnectorPlatformIcon platform={connector.platform} size={11} />
                {connectorMeta.label}
              </span>
            )}
            {connector && connectorPresence && (() => {
              const lastAt = connectorPresence.lastMessageAt
              if (!lastAt) return (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-text-3/50">
                  <span className="w-1.5 h-1.5 rounded-full bg-text-3/40" />
                  Inactive
                </span>
              )
              const ago = Date.now() - lastAt
              const isActive = ago < 5 * 60_000
              const isRecent = ago < 30 * 60_000
              const label = isActive ? 'Active' : isRecent ? `${Math.floor(ago / 60_000)}m ago` : 'Inactive'
              const dotColor = isActive ? 'bg-emerald-400' : isRecent ? 'bg-amber-400' : 'bg-text-3/40'
              const textColor = isActive ? 'text-emerald-400' : isRecent ? 'text-amber-300' : 'text-text-3/50'
              return (
                <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] ${textColor}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                  {label}
                </span>
              )
            })()}
            {session.provider && session.provider !== 'claude-cli' && (
              <span className="shrink-0 px-2.5 py-0.5 rounded-[7px] bg-accent-soft text-accent-bright text-[10px] font-700 uppercase tracking-wider">
                {providerLabel}
              </span>
            )}
            {agent?.isOrchestrator && (
              <span className="shrink-0 px-2.5 py-0.5 rounded-[7px] bg-[#F59E0B]/10 text-[#F59E0B] text-[10px] font-700 uppercase tracking-wider">
                Orchestrator
              </span>
            )}
            {session.tools?.length ? (
              <span className="shrink-0 px-2.5 py-0.5 rounded-[7px] bg-emerald-500/10 text-emerald-400 text-[10px] font-700 uppercase tracking-wider">
                Tools
              </span>
            ) : null}
            {streaming && (
              <span className="shrink-0 w-2 h-2 rounded-full bg-accent-bright" style={{ animation: 'pulse 1.5s ease infinite' }} />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-text-3/60 font-mono block truncate">{shortPath(session.cwd)}</span>
            {modelName && (
              <>
                <span className="text-[11px] text-text-3/60">·</span>
                <span className="text-[11px] text-text-3/50 font-mono truncate shrink-0">{modelName}</span>
                {session.conversationTone && session.conversationTone !== 'neutral' && (() => {
                  const toneColors: Record<string, string> = {
                    formal: 'bg-[#3B82F6]',
                    casual: 'bg-emerald-400',
                    empathetic: 'bg-purple-400',
                    technical: 'bg-[#F59E0B]',
                  }
                  const color = toneColors[session.conversationTone] || ''
                  return color ? (
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${color}`}
                      title={`Tone: ${session.conversationTone}`}
                    />
                  ) : null
                })()}
              </>
            )}
            {lastUsage && !streaming && (
              <>
                <span className="text-[11px] text-text-3/60">·</span>
                <UsageBadge {...lastUsage} />
              </>
            )}
          </div>
          {(() => {
            const liveStatus = agentStatus || (missionState.status ? {
              goal: missionState.goal ?? undefined,
              status: missionState.status ?? undefined,
              summary: missionState.summary ?? undefined,
              nextAction: missionState.nextAction ?? undefined,
            } : null)
            if (!liveStatus) return null
            const statusColors: Record<string, string> = {
              idle: 'bg-text-3/40',
              progress: 'bg-[#3B82F6]',
              blocked: 'bg-amber-400',
              ok: 'bg-emerald-400',
            }
            const dotColor = statusColors[liveStatus.status || ''] || 'bg-text-3/40'
            return (
              <div className="flex items-center gap-2 mt-0.5">
                {liveStatus.goal && (
                  <span className="text-[10px] text-text-3/60 font-mono truncate max-w-[240px]" title={liveStatus.goal}>
                    {liveStatus.goal}
                  </span>
                )}
                {liveStatus.status && (
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[5px] text-[9px] font-700 uppercase tracking-wider ${
                    liveStatus.status === 'blocked' ? 'bg-amber-400/15 text-amber-300'
                    : liveStatus.status === 'ok' ? 'bg-emerald-400/15 text-emerald-400'
                    : liveStatus.status === 'progress' ? 'bg-[#3B82F6]/15 text-[#60A5FA]'
                    : 'bg-white/[0.04] text-text-3/60'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                    {liveStatus.status}
                  </span>
                )}
                {liveStatus.nextAction && (
                  <>
                    <span className="text-[10px] text-text-3/40">→</span>
                    <span className="text-[10px] text-text-3/50 font-mono truncate max-w-[200px]" title={liveStatus.nextAction}>
                      {liveStatus.nextAction}
                    </span>
                  </>
                )}
              </div>
            )
          })()}
        </div>
        <div className="flex gap-1.5">
          {streaming && (
            <IconButton onClick={onStop} variant="danger" aria-label="Stop generation">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </IconButton>
          )}
          {agent && (
            <IconButton onClick={() => setInspectorOpen(!inspectorOpen)} active={inspectorOpen} aria-label="Toggle inspector panel">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </IconButton>
          )}
          <IconButton onClick={() => setDebugOpen(!debugOpen)} active={debugOpen} aria-label="Toggle debug panel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 20V10" />
              <path d="M18 20V4" />
              <path d="M6 20v-4" />
            </svg>
          </IconButton>
          <IconButton onClick={toggleSound} active={soundEnabled} aria-label="Toggle sound notifications">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 8A6 6 0 0 1 18 16" />
              <path d="M13 2L8 7H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h4l5 5V2z" />
            </svg>
          </IconButton>
          <IconButton onClick={toggleTts} active={ttsEnabled} aria-label="Toggle text-to-speech">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          </IconButton>
          {voiceSupported && onVoiceToggle && (
            <IconButton onClick={onVoiceToggle} active={voiceActive} aria-label="Toggle voice conversation">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </IconButton>
          )}
          <IconButton onClick={(e) => { e.stopPropagation(); onMenuToggle() }} aria-label="Chat menu">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="6" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="18" r="1" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Sub-bar: tools toggle + agent memories + task link + CLI session ID + browser */}
      {(agent || linkedTask || resumeHandle || browserActive || session.tools?.length || isMainSession) && (
        <div className="flex items-center gap-3 px-5 pb-2.5 -mt-1">
          {(((agent?.tools?.length ?? 0) > 0) || ((session.tools?.length ?? 0) > 0)) && (
            <ChatToolToggles session={session} />
          )}
          {heartbeatSupported && (
            <>
              <button
                onClick={handleToggleHeartbeat}
                disabled={heartbeatSaving}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] transition-colors cursor-pointer border-none
                  ${heartbeatWillRun ? 'bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.04] hover:bg-white/[0.07] text-text-3'}`}
                title={heartbeatWillRun ? 'Toggle heartbeat' : !heartbeatEnabled ? 'Heartbeat disabled — click to enable' : 'Heartbeat enabled but paused (bounded loop mode, no explicit opt-in)'}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${heartbeatWillRun ? 'bg-emerald-400' : 'bg-text-3/40'}`} />
                <span className="text-[11px] font-600">
                  HB {heartbeatWillRun ? 'On' : 'Off'}
                </span>
                {heartbeatEnabled && !loopIsOngoing && !heartbeatExplicitOptIn && (
                  <span className="text-[10px] text-text-3/50">(bounded)</span>
                )}
              </button>
              <div className="relative" ref={hbDropdownRef}>
                <button
                  onClick={() => setHbDropdownOpen((o) => !o)}
                  disabled={heartbeatSaving}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] text-text-3 transition-colors cursor-pointer border-none"
                  title="Set heartbeat interval"
                >
                  <span className="text-[11px] font-600">{formatDuration(heartbeatIntervalSec)}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-text-3/50">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {hbDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 py-1 rounded-[10px] border border-white/[0.06] bg-bg/95 backdrop-blur-md shadow-lg z-50 min-w-[80px]">
                    {[30, 60, 120, 300, 600, 1800, 3600].map((sec) => (
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
            </>
          )}
          {isMainSession && (
            <>
              <button
                onClick={handleToggleMissionPause}
                disabled={mainLoopSaving}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] transition-colors cursor-pointer border-none
                  ${missionPaused ? 'bg-amber-500/12 hover:bg-amber-500/20 text-amber-300' : 'bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-400'}`}
                title={missionPaused ? 'Resume autonomous mission loop' : 'Pause autonomous mission loop'}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${missionPaused ? 'bg-amber-300' : 'bg-emerald-400'}`} />
                <span className="text-[11px] font-600">
                  Mission {missionPaused ? 'Paused' : 'Live'}
                </span>
              </button>
              <button
                onClick={handleToggleMissionMode}
                disabled={mainLoopSaving}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] transition-colors cursor-pointer border-none
                  ${missionMode === 'autonomous'
                    ? 'bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200'
                    : 'bg-white/[0.04] hover:bg-white/[0.07] text-text-3'
                  }`}
                title="Toggle mission autonomy mode"
              >
                <span className="text-[11px] font-600">
                  Mode {missionMode === 'autonomous' ? 'Auto' : 'Assist'}
                </span>
              </button>
              <button
                onClick={handleNudgeMission}
                disabled={mainLoopSaving || missionPaused}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-[#3B82F6]/10 hover:bg-[#3B82F6]/18 text-[#60A5FA] transition-colors cursor-pointer border-none disabled:opacity-60"
                title="Run one immediate main-loop mission tick"
              >
                <span className="text-[11px] font-600">Nudge</span>
              </button>
              <button
                onClick={handleSetMissionGoal}
                disabled={mainLoopSaving}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-fuchsia-500/10 hover:bg-fuchsia-500/18 text-fuchsia-300 transition-colors cursor-pointer border-none"
                title="Set an explicit mission goal"
              >
                <span className="text-[11px] font-600">Set Goal</span>
              </button>
              {missionEventsCount > 0 && (
                <button
                  onClick={handleClearMissionEvents}
                  disabled={mainLoopSaving}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] text-text-3 transition-colors cursor-pointer border-none"
                  title="Clear pending mission events"
                >
                  <span className="text-[11px] font-600">Events {missionEventsCount}</span>
                </button>
              )}
              <span className="text-[10px] text-text-3/50 uppercase tracking-wider">
                {`State ${missionStatus}${missionMomentum !== null ? ` · ${missionMomentum}` : ''}`}
              </span>
              {mainLoopError && (
                <span className="text-[10px] text-red-300/90 truncate max-w-[280px]" title={mainLoopError}>
                  {mainLoopError}
                </span>
              )}
              {mainLoopNotice && (
                <span className="text-[10px] text-emerald-300/90 truncate max-w-[220px]" title={mainLoopNotice}>
                  {mainLoopNotice}
                </span>
              )}
            </>
          )}
          {agent && session.tools?.includes('memory') && (
            <button
              onClick={() => {
                setMemoryAgentFilter(session.agentId!)
                setActiveView('memory')
                setSidebarOpen(true)
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-accent-soft/50 hover:bg-accent-soft transition-colors cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-accent-bright/60">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              <span className="text-[11px] font-600 text-accent-bright/60">
                {agent.name} Memories
              </span>
            </button>
          )}
          {isOpenClawAgent && openclawSessionKey && (
            <>
              <button
                onClick={handleSyncHistory}
                disabled={syncingHistory}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-indigo-500/10 hover:bg-indigo-500/15 transition-colors cursor-pointer border-none disabled:opacity-50"
                title="Sync chat history from OpenClaw gateway"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-indigo-400">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
                <span className="text-[11px] font-600 text-indigo-400">
                  {syncingHistory ? 'Syncing...' : 'Sync History'}
                </span>
              </button>
              {syncResult && (
                <span className="text-[10px] text-emerald-300/90">{syncResult}</span>
              )}
            </>
          )}
          {linkedTask && (
            <button
              onClick={() => setActiveView('tasks')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-[#F59E0B]/10 hover:bg-[#F59E0B]/15 transition-colors cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <span className="text-[11px] font-600 text-[#F59E0B] truncate max-w-[200px]">
                Task: {linkedTask.title}
              </span>
            </button>
          )}
          {resumeHandle && (
            <button
              onClick={handleCopySessionId}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] transition-colors cursor-pointer group"
              title="Copy resume handle/command to clipboard"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/50">
                <path d="M4 17l6 0l0 -6" />
                <path d="M20 7l-6 0l0 6" />
                <path d="M4 17l10 -10" />
              </svg>
              <span className="text-[11px] font-mono text-text-3/50 group-hover:text-text-3/70 truncate max-w-[220px]">
                {copied ? 'Copied!' : `${resumeHandle.label}: ${resumeHandle.id}`}
              </span>
              {!copied && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/60 shrink-0">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
          {browserActive && (
            <button
              onClick={onStopBrowser}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-[#3B82F6]/10 hover:bg-[#F43F5E]/15 transition-colors cursor-pointer group"
              title="Stop browser"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-[#3B82F6] group-hover:text-[#F43F5E]">
                <rect x="3" y="3" width="18" height="14" rx="2" />
                <path d="M3 9h18" />
                <circle cx="7" cy="6" r="0.5" fill="currentColor" />
                <circle cx="10" cy="6" r="0.5" fill="currentColor" />
              </svg>
              <span className="text-[11px] font-600 text-[#3B82F6] group-hover:text-[#F43F5E]">
                Browser Active
              </span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-text-3/60 group-hover:text-[#F43F5E] shrink-0">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      )}
    </header>
  )
}
