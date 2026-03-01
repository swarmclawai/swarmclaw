'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api-client'
import type { GatewayReloadMode } from '@/types'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

interface ConfigIssue {
  id: string
  severity: 'warning' | 'error'
  title: string
  description: string
  repairAction?: string
}

export function GatewayConnectionPanel() {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [error, setError] = useState('')
  const [reloadMode, setReloadMode] = useState<GatewayReloadMode>('hot')
  const [reloadSaving, setReloadSaving] = useState(false)
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [repairingId, setRepairingId] = useState<string | null>(null)

  const checkStatus = useCallback(async () => {
    try {
      const res = await api<{ connected: boolean }>('GET', '/openclaw/gateway')
      setStatus(res.connected ? 'connected' : 'disconnected')
    } catch {
      setStatus('disconnected')
    }
  }, [])

  const loadReloadMode = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; result: GatewayReloadMode }>('POST', '/openclaw/gateway', {
        method: 'gateway.reload-mode.get',
        params: {},
      })
      if (res.ok && res.result) setReloadMode(res.result)
    } catch {
      // ignore — gateway may not be connected
    }
  }, [])

  const loadIssues = useCallback(async () => {
    try {
      const res = await api<{ issues: ConfigIssue[] }>('GET', '/openclaw/config-sync')
      setIssues(res.issues ?? [])
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  useEffect(() => {
    if (status === 'connected') {
      loadReloadMode()
      loadIssues()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const handleConnect = async () => {
    setStatus('connecting')
    setError('')
    try {
      const res = await api<{ ok: boolean; error?: string }>('POST', '/openclaw/gateway', {
        method: 'gateway.connect',
        params: { url: url || undefined, token: token || undefined },
      })
      if (res.ok) {
        setStatus('connected')
      } else {
        setStatus('disconnected')
        setError(res.error || 'Connection failed')
      }
    } catch (err: unknown) {
      setStatus('disconnected')
      setError(err instanceof Error ? err.message : 'Connection failed')
    }
  }

  const handleDisconnect = async () => {
    setError('')
    try {
      await api('POST', '/openclaw/gateway', {
        method: 'gateway.disconnect',
        params: {},
      })
      setStatus('disconnected')
      setIssues([])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Disconnect failed')
    }
  }

  const handleReloadModeChange = async (mode: GatewayReloadMode) => {
    setReloadSaving(true)
    try {
      await api('POST', '/openclaw/gateway', {
        method: 'gateway.reload-mode.set',
        params: { mode },
      })
      setReloadMode(mode)
    } catch {
      // ignore
    } finally {
      setReloadSaving(false)
    }
  }

  const handleRepair = async (issueId: string) => {
    setRepairingId(issueId)
    try {
      await api('POST', '/openclaw/config-sync', { issueId })
      await loadIssues()
    } catch {
      // ignore
    } finally {
      setRepairingId(null)
    }
  }

  const dotColor = status === 'connected'
    ? 'bg-emerald-400'
    : status === 'connecting'
      ? 'bg-amber-400 animate-pulse'
      : 'bg-red-400'

  const reloadModes: { value: GatewayReloadMode; label: string; desc: string }[] = [
    { value: 'hot', label: 'Hot', desc: 'Only reload changed agents' },
    { value: 'hybrid', label: 'Hybrid', desc: 'Hot + restart stale sessions' },
    { value: 'full', label: 'Full', desc: 'Restart all agents on change' },
  ]

  const actionableIssues = issues.filter((i) => i.id !== 'no-connection')

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className="text-[13px] font-600 text-text capitalize">{status}</span>
        {actionableIssues.length > 0 && (
          <span className="ml-auto px-2 py-0.5 rounded-[6px] bg-amber-400/10 text-amber-400 text-[10px] font-700">
            {actionableIssues.length} issue{actionableIssues.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[11px] font-600 uppercase tracking-wider text-text-3/50">Gateway URL</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="ws://127.0.0.1:18789"
          className="w-full px-3 py-2 rounded-[10px] border border-white/[0.06] bg-black/20 text-[13px] text-text font-mono outline-none placeholder:text-text-3/40 focus:border-white/[0.12] transition-colors"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[11px] font-600 uppercase tracking-wider text-text-3/50">Token (optional)</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token"
          className="w-full px-3 py-2 rounded-[10px] border border-white/[0.06] bg-black/20 text-[13px] text-text font-mono outline-none placeholder:text-text-3/40 focus:border-white/[0.12] transition-colors"
        />
      </div>

      <div className="flex gap-2">
        {status !== 'connected' ? (
          <button
            onClick={handleConnect}
            disabled={status === 'connecting'}
            className="px-4 py-2 rounded-[10px] border-none bg-accent-bright text-white text-[12px] font-600 cursor-pointer disabled:opacity-40 transition-all hover:brightness-110"
            style={{ fontFamily: 'inherit' }}
          >
            {status === 'connecting' ? 'Connecting...' : 'Connect'}
          </button>
        ) : (
          <button
            onClick={handleDisconnect}
            className="px-4 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-red-400 text-[12px] font-600 cursor-pointer transition-all hover:bg-red-400/10"
            style={{ fontFamily: 'inherit' }}
          >
            Disconnect
          </button>
        )}
        <button
          onClick={checkStatus}
          className="px-4 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600 cursor-pointer transition-all hover:bg-white/[0.04]"
          style={{ fontFamily: 'inherit' }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-[12px] text-red-400">{error}</p>
      )}

      {/* Reload Mode Toggle (F21) */}
      {status === 'connected' && (
        <div className="flex flex-col gap-2 pt-2 border-t border-white/[0.04]">
          <label className="text-[11px] font-600 uppercase tracking-wider text-text-3/50">Reload Mode</label>
          <div className="flex gap-1">
            {reloadModes.map((rm) => (
              <button
                key={rm.value}
                onClick={() => handleReloadModeChange(rm.value)}
                disabled={reloadSaving}
                className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 cursor-pointer transition-all border
                  ${reloadMode === rm.value
                    ? 'bg-accent-soft text-accent-bright border-accent-bright/30'
                    : 'bg-transparent text-text-3 border-white/[0.06] hover:border-white/[0.12]'
                  }`}
                style={{ fontFamily: 'inherit' }}
                title={rm.desc}
              >
                {rm.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-text-3/40">
            {reloadModes.find((r) => r.value === reloadMode)?.desc}
          </p>
        </div>
      )}

      {/* Config Issues (F19) */}
      {actionableIssues.length > 0 && (
        <div className="flex flex-col gap-2 pt-2 border-t border-white/[0.04]">
          <label className="text-[11px] font-600 uppercase tracking-wider text-text-3/50">Config Issues</label>
          {actionableIssues.map((issue) => (
            <div
              key={issue.id}
              className={`flex items-start gap-3 p-3 rounded-[10px] border ${
                issue.severity === 'error'
                  ? 'bg-red-400/[0.04] border-red-400/20'
                  : 'bg-amber-400/[0.04] border-amber-400/20'
              }`}
            >
              <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                issue.severity === 'error' ? 'bg-red-400' : 'bg-amber-400'
              }`} />
              <div className="flex-1 min-w-0">
                <p className={`text-[12px] font-600 ${
                  issue.severity === 'error' ? 'text-red-400' : 'text-amber-400'
                }`}>
                  {issue.title}
                </p>
                <p className="text-[11px] text-text-3/60 mt-0.5">{issue.description}</p>
              </div>
              {issue.repairAction && (
                <button
                  onClick={() => handleRepair(issue.repairAction!)}
                  disabled={repairingId === issue.repairAction}
                  className="shrink-0 px-3 py-1 rounded-[7px] border-none bg-accent-bright text-white text-[10px] font-600 cursor-pointer disabled:opacity-40 transition-all hover:brightness-110"
                  style={{ fontFamily: 'inherit' }}
                >
                  {repairingId === issue.repairAction ? 'Repairing...' : 'Repair'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
