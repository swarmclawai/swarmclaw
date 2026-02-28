'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { api } from '@/lib/api-client'
import type { McpServerConfig, McpTransport } from '@/types'

function McpServerForm({ editing, onClose, loadMcpServers }: {
  editing: McpServerConfig | null
  onClose: () => void
  loadMcpServers: () => Promise<void>
}) {
  const [name, setName] = useState(editing?.name || '')
  const [transport, setTransport] = useState<McpTransport>(editing?.transport || 'stdio')
  const [command, setCommand] = useState(editing?.command || '')
  const [args, setArgs] = useState(editing?.args?.join(', ') || '')
  const [url, setUrl] = useState(editing?.url || '')
  const [envText, setEnvText] = useState(
    editing?.env ? Object.entries(editing.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
  )
  const [headersText, setHeadersText] = useState(
    editing?.headers ? Object.entries(editing.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
  )
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; tools?: string[]; error?: string } | null>(null)

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
    }
    if (transport === 'stdio') {
      data.command = command.trim()
      data.args = args.trim() ? args.split(',').map((a) => a.trim()).filter(Boolean) : []
    } else {
      data.url = url.trim()
    }
    if (editing) {
      await api('PUT', `/mcp-servers/${editing.id}`, data)
    } else {
      await api('POST', '/mcp-servers', data)
    }
    await loadMcpServers()
    onClose()
  }

  const handleDelete = async () => {
    if (editing) {
      await api('DELETE', `/mcp-servers/${editing.id}`)
      await loadMcpServers()
      onClose()
    }
  }

  const handleTest = async () => {
    if (!editing) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api<{ ok: boolean; tools?: string[]; error?: string }>('POST', `/mcp-servers/${editing.id}/test`)
      setTestResult(result)
    } catch (err: unknown) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' })
    }
    setTesting(false)
  }

  const canSave = name.trim() && (transport === 'stdio' ? command.trim() : url.trim())

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
          <button onClick={handleDelete} className="py-3.5 px-6 rounded-[14px] border border-red-500/20 bg-transparent text-red-400 text-[15px] font-600 cursor-pointer hover:bg-red-500/10 transition-all" style={{ fontFamily: 'inherit' }}>
            Delete
          </button>
        )}
        <button onClick={onClose} className="flex-1 py-3.5 rounded-[14px] border border-white/[0.08] bg-transparent text-text-2 text-[15px] font-600 cursor-pointer hover:bg-surface-2 transition-all" style={{ fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={handleSave} disabled={!canSave} className="flex-1 py-3.5 rounded-[14px] border-none bg-[#6366F1] text-white text-[15px] font-600 cursor-pointer active:scale-[0.97] disabled:opacity-30 transition-all shadow-[0_4px_20px_rgba(99,102,241,0.25)] hover:brightness-110" style={{ fontFamily: 'inherit' }}>
          {editing ? 'Save' : 'Create'}
        </button>
      </div>
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
