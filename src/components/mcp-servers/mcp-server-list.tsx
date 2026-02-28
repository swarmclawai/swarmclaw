'use client'

import { useEffect, useState, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'

const transportColors: Record<string, string> = {
  stdio: 'bg-emerald-500/15 text-emerald-400',
  sse: 'bg-blue-500/15 text-blue-400',
  'streamable-http': 'bg-purple-500/15 text-purple-400',
}

type McpStatus = { ok: boolean; tools?: string[]; error?: string; loading: boolean }

export function McpServerList({ inSidebar }: { inSidebar?: boolean }) {
  const mcpServers = useAppStore((s) => s.mcpServers)
  const loadMcpServers = useAppStore((s) => s.loadMcpServers)
  const setMcpServerSheetOpen = useAppStore((s) => s.setMcpServerSheetOpen)
  const setEditingMcpServerId = useAppStore((s) => s.setEditingMcpServerId)
  const [statuses, setStatuses] = useState<Record<string, McpStatus>>({})
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    loadMcpServers()
  }, [loadMcpServers])

  const serverList = Object.values(mcpServers)

  // Staggered status tests on mount
  useEffect(() => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []

    serverList.forEach((server, i) => {
      setStatuses((prev) => ({ ...prev, [server.id]: { ok: false, loading: true } }))
      const timer = setTimeout(async () => {
        try {
          const res = await api<{ ok: boolean; tools?: string[]; error?: string }>('POST', `/mcp-servers/${server.id}/test`)
          setStatuses((prev) => ({ ...prev, [server.id]: { ok: res.ok, tools: res.tools, error: res.error, loading: false } }))
        } catch {
          setStatuses((prev) => ({ ...prev, [server.id]: { ok: false, error: 'Test failed', loading: false } }))
        }
      }, i * 200)
      timersRef.current.push(timer)
    })

    return () => timersRef.current.forEach(clearTimeout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpServers])

  const handleEdit = (id: string) => {
    setEditingMcpServerId(id)
    setMcpServerSheetOpen(true)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await api('DELETE', `/mcp-servers/${id}`)
    await loadMcpServers()
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-4'}`}>
      {serverList.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[13px] text-text-3/60">No MCP servers configured</p>
          <button
            onClick={() => { setEditingMcpServerId(null); setMcpServerSheetOpen(true) }}
            className="mt-3 px-4 py-2 rounded-[10px] bg-transparent text-accent-bright text-[13px] font-600 cursor-pointer border border-accent-bright/20 hover:bg-accent-soft transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            + Add MCP Server
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {serverList.map((server) => (
            <button
              key={server.id}
              onClick={() => handleEdit(server.id)}
              className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  {(() => {
                    const s = statuses[server.id]
                    if (!s || s.loading) return <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shrink-0" title="Testing..." />
                    if (s.ok) return (
                      <span className="flex items-center gap-1 shrink-0">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                        {s.tools && <span className="text-[10px] text-emerald-400/80 font-mono">{s.tools.length} tools</span>}
                      </span>
                    )
                    return <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" title={s.error || 'Failed'} />
                  })()}
                  <span className="font-display text-[14px] font-600 text-text truncate">{server.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${transportColors[server.transport] || 'bg-white/10 text-text-3'}`}>
                    {server.transport}
                  </span>
                  <button
                    onClick={(e) => handleDelete(e, server.id)}
                    className="text-text-3/40 hover:text-red-400 transition-colors p-0.5"
                    title="Delete server"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
              <p className="text-[12px] text-text-3/60 font-mono truncate">
                {server.transport === 'stdio' ? server.command : server.url}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
