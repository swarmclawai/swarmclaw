'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'
import type { Connector } from '@/types'
import { ConnectorPlatformBadge, getConnectorPlatformLabel } from '@/components/shared/connector-platform-icon'

export function ConnectorList({ inSidebar: _inSidebar }: { inSidebar?: boolean }) {
  void _inSidebar
  const connectors = useAppStore((s) => s.connectors)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const setConnectorSheetOpen = useAppStore((s) => s.setConnectorSheetOpen)
  const setEditingConnectorId = useAppStore((s) => s.setEditingConnectorId)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [toggling, setToggling] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    await Promise.all([loadConnectors(), loadAgents()])
    setLoaded(true)
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
      // Stop then start to reconnect
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

  return (
    <div className="flex-1 overflow-y-auto pb-20">
      {error && (
        <div className="mx-4 mt-2 mb-1 px-3 py-2 rounded-[8px] bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] leading-snug">
          {error}
        </div>
      )}
      {list.map((c) => {
        const platformLabel = getConnectorPlatformLabel(c.platform)
        const agent = agents[c.agentId]
        const isRunning = c.status === 'running'
        const isToggling = toggling === c.id
        // Can only toggle if connector has credentials (or is WhatsApp which uses QR)
        const hasCredentials = c.platform === 'whatsapp' || !!c.credentialId
        return (
          <div
            key={c.id}
            className="w-full flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02] transition-colors group"
          >
            {/* Clickable area — opens editor */}
            <button
              onClick={() => { setEditingConnectorId(c.id); setConnectorSheetOpen(true) }}
              className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer bg-transparent border-none text-left p-0"
            >
              <ConnectorPlatformBadge platform={c.platform} size={36} iconSize={16} />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-600 text-text truncate">{c.name}</span>
                  <span
                    className={`shrink-0 w-2 h-2 rounded-full ${
                      isRunning ? 'bg-green-400' :
                      c.status === 'error' ? 'bg-red-400' : 'bg-white/20'
                    }`}
                  />
                  {c.qrDataUrl && (
                    <span className="shrink-0 text-[10px] font-600 uppercase tracking-wider text-violet-400/80 bg-violet-400/[0.08] px-1.5 py-0.5 rounded-[5px]">
                      QR Ready
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-text-3 truncate">
                  {c.lastError
                    ? <span className="text-red-400">{c.lastError.slice(0, 60)}{c.lastError.length > 60 ? '...' : ''}</span>
                    : <>{platformLabel} {agent ? `\u2192 ${agent.name}` : ''}</>
                  }
                </div>
              </div>
            </button>

            {/* Reconnect button for error-state connectors */}
            {c.status === 'error' && hasCredentials && (
              <button
                onClick={(e) => handleReconnect(e, c)}
                disabled={reconnecting === c.id}
                title="Reconnect"
                aria-label="Reconnect connector"
                className={`shrink-0 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 transition-all cursor-pointer border-none
                  ${reconnecting === c.id ? 'opacity-50' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}
                  bg-amber-500/10 text-amber-400 hover:bg-amber-500/20`}
              >
                {reconnecting === c.id ? '...' : 'Reconnect'}
              </button>
            )}

            {/* Toggle button — visible on hover, only if connector has credentials */}
            {hasCredentials && <button
              onClick={(e) => handleToggle(e, c)}
              disabled={isToggling}
              title={isRunning ? 'Stop connector' : 'Start connector'}
              aria-label={isRunning ? 'Stop connector' : 'Start connector'}
              className={`shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center transition-all cursor-pointer border-none ${
                isToggling ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
              } ${
                isRunning
                  ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                  : 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
              } disabled:opacity-50`}
            >
              {isToggling ? (
                <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
              ) : isRunning ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="6,3 21,12 6,21" />
                </svg>
              )}
            </button>}
          </div>
        )
      })}
    </div>
  )
}
