'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import type { Connector, ConnectorPlatform } from '@/types'

const PLATFORM_ICONS: Record<ConnectorPlatform, { color: string; label: string }> = {
  discord: { color: '#5865F2', label: 'Discord' },
  telegram: { color: '#229ED9', label: 'Telegram' },
  slack: { color: '#4A154B', label: 'Slack' },
  whatsapp: { color: '#25D366', label: 'WhatsApp' },
}

export function ConnectorList({ inSidebar }: { inSidebar?: boolean }) {
  const connectors = useAppStore((s) => s.connectors)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const setConnectorSheetOpen = useAppStore((s) => s.setConnectorSheetOpen)
  const setEditingConnectorId = useAppStore((s) => s.setEditingConnectorId)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)

  useEffect(() => {
    loadConnectors()
    loadAgents()
  }, [])

  const list = Object.values(connectors) as Connector[]

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
      {list.map((c) => {
        const platform = PLATFORM_ICONS[c.platform]
        const agent = agents[c.agentId]
        return (
          <button
            key={c.id}
            onClick={() => { setEditingConnectorId(c.id); setConnectorSheetOpen(true) }}
            className="w-full flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02] transition-colors cursor-pointer bg-transparent border-none text-left"
          >
            {/* Platform indicator */}
            <div
              className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 text-white text-[11px] font-700"
              style={{ backgroundColor: platform.color }}
            >
              {platform.label.slice(0, 2).toUpperCase()}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-600 text-text truncate">{c.name}</span>
                <span
                  className={`shrink-0 w-2 h-2 rounded-full ${
                    c.status === 'running' ? 'bg-green-400' :
                    c.status === 'error' ? 'bg-red-400' : 'bg-white/20'
                  }`}
                />
              </div>
              <div className="text-[11px] text-text-3 truncate">
                {platform.label} {agent ? `\u2192 ${agent.name}` : ''}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
