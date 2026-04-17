'use client'

import { useEffect, useState, useMemo, useRef, type ReactNode } from 'react'
import type { Session } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useNow } from '@/hooks/use-now'
import { IconButton } from '@/components/shared/icon-button'
import { api } from '@/lib/app/api-client'
import {
  ConnectorPlatformIcon,
  getSessionConnector,
  resolveConnectorPlatformMeta,
} from '@/components/shared/connector-platform-icon'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useNavigate } from '@/lib/app/navigation'
import { getEnabledToolIds } from '@/lib/capability-selection'
import { ContextMeterBadge } from './context-meter-badge'

function Tip({ label, children, side = 'bottom' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6}
        className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[8px] px-2.5 py-1.5 text-[11px] z-[100]">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function HeaderChip({
  children,
  title,
  onClick,
  className = '',
  active = false,
}: {
  children: ReactNode
  title?: string
  onClick?: () => void
  className?: string
  active?: boolean
}) {
  const baseClass = `inline-flex max-w-full items-center gap-1.5 rounded-[9px] border px-2.5 py-1 text-[10px] font-600 backdrop-blur-sm transition-colors ${
    active
      ? 'border-accent-bright/20 bg-accent-soft/50 text-accent-bright'
      : 'border-white/[0.06] bg-white/[0.03] text-text-3/68'
  } ${onClick ? 'cursor-pointer hover:border-white/[0.1] hover:bg-white/[0.06] hover:text-text-2' : ''} ${className}`

  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={baseClass}>
        {children}
      </button>
    )
  }

  return (
    <span title={title} className={baseClass}>
      {children}
    </span>
  )
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
  connectorSources?: Map<string, { platform: string; connectorName: string }>
  connectorFilter?: string | null
  onConnectorFilterChange?: (filter: string | null) => void
  hasMultipleSources?: boolean
  messageCount?: number
  onCompactComplete?: () => void
  onClearRequest?: () => void
}

