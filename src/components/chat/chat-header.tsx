'use client'

import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/runtime/heartbeat-defaults'
import { useEffect, useState, useMemo, useRef, useCallback, type ReactNode } from 'react'
import type { Agent, Session } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useNow } from '@/hooks/use-now'
import { IconButton } from '@/components/shared/icon-button'
import { ChatToolToggles } from './chat-tool-toggles'
import { api } from '@/lib/app/api-client'
import {
  ConnectorPlatformIcon,
  getSessionConnector,
  resolveConnectorPlatformMeta,
} from '@/components/shared/connector-platform-icon'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ModelCombobox } from '@/components/shared/model-combobox'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import type { ProviderType } from '@/types'
import { copyTextToClipboard } from '@/lib/clipboard'
import { buildOpenClawMainSessionKey } from '@/lib/openclaw/openclaw-agent-id'
import { useWs } from '@/hooks/use-ws'
import { useNavigate } from '@/lib/app/navigation'
import { StatusDot } from '@/components/ui/status-dot'
import { formatDurationSec } from '@/lib/format-display'

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

function getAgentWalletIds(agent: { walletIds?: string[]; walletId?: string | null } | null | undefined): string[] {
  const ids = Array.isArray(agent?.walletIds)
    ? agent.walletIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const legacy = typeof agent?.walletId === 'string' && agent.walletId.trim()
    ? [agent.walletId.trim()]
    : []
  return dedup([...ids, ...legacy])
}

