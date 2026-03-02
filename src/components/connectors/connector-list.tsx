'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'
import type { Connector } from '@/types'
import { ConnectorPlatformIcon, ConnectorPlatformBadge, CONNECTOR_PLATFORM_META, getConnectorPlatformLabel } from '@/components/shared/connector-platform-icon'
import { AgentAvatar } from '@/components/agents/agent-avatar'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ConnectorList({ inSidebar }: { inSidebar?: boolean }) {
  const connectors = useAppStore((s) => s.connectors)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const setConnectorSheetOpen = useAppStore((s) => s.setConnectorSheetOpen)
  const setEditingConnectorId = useAppStore((s) => s.setEditingConnectorId)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const loadChatrooms = useChatroomStore((s) => s.loadChatrooms)
  const [toggling, setToggling] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    await Promise.all([loadConnectors(), loadAgents(), loadChatrooms()])
    setLoaded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConnectors, loadAgents])

  useEffect(() => { void refresh() }, [refresh])
  useWs('connectors', loadConnectors, 15_000)

  // Auto-clear error after 5s
  useEffect(() => {
    if (error) { const t = setTimeout(() => setError(null), 5000); return () => clearTimeout(t) }
  }, [error])

  const handleToggle = async (e: React.MouseEvent, c: Connector) => {
    e.stopPropagation()
    const action = c.status === 'running' ? 'stop' : 'start'
    setToggling(c.id)
    setError(null)
    try {
      await api('PUT', `/connectors/${c.id}`, { action })
      await refresh()
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message ? err.message : `Failed to ${action}`
      setError(msg)
      await refresh()
    } finally {
      setToggling(null)
    }
  }

  const handleReconnect = async (e: React.MouseEvent, c: Connector) => {
    e.stopPropagation()
    setReconnecting(c.id)
    setError(null)
    try {
      try { await api('PUT', `/connectors/${c.id}`, { action: 'stop' }) } catch { /* may already be stopped */ }
      await api('PUT', `/connectors/${c.id}`, { action: 'start' })
      await refresh()
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message ? err.message : 'Failed to reconnect'
      setError(msg)
      await refresh()
    } finally {
      setReconnecting(null)
    }
  }

  const list = Object.values(connectors) as Connector[]

  if (!loaded) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        <p className="text-[13px] text-text-3">Loading connectors...</p>
      </div>
    )
  }

  if (!list.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        <p className="text-[13px] text-text-3">No connectors configured yet.</p>
        <button
          onClick={() => { setEditingConnectorId(null); setConnectorSheetOpen(true) }}
          className="mt-3 text-[13px] text-accent-bright hover:underline cursor-pointer bg-transparent border-none"
        >
          + Add Connector
        </button>
      </div>
    )
  }

  // Sidebar: compact list layout
  if (inSidebar) {
    return (
      <div className="flex-1 overflow-y-auto pb-20">
        {error && (
          <div className="mx-4 mt-2 mb-1 px-3 py-2 rounded-[8px] bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] leading-snug">
            {error}
          </div>
        )}
        {list.map((c) => {
          const agent = c.agentId ? agents[c.agentId] : null
          const chatroom = c.chatroomId ? chatrooms[c.chatroomId] : null
          const isRunning = c.status === 'running'
          const meta = CONNECTOR_PLATFORM_META[c.platform]
          return (
            <button
              key={c.id}
              onClick={() => { setEditingConnectorId(c.id); setConnectorSheetOpen(true) }}
              className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer bg-transparent border-none text-left"
            >
              <ConnectorPlatformIcon platform={c.platform} size={16} />
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-600 text-text truncate block">{c.name}</span>
                <span className="text-[11px] text-text-3 truncate block">
                  {chatroom ? chatroom.name : agent?.name || meta?.label}
                </span>
              </div>
              <span className={`shrink-0 w-2 h-2 rounded-full ${
                isRunning ? 'bg-green-400' : c.status === 'error' ? 'bg-red-400' : 'bg-white/20'
              }`} />
            </button>
          )
        })}
      </div>
    )
  }

  // Main view: card grid
  return (
    <div className="flex-1 overflow-y-auto pb-20 px-5 pt-2">
      {error && (
        <div className="mb-3 px-3 py-2 rounded-[8px] bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] leading-snug">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {list.map((c) => {
          const platformLabel = getConnectorPlatformLabel(c.platform)
          const agent = c.agentId ? agents[c.agentId] : null
          const chatroom = c.chatroomId ? chatrooms[c.chatroomId] : null
          const isRunning = c.status === 'running'
          const isToggling = toggling === c.id
          const hasCredentials = c.platform === 'whatsapp'
            || c.platform === 'openclaw'
            || c.platform === 'signal'
            || (c.platform === 'bluebubbles' && (!!c.credentialId || !!c.config?.password))
            || !!c.credentialId
          const lastMsg = c.presence?.lastMessageAt

          return (
            <button
              key={c.id}
              onClick={() => { setEditingConnectorId(c.id); setConnectorSheetOpen(true) }}
              className="group relative flex flex-col rounded-[14px] border border-white/[0.06] bg-surface p-4 cursor-pointer transition-all hover:border-white/[0.12] hover:bg-white/[0.02] text-left w-full"
              style={{ fontFamily: 'inherit' }}
            >
              {/* Header: platform badge + status */}
              <div className="flex items-center gap-3 mb-3">
                <ConnectorPlatformBadge platform={c.platform} size={40} iconSize={20} roundedClassName="rounded-[10px]" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-600 text-text truncate">{c.name}</span>
                    <span className={`shrink-0 w-2 h-2 rounded-full ${
                      isRunning ? 'bg-green-400' : c.status === 'error' ? 'bg-red-400' : 'bg-white/20'
                    }`} />
                  </div>
                  <span className="text-[11px] text-text-3 block">
                    {isRunning ? 'Connected' : c.status === 'error' ? 'Error' : 'Stopped'}
                    {c.qrDataUrl && ' · QR ready'}
                  </span>
                </div>
              </div>

              {/* Route target: agent or chatroom */}
              <div className="flex items-center gap-2.5 mb-2.5 px-0.5">
                {chatroom ? (
                  <>
                    <div className="w-6 h-6 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-[12px] font-600 text-text-2 block truncate">{chatroom.name}</span>
                      <span className="text-[10px] text-text-3/60 block">
                        {chatroom.agentIds.length} agent{chatroom.agentIds.length !== 1 ? 's' : ''}
                        {chatroom.chatMode === 'parallel' ? ' · parallel' : ' · sequential'}
                      </span>
                    </div>
                  </>
                ) : agent ? (
                  <>
                    <AgentAvatar seed={agent.avatarSeed || null} name={agent.name} size={24} />
                    <div className="flex-1 min-w-0">
                      <span className="text-[12px] font-600 text-text-2 block truncate">{agent.name}</span>
                      <span className="text-[10px] text-text-3/60 block">{agent.provider}/{agent.model}</span>
                    </div>
                  </>
                ) : (
                  <span className="text-[11px] text-text-3/50">{platformLabel}</span>
                )}
              </div>

              {/* Footer: last message time + error */}
              <div className="flex items-center gap-2 mt-auto pt-2 border-t border-white/[0.04]">
                {c.lastError ? (
                  <span className="text-[10px] text-red-400 truncate flex-1">
                    {c.lastError.slice(0, 50)}{c.lastError.length > 50 ? '...' : ''}
                  </span>
                ) : lastMsg ? (
                  <span className="text-[10px] text-text-3/60 flex-1">Last message {relativeTime(lastMsg)}</span>
                ) : (
                  <span className="text-[10px] text-text-3/40 flex-1">No messages yet</span>
                )}

                {/* Action buttons */}
                <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {c.status === 'error' && hasCredentials && (
                    <button
                      onClick={(e) => handleReconnect(e, c)}
                      disabled={reconnecting === c.id}
                      title="Reconnect"
                      className="px-2 py-1 rounded-[6px] text-[10px] font-600 transition-all cursor-pointer border-none opacity-0 group-hover:opacity-100 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      {reconnecting === c.id ? '...' : 'Reconnect'}
                    </button>
                  )}
                  {hasCredentials && (
                    <button
                      onClick={(e) => handleToggle(e, c)}
                      disabled={isToggling}
                      title={isRunning ? 'Stop' : 'Start'}
                      className={`w-7 h-7 rounded-[6px] flex items-center justify-center transition-all cursor-pointer border-none ${
                        isToggling ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      } ${isRunning
                        ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                        : 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                      } disabled:opacity-50`}
                    >
                      {isToggling ? (
                        <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : isRunning ? (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                      ) : (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 21,12 6,21" /></svg>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
