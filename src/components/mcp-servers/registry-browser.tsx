'use client'

/**
 * Browse the public SwarmDock MCP Registry (https://mcp.swarmdock.ai) from
 * the New MCP Server sheet. Selecting a server populates the form with its
 * recommended install method so users get one-click discovery without
 * leaving SwarmClaw.
 *
 * Read-only — SwarmClaw only consumes the registry. Attestations and
 * submissions happen through SwarmDock directly.
 */

import { useEffect, useState } from 'react'

const REGISTRY_API = 'https://swarmdock-api.onrender.com/api/v1/mcp/servers'

export interface RegistryPrefill {
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  sourceSlug: string
}

interface RegistryServer {
  slug: string
  name: string
  description: string
  transport: string
  authMode: string
  language: string | null
  tags: string[]
  qualityScore: number
  verifiedUsageCount: number
  paidTier: boolean
}

interface RegistryDetail extends RegistryServer {
  installations: Array<{ method: string; spec: Record<string, unknown> }>
}

function mapTransport(transport: string): 'stdio' | 'sse' | 'streamable-http' {
  if (transport === 'sse') return 'sse'
  if (transport === 'streamable_http') return 'streamable-http'
  return 'stdio'
}

function installToPrefill(server: RegistryDetail): RegistryPrefill | null {
  const preferred = server.installations.find((i) => i.method === 'npx')
    ?? server.installations.find((i) => i.method === 'npm')
    ?? server.installations.find((i) => i.method === 'uvx')
    ?? server.installations.find((i) => i.method === 'pipx')
    ?? server.installations.find((i) => i.method === 'docker')
    ?? server.installations.find((i) => i.method === 'remote')
    ?? server.installations[0]

  if (!preferred) return null

  const spec = preferred.spec
  const transport = mapTransport(server.transport)

  if (preferred.method === 'remote') {
    const url = typeof spec.url === 'string' ? spec.url : undefined
    return url
      ? { name: server.name, transport: transport === 'stdio' ? 'streamable-http' : transport, url, sourceSlug: server.slug }
      : null
  }

  const command = typeof spec.command === 'string' ? spec.command : preferred.method === 'docker' ? 'docker' : 'npx'
  const args = Array.isArray(spec.args)
    ? spec.args.filter((a): a is string => typeof a === 'string')
    : preferred.method === 'npm' && typeof spec.package === 'string'
      ? ['-y', spec.package]
      : []

  return { name: server.name, transport, command, args, sourceSlug: server.slug }
}

export function RegistryBrowser({
  open,
  onClose,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  onSelect: (prefill: RegistryPrefill) => void
}) {
  const [query, setQuery] = useState('')
  const [servers, setServers] = useState<RegistryServer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const fetchServers = async () => {
      setLoading(true)
      setError(null)
      try {
        const qs = query ? `?q=${encodeURIComponent(query)}&limit=20` : '?limit=20'
        const res = await fetch(`${REGISTRY_API}${qs}`)
        if (!res.ok) throw new Error(`Registry returned ${res.status}`)
        const data = await res.json() as { servers: RegistryServer[] }
        if (!cancelled) setServers(data.servers)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load registry')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const timer = setTimeout(fetchServers, query ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  const handleSelect = async (slug: string) => {
    setSelecting(slug)
    try {
      const res = await fetch(`${REGISTRY_API}/${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(`Server detail returned ${res.status}`)
      const detail = await res.json() as RegistryDetail
      const prefill = installToPrefill(detail)
      if (!prefill) {
        setError('This server has no installation method SwarmClaw can consume yet.')
        return
      }
      onSelect(prefill)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch server')
    } finally {
      setSelecting(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-[20px] border border-white/[0.08] bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
          <div>
            <h3 className="font-display text-[18px] font-700 tracking-[-0.02em]">Browse SwarmDock MCP Registry</h3>
            <p className="mt-0.5 text-[12px] text-text-3">
              Public directory with verified usage signal · <a href="https://mcp.swarmdock.ai" target="_blank" rel="noopener noreferrer" className="text-accent-bright hover:underline">mcp.swarmdock.ai</a>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-3 hover:text-text"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4">
          <input
            type="text"
            placeholder="Search — e.g. postgres, pdf, github"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-[12px] border border-white/[0.08] bg-surface-2 px-4 py-2.5 text-[14px] outline-none focus-glow"
            style={{ fontFamily: 'inherit' }}
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <p className="px-2 py-4 text-center text-[13px] text-text-3">Loading...</p>
          ) : error ? (
            <p className="px-2 py-4 text-center text-[13px] text-red-400">{error}</p>
          ) : servers.length === 0 ? (
            <p className="px-2 py-4 text-center text-[13px] text-text-3">No servers found.</p>
          ) : (
            <ul className="space-y-1.5">
              {servers.map((server) => (
                <li key={server.slug}>
                  <button
                    type="button"
                    onClick={() => handleSelect(server.slug)}
                    disabled={selecting !== null}
                    className="group flex w-full flex-col gap-1 rounded-[12px] border border-transparent px-3 py-2.5 text-left transition-all hover:border-white/[0.08] hover:bg-surface-2 disabled:opacity-60"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-600 group-hover:text-accent-bright">{server.name}</span>
                      <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-mono uppercase text-text-3">
                        {server.transport}
                      </span>
                      {server.paidTier ? (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-600 text-emerald-400">
                          Paid
                        </span>
                      ) : null}
                      {selecting === server.slug ? (
                        <span className="ml-auto text-[11px] text-accent-bright">Loading...</span>
                      ) : (
                        <span className="ml-auto text-[11px] text-text-3">
                          Q {server.qualityScore.toFixed(2)} · {server.verifiedUsageCount.toLocaleString()} uses
                        </span>
                      )}
                    </div>
                    <p className="line-clamp-2 text-[12px] text-text-3">{server.description}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