function getAgentActiveWalletId(agent: { activeWalletId?: string | null; walletIds?: string[]; walletId?: string | null } | null | undefined): string | null {
  const walletIds = getAgentWalletIds(agent)
  if (typeof agent?.activeWalletId === 'string' && walletIds.includes(agent.activeWalletId)) return agent.activeWalletId
  if (typeof agent?.walletId === 'string' && walletIds.includes(agent.walletId)) return agent.walletId
  return walletIds[0] || null
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

function shortPath(p: string): string {
  return (p || '').replace(/^\/Users\/\w+/, '~')
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
  connectorSources?: Map<string, { platform: string; connectorName: string }>
  connectorFilter?: string | null
  onConnectorFilterChange?: (filter: string | null) => void
  hasMultipleSources?: boolean
}

export function ChatHeader({ session, streaming, onStop, onMenuToggle, onBack, mobile, browserActive, onStopBrowser, onVoiceToggle, voiceActive, voiceSupported, heartbeatHistoryOpen, onToggleHeartbeatHistory, connectorSources, connectorFilter, onConnectorFilterChange, hasMultipleSources }: Props) {
  const now = useNow()
  const ttsEnabled = useChatStore((s) => s.ttsEnabled)
  const toggleTts = useChatStore((s) => s.toggleTts)
  const soundEnabled = useChatStore((s) => s.soundEnabled)
  const toggleSound = useChatStore((s) => s.toggleSound)
  const agentStatus = useChatStore((s) => s.agentStatus)
  const agents = useAppStore((s) => s.agents)
  const tasks = useAppStore((s) => s.tasks)
  const navigateTo = useNavigate()
  const setMemoryAgentFilter = useAppStore((s) => s.setMemoryAgentFilter)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const appSettings = useAppStore((s) => s.appSettings)
  const refreshSession = useAppStore((s) => s.refreshSession)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const updateAgentInStore = useAppStore((s) => s.updateAgentInStore)
  const updateSessionInStore = useAppStore((s) => s.updateSessionInStore)
  const inspectorOpen = useAppStore((s) => s.inspectorOpen)
  const setInspectorOpen = useAppStore((s) => s.setInspectorOpen)
  const connectors = useAppStore((s) => s.connectors)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const agent = session.agentId ? agents[session.agentId] : null
  const connector = getSessionConnector(session, connectors)
  const connectorMeta = connector ? resolveConnectorPlatformMeta(connector.platform) : null
  const connectorPresence = connector?.presence
  const providers = useAppStore((s) => s.providers)
  const loadProviders = useAppStore((s) => s.loadProviders)
  const modelName = session.model || agent?.model || ''
  const providerLabel = PROVIDER_LABELS[session.provider] || session.provider
  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false)
  const modelSwitcherRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [heartbeatSaving, setHeartbeatSaving] = useState(false)
  const [hbDropdownOpen, setHbDropdownOpen] = useState(false)
  const hbDropdownRef = useRef<HTMLDivElement>(null)
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false)
  const sourceDropdownRef = useRef<HTMLDivElement>(null)
  const [syncingHistory, setSyncingHistory] = useState(false)
  const [syncResult, setSyncResult] = useState('')
  const [openClawDashboardUrl, setOpenClawDashboardUrl] = useState<string | null>(null)
  const [openClawDashboardLoading, setOpenClawDashboardLoading] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameContainerRef = useRef<HTMLSpanElement>(null)
  const setWalletPanelAgentId = useAppStore((s) => s.setWalletPanelAgentId)
  const [walletBalance, setWalletBalance] = useState<{ formatted: string; symbol: string; assets?: number } | null>(null)
  const [headerWidgets, setHeaderWidgets] = useState<Array<{ id: string; label: string; icon?: string }>>([])
  const [localhostBrowser, setLocalhostBrowser] = useState(false)
  const agentWalletIds = useMemo(() => getAgentWalletIds(agent), [agent])
  const activeWalletId = useMemo(() => getAgentActiveWalletId(agent), [agent])

  useEffect(() => {
    setLocalhostBrowser(window.location.hostname === 'localhost')
  }, [])

  const refreshHeaderWidgets = useCallback(() => {
    api<Array<{ id: string; label: string; icon?: string }>>('GET', '/plugins/ui?type=header').then((widgets) => {
      if (Array.isArray(widgets)) setHeaderWidgets(widgets)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    void refreshHeaderWidgets()
  }, [refreshHeaderWidgets])

  useWs('plugins', refreshHeaderWidgets)

  const fetchWalletBalance = useCallback(async () => {
    if (!activeWalletId) {
      setWalletBalance(null)
      return
    }
    try {
      const data = await api<{ balanceFormatted?: string; balanceSymbol?: string; portfolioSummary?: { nonZeroAssets?: number } }>('GET', `/wallets/${activeWalletId}?cached=1`)
      if (data.balanceFormatted && data.balanceSymbol) {
        setWalletBalance({
          formatted: data.balanceFormatted,
          symbol: data.balanceSymbol,
          assets: typeof data.portfolioSummary?.nonZeroAssets === 'number' ? data.portfolioSummary.nonZeroAssets : undefined,
        })
      } else {
        setWalletBalance(null)
      }
    } catch {
      setWalletBalance(null)
    }
  }, [activeWalletId])

  useEffect(() => {
    void fetchWalletBalance()
  }, [fetchWalletBalance])
  useWs('wallets', fetchWalletBalance)

  const workspaceLabel = useMemo(() => shortPath(session.cwd), [session.cwd])
  const liveStatus = agentStatus || null
  const threadContextLabel = useMemo(() => {
    const title = session.connectorContext?.threadTitle?.trim()
    if (title) return title
    const persona = session.connectorContext?.threadPersonaLabel?.trim()
    if (persona) return persona
    return null
  }, [session.connectorContext?.threadPersonaLabel, session.connectorContext?.threadTitle])
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

  const visibleHeaderWidgets = useMemo(() => {
    const seen = new Set<string>()
    return headerWidgets.filter((widget) => {
      const key = widget.id || widget.label
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [headerWidgets])

  const heartbeatIntervalOptions = useMemo(
    () => [...(localhostBrowser ? [60, 300] : []), 1800, 3600, 7200, 21600, 43200],
    [localhostBrowser],
  )

  const walletHeaderMeta = useMemo(() => {
    if (!agent?.id) {
      return {
        label: 'Wallets',
        title: 'Open wallets',
      }
    }
    if (agentWalletIds.length === 0) {
      return {
        label: 'Create wallet',
        title: 'Create wallet',
      }
    }
    return {
      label: agentWalletIds.length > 1
        ? (walletBalance ? `${walletBalance.formatted} ${walletBalance.symbol}${walletBalance.assets && walletBalance.assets > 1 ? ` +${walletBalance.assets - 1}` : ''} / ${agentWalletIds.length}` : `${agentWalletIds.length} wallets`)
        : (walletBalance ? `${walletBalance.formatted} ${walletBalance.symbol}${walletBalance.assets && walletBalance.assets > 1 ? ` +${walletBalance.assets - 1}` : ''}` : 'Wallet'),
      title: agentWalletIds.length > 1 ? 'View wallets' : 'View wallet',
    }
  }, [agent?.id, agentWalletIds, walletBalance])

  const handleHeaderWidgetClick = (widgetId: string) => {
    if (widgetId === 'wallet-status') {
      if (agent?.id) setWalletPanelAgentId(agent.id)
      navigateTo('wallets')
    }
  }

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
    const fromDelegateGemini = session.delegateResumeIds?.gemini
      ? { label: 'Gemini', id: session.delegateResumeIds.gemini, command: `gemini --resume ${session.delegateResumeIds.gemini} --prompt \"<task>\"` }
      : null
    return fromSessionClaude
      || fromSessionCodex
      || fromSessionOpenCode
      || fromDelegateClaude
      || fromDelegateCodex
      || fromDelegateOpenCode
      || fromDelegateGemini
      || null
  }, [session.claudeSessionId, session.codexThreadId, session.opencodeSessionId, session.delegateResumeIds])

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
        delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
      })
      await refreshSession(session.id)
    } catch { /* best-effort */ }
  }

  const heartbeatSupported = (session.plugins?.length ?? 0) > 0
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
    let sec = resolveFrom(appSettings) ?? DEFAULT_HEARTBEAT_INTERVAL_SEC
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

  const handleToggleHeartbeat = async () => {
    if (!heartbeatSupported || heartbeatSaving) return
    setHeartbeatSaving(true)
    try {
      const next = !heartbeatEnabled
      if (session.agentId) {
        const updatedAgent = await api<Agent>('PUT', `/agents/${session.agentId}`, { heartbeatEnabled: next })
        updateAgentInStore(updatedAgent)
        // Clear any stale session-level override so the agent value wins
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

  const handleSelectHeartbeatInterval = async (sec: number) => {
    if (!heartbeatSupported || heartbeatSaving) return
    setHbDropdownOpen(false)
    setHeartbeatSaving(true)
    try {
      if (session.agentId) {
        // Save the cadence without implicitly toggling heartbeat on.
        const updatedAgent = await api<Agent>('PUT', `/agents/${session.agentId}`, {
          heartbeatInterval: formatDurationSec(sec),
          heartbeatIntervalSec: sec,
        })
        updateAgentInStore(updatedAgent)
        // Clear stale session-level overrides
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

  const isOpenClawAgent = agent?.provider === 'openclaw'
  const openclawSessionKey = isOpenClawAgent ? buildOpenClawMainSessionKey(agent?.name) : null

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
      if (result.merged > 0) await refreshSession(session.id)
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

  const loadOpenClawDashboardUrl = useCallback(async () => {
    if (!session.agentId || openClawDashboardLoading) return
    setOpenClawDashboardLoading(true)
    try {
      const result = await api<{ url: string }>('GET', `/openclaw/dashboard-url?agentId=${session.agentId}`)
      if (result.url) setOpenClawDashboardUrl(result.url)
    } catch {
      // Fall back to agent endpoint
      const ep = (agent?.apiEndpoint || 'http://localhost:18789').replace(/\/+$/, '')
      setOpenClawDashboardUrl(/^https?:\/\//i.test(ep) ? ep : `http://${ep}`)
    } finally {
      setOpenClawDashboardLoading(false)
    }
  }, [session.agentId, agent?.apiEndpoint, openClawDashboardLoading])

  useEffect(() => {
    if (isOpenClawAgent && !openClawDashboardUrl) void loadOpenClawDashboardUrl()
  }, [isOpenClawAgent, openClawDashboardUrl, loadOpenClawDashboardUrl])

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
    if (!sourceDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (sourceDropdownRef.current && !sourceDropdownRef.current.contains(e.target as Node)) setSourceDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sourceDropdownOpen])

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
      await api('PUT', `/chats/${session.id}`, { provider: nextProvider, model: nextModel })
      await refreshSession(session.id)
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
    setModelSwitcherOpen(false)
  }, [session.id])

  // Context bar shows for tools, memories, source filter, task links, resume handles, browser
  const hasToolToggles = ((agent?.plugins?.length ?? 0) > 0) || ((session.plugins?.length ?? 0) > 0)
  const hasMemoryLink = !!(agent && session.plugins?.includes('memory'))
  const hasSourceFilter = !!hasMultipleSources
  const hasContextBar = !!(hasMemoryLink || hasSourceFilter || linkedTask || resumeHandle || (isOpenClawAgent && openclawSessionKey) || browserActive)

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
                <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={(hasContextBar || hasToolToggles) ? 44 : 34} />
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
            {agent?.platformAssignScope === 'all' && (
              <HeaderChip className="bg-amber-500/10 border-amber-500/15 text-amber-400 shrink-0">Delegates</HeaderChip>
            )}
            {streaming && (
              <HeaderChip className="bg-accent-soft/60 border-accent-bright/20 text-accent-bright shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-bright" style={{ animation: 'pulse 1.5s ease infinite' }} />
                Responding
              </HeaderChip>
            )}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            {hasToolToggles && <ChatToolToggles session={session} />}
            {visibleHeaderWidgets.map((widget) => {
              const actionable = widget.id === 'wallet-status'
              const walletLabel = actionable
                ? walletHeaderMeta.label
                : (widget.label || 'Wallet')
              const widgetTitle = actionable
                ? walletHeaderMeta.title
                : widget.label
              return (
                <HeaderChip
                  key={widget.id}
                  onClick={actionable ? () => handleHeaderWidgetClick(widget.id) : undefined}
                  title={widgetTitle}
                  className={actionable ? 'text-text-3/80' : ''}
                >
                  {actionable ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                        <rect x="2" y="6" width="20" height="14" rx="2" />
                        <path d="M22 10H18a2 2 0 0 0 0 4h4" />
                      </svg>
                      <span className="truncate max-w-[120px]">{walletLabel}</span>
                    </>
                  ) : (
                    <span className="truncate max-w-[120px]">{widget.label}</span>
                  )}
                </HeaderChip>
              )
            })}
            {isOpenClawAgent ? (
              <a
                href={openClawDashboardUrl || '#'}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (openClawDashboardUrl) return
                  e.preventDefault()
                  if (!openClawDashboardLoading) void loadOpenClawDashboardUrl()
                }}
                className="inline-flex max-w-full items-center gap-1.5 rounded-[9px] border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-600 text-text-3/70 backdrop-blur-sm transition-colors hover:border-white/[0.1] hover:bg-white/[0.06] hover:text-accent-bright shrink-0"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
                </svg>
                <span className="truncate max-w-[min(42vw,220px)]">OpenClaw Dashboard</span>
                <svg width="10" height="10" viewBox="0 0 14 14" fill="none" className="shrink-0 opacity-50">
                  <path d="M5.5 3H3.5C3.22386 3 3 3.22386 3 3.5V10.5C3 10.7761 3.22386 11 3.5 11H10.5C10.7761 11 11 10.7761 11 10.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  <path d="M8 2H12V6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 2L7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </a>
            ) : modelName ? (
              <div className="relative shrink-0" ref={modelSwitcherRef}>
                <Tip label={`Switch model (${providerLabel})`}>
                <button
                  type="button"
                  onClick={() => {
                    if (streaming) return
                    setModelSwitcherOpen((o) => { if (!o) void loadProviders(); return !o })
                  }}
                  disabled={streaming}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-[9px] border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-600 text-text-3/70 backdrop-blur-sm transition-colors hover:border-white/[0.1] hover:bg-white/[0.06] hover:text-text-2 disabled:cursor-default disabled:opacity-60"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
                  </svg>
                  <span className="truncate max-w-[min(42vw,220px)]">{mobile ? modelName : `${providerLabel} · ${modelName}`}</span>
                  <svg width="7" height="7" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-40">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                </Tip>
                {modelSwitcherOpen && (
                  <div className="absolute z-50 top-full right-0 sm:left-0 sm:right-auto mt-2 w-[min(320px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] rounded-[12px] border border-white/[0.08] bg-surface backdrop-blur-md shadow-xl p-3">
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
                      credentialId={session.credentialId}
                      apiEndpoint={session.apiEndpoint}
                      supportsDiscovery={currentProviderInfo?.supportsModelDiscovery}
                      className="px-2.5 py-1.5 rounded-[7px] text-[12px] font-mono bg-white/[0.04] hover:bg-white/[0.06] transition-colors"
                    />
                  </div>
                )}
              </div>
            ) : null}
            {threadContextLabel && (
              <HeaderChip title={threadContextLabel}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
                </svg>
                <span className="truncate max-w-[min(42vw,220px)]">{threadContextLabel}</span>
              </HeaderChip>
            )}
            <Tip label={`Open working directory: ${workspaceLabel}`}>
            <HeaderChip
              onClick={() => { api('POST', '/files/open', { path: session.cwd }).catch(() => {}) }}
              title={workspaceLabel}
              className="max-w-[min(44vw,220px)]"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="truncate">{mobile ? 'Workspace' : workspaceLabel}</span>
            </HeaderChip>
            </Tip>
            {liveStatus?.status && (
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
            )}
            {!mobile && liveStatus?.nextAction && (
              <span className="text-[10px] text-text-3/45 font-mono truncate max-w-[min(34vw,220px)]" title={liveStatus.nextAction}>
                Next: {liveStatus.nextAction}
              </span>
            )}
          </div>
        </div>

        <div className={`flex items-center gap-2 shrink-0 ${mobile ? 'w-full justify-between pt-1' : 'ml-auto'}`}>
          {/* Heartbeat compound control */}
          {heartbeatSupported && (
            <div className="flex items-center rounded-[12px] border border-white/[0.06] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] shrink-0">
              <Tip label={heartbeatWillRun ? 'Disable heartbeat — periodic check-ins' : 'Enable heartbeat — periodic check-ins'}>
              <button
                onClick={handleToggleHeartbeat}
                disabled={heartbeatSaving}
                aria-pressed={heartbeatWillRun}
                className={`flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-l-[11px] transition-colors cursor-pointer border-none text-[11px] font-600
                  ${heartbeatWillRun ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-text-3/70 hover:bg-white/[0.04]'}`}
              >
                <StatusDot status={heartbeatWillRun ? 'online' : heartbeatEnabled ? 'warning' : 'idle'} size="sm" />
                <span className="hidden sm:inline">Heartbeat</span>
                <span className="sm:hidden">HB</span>
                <span className={`hidden md:inline text-[9px] uppercase tracking-wider ${
                  heartbeatWillRun ? 'text-emerald-300/80' : heartbeatEnabled ? 'text-amber-300/70' : 'text-text-3/40'
                }`}>
                  {heartbeatWillRun ? 'On' : heartbeatEnabled ? 'Bounded' : 'Off'}
                </span>
              </button>
              </Tip>
              <div className="relative" ref={hbDropdownRef}>
                <Tip label="Set heartbeat interval">
                <button
                  onClick={() => setHbDropdownOpen((o) => !o)}
                  disabled={heartbeatSaving}
                  className="flex items-center gap-0.5 pl-1 pr-2.5 py-1.5 text-text-3/60 hover:text-text-2 hover:bg-white/[0.04] transition-colors cursor-pointer border-none rounded-r-[11px]"
                >
                  <span className="text-[11px] font-600">{formatDurationSec(heartbeatIntervalSec)}</span>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="opacity-40">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                </Tip>
                {hbDropdownOpen && (
                  <div className="absolute top-full right-0 mt-1 py-1 rounded-[10px] border border-white/[0.06] bg-bg/95 backdrop-blur-md shadow-lg z-50 min-w-[88px]">
                    {heartbeatIntervalOptions.map((sec) => (
                      <button
                        key={sec}
                        onClick={() => handleSelectHeartbeatInterval(sec)}
                        className={`w-full text-left px-3 py-1.5 text-[11px] font-600 transition-colors cursor-pointer border-none
                          ${sec === heartbeatIntervalSec ? 'bg-accent-soft text-accent-bright' : 'text-text-3 hover:bg-white/[0.06]'}`}
                      >
                        {formatDurationSec(sec)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

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
          {isOpenClawAgent && openclawSessionKey && (
            <>
              <Tip label="Sync chat history from OpenClaw gateway">
              <button
                onClick={handleSyncHistory}
                disabled={syncingHistory}
                className="flex items-center gap-1 px-2 py-1 rounded-[7px] bg-indigo-500/8 hover:bg-indigo-500/12 transition-colors cursor-pointer border-none disabled:opacity-50 text-[10px] font-600 text-indigo-400 shrink-0"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" />
                </svg>
                {syncingHistory ? 'Syncing...' : 'Sync'}
              </button>
              </Tip>
              {syncResult && <span className="text-[9px] text-emerald-300/80 shrink-0">{syncResult}</span>}
            </>
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