export function ChatHeader({ session, streaming, onStop, onMenuToggle, onBack, mobile, browserActive, onStopBrowser, onVoiceToggle, voiceActive, voiceSupported, connectorSources, connectorFilter, onConnectorFilterChange, hasMultipleSources, messageCount = 0, onCompactComplete, onClearRequest }: Props) {
  const now = useNow()
  const agentStatus = useChatStore((s) => s.agentStatus)
  const agents = useAppStore((s) => s.agents)
  const tasks = useAppStore((s) => s.tasks)
  const navigateTo = useNavigate()
  const setMemoryAgentFilter = useAppStore((s) => s.setMemoryAgentFilter)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const refreshSession = useAppStore((s) => s.refreshSession)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const inspectorOpen = useAppStore((s) => s.inspectorOpen)
  const setInspectorOpen = useAppStore((s) => s.setInspectorOpen)
  const connectors = useAppStore((s) => s.connectors)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const agent = session.agentId ? agents[session.agentId] : null
  const connector = getSessionConnector(session, connectors)
  const connectorMeta = connector ? resolveConnectorPlatformMeta(connector.platform) : null
  const connectorPresence = connector?.presence
  const [copied, setCopied] = useState(false)
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false)
  const sourceDropdownRef = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameContainerRef = useRef<HTMLSpanElement>(null)
  const liveStatus = agentStatus || null
  const connectorPresenceMeta = useMemo(() => {
    if (!connector) return null
    const lastAt = connectorPresence?.lastMessageAt
    if (!lastAt) {
      return {
        label: 'Idle',
        dotClass: 'bg-text-3/30',
        textClass: 'text-text-3/45',
      }
    }
    if (!now) {
      return {
        label: 'Idle',
        dotClass: 'bg-text-3/30',
        textClass: 'text-text-3/45',
      }
    }
    const ago = now - lastAt
    if (ago < 5 * 60_000) {
      return {
        label: 'Active',
        dotClass: 'bg-emerald-400',
        textClass: 'text-emerald-400',
      }
    }
    if (ago < 30 * 60_000) {
      return {
        label: `${Math.floor(ago / 60_000)}m ago`,
        dotClass: 'bg-amber-400',
        textClass: 'text-amber-300',
      }
    }
    return {
      label: 'Idle',
      dotClass: 'bg-text-3/30',
      textClass: 'text-text-3/45',
    }
  }, [connector, connectorPresence?.lastMessageAt, now])

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
    const fromSessionCursor = session.cursorSessionId
      ? { label: 'Cursor', id: session.cursorSessionId, command: `cursor-agent --resume ${session.cursorSessionId} --print \"<task>\"` }
      : null
    const fromSessionQwen = session.qwenSessionId
      ? { label: 'Qwen Code', id: session.qwenSessionId, command: `qwen --resume ${session.qwenSessionId} -p \"<task>\"` }
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
    const fromDelegateGemini = session.delegateResumeIds?.gemini
      ? { label: 'Gemini', id: session.delegateResumeIds.gemini, command: `gemini --resume ${session.delegateResumeIds.gemini} --prompt \"<task>\"` }
      : null
    const fromDelegateCursor = session.delegateResumeIds?.cursor
      ? { label: 'Cursor', id: session.delegateResumeIds.cursor, command: `cursor-agent --resume ${session.delegateResumeIds.cursor} --print \"<task>\"` }
      : null
    const fromDelegateQwen = session.delegateResumeIds?.qwen
      ? { label: 'Qwen Code', id: session.delegateResumeIds.qwen, command: `qwen --resume ${session.delegateResumeIds.qwen} -p \"<task>\"` }
      : null
    return fromSessionClaude
      || fromSessionCodex
      || fromSessionOpenCode
      || fromSessionCursor
      || fromSessionQwen
      || fromDelegateClaude
      || fromDelegateCodex
      || fromDelegateOpenCode
      || fromDelegateGemini
      || fromDelegateCursor
      || fromDelegateQwen
      || null
  }, [session.claudeSessionId, session.codexThreadId, session.opencodeSessionId, session.cursorSessionId, session.qwenSessionId, session.delegateResumeIds])

  const handleCopySessionId = () => {
    if (!resumeHandle) return
    void copyTextToClipboard(resumeHandle.command).then((copiedCommand) => {
      if (!copiedCommand) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleDismissResumeHandle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await api('PUT', `/chats/${session.id}`, {
        claudeSessionId: null,
        codexThreadId: null,
        opencodeSessionId: null,
        geminiSessionId: null,
        copilotSessionId: null,
        droidSessionId: null,
        cursorSessionId: null,
        qwenSessionId: null,
        acpSessionId: null,
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null, copilot: null, droid: null, cursor: null, qwen: null },
      })
      await refreshSession(session.id)
    } catch { /* best-effort */ }
  }

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
    if (!sourceDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (sourceDropdownRef.current && !sourceDropdownRef.current.contains(e.target as Node)) setSourceDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sourceDropdownOpen])

  useEffect(() => {
    if (session.name.startsWith('connector:')) {
      void loadConnectors()
    }
  }, [session.name, loadConnectors])

  // Context bar shows for memories, source filter, task links, resume handles, browser
  const hasMemoryLink = !!(agent && getEnabledToolIds(session).includes('memory'))
  const hasSourceFilter = !!hasMultipleSources
  const hasContextBar = !!(hasMemoryLink || hasSourceFilter || linkedTask || resumeHandle || browserActive)

  return (
    <>
    <header
      className="relative z-20 border-b border-white/[0.06] shrink-0"
      style={{
        background: 'radial-gradient(circle at top left, rgba(66, 211, 255, 0.08), transparent 32%), radial-gradient(circle at top right, rgba(255, 190, 92, 0.05), transparent 28%), linear-gradient(180deg, rgba(var(--rgb-bg, 15,15,26), 0.96) 0%, rgba(var(--rgb-bg, 15,15,26), 0.9) 100%)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        ...(mobile ? { paddingTop: 'max(12px, env(safe-area-inset-top))' } : {}),
      }}
    >
      {/* Main row */}
      <div className="flex flex-wrap items-start gap-3 px-4 py-2.5 min-h-[64px]">
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
                className="absolute -inset-[4px] rounded-full"
                style={{
                  background: 'radial-gradient(circle, var(--color-accent-bright), transparent 70%)',
                  animation: 'pulse-glow 2s ease-in-out infinite',
                  filter: 'blur(5px)',
                }}
              />
            )}
            <div
              className="relative rounded-full transition-transform duration-500"
              style={{
                padding: 2,
                background: streaming
                  ? 'linear-gradient(135deg, var(--color-accent-bright), var(--color-accent))'
                  : 'linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03))',
                animation: streaming ? 'avatar-pulse 2s ease-in-out infinite' : undefined,
              }}
            >
              <div className="rounded-full bg-bg">
                <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={hasContextBar ? 44 : 34} />
              </div>
            </div>
          </div>
        )}

        {/* Identity + metadata — fills center */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
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
            ) : agent ? (
              <button
                type="button"
                onClick={startRename}
                title="Rename agent"
                className="group/title inline-flex min-w-0 items-center gap-1.5 rounded-[9px] px-1 py-0.5 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-bright/40"
              >
                <span className="font-display text-[16px] font-700 truncate tracking-[-0.02em] text-text transition-colors group-hover/title:text-accent-bright">
                  {(session.shortcutForAgentId && agent.id === session.shortcutForAgentId) || agent.threadSessionId === session.id
                    ? agent.name
                    : session.name}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-text-3/40 opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            ) : (
              <span className="font-display text-[16px] font-700 truncate tracking-[-0.02em] text-text">{session.name}</span>
            )}
            {connector && connectorMeta && (
              <span
                className="inline-flex min-w-0 items-center gap-1 px-2 py-1 rounded-[8px] border text-[10px] font-700 uppercase tracking-wider shrink-0"
                style={{
                  color: connectorMeta.color,
                  backgroundColor: `${connectorMeta.color}12`,
                  borderColor: `${connectorMeta.color}22`,
                }}
                title={`${connector.name} connector`}
              >
                <ConnectorPlatformIcon platform={connector.platform} size={10} />
                <span className="truncate max-w-[140px]">{connectorMeta.label}</span>
              </span>
            )}
            {connectorPresenceMeta && (
              <HeaderChip className={`${connectorPresenceMeta.textClass} shrink-0`}>
                <span className={`w-1.5 h-1.5 rounded-full ${connectorPresenceMeta.dotClass}`} />
                {connectorPresenceMeta.label}
              </HeaderChip>
            )}
            {agent?.delegationEnabled === true && (
              <HeaderChip className="bg-amber-500/10 border-amber-500/15 text-amber-400 shrink-0">Delegates</HeaderChip>
            )}
            {streaming && (
              <HeaderChip className="bg-accent-soft/60 border-accent-bright/20 text-accent-bright shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-bright" style={{ animation: 'pulse 1.5s ease infinite' }} />
                Responding
              </HeaderChip>
            )}
            {messageCount > 0 && onCompactComplete && onClearRequest && (
              <ContextMeterBadge
                sessionId={session.id}
                messageCount={messageCount}
                onCompactComplete={onCompactComplete}
                onClearRequest={onClearRequest}
              />
            )}
          </div>
          {liveStatus?.status && (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <HeaderChip
              className={`${
                liveStatus.status === 'blocked' ? 'bg-amber-400/12 border-amber-400/15 text-amber-300'
                : liveStatus.status === 'ok' ? 'bg-emerald-400/12 border-emerald-400/15 text-emerald-400'
                : liveStatus.status === 'progress' ? 'bg-blue-500/12 border-blue-500/15 text-blue-400'
                : 'text-text-3/60'
              }`}
              title={liveStatus.goal || liveStatus.summary || liveStatus.nextAction || liveStatus.status}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                liveStatus.status === 'blocked' ? 'bg-amber-300'
                : liveStatus.status === 'ok' ? 'bg-emerald-400'
                : liveStatus.status === 'progress' ? 'bg-blue-400'
                : 'bg-text-3/30'
              }`} />
              {liveStatus.status}
            </HeaderChip>
            {!mobile && liveStatus?.nextAction && (
              <span className="text-[10px] text-text-3/45 font-mono truncate max-w-[min(34vw,220px)]" title={liveStatus.nextAction}>
                Next: {liveStatus.nextAction}
              </span>
            )}
          </div>
          )}
        </div>

        <div className={`flex items-center gap-2 shrink-0 ${mobile ? 'w-full justify-between pt-1' : 'ml-auto'}`}>
          {/* Action buttons */}
          <div className="flex items-center shrink-0 rounded-[12px] border border-white/[0.06] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] p-1">
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
          {voiceSupported && onVoiceToggle && (
            <IconButton onClick={onVoiceToggle} active={voiceActive} tooltip="Voice mode" aria-label="Toggle voice" size="sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </IconButton>
          )}
          <div className="w-px h-3.5 bg-white/[0.06] mx-0.5" />
          <IconButton onClick={(e) => { e.stopPropagation(); onMenuToggle() }} tooltip="More" aria-label="Chat menu" size="sm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="6" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="18" r="1" />
            </svg>
          </IconButton>
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
      </div>

      {/* Context bar: tools and links */}
      {hasContextBar && (
        <div className="border-t border-white/[0.05] bg-black/[0.08] px-4 py-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {hasMemoryLink && (
            <Tip label="View agent memories">
            <button
              onClick={() => { setMemoryAgentFilter(session.agentId!); navigateTo('memory'); setSidebarOpen(true) }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-[8px] bg-accent-soft/40 hover:bg-accent-soft/70 transition-colors cursor-pointer text-[10px] font-600 text-accent-bright/55 hover:text-accent-bright/80 shrink-0"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              Memories
            </button>
            </Tip>
          )}
          {hasSourceFilter && onConnectorFilterChange && connectorSources && (
            <div className="relative shrink-0" ref={sourceDropdownRef}>
              <Tip label="Filter messages by source connector">
              <button
                onClick={() => setSourceDropdownOpen((o) => !o)}
                className={`flex items-center gap-1 px-2 py-1 rounded-[7px] transition-colors cursor-pointer border-none text-[10px] font-600 shrink-0 ${
                  connectorFilter
                    ? 'bg-accent-soft/60 text-accent-bright/80 hover:bg-accent-soft'
                    : 'bg-white/[0.03] text-text-3/50 hover:bg-white/[0.06] hover:text-text-3/70'
                }`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                {connectorFilter
                  ? (connectorSources.get(connectorFilter)?.connectorName || 'Source')
                  : 'Source'}
                <svg width="7" height="7" viewBox="0 0 16 16" fill="none" className="opacity-40">
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              </Tip>
              {sourceDropdownOpen && (
                <div className="absolute top-full right-0 sm:left-0 sm:right-auto mt-1 py-1 rounded-[10px] border border-white/[0.06] bg-bg/95 backdrop-blur-md shadow-lg z-50 min-w-[160px] max-w-[calc(100vw-2rem)]">
                  <button
                    onClick={() => { onConnectorFilterChange(null); setSourceDropdownOpen(false) }}
                    className={`w-full text-left px-3 py-1.5 text-[11px] font-600 transition-colors cursor-pointer border-none flex items-center gap-2 ${
                      !connectorFilter ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:bg-white/[0.06]'
                    }`}
                  >
                    All Sources
                  </button>
                  {Array.from(connectorSources.entries()).map(([cid, info]) => {
                    const active = connectorFilter === cid
                    const meta = resolveConnectorPlatformMeta(info.platform)
                    return (
                      <button
                        key={cid}
                        onClick={() => { onConnectorFilterChange(active ? null : cid); setSourceDropdownOpen(false) }}
                        className={`w-full text-left px-3 py-1.5 text-[11px] font-600 transition-colors cursor-pointer border-none flex items-center gap-2 ${
                          active ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:bg-white/[0.06]'
                        }`}
                      >
                        <ConnectorPlatformIcon platform={info.platform} size={12} />
                        {info.connectorName || meta?.label || info.platform}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {linkedTask && (
            <Tip label="View linked task">
            <button
              onClick={() => navigateTo('tasks')}
              className="flex items-center gap-1 px-2 py-1 rounded-[7px] bg-amber-500/8 hover:bg-amber-500/12 transition-colors cursor-pointer text-[10px] font-600 text-amber-500 shrink-0"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <span className="truncate max-w-[160px]">{linkedTask.title}</span>
            </button>
            </Tip>
          )}
          {resumeHandle && (
            <div className="flex items-center rounded-[7px] bg-white/[0.03] group/resume shrink-0">
              <Tip label="Copy CLI resume command">
              <button
                onClick={handleCopySessionId}
                className="flex min-w-0 items-center gap-1 px-2 py-1 rounded-l-[7px] hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/40 shrink-0">
                  <path d="M4 17l6 0l0 -6" /><path d="M20 7l-6 0l0 6" /><path d="M4 17l10 -10" />
                </svg>
                <span className="text-[10px] font-mono text-text-3/40 group-hover/resume:text-text-3/60 truncate max-w-[min(46vw,220px)]">
                  {copied ? 'Copied!' : `${resumeHandle.label}: ${resumeHandle.id}`}
                </span>
              </button>
              </Tip>
              <Tip label="Dismiss resume handle">
              <button
                onClick={handleDismissResumeHandle}
                className="px-1 py-1 rounded-r-[7px] hover:bg-white/[0.06] transition-colors cursor-pointer opacity-60 md:opacity-0 md:group-hover/resume:opacity-100 group-focus-within/resume:opacity-100"
              >
                <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40 hover:text-text-3">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
              </Tip>
            </div>
          )}
          {browserActive && (
            <Tip label="Close the browser session">
            <button
              onClick={onStopBrowser}
              className="flex items-center gap-1 px-2 py-1 rounded-[7px] bg-accent-bright/8 hover:bg-red-500/12 transition-colors cursor-pointer group text-[10px] font-600 shrink-0"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-accent-bright group-hover:text-red-400">
                <rect x="3" y="3" width="18" height="14" rx="2" /><path d="M3 9h18" />
              </svg>
              <span className="text-accent-bright group-hover:text-red-400">Browser</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-text-3/40 group-hover:text-red-400">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            </Tip>
          )}
        </div>
        </div>
      )}

    </header>
    </>
  )
}
