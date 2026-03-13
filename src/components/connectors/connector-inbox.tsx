'use client'

import { useEffect, useMemo, useState } from 'react'

import type {
  Connector,
  ConnectorAccessMutationAction,
  ConnectorAccessMutationResponse,
  ConnectorAccessSnapshot,
  ConnectorPlatform,
  Session,
} from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { senderMatchesAnyEntry } from '@/lib/connectors/sender-id'
import { fetchChat } from '@/lib/chat/chats'
import { api } from '@/lib/app/api-client'
import { getSessionLastMessage } from '@/lib/chat/session-summary'
import { SearchInput } from '@/components/ui/search-input'
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { PageLoader } from '@/components/ui/page-loader'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ConnectorAccessPanel } from '@/components/connectors/connector-access-panel'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import {
  ConnectorPlatformBadge,
  ConnectorPlatformIcon,
  getConnectorPlatformLabel,
  resolveConnectorPlatformMeta,
} from '@/components/shared/connector-platform-icon'

type PlatformFilter = 'all' | ConnectorPlatform

type ConversationAccessTone = 'owner' | 'approved' | 'blocked' | 'pending' | 'restricted' | 'neutral'

type InboxConnectorItem = {
  id: string
  connector: Connector | null
  platform: string
  label: string
  sessionCount: number
  lastActiveAt: number
  sessions: Session[]
}

type ConversationAccessState = {
  label: string
  detail: string
  tone: ConversationAccessTone
}

function isExternalConnectorSession(session: Session): boolean {
  const owner = typeof session.user === 'string' ? session.user.trim().toLowerCase() : ''
  const name = typeof session.name === 'string' ? session.name.trim() : ''
  return (owner === 'connector' || name.startsWith('connector:'))
    && session.connectorContext?.isOwnerConversation !== true
}

