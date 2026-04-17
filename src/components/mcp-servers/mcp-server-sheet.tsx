'use client'

import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { HintTip } from '@/components/shared/hint-tip'
import { AdvancedSettingsSection } from '@/components/shared/advanced-settings-section'
import { api } from '@/lib/app/api-client'
import { toast } from 'sonner'
import type { McpServerConfig, McpTransport } from '@/types'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import { RegistryBrowser, type RegistryPrefill } from './registry-browser'

interface McpPreset {
  id: string
  label: string
  description: string
  helpUrl?: string
  transport: McpTransport
  command?: string
  args?: string[]
  needsCwd?: boolean
  cwdHint?: string
  defaultName: string
  envTemplate?: Record<string, string>
  url?: string
  headersTemplate?: Record<string, string>
}

const MCP_PRESETS: McpPreset[] = [
  {
    id: 'swarmvault',
    label: 'SwarmVault',
    description: 'Local-first knowledge vault. Point this at a directory containing swarmvault.config.json.',
    helpUrl: 'https://swarmvault.ai',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@swarmvaultai/cli', 'mcp'],
    needsCwd: true,
    cwdHint: 'Absolute path to a SwarmVault workspace (the directory containing swarmvault.config.json). Run `npx @swarmvaultai/cli init` there first if you haven\'t.',
    defaultName: 'SwarmVault',
  },
  {
    id: 'mcp-gateway',
    label: 'MCP Gateway (local)',
    description: 'Consolidate many MCP servers behind one entry. The gateway fans out to your downstream servers, namespaces their tools, and only exposes the ones you pre-load — big token savings when you run more than a handful of MCP servers.',
    helpUrl: 'https://github.com/swarmclawai/mcp-gateway',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@swarmclawai/mcp-gateway@latest', 'start'],
    needsCwd: true,
    cwdHint: 'Absolute path to a directory containing mcp-gateway.config.json. Run `npx @swarmclawai/mcp-gateway init --write` there first to generate a starter config.',
    defaultName: 'MCP Gateway',
  },
  {
    id: 'swarmdock',
    label: 'SwarmDock',
    description: 'Agent marketplace — browse tasks, bid, submit work, publish MCP services, earn USDC. Connects to the hosted MCP endpoint; generate a key and register an agent at swarmdock.ai/mcp/connect, then paste it into the Bearer header below.',
    helpUrl: 'https://www.swarmdock.ai/mcp/connect',
    transport: 'streamable-http',
    url: 'https://swarmdock-api.onrender.com/mcp',
    defaultName: 'SwarmDock',
    headersTemplate: {
      Authorization: 'Bearer <your-base64-ed25519-secret>',
    },
  },
]

