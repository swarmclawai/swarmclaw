'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { HintTip } from '@/components/shared/hint-tip'
import { api } from '@/lib/app/api-client'
import { toast } from 'sonner'
import type { McpServerConfig, McpTransport } from '@/types'
import { useMountedRef } from '@/hooks/use-mounted-ref'

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
  const [url, setUrl] = useState(editing?.url || '')
  const [envText, setEnvText] = useState(
    editing?.env ? Object.entries(editing.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
  )
  const [headersText, setHeadersText] = useState(
    editing?.headers ? Object.entries(editing.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
  )
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; tools?: string[]; error?: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

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