function relativeTime(ts?: number | null): string {
  if (!ts) return 'No activity yet'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function sessionPreview(session: Session): string {
  const last = getSessionLastMessage(session)
  const text = typeof last?.text === 'string' ? last.text.trim() : ''
  return text || 'No messages yet'
}

function senderInitials(value: string): string {
  const words = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
  if (!words.length) return '?'
  return words.map((word) => word[0]?.toUpperCase() || '').join('')
}

function collectSessionSenderIds(session: Session): string[] {
  return [session.connectorContext?.senderId, session.connectorContext?.senderIdAlt]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
}

function resolveConversationAccessState(session: Session, snapshot: ConnectorAccessSnapshot | null): ConversationAccessState | null {
  if (!snapshot) return null
  const senderIds = collectSessionSenderIds(session)
  if (senderIds.length === 0) return null

  const pending = snapshot.pendingPairingRequests.find((entry) => senderMatchesAnyEntry(senderIds, [entry.senderId])) || null
  const isOwnerOverride = !!snapshot.ownerSenderId && senderMatchesAnyEntry(senderIds, [snapshot.ownerSenderId])
  const isBlocked = senderMatchesAnyEntry(senderIds, snapshot.denyFrom)
  const isConfigAllowed = senderMatchesAnyEntry(senderIds, snapshot.allowFrom)
  const isStoredAllowed = senderMatchesAnyEntry(senderIds, snapshot.storedAllowedSenderIds)
  const isGlobalAllowed = senderMatchesAnyEntry(senderIds, snapshot.globalWhatsAppApprovedContacts.map((entry) => entry.phone))
  const dmAddressingOverride = snapshot.senderAddressingOverrides.find((entry) => senderMatchesAnyEntry(senderIds, [entry.senderId]))?.dmAddressingMode || null
  const requiresDirectAddress = (dmAddressingOverride || snapshot.dmAddressingMode) === 'addressed'
  const isApproved = isOwnerOverride || isConfigAllowed || isStoredAllowed || isGlobalAllowed

  if (isOwnerOverride) {
    return { label: 'Owner', detail: 'Routes into the main thread', tone: 'owner' }
  }
  if (isBlocked) {
    return { label: 'Blocked', detail: 'Replies and pairing are suppressed', tone: 'blocked' }
  }
  if (isApproved) {
    const detailBase = isGlobalAllowed
      ? 'Approved from global WhatsApp contacts'
      : isStoredAllowed
        ? 'Approved via paired sender store'
        : 'Approved in this connector'
    const detail = requiresDirectAddress ? `${detailBase} · name required` : detailBase
    return { label: 'Approved', detail, tone: 'approved' }
  }
  if (pending) {
    return {
      label: 'Pending',
      detail: `${requiresDirectAddress ? 'Name required once approved · ' : ''}Awaiting approval · code ${pending.code}`,
      tone: 'pending',
    }
  }
  if (snapshot.dmPolicy === 'open') {
    return {
      label: 'Open',
      detail: requiresDirectAddress
        ? 'This connector accepts new senders, but they must name the agent'
        : 'This connector accepts new senders',
      tone: 'neutral',
    }
  }
  if (snapshot.dmPolicy === 'disabled') {
    return { label: 'Disabled', detail: 'Direct messages are turned off', tone: 'blocked' }
  }
  return {
    label: snapshot.dmPolicy === 'allowlist' ? 'Not approved' : 'Needs approval',
    detail: snapshot.dmPolicy === 'allowlist'
      ? `Not present in the connector allowlist${requiresDirectAddress ? ' · name required after approval' : ''}`
      : `Not yet paired or explicitly allowed${requiresDirectAddress ? ' · name required after approval' : ''}`,
    tone: 'restricted',
  }
}

function accessToneClasses(tone: ConversationAccessTone): { badge: string; accent: string } {
  switch (tone) {
    case 'owner':
      return {
        badge: 'border-sky-500/25 bg-sky-500/12 text-sky-200',
        accent: 'shadow-[inset_0_0_0_1px_rgba(56,189,248,0.14)]',
      }
    case 'approved':
      return {
        badge: 'border-emerald-500/25 bg-emerald-500/12 text-emerald-200',
        accent: 'shadow-[inset_0_0_0_1px_rgba(16,185,129,0.14)]',
      }
    case 'blocked':
      return {
        badge: 'border-red-500/25 bg-red-500/12 text-red-200',
        accent: 'shadow-[inset_0_0_0_1px_rgba(239,68,68,0.16)]',
      }
    case 'pending':
      return {
        badge: 'border-amber-500/25 bg-amber-500/12 text-amber-200',
        accent: 'shadow-[inset_0_0_0_1px_rgba(245,158,11,0.16)]',
      }
    case 'restricted':
      return {
        badge: 'border-orange-500/25 bg-orange-500/12 text-orange-200',
        accent: 'shadow-[inset_0_0_0_1px_rgba(249,115,22,0.16)]',
      }
    default:
      return {
        badge: 'border-white/[0.08] bg-white/[0.05] text-text-3',
        accent: '',
      }
  }
}

function SenderAvatar(props: {
  name: string
  avatarUrl?: string | null
  platform: string
}) {
  const meta = resolveConnectorPlatformMeta(props.platform)
  return (
    <Avatar size="lg" className="h-11 w-11 rounded-full border border-white/[0.08] bg-white/[0.04]">
      {props.avatarUrl ? <AvatarImage src={props.avatarUrl} alt={props.name} className="h-full w-full object-cover" /> : null}
      <AvatarFallback className="rounded-full bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.26),rgba(8,15,32,0.92)_72%)] text-[12px] font-700 text-text">
        {senderInitials(props.name)}
      </AvatarFallback>
      <AvatarBadge className="bg-black/80 text-white ring-black/60">
        <ConnectorPlatformIcon platform={props.platform} size={10} />
      </AvatarBadge>
      <span className="sr-only">{meta.label}</span>
    </Avatar>
  )
}

function connectorSearchText(session: Session, connector: Connector | null, agentName: string | undefined): string {
  const last = getSessionLastMessage(session)
  return [
    session.connectorContext?.senderName,
    session.connectorContext?.channelId,
    session.connectorContext?.platform,
    connector?.name,
    connector?.platform,
    agentName,
    last?.text,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function ConnectorInbox() {
  const sessions = useAppStore((s) => s.sessions)
  const connectors = useAppStore((s) => s.connectors)
  const agents = useAppStore((s) => s.agents)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const loadAgents = useAppStore((s) => s.loadAgents)

  const [ready, setReady] = useState(false)
  const [search, setSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all')
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedTranscript, setSelectedTranscript] = useState<Session | null>(null)
  const [transcriptErrorSessionId, setTranscriptErrorSessionId] = useState<string | null>(null)
  const [accessSnapshot, setAccessSnapshot] = useState<ConnectorAccessSnapshot | null>(null)
  const [accessLoading, setAccessLoading] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)
  const [accessPending, setAccessPending] = useState(false)
  const [accessSheetOpen, setAccessSheetOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([loadSessions(), loadConnectors(), loadAgents()])
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [loadAgents, loadConnectors, loadSessions])

  useWs('sessions', loadSessions, 15_000)
  useWs('connectors', loadConnectors, 15_000)
  useWs('agents', loadAgents, 30_000)

  const inboxSessions = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return Object.values(sessions)
      .filter(isExternalConnectorSession)
      .filter((session) => {
        const platform = session.connectorContext?.platform || ''
        if (platformFilter !== 'all' && platform !== platformFilter) return false
        if (!normalizedSearch) return true
        const connector = session.connectorContext?.connectorId
          ? connectors[session.connectorContext.connectorId]
          : null
        return connectorSearchText(session, connector, agents[session.agentId || '']?.name).includes(normalizedSearch)
      })
      .sort((a, b) => (b.lastActiveAt || b.createdAt || 0) - (a.lastActiveAt || a.createdAt || 0))
  }, [agents, connectors, platformFilter, search, sessions])

  const platformOptions = useMemo(() => {
    const platforms = new Set<string>()
    for (const session of Object.values(sessions)) {
      if (!isExternalConnectorSession(session)) continue
      const platform = session.connectorContext?.platform || ''
      if (platform) platforms.add(platform)
    }
    return [...platforms].sort((a, b) => getConnectorPlatformLabel(a).localeCompare(getConnectorPlatformLabel(b)))
  }, [sessions])

  const connectorItems = useMemo(() => {
    const grouped = new Map<string, InboxConnectorItem>()
    for (const session of inboxSessions) {
      const connectorId = session.connectorContext?.connectorId || `session:${session.id}`
      const connector = session.connectorContext?.connectorId
        ? connectors[session.connectorContext.connectorId] || null
        : null
      const platform = connector?.platform || session.connectorContext?.platform || 'unknown'
      const label = connector?.name || session.connectorContext?.channelId || session.connectorContext?.senderName || 'Unlinked connector'
      const existing = grouped.get(connectorId)
      if (existing) {
        existing.sessions.push(session)
        existing.sessionCount += 1
        existing.lastActiveAt = Math.max(existing.lastActiveAt, session.lastActiveAt || session.createdAt || 0)
      } else {
        grouped.set(connectorId, {
          id: connectorId,
          connector,
          platform,
          label,
          sessionCount: 1,
          lastActiveAt: session.lastActiveAt || session.createdAt || 0,
          sessions: [session],
        })
      }
    }
    return [...grouped.values()]
      .map((item) => ({
        ...item,
        sessions: [...item.sessions].sort((a, b) => (b.lastActiveAt || b.createdAt || 0) - (a.lastActiveAt || a.createdAt || 0)),
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }, [connectors, inboxSessions])

  const effectiveConnectorId = useMemo(() => {
    if (!connectorItems.length) return null
    if (selectedConnectorId && connectorItems.some((item) => item.id === selectedConnectorId)) {
      return selectedConnectorId
    }
    return connectorItems[0].id
  }, [connectorItems, selectedConnectorId])

  const selectedConnectorItem = useMemo(() => {
    if (!effectiveConnectorId) return null
    return connectorItems.find((item) => item.id === effectiveConnectorId) || null
  }, [connectorItems, effectiveConnectorId])

  const conversationSessions = useMemo(() => selectedConnectorItem?.sessions || [], [selectedConnectorItem])

  const effectiveSelectedSessionId = useMemo(() => {
    if (!conversationSessions.length) return null
    if (selectedSessionId && conversationSessions.some((session) => session.id === selectedSessionId)) {
      return selectedSessionId
    }
    return conversationSessions[0].id
  }, [conversationSessions, selectedSessionId])

  const selectedSummary = effectiveSelectedSessionId ? sessions[effectiveSelectedSessionId] || null : null

  useEffect(() => {
    if (!effectiveSelectedSessionId) return
    let cancelled = false
    fetchChat(effectiveSelectedSessionId)
      .then((session) => {
        if (!cancelled) {
          setSelectedTranscript(session)
          setTranscriptErrorSessionId(null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedTranscript(null)
          setTranscriptErrorSessionId(effectiveSelectedSessionId)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    effectiveSelectedSessionId,
    selectedSummary?.lastActiveAt,
    selectedSummary?.messageCount,
  ])

  const selectedSession = selectedTranscript?.id === effectiveSelectedSessionId
    ? selectedTranscript
    : selectedSummary
  const selectedConnector = selectedSession?.connectorContext?.connectorId
    ? connectors[selectedSession.connectorContext.connectorId] || null
    : null
  const selectedAgent = selectedSession?.agentId ? agents[selectedSession.agentId] : null
  const transcriptMessages = Array.isArray(selectedTranscript?.messages) ? selectedTranscript.messages : []
  const loadingTranscript = !!effectiveSelectedSessionId
    && selectedTranscript?.id !== effectiveSelectedSessionId
    && transcriptErrorSessionId !== effectiveSelectedSessionId
  const accessConnectorId = selectedConnector?.id || selectedSession?.connectorContext?.connectorId || null
  const activeConversationSnapshot = accessSnapshot
    && selectedConnectorItem
    && accessSnapshot.connectorId === (selectedConnectorItem.connector?.id || accessConnectorId)
      ? accessSnapshot
      : null

  useEffect(() => {
    if (!accessConnectorId) {
      setAccessSnapshot(null)
      setAccessError(null)
      setAccessLoading(false)
      return
    }
    let cancelled = false
    const params = new URLSearchParams()
    const senderId = selectedSession?.connectorContext?.senderId?.trim()
    const senderIdAlt = selectedSession?.connectorContext?.senderIdAlt?.trim()
    if (senderId) params.set('senderId', senderId)
    if (senderIdAlt) params.set('senderIdAlt', senderIdAlt)
    setAccessLoading(true)
    setAccessError(null)
    api<ConnectorAccessSnapshot>('GET', `/connectors/${accessConnectorId}/access${params.toString() ? `?${params.toString()}` : ''}`)
      .then((snapshot) => {
        if (!cancelled) setAccessSnapshot(snapshot)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setAccessSnapshot(null)
          setAccessError(err instanceof Error ? err.message : 'Failed to load connector access.')
        }
      })
      .finally(() => {
        if (!cancelled) setAccessLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    accessConnectorId,
    selectedSession?.connectorContext?.senderId,
    selectedSession?.connectorContext?.senderIdAlt,
  ])

  const handleAccessAction = async (
    action: ConnectorAccessMutationAction,
    payload?: {
      senderId?: string | null
      senderIdAlt?: string | null
      code?: string | null
      dmAddressingMode?: 'open' | 'addressed' | null
    },
  ) => {
    if (!accessConnectorId) return
    setAccessPending(true)
    setAccessError(null)
    try {
      const result = await api<ConnectorAccessMutationResponse>('PUT', `/connectors/${accessConnectorId}/access`, {
        action,
        senderId: payload?.senderId || null,
        senderIdAlt: payload?.senderIdAlt || null,
        code: payload?.code || null,
        dmAddressingMode: payload?.dmAddressingMode || null,
      })
      setAccessSnapshot(result.snapshot)
      await Promise.all([loadConnectors(), loadSessions()])
    } catch (err: unknown) {
      setAccessError(err instanceof Error ? err.message : 'Failed to update connector access.')
    } finally {
      setAccessPending(false)
    }
  }

  const conversationAccessSummary = useMemo(() => {
    const counts = {
      approved: 0,
      pending: 0,
      blocked: 0,
      restricted: 0,
    }
    const bySessionId = new Map<string, ConversationAccessState>()
    for (const session of conversationSessions) {
      const state = resolveConversationAccessState(session, activeConversationSnapshot)
      if (!state) continue
      bySessionId.set(session.id, state)
      if (state.tone === 'approved' || state.tone === 'owner') counts.approved += 1
      else if (state.tone === 'pending') counts.pending += 1
      else if (state.tone === 'blocked') counts.blocked += 1
      else if (state.tone === 'restricted') counts.restricted += 1
    }
    return { counts, bySessionId }
  }, [activeConversationSnapshot, conversationSessions])

  if (!ready) {
    return <PageLoader label="Loading inbox..." />
  }

  const activePlatformMeta = resolveConnectorPlatformMeta(selectedConnectorItem?.platform || selectedSession?.connectorContext?.platform || 'connector')

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 px-5 md:px-6 py-5 gap-4">
      <div className="rounded-[22px] border border-white/[0.08] bg-[linear-gradient(135deg,rgba(37,99,235,0.12),rgba(8,15,32,0.84)_48%,rgba(16,185,129,0.08))] overflow-hidden">
        <div className="px-6 py-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-[720px]">
            <div className="text-[11px] uppercase tracking-[0.14em] text-accent-bright/80 font-700">Connector Inbox</div>
            <h1 className="mt-2 font-display text-[28px] md:text-[34px] leading-[1.02] tracking-[-0.04em] text-text">
              External connector traffic stays here, separate from your main agent thread.
            </h1>
            <p className="mt-3 text-[13px] md:text-[14px] text-text-3 leading-relaxed">
              Filter by platform, jump between connector bridges, and inspect isolated transcripts without mixing outside senders into your own chat context.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 md:min-w-[300px]">
            <div className="rounded-[16px] border border-white/[0.08] bg-black/20 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-text-3/70">Connectors</div>
              <div className="mt-2 text-[26px] font-display font-700 tracking-[-0.04em] text-text">{connectorItems.length}</div>
              <div className="text-[11px] text-text-3">Bridges with active external conversations</div>
            </div>
            <div className="rounded-[16px] border border-white/[0.08] bg-black/20 px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-text-3/70">Conversations</div>
              <div className="mt-2 text-[26px] font-display font-700 tracking-[-0.04em] text-text">{inboxSessions.length}</div>
              <div className="text-[11px] text-text-3">Strictly isolated external sender sessions</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[300px_360px_minmax(0,1fr)] gap-4 flex-1 min-h-0">
        <section className="rounded-[20px] border border-white/[0.08] bg-white/[0.02] overflow-hidden min-h-[260px] xl:min-h-0 flex flex-col">
          <div className="px-4 py-4 border-b border-white/[0.06] space-y-3 shrink-0">
            <SearchInput
              size="sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              placeholder="Search senders, messages, or connectors"
              aria-label="Search inbox conversations"
            />
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-text-3/65 mb-2">Connector type</div>
              <select
                value={platformFilter}
                onChange={(e) => {
                  setPlatformFilter(e.target.value as PlatformFilter)
                  setSelectedConnectorId(null)
                  setSelectedSessionId(null)
                }}
                className="w-full rounded-[12px] border border-white/[0.08] bg-black/20 px-3 py-2.5 text-[13px] text-text outline-none focus:border-accent-bright/35"
              >
                <option value="all">All connector types</option>
                {platformOptions.map((platform) => (
                  <option key={platform} value={platform}>
                    {getConnectorPlatformLabel(platform)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between gap-3 shrink-0">
            <div>
              <div className="text-[12px] font-700 text-text">Bridges</div>
              <div className="text-[11px] text-text-3">Switch between connector instances</div>
            </div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-3/65">
              {connectorItems.length} active
            </div>
          </div>

          {!connectorItems.length ? (
            <div className="px-5 py-10 text-center text-[13px] text-text-3">
              No external connector conversations match the current filters.
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-4">
              {connectorItems.map((item) => {
                const active = item.id === effectiveConnectorId
                const meta = resolveConnectorPlatformMeta(item.platform)
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelectedConnectorId(item.id)
                      setSelectedSessionId(item.sessions[0]?.id || null)
                    }}
                    className={`w-full text-left px-4 py-3 border-b border-white/[0.05] transition-colors cursor-pointer ${
                      active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <ConnectorPlatformBadge platform={item.platform} size={38} iconSize={18} roundedClassName="rounded-[12px]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[13px] font-700 text-text truncate">{item.label}</div>
                          <div className="text-[10px] text-text-3 whitespace-nowrap">{relativeTime(item.lastActiveAt)}</div>
                        </div>
                        <div className="mt-1 text-[11px] text-text-3 truncate">
                          {meta.label}
                          {item.connector?.agentId && agents[item.connector.agentId]?.name ? ` · ${agents[item.connector.agentId]?.name}` : ''}
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-text-3">
                            <ConnectorPlatformIcon platform={item.platform} size={11} />
                            {meta.label}
                          </span>
                          <span className="text-[11px] text-text-2">
                            {item.sessionCount} conversation{item.sessionCount === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-[20px] border border-white/[0.08] bg-white/[0.02] overflow-hidden min-h-[260px] xl:min-h-0 flex flex-col">
          <div className="px-4 py-4 border-b border-white/[0.06] shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0" style={{ backgroundColor: activePlatformMeta.color }}>
                <ConnectorPlatformIcon platform={selectedConnectorItem?.platform || selectedSession?.connectorContext?.platform || 'connector'} size={18} className="text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-[12px] font-700 text-text truncate">
                  {selectedConnectorItem?.label || 'Conversations'}
                </div>
                <div className="text-[11px] text-text-3 truncate">
                  {selectedConnectorItem ? `${selectedConnectorItem.sessionCount} active isolated sessions` : 'Pick a connector to inspect'}
                </div>
              </div>
            </div>
            {activeConversationSnapshot && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-emerald-200">
                  {conversationAccessSummary.counts.approved} approved
                </span>
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-amber-200">
                  {conversationAccessSummary.counts.pending} pending
                </span>
                <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-red-200">
                  {conversationAccessSummary.counts.blocked} blocked
                </span>
                {conversationAccessSummary.counts.restricted > 0 && (
                  <span className="rounded-full border border-orange-500/20 bg-orange-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-orange-200">
                    {conversationAccessSummary.counts.restricted} need review
                  </span>
                )}
              </div>
            )}
          </div>

          {!selectedConnectorItem ? (
            <div className="px-5 py-10 text-center text-[13px] text-text-3">
              Select a connector bridge to view its conversations.
            </div>
          ) : conversationSessions.length === 0 ? (
            <div className="px-5 py-10 text-center text-[13px] text-text-3">
              No conversations are available for this connector.
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-4">
              {conversationSessions.map((session) => {
                const active = session.id === effectiveSelectedSessionId
                const agent = session.agentId ? agents[session.agentId] : null
                const accessState = conversationAccessSummary.bySessionId.get(session.id) || null
                const accessClasses = accessState ? accessToneClasses(accessState.tone) : null
                return (
                  <button
                    key={session.id}
                    onClick={() => setSelectedSessionId(session.id)}
                    className={`w-full text-left px-4 py-3 border-b border-white/[0.05] transition-colors cursor-pointer ${
                      active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className={`rounded-[16px] px-3 py-3 ${accessClasses?.accent || ''}`}>
                      <div className="flex items-start gap-3">
                        <SenderAvatar
                          name={session.connectorContext?.senderName || session.connectorContext?.channelId || session.name}
                          avatarUrl={session.connectorContext?.senderAvatarUrl}
                          platform={session.connectorContext?.platform || selectedConnectorItem?.platform || 'connector'}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[13px] font-700 text-text truncate">
                                {session.connectorContext?.senderName || session.connectorContext?.channelId || session.name}
                              </div>
                              <div className="mt-1 text-[11px] text-text-3 truncate">
                                {session.connectorContext?.channelId || 'Unknown channel'}
                              </div>
                            </div>
                            <div className="text-[10px] text-text-3 whitespace-nowrap">
                              {relativeTime(session.lastActiveAt || session.createdAt)}
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {accessState && (
                              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] ${accessClasses?.badge || ''}`}>
                                {accessState.label}
                              </span>
                            )}
                            {agent ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-text-2">
                                <AgentAvatar
                                  seed={agent.avatarSeed || null}
                                  avatarUrl={agent.avatarUrl}
                                  name={agent.name}
                                  size={14}
                                />
                                <span className="truncate">{agent.name}</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-text-3">
                                Unassigned
                              </span>
                            )}
                          </div>
                          {accessState?.detail && (
                            <div className="mt-2 text-[11px] text-text-3 line-clamp-1">
                              {accessState.detail}
                            </div>
                          )}
                          <div className="mt-2 text-[12px] text-text-2/85 line-clamp-2">
                            {sessionPreview(session)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-[20px] border border-white/[0.08] bg-white/[0.02] overflow-hidden min-h-[380px] xl:min-h-0 flex flex-col">
          {selectedSession ? (
            <>
              <div className="px-5 py-4 border-b border-white/[0.06]">
                <div className="flex flex-wrap items-center gap-2 justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-[22px] tracking-[-0.03em] text-text">
                    {selectedSession.connectorContext?.senderName || selectedSession.name}
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-text-3">
                    <ConnectorPlatformIcon platform={selectedConnector?.platform || selectedSession.connectorContext?.platform || 'connector'} size={11} />
                    {selectedConnector?.name || selectedSession.connectorContext?.platform || 'Connector'}
                  </span>
                  <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-emerald-300">
                    Session-scoped memory
                  </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAccessSheetOpen(true)}
                    className="inline-flex items-center gap-2 rounded-[12px] border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[12px] font-600 text-text-2 transition-colors hover:bg-white/[0.07] cursor-pointer"
                  >
                    <span>Access &amp; ownership</span>
                    {accessSnapshot && (
                      <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-3">
                        {accessSnapshot.pendingPairingRequests.length} pending · {accessSnapshot.denyFrom.length} blocked{accessSnapshot.dmAddressingMode === 'addressed' ? ' · name required' : ''}
                      </span>
                    )}
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-text-3">
                  <span>{selectedSession.connectorContext?.channelId || 'Unknown channel'}</span>
                  <span>{relativeTime(selectedSession.lastActiveAt || selectedSession.createdAt)}</span>
                  <span>{selectedAgent?.name || 'Unassigned agent'}</span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4">
                <div className="rounded-[18px] border border-white/[0.08] bg-white/[0.03] overflow-hidden">
                  <div className="border-b border-white/[0.06] px-4 py-3">
                    <div className="text-[13px] font-700 text-text">Transcript</div>
                    <div className="mt-1 text-[12px] text-text-3">
                      Full isolated conversation history for this external sender session.
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
                        <SenderAvatar
                          name={selectedSession.connectorContext?.senderName || selectedSession.name}
                          avatarUrl={selectedSession.connectorContext?.senderAvatarUrl}
                          platform={selectedSession.connectorContext?.platform || selectedConnector?.platform || 'connector'}
                        />
                        <div className="min-w-0">
                          <div className="text-[11px] font-600 text-text truncate">
                            {selectedSession.connectorContext?.senderName || 'Sender'}
                          </div>
                          <div className="text-[10px] text-text-3">External sender</div>
                        </div>
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
                        <AgentAvatar
                          seed={selectedAgent?.avatarSeed || null}
                          avatarUrl={selectedAgent?.avatarUrl}
                          name={selectedAgent?.name || 'Agent'}
                          size={28}
                          className="ring-1 ring-white/[0.08]"
                        />
                        <div className="min-w-0">
                          <div className="text-[11px] font-600 text-text truncate">
                            {selectedAgent?.name || 'Agent'}
                          </div>
                          <div className="text-[10px] text-text-3">Assigned agent</div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="px-4 py-4 space-y-3">
                    {loadingTranscript ? (
                      <div className="text-[12px] text-text-3">Loading conversation…</div>
                    ) : transcriptErrorSessionId === effectiveSelectedSessionId ? (
                      <div className="text-[12px] text-amber-300">
                        The transcript summary loaded, but the full conversation could not be fetched.
                      </div>
                    ) : transcriptMessages.length > 0 ? (
                      transcriptMessages.map((message, index) => {
                        const outbound = message.role === 'assistant'
                        const speakerName = outbound
                          ? (selectedAgent?.name || 'Agent')
                          : (message.source?.senderName || selectedSession.connectorContext?.senderName || 'Sender')
                        return (
                          <div
                            key={`${message.time}-${index}`}
                            className={`flex items-end gap-3 ${outbound ? 'justify-end' : 'justify-start'}`}
                          >
                            {!outbound && (
                              <SenderAvatar
                                name={speakerName}
                                avatarUrl={selectedSession.connectorContext?.senderAvatarUrl}
                                platform={selectedSession.connectorContext?.platform || selectedConnector?.platform || 'connector'}
                              />
                            )}
                            <div
                              className={`max-w-[88%] rounded-[18px] border px-4 py-3 ${
                                outbound
                                  ? 'bg-accent-soft/90 border-accent-bright/15 text-text'
                                  : 'bg-white/[0.04] border-white/[0.06] text-text'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3 mb-2">
                                <div className="text-[10px] uppercase tracking-[0.08em] text-text-3">
                                  {speakerName}
                                </div>
                                <div className="text-[10px] text-text-3">{relativeTime(message.time)}</div>
                              </div>
                              <div className="text-[13px] whitespace-pre-wrap break-words leading-relaxed">{message.text}</div>
                            </div>
                            {outbound && (
                              <AgentAvatar
                                seed={selectedAgent?.avatarSeed || null}
                                avatarUrl={selectedAgent?.avatarUrl}
                                name={speakerName}
                                size={32}
                                className="ring-1 ring-white/[0.08]"
                              />
                            )}
                          </div>
                        )
                      })
                    ) : (
                      <div className="text-[12px] text-text-3">No persisted transcript for this conversation yet.</div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center px-6 text-center text-[13px] text-text-3">
              Pick a conversation from the middle column to inspect its transcript.
            </div>
          )}
        </section>
      </div>

      <BottomSheet
        open={accessSheetOpen && !!selectedSession}
        onClose={() => setAccessSheetOpen(false)}
        wide
        title="Connector Access & Ownership"
        description="Manage allow lists, deny lists, pairing requests, and owner routing for the selected sender."
      >
        {selectedSession ? (
          <ConnectorAccessPanel
            connector={selectedConnector}
            snapshot={accessSnapshot}
            loading={accessLoading}
            error={accessError}
            pending={accessPending}
            senderId={selectedSession.connectorContext?.senderId || null}
            senderIdAlt={selectedSession.connectorContext?.senderIdAlt || null}
            senderName={selectedSession.connectorContext?.senderName || null}
            onAction={handleAccessAction}
            description="Review the sender, switch ownership, and manage connector approvals without interrupting the main transcript view."
          />
        ) : null}
      </BottomSheet>
    </div>
  )
}
