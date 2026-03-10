'use client'

import { useEffect, useState, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { api } from '@/lib/app/api-client'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import { StatusDot } from '@/components/ui/status-dot'

const transportColors: Record<string, string> = {
  stdio: 'bg-emerald-500/15 text-emerald-400',
  sse: 'bg-blue-500/15 text-blue-400',
  'streamable-http': 'bg-purple-500/15 text-purple-400',
}

type McpStatus = { ok: boolean; tools?: string[]; error?: string; loading: boolean }
type McpToolMeta = { name: string; description?: string; inputSchema?: Record<string, unknown> }
type McpInvokeResult = { ok: boolean; text?: string; error?: string; isError?: boolean; result?: unknown }
type McpConformanceIssue = { level: 'error' | 'warning'; code: string; message: string; toolName?: string }
type McpConformanceResult = {
  ok: boolean
  toolsCount: number
  smokeToolName: string | null
  issues: McpConformanceIssue[]
  timings: { connectMs: number; listToolsMs: number; smokeInvokeMs: number | null }
}

function buildArgsTemplate(inputSchema: Record<string, unknown> | undefined): string {
  const schema = inputSchema || {}
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : []
  const properties = (schema.properties && typeof schema.properties === 'object')
    ? schema.properties as Record<string, Record<string, unknown>>
    : {}
  const template: Record<string, unknown> = {}
  for (const key of required.slice(0, 8)) {
    const prop = properties[key] || {}
    const type = typeof prop.type === 'string' ? prop.type : 'string'
    template[key] = type === 'number' || type === 'integer'
      ? 0
      : type === 'boolean'
        ? false
        : type === 'array'
          ? []
          : type === 'object'
            ? {}
            : ''
  }
  return JSON.stringify(template, null, 2) || '{}'
}

export function McpServerList({ inSidebar }: { inSidebar?: boolean }) {
  const mountedRef = useMountedRef()
  const mcpServers = useAppStore((s) => s.mcpServers)
  const loadMcpServers = useAppStore((s) => s.loadMcpServers)
  const setMcpServerSheetOpen = useAppStore((s) => s.setMcpServerSheetOpen)
  const setEditingMcpServerId = useAppStore((s) => s.setEditingMcpServerId)
  const [statuses, setStatuses] = useState<Record<string, McpStatus>>({})
  const [inspectorServerId, setInspectorServerId] = useState<string | null>(null)
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpToolMeta[]>>({})
  const [inspectorLoading, setInspectorLoading] = useState(false)
  const [inspectorError, setInspectorError] = useState<string | null>(null)
  const [selectedTool, setSelectedTool] = useState('')
  const [argsJson, setArgsJson] = useState('{}')
  const [invokeLoading, setInvokeLoading] = useState(false)
  const [invokeResult, setInvokeResult] = useState<McpInvokeResult | null>(null)
  const [conformanceByServer, setConformanceByServer] = useState<Record<string, McpConformanceResult>>({})
  const [conformanceLoading, setConformanceLoading] = useState<Record<string, boolean>>({})
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const inspectorRequestIdRef = useRef(0)
  const invokeRequestIdRef = useRef(0)

  useEffect(() => {
    loadMcpServers()
  }, [loadMcpServers])

  useEffect(() => {
    if (inspectorServerId && !mcpServers[inspectorServerId]) {
      setInspectorServerId(null)
      setInspectorError(null)
      setInvokeResult(null)
    }
  }, [inspectorServerId, mcpServers])

  const serverList = Object.values(mcpServers)
  const activeInspectorServer = inspectorServerId ? mcpServers[inspectorServerId] : null
  const activeTools = inspectorServerId ? (toolsByServer[inspectorServerId] || []) : []
  const activeToolMeta = activeTools.find((tool) => tool.name === selectedTool) || null
  const activeConformance = inspectorServerId ? conformanceByServer[inspectorServerId] : null

  // Staggered status tests on mount
  useEffect(() => {
    let cancelled = false
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []

    serverList.forEach((server, i) => {
      setStatuses((prev) => ({ ...prev, [server.id]: { ok: false, loading: true } }))
      const timer = setTimeout(async () => {
        try {
          const res = await api<{ ok: boolean; tools?: string[]; error?: string }>('POST', `/mcp-servers/${server.id}/test`)
          if (cancelled || !mountedRef.current) return
          setStatuses((prev) => ({ ...prev, [server.id]: { ok: res.ok, tools: res.tools, error: res.error, loading: false } }))
        } catch {
          if (cancelled || !mountedRef.current) return
          setStatuses((prev) => ({ ...prev, [server.id]: { ok: false, error: 'Test failed', loading: false } }))
        }
      }, i * 200)
      timersRef.current.push(timer)
    })

    return () => {
      cancelled = true
      timersRef.current.forEach(clearTimeout)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpServers])

  const handleEdit = (id: string) => {
    setEditingMcpServerId(id)
    setMcpServerSheetOpen(true)
  }

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const server = mcpServers[id]
    setConfirmDelete({ id, name: server?.name || id })
  }

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    setDeletingId(confirmDelete.id)
    try {
      await api('DELETE', `/mcp-servers/${confirmDelete.id}`)
      toast.success('MCP server deleted')
      await loadMcpServers()
      if (!mountedRef.current) return
      setConfirmDelete(null)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete server')
    } finally {
      if (mountedRef.current) {
        setDeletingId(null)
      }
    }
  }

  const handleRetest = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setStatuses((prev) => ({ ...prev, [id]: { ok: false, loading: true } }))
    try {
      const res = await api<{ ok: boolean; tools?: string[]; error?: string }>('POST', `/mcp-servers/${id}/test`)
      if (!mountedRef.current) return
      setStatuses((prev) => ({ ...prev, [id]: { ok: res.ok, tools: res.tools, error: res.error, loading: false } }))
      if (res.ok) toast.success('Connection test passed')
      else toast.error(res.error || 'Connection test failed')
    } catch (err: unknown) {
      if (!mountedRef.current) return
      setStatuses((prev) => ({ ...prev, [id]: { ok: false, error: 'Test failed', loading: false } }))
      toast.error(err instanceof Error ? err.message : 'Test failed')
    }
  }

  const handleConformance = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setConformanceLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const res = await api<McpConformanceResult>('POST', `/mcp-servers/${id}/conformance`, {
        timeoutMs: 12000,
      })
      if (!mountedRef.current) return
      setConformanceByServer((prev) => ({ ...prev, [id]: res }))
      if (res.ok) toast.success('Conformance check passed')
      else toast.error(`Conformance issues found (${res.issues.length})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Conformance failed'
      if (!mountedRef.current) return
      setConformanceByServer((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          toolsCount: 0,
          smokeToolName: null,
          issues: [{ level: 'error', code: 'request_failed', message: msg }],
          timings: { connectMs: 0, listToolsMs: 0, smokeInvokeMs: null },
        },
      }))
      toast.error(msg)
    } finally {
      if (mountedRef.current) {
        setConformanceLoading((prev) => ({ ...prev, [id]: false }))
      }
    }
  }

  const openInspector = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (inspectorServerId === id) {
      inspectorRequestIdRef.current += 1
      setInspectorServerId(null)
      setInspectorError(null)
      return
    }
    const requestId = inspectorRequestIdRef.current + 1
    inspectorRequestIdRef.current = requestId
    setInspectorServerId(id)
    setInspectorError(null)
    setInvokeResult(null)

    if (toolsByServer[id]?.length) {
      const first = toolsByServer[id][0]
      setSelectedTool(first.name)
      setArgsJson(buildArgsTemplate(first.inputSchema))
      return
    }

    setInspectorLoading(true)
    try {
      const tools = await api<McpToolMeta[]>('GET', `/mcp-servers/${id}/tools`)
      if (!mountedRef.current || inspectorRequestIdRef.current !== requestId) return
      setToolsByServer((prev) => ({ ...prev, [id]: Array.isArray(tools) ? tools : [] }))
      const first = Array.isArray(tools) && tools.length > 0 ? tools[0] : null
      setSelectedTool(first?.name || '')
      setArgsJson(first ? buildArgsTemplate(first.inputSchema) : '{}')
    } catch (err) {
      if (!mountedRef.current || inspectorRequestIdRef.current !== requestId) return
      setInspectorError(err instanceof Error ? err.message : 'Failed to load tools')
      setSelectedTool('')
      setArgsJson('{}')
    } finally {
      if (mountedRef.current && inspectorRequestIdRef.current === requestId) {
        setInspectorLoading(false)
      }
    }
  }

  const handleToolChange = (toolName: string) => {
    setSelectedTool(toolName)
    setInvokeResult(null)
    const tool = activeTools.find((t) => t.name === toolName)
    setArgsJson(buildArgsTemplate(tool?.inputSchema))
  }

  const handleInvoke = async () => {
    if (!inspectorServerId || !selectedTool) return
    const requestId = invokeRequestIdRef.current + 1
    invokeRequestIdRef.current = requestId
    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = argsJson.trim() ? JSON.parse(argsJson) : {}
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
        setInvokeResult({ ok: false, error: 'Args must be a JSON object.' })
        return
      }
    } catch {
      setInvokeResult({ ok: false, error: 'Args must be valid JSON.' })
      return
    }

    setInvokeLoading(true)
    setInvokeResult(null)
    try {
      const result = await api<McpInvokeResult>('POST', `/mcp-servers/${inspectorServerId}/invoke`, {
        toolName: selectedTool,
        args: parsedArgs,
      })
      if (!mountedRef.current || invokeRequestIdRef.current !== requestId) return
      setInvokeResult(result)
      if (result.ok) {
        if (result.isError) toast.error('Tool returned an error')
        else toast.success('Tool invoked successfully')
      } else {
        toast.error(result.error || 'Invocation failed')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invocation failed'
      if (!mountedRef.current || invokeRequestIdRef.current !== requestId) return
      setInvokeResult({ ok: false, error: msg })
      toast.error(msg)
    } finally {
      if (mountedRef.current && invokeRequestIdRef.current === requestId) {
        setInvokeLoading(false)
      }
    }
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'px-3 pb-4' : 'px-5 pb-6'}`}>
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
        <>
          {!inSidebar && inspectorServerId && (
            <div className="mb-4 p-4 rounded-[14px] border border-white/[0.08] bg-surface-2">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <h3 className="font-display text-[14px] font-600 text-text truncate">
                    MCP Inspector: {activeInspectorServer?.name || inspectorServerId}
                  </h3>
                  <p className="text-[12px] text-text-3/70">List tools and invoke them with structured JSON args.</p>
                </div>
                <button
                  onClick={() => setInspectorServerId(null)}
                  className="text-[11px] text-text-3/70 hover:text-text-2 transition-colors"
                >
                  Close
                </button>
              </div>

              {inspectorLoading ? (
                <p className="text-[12px] text-text-3/70">Loading tools...</p>
              ) : inspectorError ? (
                <p className="text-[12px] text-red-300">{inspectorError}</p>
              ) : (
    <div className="space-y-3">
                  {activeConformance && (
                    <div className={`rounded-[10px] border p-3 ${activeConformance.ok ? 'border-emerald-400/20 bg-emerald-500/[0.06]' : 'border-amber-400/20 bg-amber-500/[0.06]'}`}>
                      <p className={`text-[12px] font-600 mb-1 ${activeConformance.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
                        Conformance {activeConformance.ok ? 'passed' : 'issues found'}
                      </p>
                      <p className="text-[11px] text-text-2/80">
                        tools={activeConformance.toolsCount}, smoke={activeConformance.smokeToolName || 'none'}, issues={activeConformance.issues.length}
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <label className="text-[11px] text-text-3/70 uppercase tracking-[0.08em]">Tool</label>
                    <label className="text-[11px] text-text-3/70 uppercase tracking-[0.08em]">Args (JSON)</label>
                    <select
                      value={selectedTool}
                      onChange={(e) => handleToolChange(e.target.value)}
                      className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-bg text-text text-[12px]"
                      style={{ fontFamily: 'inherit' }}
                    >
                      {activeTools.length === 0 && <option value="">No tools available</option>}
                      {activeTools.map((tool) => (
                        <option key={tool.name} value={tool.name}>{tool.name}</option>
                      ))}
                    </select>
                    <textarea
                      value={argsJson}
                      onChange={(e) => setArgsJson(e.target.value)}
                      className="min-h-[96px] px-3 py-2 rounded-[10px] border border-white/[0.08] bg-bg text-text text-[12px] font-mono"
                    />
                  </div>

                  {activeToolMeta?.description && (
                    <p className="text-[12px] text-text-3/80">{activeToolMeta.description}</p>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleInvoke}
                      disabled={!selectedTool || invokeLoading}
                      className="px-3 py-1.5 rounded-[9px] bg-accent-soft text-accent-bright text-[12px] font-600 disabled:opacity-60 disabled:cursor-not-allowed"
                      style={{ fontFamily: 'inherit' }}
                    >
                      {invokeLoading ? 'Running...' : 'Invoke Plugin'}                    </button>
                    <span className="text-[11px] text-text-3/60">Result is captured below with raw payload.</span>
                  </div>

                  {invokeResult && (
                    <div className={`rounded-[10px] border p-3 ${invokeResult.ok ? 'border-emerald-400/20 bg-emerald-500/[0.06]' : 'border-red-400/20 bg-red-500/[0.06]'}`}>
                      <p className={`text-[12px] font-600 mb-2 ${invokeResult.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                        {invokeResult.ok ? (invokeResult.isError ? 'Invocation returned MCP error' : 'Invocation succeeded') : 'Invocation failed'}
                      </p>
                      <pre className="text-[11px] text-text-2/90 font-mono whitespace-pre-wrap break-words">
                        {invokeResult.ok
                          ? JSON.stringify({ text: invokeResult.text, isError: invokeResult.isError, result: invokeResult.result }, null, 2)
                          : (invokeResult.error || 'Unknown error')}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className={inSidebar ? 'space-y-2' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'}>
            {serverList.map((server) => (
              <div
                key={server.id}
                role="button"
                tabIndex={0}
                onClick={() => handleEdit(server.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleEdit(server.id)
                  }
                }}
                className="w-full text-left p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 transition-all cursor-pointer"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {(() => {
                      const s = statuses[server.id]
                      if (!s || s.loading) return <StatusDot status="warning" pulse className="shrink-0" />
                      if (s.ok) return (
                        <span className="flex items-center gap-1 shrink-0">
                          <StatusDot status="online" />
                          {s.tools && <span className="text-[10px] text-emerald-400/80 font-mono">{s.tools.length} tools</span>}
                        </span>
                      )
                      return <StatusDot status="offline" className="shrink-0" />
                    })()}
                    <span className="font-display text-[14px] font-600 text-text truncate">{server.name}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {!inSidebar && (
                      <>
                        <button
                          onClick={(e) => openInspector(e, server.id)}
                          className={`text-[10px] font-600 px-2 py-0.5 rounded-[7px] transition-colors ${
                            inspectorServerId === server.id
                              ? 'bg-accent-soft text-accent-bright'
                              : 'bg-white/[0.06] text-text-3 hover:text-text-2'
                          }`}
                          title="Open MCP inspector"
                        >
                          Inspect
                        </button>
                        <button
                          onClick={(e) => handleConformance(e, server.id)}
                          className={`text-[10px] font-600 px-2 py-0.5 rounded-[7px] transition-colors ${
                            conformanceByServer[server.id]?.ok
                              ? 'bg-emerald-500/10 text-emerald-300'
                              : conformanceByServer[server.id]
                                ? 'bg-amber-500/10 text-amber-300'
                                : 'bg-white/[0.06] text-text-3 hover:text-text-2'
                          }`}
                          title="Run MCP conformance checks"
                        >
                          {conformanceLoading[server.id] ? 'Checking...' : 'Conformance'}
                        </button>
                        <button
                          onClick={(e) => handleRetest(e, server.id)}
                          className="text-text-3/40 hover:text-text-2 transition-colors p-0.5"
                          title="Re-test connection"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
                          </svg>
                        </button>
                      </>
                    )}
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
                {conformanceByServer[server.id] && (
                  <p className={`mt-1 text-[11px] ${conformanceByServer[server.id].ok ? 'text-emerald-300/80' : 'text-amber-300/80'}`}>
                    {conformanceByServer[server.id].ok
                      ? `Conformance passed (${conformanceByServer[server.id].toolsCount} tools)`
                      : `Conformance issues: ${conformanceByServer[server.id].issues.length}`}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete MCP Server?"
        message={confirmDelete ? `Delete "${confirmDelete.name}"? This will remove the MCP server from the app.` : 'Delete this MCP server?'}
        confirmLabel={deletingId ? 'Deleting...' : 'Delete'}
        confirmDisabled={!!deletingId}
        cancelDisabled={!!deletingId}
        danger
        onConfirm={() => { void handleDeleteConfirm() }}
        onCancel={() => { if (!deletingId) setConfirmDelete(null) }}
      />
    </div>
  )
}