function McpServerForm({ editing, onClose, loadMcpServers }: {
  editing: McpServerConfig | null
  onClose: () => void
  loadMcpServers: () => Promise<void>
}) {
  const mountedRef = useMountedRef()
  const [name, setName] = useState(editing?.name || '')
  const [transport, setTransport] = useState<McpTransport>(editing?.transport || 'stdio')
  const [command, setCommand] = useState(editing?.command || '')
  const [args, setArgs] = useState(editing?.args?.join(', ') || '')
  const [cwd, setCwd] = useState(editing?.cwd || '')
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [registryBrowserOpen, setRegistryBrowserOpen] = useState(false)
  const [url, setUrl] = useState(editing?.url || '')
  const [envText, setEnvText] = useState(
    editing?.env ? Object.entries(editing.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
  )
  const [headersText, setHeadersText] = useState(
    editing?.headers ? Object.entries(editing.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
  )
  const initialExposureMode: 'all' | 'lazy' | 'selected' =
    editing === null || editing?.alwaysExpose === undefined || editing.alwaysExpose === true
      ? 'all'
      : editing.alwaysExpose === false
        ? 'lazy'
        : 'selected'
  const [exposureMode, setExposureMode] = useState<'all' | 'lazy' | 'selected'>(initialExposureMode)
  const [exposureAllowlistText, setExposureAllowlistText] = useState(
    Array.isArray(editing?.alwaysExpose) ? editing.alwaysExpose.join(', ') : '',
  )
  const [advancedOpen, setAdvancedOpen] = useState(initialExposureMode !== 'all')
  const [discoveredTools, setDiscoveredTools] = useState<Array<{ name: string; description?: string; tokens: number }> | null>(null)
  const [discoveredLoading, setDiscoveredLoading] = useState(false)
  const [discoveredError, setDiscoveredError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; tools?: string[]; error?: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Lazily load discovered tools when the user picks the allow-list mode
  // for an existing (edited) server. Only hits the server once per sheet open.
  useEffect(() => {
    if (!editing || exposureMode !== 'selected' || discoveredTools || discoveredLoading) return
    let cancelled = false
    setDiscoveredLoading(true)
    setDiscoveredError(null)
    void (async () => {
      try {
        const res = await api<{ tools: Array<{ name: string; description?: string; tokens: number }> }>(
          'GET',
          `/mcp-servers/${editing.id}/tools-info`,
        )
        if (cancelled) return
        setDiscoveredTools(res.tools)
      } catch (err: unknown) {
        if (cancelled) return
        setDiscoveredError(err instanceof Error ? err.message : 'Failed to load tools')
      } finally {
        if (!cancelled) setDiscoveredLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [editing, exposureMode, discoveredTools, discoveredLoading])

  const toggleAllowlistTool = (toolName: string) => {
    const current = exposureAllowlistText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    const next = current.includes(toolName)
      ? current.filter((t) => t !== toolName)
      : [...current, toolName]
    setExposureAllowlistText(next.join(', '))
  }

  const parseEnv = (text: string): Record<string, string> | undefined => {
    if (!text.trim()) return undefined
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return Object.keys(env).length > 0 ? env : undefined
  }

  const parseHeaders = (text: string): Record<string, string> | undefined => {
    if (!text.trim()) return undefined
    const headers: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  }

  const handleSave = async () => {
    const data: Record<string, unknown> = {
      name: name.trim() || 'Unnamed Server',
      transport,
      env: parseEnv(envText),
      headers: parseHeaders(headersText),
      alwaysExpose:
        exposureMode === 'all'
          ? true
          : exposureMode === 'lazy'
            ? false
            : exposureAllowlistText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    }
    if (transport === 'stdio') {
      data.command = command.trim()
      data.args = args.trim() ? args.split(',').map((a) => a.trim()).filter(Boolean) : []
      data.cwd = cwd.trim() || undefined
    } else {
      data.url = url.trim()
    }
    try {
      if (editing) {
        await api('PUT', `/mcp-servers/${editing.id}`, data)
        toast.success('MCP server updated')
      } else {
        await api('POST', '/mcp-servers', data)
        toast.success('MCP server created')
      }
      await loadMcpServers()
      if (!mountedRef.current) return
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to save server')
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    setDeleting(true)
    try {
      await api('DELETE', `/mcp-servers/${editing.id}`)
      toast.success('MCP server deleted')
      await loadMcpServers()
      if (!mountedRef.current) return
      setConfirmDelete(false)
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete server')
    } finally {
      if (mountedRef.current) {
        setDeleting(false)
      }
    }
  }

  const handleTest = async () => {
    if (!editing) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api<{ ok: boolean; tools?: string[]; error?: string }>('POST', `/mcp-servers/${editing.id}/test`)
      if (!mountedRef.current) return
      setTestResult(result)
      if (result.ok) toast.success('Connection test passed')
      else toast.error(result.error || 'Connection test failed')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Test failed'
      if (!mountedRef.current) return
      setTestResult({ ok: false, error: msg })
      toast.error(msg)
    }
    if (mountedRef.current) {
      setTesting(false)
    }
  }

  const canSave = name.trim() && (transport === 'stdio' ? command.trim() : url.trim())

  const applyPreset = (preset: McpPreset) => {
    setActivePresetId(preset.id)
    setTransport(preset.transport)
    if (preset.command !== undefined) setCommand(preset.command)
    if (preset.args !== undefined) setArgs(preset.args.join(', '))
    if (preset.url !== undefined) setUrl(preset.url)
    if (!name.trim()) setName(preset.defaultName)
    if (preset.envTemplate && !envText.trim()) {
      setEnvText(Object.entries(preset.envTemplate).map(([k, v]) => `${k}=${v}`).join('\n'))
    }
    if (preset.headersTemplate && !headersText.trim()) {
      setHeadersText(Object.entries(preset.headersTemplate).map(([k, v]) => `${k}: ${v}`).join('\n'))
    }
  }

  const activePreset = activePresetId ? MCP_PRESETS.find((p) => p.id === activePresetId) ?? null : null

  const applyRegistryPrefill = (prefill: RegistryPrefill) => {
    setActivePresetId(null)
    setTransport(prefill.transport)
    if (prefill.command !== undefined) setCommand(prefill.command)
    if (prefill.args !== undefined) setArgs(prefill.args.join(', '))
    if (prefill.url !== undefined) setUrl(prefill.url)
    if (!name.trim()) setName(prefill.name)
    toast.success(`Prefilled from SwarmDock MCP Registry: ${prefill.sourceSlug}`)
  }

  const inputClass = "w-full px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow"
  const labelClass = "block font-display text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-3"

  return (
    <>
      <div className="mb-10">
        <h2 className="font-display text-[28px] font-700 tracking-[-0.03em] mb-2">
          {editing ? 'Edit MCP Server' : 'New MCP Server'}
        </h2>
        <p className="text-[14px] text-text-3">Configure an MCP server to provide tools to agents</p>
      </div>

      {!editing && MCP_PRESETS.length > 0 && (
        <div className="mb-8">
          <label className={labelClass}>Quick Setup</label>
          <div className="flex flex-wrap gap-2">
            {MCP_PRESETS.map((preset) => {
              const isActive = activePresetId === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`py-2 px-4 rounded-[12px] border text-[13px] font-600 cursor-pointer transition-all ${
                    isActive
                      ? 'border-accent-bright bg-accent-bright/10 text-accent-bright'
                      : 'border-white/[0.08] bg-transparent text-text-2 hover:bg-surface-2'
                  }`}
                  style={{ fontFamily: 'inherit' }}
                  title={preset.description}
                >
                  {preset.label}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setRegistryBrowserOpen(true)}
              className="py-2 px-4 rounded-[12px] border border-dashed border-accent-bright/30 bg-transparent text-[13px] font-600 text-accent-bright cursor-pointer transition-all hover:bg-accent-bright/10"
              style={{ fontFamily: 'inherit' }}
              title="Browse the public SwarmDock MCP Registry"
            >
              Browse Registry...
            </button>
          </div>
          {activePreset && (
            <p className="mt-3 text-[12px] text-text-3">
              {activePreset.description}
              {activePreset.helpUrl && (
                <>
                  {' '}
                  <a href={activePreset.helpUrl} target="_blank" rel="noopener noreferrer" className="text-accent-bright hover:underline">Learn more</a>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <div className="mb-8">
        <label className={labelClass}>Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Filesystem Server" className={inputClass} style={{ fontFamily: 'inherit' }} />
      </div>

      <div className="mb-8">
        <label className={labelClass}>Transport</label>
        <select
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpTransport)}
          className={inputClass}
          style={{ fontFamily: 'inherit' }}
        >
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="streamable-http">streamable-http</option>
        </select>
      </div>

      {transport === 'stdio' ? (
        <>
          <div className="mb-8">
            <label className={labelClass}>Command</label>
            <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. npx -y @modelcontextprotocol/server-filesystem" className={inputClass} style={{ fontFamily: 'inherit' }} />
          </div>
          <div className="mb-8">
            <label className={labelClass}>
              Arguments <span className="normal-case tracking-normal font-normal text-text-3">(comma-separated)</span>
            </label>
            <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="e.g. /path/to/dir, --verbose" className={inputClass} style={{ fontFamily: 'inherit' }} />
          </div>
          <div className="mb-8">
            <label className={labelClass}>
              <span className="inline-flex items-center gap-2">
                Working Directory <span className="normal-case tracking-normal font-normal text-text-3">(optional)</span>
                <HintTip text={activePreset?.cwdHint || 'Working directory for the spawned process. Useful when the MCP server discovers config from cwd (e.g. SwarmVault).'} />
              </span>
            </label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={activePreset?.needsCwd ? 'e.g. /Users/you/my-vault' : 'e.g. /path/to/working/dir'}
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </>
      ) : (
        <div className="mb-8">
          <label className={labelClass}>URL</label>
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="e.g. http://localhost:8080/sse" className={inputClass} style={{ fontFamily: 'inherit' }} />
        </div>
      )}

      <div className="mb-8">
        <label className={labelClass}>
          Environment Variables <span className="normal-case tracking-normal font-normal text-text-3">(optional, KEY=VALUE per line)</span>
        </label>
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={"API_KEY=sk-...\nDEBUG=true"}
          rows={3}
          className={`${inputClass} resize-y min-h-[80px] font-mono text-[13px]`}
          style={{ fontFamily: 'inherit' }}
        />
      </div>

      {transport !== 'stdio' && (
        <div className="mb-8">
          <label className={labelClass}>
            Headers <span className="normal-case tracking-normal font-normal text-text-3">(optional, Key: Value per line)</span>
          </label>
          <textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder={"Authorization: Bearer sk-...\nX-Custom: value"}
            rows={3}
            className={`${inputClass} resize-y min-h-[80px] font-mono text-[13px]`}
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      )}

      <AdvancedSettingsSection
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((v) => !v)}
        summary={exposureMode === 'all' ? 'All tools eager' : exposureMode === 'lazy' ? 'Lazy (on demand)' : 'Allow-list'}
        badges={exposureMode === 'selected' && exposureAllowlistText.trim()
          ? exposureAllowlistText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5)
          : []}
      >
        <div className="space-y-4">
          <div>
            <label className={labelClass}>
              Tool exposure
              <HintTip text="Controls how this server's tools get bound into agent context. Lazy servers stay hidden until an agent calls `mcp_tool_search` to discover them — that's how you cut token usage from chatty MCP servers." />
            </label>
            <div className="flex flex-col gap-2">
              {([
                ['all', 'Expose all tools', 'Every tool from this server is bound on every turn. Default — preserves legacy behavior.'],
                ['lazy', 'Lazy — expose none', 'No tools bound until the agent calls mcp_tool_search to discover them. Biggest token savings.'],
                ['selected', 'Allow-list', 'Only pre-bind the tools you list below. Agent can still discover others via mcp_tool_search.'],
              ] as const).map(([value, label, hint]) => (
                <label key={value} className={`flex items-start gap-3 p-3 rounded-[12px] border cursor-pointer transition-all ${exposureMode === value ? 'border-accent-bright bg-accent-bright/5' : 'border-white/[0.08] hover:bg-surface-2'}`}>
                  <input
                    type="radio"
                    name="exposureMode"
                    value={value}
                    checked={exposureMode === value}
                    onChange={() => setExposureMode(value)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-600 text-text">{label}</div>
                    <div className="text-[12px] text-text-3 leading-[1.5] mt-0.5">{hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
          {exposureMode === 'selected' && (
            <div>
              <label className={labelClass}>
                Allow-list tools
                <HintTip text="Pick the tools to bind eagerly. Every unchecked tool stays discoverable via `mcp_tool_search`." />
              </label>
              {discoveredLoading && (
                <div className="text-[12px] text-text-3">Loading tools...</div>
              )}
              {discoveredError && (
                <div className="text-[12px] text-amber-400">
                  Could not load tools: {discoveredError}. Type names manually below.
                </div>
              )}
              {discoveredTools && discoveredTools.length > 0 && (
                (() => {
                  const selected = new Set(
                    exposureAllowlistText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
                  )
                  const totalTokens = discoveredTools.reduce((n, t) => n + t.tokens, 0)
                  const selectedTokens = discoveredTools
                    .filter((t) => selected.has(t.name))
                    .reduce((n, t) => n + t.tokens, 0)
                  return (
                    <div className="space-y-1 rounded-[12px] border border-white/[0.08] bg-surface/50 p-2 max-h-[320px] overflow-auto">
                      <div className="px-2 py-1 text-[11px] font-mono text-text-3">
                        {selectedTokens.toLocaleString()} / {totalTokens.toLocaleString()} tokens selected
                      </div>
                      {discoveredTools.map((t) => {
                        const checked = selected.has(t.name)
                        return (
                          <label
                            key={t.name}
                            className={`flex items-start gap-3 p-2 rounded-[10px] cursor-pointer transition-colors ${checked ? 'bg-accent-bright/5' : 'hover:bg-white/[0.03]'}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAllowlistTool(t.name)}
                              className="mt-1 shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[13px] font-mono text-text truncate">{t.name}</span>
                                <span className="text-[10px] font-mono text-text-3 shrink-0">{t.tokens.toLocaleString()} tok</span>
                              </div>
                              {t.description && (
                                <p className="text-[12px] text-text-3/80 leading-[1.4] mt-0.5 line-clamp-2">{t.description}</p>
                              )}
                            </div>
                          </label>
                        )
                      })}
                    </div>
                  )
                })()
              )}
              {(!discoveredTools || discoveredTools.length === 0) && !discoveredLoading && (
                <textarea
                  value={exposureAllowlistText}
                  onChange={(e) => setExposureAllowlistText(e.target.value)}
                  placeholder={"read_file\nwrite_file"}
                  rows={3}
                  className={`${inputClass} resize-y min-h-[80px] font-mono text-[13px]`}
                  style={{ fontFamily: 'inherit' }}
                />
              )}
            </div>
          )}
        </div>
      </AdvancedSettingsSection>

      {editing && (
        <div className="mb-8">
          <button
            onClick={handleTest}
            disabled={testing}
            className="py-3 px-6 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[14px] font-600 cursor-pointer hover:bg-surface-2 transition-all disabled:opacity-30"
            style={{ fontFamily: 'inherit' }}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {testResult && (
            <div className={`mt-3 p-3 rounded-[10px] text-[13px] ${testResult.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              {testResult.ok ? (
                <>
                  Connected successfully.{' '}
                  {testResult.tools && testResult.tools.length > 0 && (
                    <span className="text-text-3">{testResult.tools.length} tool{testResult.tools.length !== 1 ? 's' : ''} available: {testResult.tools.join(', ')}</span>
                  )}
                </>
              ) : (
                <span>{testResult.error || 'Connection failed'}</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-2 border-t border-white/[0.04]">
        {editing && (
          <button onClick={() => setConfirmDelete(true)} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!canSave} className="flex-1 py-3.5 rounded-[14px] border-none bg-accent-bright text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete MCP Server?"
        message={editing ? `Delete "${editing.name}"? This will remove the MCP server from the app.` : 'Delete this MCP server?'}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        confirmDisabled={deleting}
        cancelDisabled={deleting}
        danger
        onConfirm={() => { void handleDelete() }}
        onCancel={() => { if (!deleting) setConfirmDelete(false) }}
      />
      <RegistryBrowser
        open={registryBrowserOpen}
        onClose={() => setRegistryBrowserOpen(false)}
        onSelect={applyRegistryPrefill}
      />
    </>
  )
}

export function McpServerSheet() {
  const open = useAppStore((s) => s.mcpServerSheetOpen)
  const setOpen = useAppStore((s) => s.setMcpServerSheetOpen)
  const editingId = useAppStore((s) => s.editingMcpServerId)
  const setEditingId = useAppStore((s) => s.setEditingMcpServerId)
  const mcpServers = useAppStore((s) => s.mcpServers)
  const loadMcpServers = useAppStore((s) => s.loadMcpServers)

  const editing = editingId ? mcpServers[editingId] : null

  const onClose = () => {
    setOpen(false)
    setEditingId(null)
  }

  return (
    <BottomSheet open={open} onClose={onClose} wide>
      <McpServerForm
        key={editingId || '__new__'}
        editing={editing}
        onClose={onClose}
        loadMcpServers={loadMcpServers}
      />
    </BottomSheet>
  )
}
